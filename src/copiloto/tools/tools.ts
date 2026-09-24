// Herramientas de solo lectura. Todo el cálculo se hace aquí con decimal.js, sobre datos crudos
// de InventoryDataSource. Jev nunca calcula cifras: recibe las que salen de aquí ya formateadas.
import Decimal from "decimal.js";
import type { Herramienta } from "../jev/catalog";
import type { Product, SessionContext } from "../domain";
import { formatBase, formatDecimal, formatMoney } from "../entities/units";
import { addDays, businessDay, formatDay } from "./periods";
import type { EvalItem, InventoryDataSource, MovementType, ToolParams, ToolResult, ToolRow } from "./types";

export const MAX_ROWS = 12;
/** Días de historial para el consumo medio diario. */
export const CONSUMPTION_WINDOW_DAYS = 28;
/** Días de historial para precios y desvíos si el usuario no indica periodo. */
const DEFAULT_LOOKBACK_DAYS = 90;

const MOVEMENT_LABELS: Record<MovementType, string> = {
  opening: "apertura",
  purchase: "compra",
  consumption: "consumo",
  waste: "merma",
  transfer_out: "traspaso enviado",
  transfer_in: "traspaso recibido",
  count_adjustment: "ajuste de inventario",
  manual_adjustment: "ajuste manual",
};

export type ToolName = Exclude<Herramienta, "ninguna">;

export interface Tools {
  /** Fuente de datos de solo lectura (también la usan los borradores). */
  readonly source: InventoryDataSource;
  run(tool: ToolName, params: ToolParams, ctx: SessionContext): Promise<ToolResult>;
}

function productMap(ctx: SessionContext): Map<string, Product> {
  return new Map(ctx.products.map((p) => [p.id, p]));
}

function locationName(ctx: SessionContext, id: string): string {
  return ctx.locations.find((l) => l.id === id)?.name ?? "local desconocido";
}

function sinceIso(day: string): string {
  return `${addDays(day, -1)}T00:00:00Z`;
}

function pct(part: Decimal, whole: Decimal): Decimal | null {
  return whole.isZero() ? null : part.div(whole).mul(100);
}

function finish(tool: ToolName, rows: ToolRow[], totals: Record<string, string>, evalItems: EvalItem[] = []): ToolResult {
  return { tool, rows: rows.slice(0, MAX_ROWS), totals, count: rows.length, truncated: rows.length > MAX_ROWS, evalItems };
}

