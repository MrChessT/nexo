// Herramientas de solo lectura. Todo el cálculo se hace aquí con decimal.js, sobre datos crudos
// de InventoryDataSource. Jev nunca calcula cifras: recibe las que salen de aquí ya formateadas.
import Decimal from "decimal.js";
import type { Herramienta } from "../jev/catalog";
import type { Product, SessionContext } from "../domain";
import { formatDecimal, formatMoney, formatStock } from "../entities/units";
import { addDays, businessDay, daysInclusive, formatDay } from "./periods";
import type { EvalItem, InventoryDataSource, MovementType, ToolParams, ToolResult, ToolRow } from "./types";

export const MAX_ROWS = 12;
/** Días de historial para el consumo medio diario. */
export const CONSUMPTION_WINDOW_DAYS = 28;
/** Días de historial para precios y desvíos si el usuario no indica periodo. */
const DEFAULT_LOOKBACK_DAYS = 90;
/** Hasta dónde se busca el último precio de un producto concreto. */
const LAST_PRICE_LOOKBACK_DAYS = 365;

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

function finish(tool: ToolName, rows: ToolRow[], totals: Record<string, string>, evalItems: EvalItem[] = [], max = MAX_ROWS): ToolResult {
  return { tool, rows: rows.slice(0, max), totals, count: rows.length, truncated: rows.length > max, evalItems };
}

/** Filas del desglose por espacio: caben más (varias secciones con pocos productos cada una). */
const MAX_AREA_ROWS = 60;
const PER_AREA = 6;

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
      case "query_orders":
        return this.orders(params, ctx);
      case "query_spend":
        return this.spend(params, ctx);
      case "query_product":
        return this.product(params, ctx);
      case "query_top_usage":
        return this.topUsage(params, ctx);
    }
  }

  /**
   * Ficha de producto: categoría, formatos, proveedor y último precio de compra, y stock y mínimo en
   * cada local. Una fila por local; la ficha va en los totales (texto ya formateado).
   */
  private async product(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const product = ctx.products.find((p) => p.id === params.productIds[0]);
    if (!product) return finish("query_product", [], {});
    const [balances, levels, prices] = await Promise.all([
      this.source.balances({ locationIds: params.locationIds, productIds: [product.id] }),
      this.source.locationProducts({ locationIds: params.locationIds, productIds: [product.id] }),
      this.source.supplierPrices(product.packs.map((k) => k.id)),
    ]);
    const qty = new Map(balances.map((b) => [b.locationId, new Decimal(b.qty)]));
    const min = new Map(levels.map((l) => [l.locationId, new Decimal(l.minQty)]));
    const locations = params.locationIds.filter((id) => qty.has(id) || min.has(id));
    const rows: ToolRow[] = locations.map((id) => {
      const q = qty.get(id) ?? new Decimal(0);
      const m = min.get(id);
      return {
        local: locationName(ctx, id),
        cantidad: formatStock(q, product),
        minimo: m && m.gt(0) ? formatStock(m, product) : null,
        bajo_minimo: !!m && m.gt(0) && q.lt(m),
      };
    });
    const total = [...qty.values()].reduce((a, b) => a.plus(b), new Decimal(0));
    const packNames = new Map(product.packs.map((k) => [k.id, k.name]));
    const buy = prices
      .map((p) => `${packNames.get(p.packId) ?? "formato"} a ${formatMoney(p.lastPrice)} (${p.supplierName})`)
      .join(" · ");
    return finish("query_product", rows, {
      producto: product.name,
      categoria: product.category ?? "sin categoría",
      formatos: product.packs.map((k) => k.name).join(" · ") || "sin formatos",
      compra: buy || "sin precio de compra",
      proveedores: [...new Set(prices.map((p) => p.supplierName))].join(", ") || "sin proveedor",
      total: formatStock(total, product),
      locales: String(locations.length),
    });
  }

  /** Pedidos abiertos: borradores sin enviar, pendientes de recibir y retrasados. */
  private async orders(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const today = dayOf(params.now);
    const raw = await this.source.orders({ locationIds: params.locationIds, statuses: ["draft", "sent", "partial"] });
    const productIds = params.productIds;
    const relevant = productIds.length > 0 ? raw.filter((o) => o.lines.some((l) => productIds.includes(l.productId))) : raw;
    const STATUS: Record<string, string> = { draft: "borrador sin enviar", sent: "enviado", partial: "recibido en parte" };
    const lines = relevant.map((o) => {
      const pendingValue = o.lines.reduce((acc, l) => {
        const left = Decimal.max(0, new Decimal(l.packsQty).minus(l.receivedPacks));
        return acc.plus(left.mul(l.packPrice ?? 0));
      }, new Decimal(0));
      const sentDays = o.sentAt ? Math.floor((params.now.getTime() - new Date(o.sentAt).getTime()) / 86_400_000) : null;
      // Retraso: pasó la fecha prevista o, sin fecha, lleva más de 3 días enviado.
      const late = o.status !== "draft" && ((o.expectedDate !== null && o.expectedDate < today) || (o.expectedDate === null && sentDays !== null && sentDays > 3));
      return { o, pendingValue, late };
    });
    lines.sort((a, b) => Number(b.late) - Number(a.late) || Number(b.o.status !== "draft") - Number(a.o.status !== "draft"));
    const rows: ToolRow[] = lines.map(({ o, pendingValue, late }) => ({
      id: o.id,
      proveedor: o.supplierName,
      local: locationName(ctx, o.locationId),
      estado: STATUS[o.status] ?? o.status,
      entrega: o.expectedDate ? formatDay(o.expectedDate) : "sin fecha",
      retraso: late,
      importe: formatMoney(pendingValue),
    }));
    const pending = lines.filter((l) => l.o.status !== "draft");
    // Aviso proactivo: pedidos con retraso y borradores olvidados (más de un día sin enviar).
    const ageDays = (iso: string) => Math.floor((params.now.getTime() - new Date(iso).getTime()) / 86_400_000);
    const evalItems: EvalItem[] = lines
      .filter(({ o, late }) => late || (o.status === "draft" && ageDays(o.createdAt) >= 1))
      .map(({ o, pendingValue, late }) => ({
        kind: "pedido",
        key: `pedido:${o.id}`,
        locationId: o.locationId,
        data: {
          supplier: o.supplierName,
          venue: locationName(ctx, o.locationId),
          state: late ? "retrasado" : "borrador",
          age: `${ageDays(o.sentAt ?? o.createdAt)} días`,
          expected: o.expectedDate ? formatDay(o.expectedDate) : "sin fecha",
          value: formatMoney(pendingValue),
        },
      }));
    return finish("query_orders", rows, {
      pendientes: String(pending.length),
      borradores: String(lines.length - pending.length),
      retrasados: String(lines.filter((l) => l.late).length),
      valor_pendiente: formatMoney(pending.reduce((acc, l) => acc.plus(l.pendingValue), new Decimal(0))),
    }, evalItems);
  }

  /** Gasto en compras (recepciones contabilizadas) por proveedor en el periodo; 30 días si no se indica. */
  /**
   * «¿Qué es lo que más se gasta?»: productos ordenados por el valor consumido en el periodo (las
   * cantidades de productos distintos no se pueden comparar; el dinero sí), con su cantidad, su parte
   * del total, la media por día y el reparto por local.
   */
  private async topUsage(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const products = productMap(ctx);
    const today = dayOf(params.now);
    const from = params.period?.from ?? addDays(today, -29);
    const to = params.period?.to ?? today;
    const raw = await this.source.movements({
      locationIds: params.locationIds,
      productIds: params.productIds.length > 0 ? params.productIds : undefined,
      since: sinceIso(from),
    });
    const tz = new Map(ctx.locations.map((l) => [l.id, l]));
    const byProduct = new Map<string, { product: Product; qty: Decimal; value: Decimal; perLocation: Map<string, Decimal> }>();
    for (const m of raw) {
      if (m.type !== "consumption" || (params.areaId && m.areaId !== params.areaId)) continue;
      const loc = tz.get(m.locationId);
      const day = businessDay(new Date(m.occurredAt), loc?.timezone ?? "Europe/Madrid", loc?.dayCutoff ?? "06:00");
      if (day < from || day > to) continue;
      const product = products.get(m.productId);
      if (!product) continue;
      const qty = new Decimal(m.qty).abs();
      const entry = byProduct.get(m.productId) ?? { product, qty: new Decimal(0), value: new Decimal(0), perLocation: new Map<string, Decimal>() };
      entry.qty = entry.qty.plus(qty);
      entry.value = entry.value.plus(qty.mul(m.unitCost ?? 0));
      entry.perLocation.set(m.locationId, (entry.perLocation.get(m.locationId) ?? new Decimal(0)).plus(qty));
      byProduct.set(m.productId, entry);
    }
    const days = Math.max(1, daysInclusive(from, to));
    const total = [...byProduct.values()].reduce((acc, e) => acc.plus(e.value), new Decimal(0));
    const several = params.locationIds.length > 1;
    const rows: ToolRow[] = [...byProduct.values()]
      .sort((a, b) => b.value.cmp(a.value) || b.qty.cmp(a.qty))
      .map((e, i) => ({
        posicion: String(i + 1),
        producto: e.product.name,
        cantidad: formatStock(e.qty, e.product),
        valor: formatMoney(e.value),
        porcentaje: `${formatDecimal(pct(e.value, total) ?? new Decimal(0), 0)} %`,
        al_dia: formatStock(e.qty.div(days), e.product),
        desglose: several
          ? [...e.perLocation.entries()]
              .sort((a, b) => b[1].cmp(a[1]))
              .map(([id, q]) => `${tz.get(id)?.name ?? "Local"} ${formatStock(q, e.product)}`)
              .join(" · ")
          : null,
      }));
    return finish("query_top_usage", rows, { total: formatMoney(total), productos: String(rows.length), desde: formatDay(from), hasta: formatDay(to) }, [], 10);
  }

  private async spend(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    void ctx;
    const today = dayOf(params.now);
    const from = params.period?.from ?? addDays(today, -29);
    const to = params.period?.to ?? today;
    const raw = (await this.source.purchases({ locationIds: params.locationIds, since: from })).filter((p) => p.docDate <= to);
    const bySupplier = new Map<string, { total: Decimal; receipts: number }>();
    for (const p of raw) {
      const key = p.supplierName ?? "Sin proveedor";
      const entry = bySupplier.get(key) ?? { total: new Decimal(0), receipts: 0 };
      entry.total = entry.total.plus(p.total);
      entry.receipts += 1;
      bySupplier.set(key, entry);
    }
    const total = [...bySupplier.values()].reduce((acc, e) => acc.plus(e.total), new Decimal(0));
    const rows: ToolRow[] = [...bySupplier.entries()]
      .sort((a, b) => b[1].total.cmp(a[1].total))
      .map(([name, e]) => ({
        proveedor: name,
        albaranes: String(e.receipts),
        importe: formatMoney(e.total),
        porcentaje: `${formatDecimal(pct(e.total, total) ?? new Decimal(0), 1)} %`,
      }));
    return finish("query_spend", rows, { total: formatMoney(total), albaranes: String(raw.length), desde: formatDay(from), hasta: formatDay(to) });
  }

  private async stock(params: ToolParams, ctx: SessionContext): Promise<ToolResult> {
    const products = productMap(ctx);
    const productIds = params.productIds.length > 0 ? params.productIds : undefined;
    const [lps] = await Promise.all([this.source.locationProducts({ locationIds: params.locationIds, productIds })]);
    const minimums = new Map(lps.map((lp) => [`${lp.locationId}:${lp.productId}`, new Decimal(lp.minQty)]));

    type Line = { locationId: string; areaName: string | null; product: Product; qty: Decimal; value: Decimal; min: Decimal | null };
    const lines: Line[] = [];
    // «¿Qué hay en cada sección?»: stock de cada espacio de los locales consultados.
    const byArea = !params.areaId && params.byArea === true;
    if (byArea) {
      const areas = ctx.areas.filter((a) => params.locationIds.includes(a.locationId));
      const perArea = await Promise.all(areas.map(async (area) => ({ area, balances: await this.source.areaBalances(area.id, productIds) })));
      for (const { area, balances } of perArea) {
        for (const b of balances) {
          const product = products.get(b.productId);
          const qty = new Decimal(b.qty);
          if (!product || qty.isZero()) continue;
          lines.push({ locationId: area.locationId, areaName: area.name, product, qty, value: qty.mul(b.avgCost), min: null });
        }
      }
    } else if (params.areaId) {
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

    const totals = { productos: String(lines.length), valor_total: formatMoney(totalValue), bajo_minimo: String(belowMin.length) };

    if (byArea) {
      const order = new Map(ctx.areas.map((a, i) => [`${a.locationId}:${a.name}`, i]));
      const sorted = [...lines].sort((a, b) => (order.get(`${a.locationId}:${a.areaName}`) ?? 0) - (order.get(`${b.locationId}:${b.areaName}`) ?? 0) || b.value.cmp(a.value));
      // Todas las secciones, con sus productos de más valor (como mucho PER_AREA en cada una).
      const perArea = new Map<string, Line[]>();
      for (const l of sorted) perArea.set(`${l.locationId}:${l.areaName}`, [...(perArea.get(`${l.locationId}:${l.areaName}`) ?? []), l]);
      const rows: ToolRow[] = [...perArea.values()].flatMap((items) =>
        items.slice(0, PER_AREA).map((l) => ({
          producto: l.product.name,
          local: locationName(ctx, l.locationId),
          espacio: l.areaName,
          cantidad: formatStock(l.qty, l.product),
          valor: formatMoney(l.value),
          minimo: null,
          bajo_minimo: false,
          productos_espacio: String(items.length),
        })),
      );
      return finish("query_stock", rows, { ...totals, desglose: "espacio", espacios: String(perArea.size) }, [], MAX_AREA_ROWS);
    }

    // Varios locales: una fila por producto con el total y el reparto por local.
    if (!params.areaId && new Set(lines.map((l) => l.locationId)).size > 1) {
      const groups = new Map<string, { product: Product; qty: Decimal; value: Decimal; low: boolean; parts: Line[] }>();
      for (const l of lines) {
        const g = groups.get(l.product.id) ?? { product: l.product, qty: new Decimal(0), value: new Decimal(0), low: false, parts: [] };
        g.qty = g.qty.plus(l.qty);
        g.value = g.value.plus(l.value);
        g.low ||= l.min !== null && l.qty.lt(l.min);
        g.parts.push(l);
        groups.set(l.product.id, g);
      }
      const sorted = [...groups.values()].sort((a, b) => Number(b.low) - Number(a.low) || b.value.cmp(a.value) || a.product.name.localeCompare(b.product.name));
      const rows: ToolRow[] = sorted.map((g) => ({
        producto: g.product.name,
        local: null,
        espacio: null,
        cantidad: formatStock(g.qty, g.product),
        desglose: [...g.parts]
          .sort((a, b) => locationName(ctx, a.locationId).localeCompare(locationName(ctx, b.locationId)))
          .map((l) => `${locationName(ctx, l.locationId)} ${formatStock(l.qty, l.product)}${l.min !== null && l.qty.lt(l.min) ? " ⚠" : ""}`)
          .join(" · "),
        valor: formatMoney(g.value),
        minimo: null,
        bajo_minimo: g.low,
      }));
      return finish("query_stock", rows, { ...totals, productos: String(groups.size), desglose: "local" });
    }

    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product.name,
      local: locationName(ctx, l.locationId),
      espacio: l.areaName,
      cantidad: formatStock(l.qty, l.product),
      valor: formatMoney(l.value),
      minimo: l.min ? formatStock(l.min, l.product) : null,
      bajo_minimo: l.min !== null && l.qty.lt(l.min),
    }));
    return finish("query_stock", rows, totals);
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
      cantidad: formatStock(g.qty.abs(), g.product),
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
    // Se pide también el precio anterior al periodo para poder comparar. Con productos concretos
    // («precios de la Coca-Cola») vale el último precio conocido aunque sea de antes del periodo.
    const specific = params.productIds.length > 0;
    const raw = await this.source.prices(specific ? [...packs.keys()] : null, sinceIso(addDays(from, specific ? -LAST_PRICE_LOOKBACK_DAYS : -DEFAULT_LOOKBACK_DAYS)));
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
      if (!pack || (!specific && latest.recordedAt.slice(0, 10) < from)) continue;
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
    // Solo cuentan (y se valoran) las subidas dentro del periodo, no el último precio de hace meses.
    const rises = lines.filter((l) => l.change !== null && l.change.gt(0) && l.date >= from);
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
        expected: formatStock(l.expected, l.product!),
        counted: formatStock(l.r.countedQty, l.product!),
        diff: formatStock(l.diff, l.product!),
        diff_pct: l.diffPct ? `${formatDecimal(l.diffPct, 1)} %` : "sin stock teórico",
        diff_value: formatMoney(l.diffValue),
      },
    }));
    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product!.name,
      local: locationName(ctx, l.r.locationId),
      teorico: formatStock(l.expected, l.product!),
      contado: formatStock(l.r.countedQty, l.product!),
      diferencia: formatStock(l.diff, l.product!),
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
        stock: formatStock(l.qty, l.product!),
        minimum: formatStock(l.min, l.product!),
        avg_daily_use: formatStock(l.avg.toDecimalPlaces(2), l.product!),
        coverage_days: l.coverage ? formatDecimal(l.coverage, 1) : "sin consumo reciente",
        pending_in: formatStock(l.pendingIn, l.product!),
        suggested: formatStock(l.suggested.toDecimalPlaces(2), l.product!),
      },
    }));
    const rows: ToolRow[] = lines.map((l) => ({
      producto: l.product!.name,
      local: locationName(ctx, l.lp.locationId),
      stock: formatStock(l.qty, l.product!),
      minimo: formatStock(l.min, l.product!),
      consumo_diario: formatStock(l.avg.toDecimalPlaces(2), l.product!),
      dias_cobertura: l.coverage ? formatDecimal(l.coverage, 1) : null,
      en_camino: l.pendingIn.gt(0) ? formatStock(l.pendingIn, l.product!) : null,
      sugerido: formatStock(l.suggested.toDecimalPlaces(2), l.product!),
    }));
    return finish("query_reorder", rows, { productos: String(lines.length), horizonte: params.horizonLabel }, evalItems);
  }
}

function dayOf(now: Date): string {
  return businessDay(now, "Europe/Madrid", "06:00");
}