/** Reposición en crudo (decimal.js): la usan la herramienta query_reorder y la analítica. */
export async function computeReorder(source: InventoryDataSource, params: ToolParams, ctx: SessionContext) {
  const products = productMap(ctx);
  const productIds = params.productIds.length > 0 ? params.productIds : undefined;
  const today = dayOf(params.now);
  const [lps, balances, movements, transfers, orders] = await Promise.all([
    source.locationProducts({ locationIds: params.locationIds, productIds }),
    source.balances({ locationIds: params.locationIds, productIds }),
    source.movements({ locationIds: params.locationIds, productIds, since: sinceIso(addDays(today, -CONSUMPTION_WINDOW_DAYS)) }),
    source.transfers({ locationIds: params.locationIds, status: ["in_transit"] }),
    source.openOrders({ locationIds: params.locationIds }),
  ]);
  const stock = new Map(balances.map((b) => [`${b.locationId}:${b.productId}`, new Decimal(b.qty)]));
  // Salidas que consumen stock del local. Los traspasos enviados no cuentan: son redistribución.
  const used = new Map<string, Decimal>();
  for (const m of movements) {
    const qty = new Decimal(m.qty);
    const isOutflow = m.type === "consumption" || m.type === "waste" || ((m.type === "count_adjustment" || m.type === "manual_adjustment") && qty.lt(0));
    if (!isOutflow) continue;
    const key = `${m.locationId}:${m.productId}`;
    used.set(key, (used.get(key) ?? new Decimal(0)).plus(qty.abs()));
  }
  const incoming = new Map<string, Decimal>();
  for (const t of transfers) {
    if (!params.locationIds.includes(t.toLocationId)) continue;
    for (const l of t.lines) {
      const key = `${t.toLocationId}:${l.productId}`;
      incoming.set(key, (incoming.get(key) ?? new Decimal(0)).plus(l.qtySent));
    }
  }

  // Lo ya pedido al proveedor (y aún no recibido) también está en camino: no se vuelve a sugerir.
  for (const o of orders) {
    if (productIds && !productIds.includes(o.productId)) continue;
    const key = `${o.locationId}:${o.productId}`;
    incoming.set(key, (incoming.get(key) ?? new Decimal(0)).plus(o.qtyBase));
  }

  const horizonDays = new Decimal(params.horizonDays);
  const lines = lps
    .map((lp) => {
      const key = `${lp.locationId}:${lp.productId}`;
      const product = products.get(lp.productId);
      const qty = stock.get(key) ?? new Decimal(0);
      const min = new Decimal(lp.minQty);
      const par = new Decimal(lp.parQty);
      const avg = (used.get(key) ?? new Decimal(0)).div(CONSUMPTION_WINDOW_DAYS);
      const pendingIn = incoming.get(key) ?? new Decimal(0);
      const available = qty.plus(pendingIn);
      const coverage = avg.gt(0) ? qty.div(avg) : null;
      const needForHorizon = avg.mul(horizonDays).plus(min).minus(available);
      const toPar = par.minus(available);
      const suggested = Decimal.max(0, needForHorizon, toPar);
      return { lp, product, qty, min, par, avg, pendingIn, coverage, suggested, available };
    })
    .filter((l) => l.product && (l.available.lt(l.min) || (l.avg.gt(0) && l.available.minus(l.avg.mul(horizonDays)).lt(l.min))))
    .sort((a, b) => (a.coverage ?? new Decimal(1e9)).cmp(b.coverage ?? new Decimal(1e9)));
  return lines.map((l) => ({ ...l, product: l.product! }));
}

export class InventoryTools implements Tools {
  constructor(readonly source: InventoryDataSource) {}

  async run(tool: ToolName, params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    switch (tool) {
      case "query_stock":
        return this.stock(params, ctx);
      case "query_movements":
        return this.movements(params, ctx);
      case "query_prices":
        return this.prices(params, ctx);
      case "query_pending_transfers":
        return this.pendingTransfers(params, ctx);
      case "query_count_variance":
        return this.countVariance(params, ctx);
      case "query_reorder":
        return this.reorder(params, ctx);
    }
  }

  private async stock(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const products = productMap(ctx);
    const productIds = params.productIds.length > 0 ? params.productIds : undefined;
    const [lps] = await Promise.all([this.source.locationProducts({ locationIds: params.locationIds, productIds })]);
    const minimums = new Map(lps.map((lp) => [`${lp.locationId}:${lp.productId}`, new Decimal(lp.minQty)]));

    type Line = { locationId: string; areaName: string | null; product: Product; qty: Decimal; value: Decimal; min: Decimal | null };
    const lines: Line[] = [];
    if (params.areaId) {
      const area = ctx.areas.find((a) => a.id === params.areaId);
      for (const b of await this.source.areaBalances(params.areaId, productIds)) {
        const product = products.get(b.productId);
        if (!product || !area) continue;
        const qty = new Decimal(b.qty);
        lines.push({ locationId: area.locationId, areaName: area.name, product, qty, value: qty.mul(b.avgCost), min: null });
      }
    } else {
      for (const b of await this.source.balances({ locationIds: params.locationIds, productIds })) {
        const product = products.get(b.productId);
        if (!product) continue;
        const qty = new Decimal(b.qty);
        const min = minimums.get(`${b.locationId}:${b.productId}`) ?? null;
        lines.push({ locationId: b.locationId, areaName: null, product, qty, value: qty.mul(b.avgCost), min: min && min.gt(0) ? min : null });
      }
    }

    lines.sort((a, b) => {
      const aLow = a.min !== null && a.qty.lt(a.min) ? 1 : 0;
      const bLow = b.min !== null && b.qty.lt(b.min) ? 1 : 0;
      return bLow - aLow || b.value.cmp(a.value) || a.product.name.localeCompare(b.product.name);
    });
    const totalValue = lines.reduce((acc, l) => acc.plus(l.value), new Decimal(0));
    const belowMin = lines.filter((l) => l.min !== null && l.qty.lt(l.min));

    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product.name,
      local: locationName(ctx, l.locationId),
      espacio: l.areaName,
      cantidad: formatBase(l.qty, l.product.baseUnit),
      valor: formatMoney(l.value),
      minimo: l.min ? formatBase(l.min, l.product.baseUnit) : null,
      bajo_minimo: l.min !== null && l.qty.lt(l.min),
    }));
    return finish("query_stock", rows, {
      productos: String(lines.length),
      valor_total: formatMoney(totalValue),
      bajo_minimo: String(belowMin.length),
    });
  }

  private async movements(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const period = params.period!;
    const products = productMap(ctx);
    const raw = await this.source.movements({
      locationIds: params.locationIds,
      productIds: params.productIds.length > 0 ? params.productIds : undefined,
      since: sinceIso(period.from),
    });
    const tz = new Map(ctx.locations.map((l) => [l.id, l]));
    const groups = new Map<string, { type: MovementType; product: Product; qty: Decimal; value: Decimal; count: number }>();
    const byType = new Map<MovementType, Decimal>();
    for (const m of raw) {
      if (params.areaId && m.areaId !== params.areaId) continue;
      const loc = tz.get(m.locationId);
      const day = businessDay(new Date(m.occurredAt), loc?.timezone ?? "Europe/Madrid", loc?.dayCutoff ?? "06:00");
      if (day < period.from || day > period.to) continue;
      const product = products.get(m.productId);
      if (!product) continue;
      const key = `${m.type}:${m.productId}`;
      const qty = new Decimal(m.qty);
      const value = qty.mul(m.unitCost ?? 0);
      const g = groups.get(key) ?? { type: m.type, product, qty: new Decimal(0), value: new Decimal(0), count: 0 };
      g.qty = g.qty.plus(qty);
      g.value = g.value.plus(value);
      g.count += 1;
      groups.set(key, g);
      byType.set(m.type, (byType.get(m.type) ?? new Decimal(0)).plus(value));
    }
    const sorted = [...groups.values()].sort((a, b) => b.value.abs().cmp(a.value.abs()));
    const rows: ToolRow[] = sorted.map((g) => ({
      tipo: MOVEMENT_LABELS[g.type],
      producto: g.product.name,
      cantidad: formatBase(g.qty.abs(), g.product.baseUnit),
      valor: formatMoney(g.value.abs()),
      movimientos: String(g.count),
    }));
    const totals: Record<string, string> = { periodo: period.label, movimientos: String(raw.length) };
    for (const [type, value] of byType) totals[`valor_${MOVEMENT_LABELS[type].replace(/ /g, "_")}`] = formatMoney(value.abs());
    return finish("query_movements", rows, totals);
  }

  private async prices(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const from = params.period?.from ?? addDays(dayOf(params.now), -DEFAULT_LOOKBACK_DAYS);
    const packs = new Map<string, { product: Product; packName: string }>();
    for (const product of ctx.products) {
      if (params.productIds.length > 0 && !params.productIds.includes(product.id)) continue;
      for (const pack of product.packs) packs.set(pack.id, { product, packName: pack.name });
    }
    // Se pide también el precio anterior al periodo para poder comparar.
    const raw = await this.source.prices(params.productIds.length > 0 ? [...packs.keys()] : null, sinceIso(addDays(from, -DEFAULT_LOOKBACK_DAYS)));
    const series = new Map<string, typeof raw>();
    for (const p of raw) {
      const key = `${p.supplierId}:${p.packId}`;
      series.set(key, [...(series.get(key) ?? []), p]);
    }
    type Line = { product: Product; packName: string; supplier: string; old: Decimal | null; latest: Decimal; change: Decimal | null; date: string };
    const lines: Line[] = [];
    for (const list of series.values()) {
      list.sort((a, b) => a.recordedAt.localeCompare(b.recordedAt));
      const latest = list[list.length - 1]!;
      const pack = packs.get(latest.packId);
      if (!pack || latest.recordedAt.slice(0, 10) < from) continue;
      const previous = [...list].reverse().find((p) => p.recordedAt < latest.recordedAt && !new Decimal(p.price).eq(latest.price));
      const old = previous ? new Decimal(previous.price) : null;
      const latestPrice = new Decimal(latest.price);
      lines.push({
        product: pack.product,
        packName: pack.packName,
        supplier: latest.supplierName,
        old,
        latest: latestPrice,
        change: old ? pct(latestPrice.minus(old), old) : null,
        date: latest.recordedAt.slice(0, 10),
      });
    }
    lines.sort((a, b) => (b.change ?? new Decimal(-1e9)).cmp(a.change ?? new Decimal(-1e9)));
    const rises = lines.filter((l) => l.change !== null && l.change.gt(0));
    const evalItems: EvalItem[] = rises.map((l) => ({
      kind: "subida",
      key: `subida_precio:${l.supplier}:${l.product.id}:${l.packName}`,
      locationId: null,
      data: {
        product: `${l.product.name} (${l.packName})`,
        supplier: l.supplier,
        old_price: formatMoney(l.old!),
        new_price: formatMoney(l.latest),
        change_pct: `${formatDecimal(l.change!, 1)} %`,
      },
    }));
    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product.name,
      formato: l.packName,
      proveedor: l.supplier,
      precio_anterior: l.old ? formatMoney(l.old) : null,
      precio_actual: formatMoney(l.latest),
      variacion: l.change ? `${formatDecimal(l.change, 1)} %` : null,
      fecha: formatDay(l.date),
    }));
    return finish("query_prices", rows, { precios: String(lines.length), subidas: String(rises.length), desde: formatDay(from) }, evalItems);
  }

  private async pendingTransfers(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const products = productMap(ctx);
    const raw = await this.source.transfers({ locationIds: params.locationIds, status: ["in_transit"] });
    const now = params.now.getTime();
    const lines = raw.map((t) => {
      const value = t.lines.reduce((acc, l) => acc.plus(new Decimal(l.qtySent).mul(l.unitCost ?? 0)), new Decimal(0));
      const hours = t.sentAt ? new Decimal(now - new Date(t.sentAt).getTime()).div(3_600_000) : new Decimal(0);
      return { t, value, hours };
    });
    lines.sort((a, b) => b.hours.cmp(a.hours));
    const describeAgo = (hours: Decimal) =>
      hours.lt(48) ? `${formatDecimal(hours.floor(), 0)} horas` : `${formatDecimal(hours.div(24).floor(), 0)} días`;
    const evalItems: EvalItem[] = lines.map(({ t, value, hours }) => ({
      kind: "atasco",
      key: `traspaso_pendiente:${t.id}`,
      locationId: t.toLocationId,
      data: {
        from: locationName(ctx, t.fromLocationId),
        to: locationName(ctx, t.toLocationId),
        sent_ago: describeAgo(hours),
        value: formatMoney(value),
        lines: String(t.lines.length),
      },
    }));
    const rows: ToolRow[] = lines.map(({ t, value, hours }) => ({
      id: t.id,
      origen: locationName(ctx, t.fromLocationId),
      destino: locationName(ctx, t.toLocationId),
      enviado_hace: describeAgo(hours),
      lineas: String(t.lines.length),
      productos: t.lines.map((l) => products.get(l.productId)?.name ?? "?").slice(0, 4).join(", "),
      valor: formatMoney(value),
    }));
    const total = lines.reduce((acc, l) => acc.plus(l.value), new Decimal(0));
    return finish("query_pending_transfers", rows, { traspasos: String(lines.length), valor_en_transito: formatMoney(total) }, evalItems);
  }

  private async countVariance(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const products = productMap(ctx);
    const from = params.period?.from ?? addDays(dayOf(params.now), -30);
    const raw = await this.source.countResults({
      locationIds: params.locationIds,
      productIds: params.productIds.length > 0 ? params.productIds : undefined,
      since: sinceIso(from),
    });
    const lines = raw
      .map((r) => {
        const expected = new Decimal(r.expectedQty);
        const diff = new Decimal(r.countedQty).minus(expected);
        return { r, product: products.get(r.productId), expected, diff, diffValue: diff.mul(r.unitCost), diffPct: pct(diff, expected) };
      })
      .filter((l) => l.product && !l.diff.isZero())
      .sort((a, b) => b.diffValue.abs().cmp(a.diffValue.abs()));
    const evalItems: EvalItem[] = lines.map((l) => ({
      kind: "desvio",
      key: `desvio_inventario:${l.r.countId}:${l.r.productId}`,
      locationId: l.r.locationId,
      data: {
        product: l.product!.name,
        venue: locationName(ctx, l.r.locationId),
        expected: formatBase(l.expected, l.product!.baseUnit),
        counted: formatBase(l.r.countedQty, l.product!.baseUnit),
        diff: formatBase(l.diff, l.product!.baseUnit),
        diff_pct: l.diffPct ? `${formatDecimal(l.diffPct, 1)} %` : "sin stock teórico",
        diff_value: formatMoney(l.diffValue),
      },
    }));
    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product!.name,
      local: locationName(ctx, l.r.locationId),
      teorico: formatBase(l.expected, l.product!.baseUnit),
      contado: formatBase(l.r.countedQty, l.product!.baseUnit),
      diferencia: formatBase(l.diff, l.product!.baseUnit),
      diferencia_pct: l.diffPct ? `${formatDecimal(l.diffPct, 1)} %` : null,
      valor: formatMoney(l.diffValue),
      fecha: formatDay(l.r.closedAt.slice(0, 10)),
    }));
    const total = lines.reduce((acc, l) => acc.plus(l.diffValue), new Decimal(0));
    return finish("query_count_variance", rows, { desvios: String(lines.length), valor_neto: formatMoney(total), desde: formatDay(from) }, evalItems);
  }

  private async reorder(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const lines = await computeReorder(this.source, params, ctx);

    const evalItems: EvalItem[] = lines.map((l) => ({
      kind: "reponer",
      key: `stock_bajo:${l.lp.locationId}:${l.lp.productId}`,
      locationId: l.lp.locationId,
      data: {
        product: l.product!.name,
        venue: locationName(ctx, l.lp.locationId),
        stock: formatBase(l.qty, l.product!.baseUnit),
        minimum: formatBase(l.min, l.product!.baseUnit),
        avg_daily_use: formatBase(l.avg.toDecimalPlaces(2), l.product!.baseUnit),
        coverage_days: l.coverage ? formatDecimal(l.coverage, 1) : "sin consumo reciente",
        pending_in: formatBase(l.pendingIn, l.product!.baseUnit),
        suggested: formatBase(l.suggested.toDecimalPlaces(2), l.product!.baseUnit),
      },
    }));
    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product!.name,
      local: locationName(ctx, l.lp.locationId),
      stock: formatBase(l.qty, l.product!.baseUnit),
      minimo: formatBase(l.min, l.product!.baseUnit),
      consumo_diario: formatBase(l.avg.toDecimalPlaces(2), l.product!.baseUnit),
      dias_cobertura: l.coverage ? formatDecimal(l.coverage, 1) : null,
      en_camino: l.pendingIn.gt(0) ? formatBase(l.pendingIn, l.product!.baseUnit) : null,
      sugerido: formatBase(l.suggested.toDecimalPlaces(2), l.product!.baseUnit),
    }));
    return finish("query_reorder", rows, { productos: String(lines.length), horizonte: params.horizonLabel }, evalItems);
  }
}

function dayOf(now: Date): string {
  return businessDay(now, "Europe/Madrid", "06:00");
}
