// Plan de acción → borrador validado. Todo cálculo con decimal.js; el borrador no ejecuta nada:
// se guarda en el servidor y solo se ejecuta con /actions/confirm tras el clic del usuario.
import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import type { CountCloseDraft, CountDraft, Draft, ReceiptDraft, Role, TransferDraft, WasteDraft } from "../contract/index";
import { hasRole, type Pack, type Product, type SessionContext } from "../domain";
import { formatDecimal, formatMoney, formatStock, toBase, unitReadings } from "../entities/units";
import type { ActionPlan, CatalogPlan, ClarifyPlan, DocumentPlan, ResolvedProduct } from "../agent/interpret";
import { DocumentDraftBuilder } from "./document-builder";
import type { NavigateEvent } from "../contract/index";
import { CatalogDraftBuilder, type Review } from "./catalog-builder";
import { label } from "../jev/catalog";
import { businessDay } from "../tools/periods";
import type { InventoryDataSource } from "../tools/types";
import { validateDraft } from "./schemas";

export const DRAFT_TTL_MS = 15 * 60 * 1000;

export type BuildResult =
  | { kind: "draft"; draft: Draft; summary: Record<string, string>; review?: Review }
  | { kind: "clarify"; plan: ClarifyPlan }
  | { kind: "error"; message: string; navigate?: NavigateEvent };

const REQUIRED_ROLE: Record<Draft["kind"], Role> = {
  merma: "staff",
  traspaso: "staff",
  recepcion: "staff",
  cierre_inventario: "manager",
  // El catálogo solo lo cambian encargados o superiores (lo exige también RLS).
  precio: "manager",
  producto_nuevo: "manager",
  minimo: "manager",
  archivar: "manager",
  // Un pedido se crea en borrador: cualquiera del local puede prepararlo; enviarlo es de encargado.
  pedido: "staff",
  // Recibir lo puede hacer cualquiera del local; enviar un pedido o cancelar, un encargado (ver DocumentBuilder).
  documento: "staff",
  conteo: "staff",
};

const EDITABLE: Record<Draft["kind"], string[]> = {
  merma: ["qtyBase", "reason", "areaId", "acknowledged"],
  traspaso: ["lines.*.qtyBase", "send", "note", "acknowledged"],
  recepcion: ["lines.*.packsQty", "lines.*.packPrice", "supplierId", "docNumber", "docDate", "acknowledged"],
  cierre_inventario: ["zeroUncounted", "asConsumption", "acknowledged"],
  precio: ["newPrice", "acknowledged"],
  producto_nuevo: ["name", "categoryId", "dimension", "packName", "packQtyBase", "price", "acknowledged"],
  minimo: ["newValue", "acknowledged"],
  archivar: ["acknowledged"],
  pedido: ["orders.*.lines.*.packsQty", "acknowledged"],
  documento: ["acknowledged"],
  conteo: ["acknowledged"],
};

/** Cabecera común de cualquier borrador (id, rol, caducidad, campos editables). */
export function draftBase<K extends Draft["kind"]>(kind: K, title: string, ctx: SessionContext, warnings: string[], now: Date) {
  const requiredRole = REQUIRED_ROLE[kind];
  return {
    draftId: randomUUID(),
    kind,
    title,
    requiredRole,
    canConfirm: hasRole(ctx.role, requiredRole),
    coherence: 0,
    warnings,
    editable: EDITABLE[kind],
    expiresAt: new Date(now.getTime() + DRAFT_TTL_MS).toISOString(),
  };
}

export interface Quantity {
  qtyBase: Decimal;
  pack: Pack | null;
  input: { amount: string; unit: string; packId?: string };
  warnings: string[];
}

function locationName(ctx: SessionContext, id: string): string {
  return ctx.locations.find((l) => l.id === id)?.name ?? "local";
}

/** «2 × Botella 70 cl», «3 × Caja 24» o, sin formato, como se cuenta («6 ud», «1,5 kg»). Sin ml. */
function describeInput(q: Quantity, product: Product): string {
  return q.pack ? `${formatDecimal(q.input.amount, 4)} × ${q.pack.name}` : formatStock(q.qtyBase, product);
}

export interface BuildInput {
  plan: ActionPlan;
  /** Mensaje del usuario: las acciones de catálogo extraen de él nombre, precio y cantidades. */
  message?: string;
  ctx: SessionContext;
  source: InventoryDataSource;
  overrides: Record<string, string>;
  now: Date;
}

export class DraftBuilder {
  readonly #catalog = new CatalogDraftBuilder();
  readonly #documents = new DocumentDraftBuilder();

  async build(input: BuildInput | (Omit<BuildInput, "plan"> & { plan: CatalogPlan }) | (Omit<BuildInput, "plan"> & { plan: DocumentPlan })): Promise<BuildResult> {
    if (input.plan.type === "catalogo") return this.#catalog.build({ ...input, plan: input.plan, message: input.message ?? "" });
    if (input.plan.type === "documento") return this.#documents.build({ ...input, plan: input.plan, message: input.message ?? "" });
    const stock = input as BuildInput;
    switch (stock.plan.accion) {
      case "merma":
        return this.waste(stock);
      case "traspaso":
        return this.transfer(stock);
      case "recepcion":
        return this.receipt(stock);
      case "cierre_inventario":
        return this.countClose(stock);
      case "abrir_inventario":
        return this.countOpen(stock);
      case "anotar_conteo":
        return this.countLines(stock);
    }
  }

  private quantity(p: ResolvedProduct, overrides: Record<string, string>): Quantity | ClarifyPlan {
    return resolveQuantity(p, overrides);
  }

  private base(kind: Draft["kind"], title: string, ctx: SessionContext, warnings: string[], now: Date) {
    return draftBase(kind, title, ctx, warnings, now);
  }

  private async stockWarning(source: InventoryDataSource, locationId: string, product: Product, qty: Decimal): Promise<string | null> {
    const [balance] = await source.balances({ locationIds: [locationId], productIds: [product.id] });
    const available = new Decimal(balance?.qty ?? 0);
    return qty.gt(available) ? `Solo constan ${formatStock(available, product)} de ${product.name} en stock.` : null;
  }

  private async waste({ plan, ctx, source, overrides, now }: BuildInput): Promise<BuildResult> {
    const [p, ...rest] = plan.products;
    if (!p) return { kind: "error", message: "No sé qué producto dar de baja." };
    const q = this.quantity(p, overrides);
    if ("type" in q) return { kind: "clarify", plan: q };

    const warnings = [...q.warnings];
    if (rest.length > 0) warnings.push("Solo preparo una merma por mensaje; registra el resto por separado.");
    if (plan.locationOutcome === "confirmar") warnings.push("Revisa el local.");
    const stock = await this.stockWarning(source, plan.locationId, p.product, q.qtyBase);
    if (stock) warnings.push(stock);

    const area = plan.areaId ? ctx.areas.find((a) => a.id === plan.areaId) ?? null : null;
    const reason = plan.motivo === "no_indicado" ? null : label(plan.motivo).toLowerCase();
    const where = `${locationName(ctx, plan.locationId)}${area ? ` · ${area.name}` : ""}`;
    const draft: WasteDraft = {
      ...this.base("merma", `Merma: ${describeInput(q, p.product)} de ${p.product.name} en ${where}`, ctx, warnings, now),
      kind: "merma",
      locationId: plan.locationId,
      locationName: locationName(ctx, plan.locationId),
      areaId: area?.id ?? null,
      areaName: area?.name ?? null,
      productId: p.product.id,
      productName: p.product.name,
      qtyBase: q.qtyBase.toString(),
      baseUnit: p.product.baseUnit,
      input: q.input,
      reason,
    };
    return {
      kind: "draft",
      draft: validateDraft(draft),
      summary: { operation: "write off (merma)", product: p.product.name, quantity: describeInput(q, p.product), venue: where, reason: reason ?? "not stated" },
    };
  }

  private async transfer({ plan, ctx, source, overrides, now }: BuildInput): Promise<BuildResult> {
    const toLocationId = plan.toLocationId!;
    const lines: TransferDraft["lines"] = [];
    const warnings: string[] = [];
    const described: string[] = [];
    for (const p of plan.products) {
      const q = this.quantity(p, overrides);
      if ("type" in q) return { kind: "clarify", plan: q };
      warnings.push(...q.warnings);
      const stock = await this.stockWarning(source, plan.locationId, p.product, q.qtyBase);
      if (stock) warnings.push(stock);
      const existing = lines.find((l) => l.productId === p.product.id);
      if (existing) {
        existing.qtyBase = new Decimal(existing.qtyBase).plus(q.qtyBase).toString();
      } else {
        lines.push({ productId: p.product.id, productName: p.product.name, qtyBase: q.qtyBase.toString(), baseUnit: p.product.baseUnit, input: q.input });
      }
      described.push(`${describeInput(q, p.product)} de ${p.product.name}`);
    }
    if (plan.locationOutcome === "confirmar") warnings.push("Revisa el local de origen.");
    if (plan.toLocationOutcome === "confirmar") warnings.push("Revisa el local de destino.");
    const canSend = hasRole(ctx.role, "manager");
    if (!canSend) warnings.push("Se guardará como borrador: enviarlo requiere rol de encargado.");

    const from = locationName(ctx, plan.locationId);
    const to = locationName(ctx, toLocationId);
    const draft: TransferDraft = {
      ...this.base("traspaso", `Traspaso ${from} → ${to}: ${described.join(", ")}`, ctx, warnings, now),
      kind: "traspaso",
      fromLocationId: plan.locationId,
      fromLocationName: from,
      toLocationId,
      toLocationName: to,
      lines,
      send: canSend,
      note: null,
    };
    return {
      kind: "draft",
      draft: validateDraft(draft),
      summary: { operation: "transfer between venues", from, to, lines: described.join("; ") },
    };
  }

  private async receipt({ plan, ctx, source, overrides, now }: BuildInput): Promise<BuildResult> {
    const warnings: string[] = [];
    const lines: ReceiptDraft["lines"] = [];
    const described: string[] = [];
    for (const p of plan.products) {
      const q = this.quantity(p, overrides);
      if ("type" in q) return { kind: "clarify", plan: q };
      warnings.push(...q.warnings);
      // Las recepciones van por formato de compra.
      let pack = q.pack;
      let packsQty = pack ? new Decimal(q.input.amount) : null;
      if (!pack) {
        pack = p.product.packs.find((k) => k.isPurchaseDefault) ?? (p.product.packs.length === 1 ? p.product.packs[0]! : null);
        if (!pack) return { kind: "error", message: `${p.product.name} no tiene un formato de compra definido. Regístralo en Recepciones.` };
        packsQty = q.qtyBase.div(pack.qtyBase);
        if (!packsQty.isInteger()) warnings.push(`${formatDecimal(packsQty, 4)} × ${pack.name} de ${p.product.name}: no es un número entero de formatos.`);
      }
      lines.push({
        packId: pack.id,
        packName: pack.name,
        productId: p.product.id,
        productName: p.product.name,
        packsQty: packsQty!.toString(),
        packPrice: p.price,
        priceSource: p.price ? "usuario" : null,
      });
      described.push(`${formatDecimal(packsQty!, 4)} × ${pack.name} de ${p.product.name}`);
    }

    // Precio y proveedor por defecto: el último precio de compra de cada formato.
    const prices = await source.supplierPrices(lines.filter((l) => !l.packPrice).map((l) => l.packId));
    const suppliers = new Set<string>();
    for (const line of lines) {
      if (line.packPrice) continue;
      const last = prices.find((p) => p.packId === line.packId);
      if (last) {
        line.packPrice = new Decimal(last.lastPrice).toString();
        line.priceSource = "ultimo_precio";
        suppliers.add(`${last.supplierId}|${last.supplierName}`);
        warnings.push(`Precio de ${line.productName} tomado del último albarán (${formatMoney(last.lastPrice)}); revísalo.`);
      } else {
        warnings.push(`Falta el precio de ${line.productName}.`);
      }
    }
    const [onlySupplier] = suppliers.size === 1 ? [...suppliers] : [];
    const [supplierId, supplierName] = onlySupplier ? onlySupplier.split("|") : [null, null];
    if (supplierId) warnings.push(`Proveedor según el último precio: ${supplierName}.`);
    if (plan.locationOutcome === "confirmar") warnings.push("Revisa el local.");

    const location = ctx.locations.find((l) => l.id === plan.locationId);
    const draft: ReceiptDraft = {
      ...this.base("recepcion", `Recepción en ${locationName(ctx, plan.locationId)}: ${described.join(", ")}`, ctx, warnings, now),
      kind: "recepcion",
      locationId: plan.locationId,
      locationName: locationName(ctx, plan.locationId),
      supplierId: supplierId ?? null,
      supplierName: supplierName ?? null,
      docNumber: null,
      docDate: businessDay(now, location?.timezone ?? "Europe/Madrid", "00:00"),
      lines,
    };
    return {
      kind: "draft",
      draft: validateDraft(draft),
      summary: { operation: "goods receipt from a supplier", venue: locationName(ctx, plan.locationId), lines: described.join("; ") },
    };
  }

  /** Abrir inventario: uno por local; si ya hay uno abierto, se dice y se explica cómo apuntar. */
  private async countOpen({ plan, ctx, source, now }: BuildInput): Promise<BuildResult> {
    const name = locationName(ctx, plan.locationId);
    const open = await source.openCount(plan.locationId);
    if (open) {
      const counted = new Set(open.lines.map((l) => l.productId)).size;
      return { kind: "error", message: `Ya hay un inventario abierto en ${name} (${counted} ${counted === 1 ? "producto contado" : "productos contados"}). Ve apuntando: «en la barra hay 5 botellas de Beefeater».`, navigate: { route: "/inventarios", filters: { locationId: plan.locationId }, auto: false } };
    }
    const warnings = plan.locationOutcome === "confirmar" ? ["Revisa el local."] : [];
    const draft: CountDraft = {
      ...this.base("conteo", `Abrir inventario en ${name}`, ctx, warnings, now),
      kind: "conteo",
      operation: "abrir",
      locationId: plan.locationId,
      locationName: name,
      countId: null,
      areaId: null,
      areaName: null,
      lines: [],
    };
    return { kind: "draft", draft: validateDraft(draft), summary: { operation: "start a stock count", venue: name } };
  }

  /** Apuntar lo contado en el inventario abierto del local (se suma a lo ya contado de ese producto). */
  private async countLines({ plan, ctx, source, overrides, now }: BuildInput): Promise<BuildResult> {
    const name = locationName(ctx, plan.locationId);
    const open = await source.openCount(plan.locationId);
    if (!open) {
      return { kind: "error", message: `No hay ningún inventario abierto en ${name}. Dime «empieza el inventario de ${name}» para abrirlo.`, navigate: { route: "/inventarios", filters: { locationId: plan.locationId }, auto: false } };
    }
    const area = plan.areaId ? ctx.areas.find((a) => a.id === plan.areaId) ?? null : null;
    const warnings: string[] = [];
    const lines: CountDraft["lines"] = [];
    for (const p of plan.products) {
      const q = this.quantity(p, overrides);
      if ("type" in q) return { kind: "clarify", plan: q };
      warnings.push(...q.warnings);
      const before = open.lines.filter((l) => l.productId === p.product.id).reduce((a, l) => a.plus(l.qty), new Decimal(0));
      if (before.gt(0)) warnings.push(`${p.product.name} ya tenía ${formatStock(before, p.product)} contado: se suma.`);
      lines.push({ productId: p.product.id, productName: p.product.name, qtyBase: q.qtyBase.toString(), baseUnit: p.product.baseUnit, input: q.input, text: describeInput(q, p.product) });
    }
    if (plan.locationOutcome === "confirmar") warnings.push("Revisa el local.");
    const where = `${name}${area ? ` · ${area.name}` : ""}`;
    const draft: CountDraft = {
      ...this.base("conteo", `Contado en ${where}: ${lines.map((l) => `${l.text} de ${l.productName}`).join(", ")}`, ctx, warnings, now),
      kind: "conteo",
      operation: "anotar",
      locationId: plan.locationId,
      locationName: name,
      countId: open.id,
      areaId: area?.id ?? null,
      areaName: area?.name ?? null,
      lines,
    };
    return { kind: "draft", draft: validateDraft(draft), summary: { operation: "record counted quantities in the open stock count", venue: where, lines: lines.map((l) => `${l.text} of ${l.productName}`).join("; ") } };
  }

  private async countClose({ plan, ctx, source, now }: BuildInput): Promise<BuildResult> {
    const name = locationName(ctx, plan.locationId);
    const count = await source.openCount(plan.locationId);
    if (!count) return { kind: "error", message: `No hay ningún inventario abierto en ${name}.` };
    const counted = new Map<string, Decimal>();
    for (const line of count.lines) counted.set(line.productId, (counted.get(line.productId) ?? new Decimal(0)).plus(line.qty));
    const productIds = [...counted.keys()];
    const balances = await source.balances({ locationIds: [plan.locationId], productIds });
    const byProduct = new Map(balances.map((b) => [b.productId, b]));
    const products = new Map(ctx.products.map((p) => [p.id, p]));

    const adjustments: CountCloseDraft["preview"]["adjustments"] = [];
    let total = new Decimal(0);
    for (const [productId, qty] of counted) {
      const product = products.get(productId);
      const balance = byProduct.get(productId);
      const expected = new Decimal(balance?.qty ?? 0);
      const diff = qty.minus(expected);
      const diffValue = diff.mul(balance?.avgCost ?? 0).toDecimalPlaces(2);
      total = total.plus(diffValue);
      if (diff.isZero()) continue;
      adjustments.push({
        productId,
        productName: product?.name ?? "producto",
        expected: expected.toString(),
        counted: qty.toString(),
        diff: diff.toString(),
        baseUnit: product?.baseUnit ?? "ud",
        diffValue: diffValue.toString(),
        ...(product ? { expectedText: formatStock(expected, product), countedText: formatStock(qty, product), diffText: formatStock(diff, product) } : {}),
      });
    }
    const warnings = ["Los productos no contados se quedan como están (no se ponen a cero)."];
    if (plan.locationOutcome === "confirmar") warnings.push("Revisa el local.");
    const draft: CountCloseDraft = {
      ...this.base("cierre_inventario", `Cerrar inventario de ${name}: ${adjustments.length} ajustes, ${formatMoney(total)}`, ctx, warnings, now),
      kind: "cierre_inventario",
      countId: count.id,
      locationId: plan.locationId,
      locationName: name,
      zeroUncounted: false,
      // En un bar sin TPV, lo que falta al contar es lo que se ha servido: consumo real.
      asConsumption: true,
      preview: { countedProducts: counted.size, adjustments, totalDiffValue: total.toString() },
    };
    return {
      kind: "draft",
      draft: validateDraft(draft),
      summary: { operation: "close the open stock count and apply its differences", venue: name, adjustments: String(adjustments.length), total_value: formatMoney(total) },
    };
  }
}

/** Opción «unidades sueltas» de la pregunta de formato (productos que se cuentan por unidades). */
export const BASE_PACK = "base";

/**
 * Cantidad en unidad base. Si el formato es ambiguo o incompatible, devuelve una aclaración. Sin
 * unidad («5 de ron») y con más de una lectura posible (botellas o cajas) también se pregunta.
 */
export function resolveQuantity(p: ResolvedProduct, overrides: Record<string, string>): Quantity | ClarifyPlan {
  const packOverride = overrides[`unidad_${p.segmentIndex}`];
  const warnings: string[] = [];
  if (p.productOutcome === "confirmar") warnings.push(`Revisa el producto: ${p.product.name}.`);
  if (p.quantityOutcome === "confirmar") warnings.push(`Revisa la cantidad de ${p.product.name}.`);

  if (packOverride && p.amount) {
    if (packOverride === BASE_PACK) {
      return { qtyBase: new Decimal(p.amount), pack: null, input: { amount: p.amount, unit: p.product.baseUnit }, warnings };
    }
    const pack = p.product.packs.find((k) => k.id === packOverride);
    if (pack) {
      return { qtyBase: new Decimal(p.amount).mul(pack.qtyBase), pack, input: { amount: p.amount, unit: pack.name, packId: pack.id }, warnings };
    }
  }
  if (p.unit === null && p.amount !== null) {
    const readings = unitReadings(p.product);
    if (readings.length > 1) {
      return {
        type: "clarify",
        field: "cantidad",
        question: `¿En qué formato son las ${formatDecimal(p.amount, 4)} de ${p.product.name}?`,
        options: readings.slice(0, 4).map((k) => (k === BASE_PACK ? { id: `pack:${BASE_PACK}`, label: "Unidades sueltas", probability: null } : { id: `pack:${k.id}`, label: k.name, probability: null })),
        segmentIndex: p.segmentIndex,
      };
    }
  }
  const result = toBase(p.amount!, p.unit, p.product);
  if (result.ok) {
    if (result.assumed) warnings.push(`He supuesto ${result.pack ? `el formato «${result.pack.name}»` : `la unidad ${p.product.baseUnit}`} para ${p.product.name}.`);
    return {
      qtyBase: result.qtyBase,
      pack: result.pack,
      input: { amount: p.amount!, unit: result.pack?.name ?? p.unit ?? p.product.baseUnit, ...(result.pack ? { packId: result.pack.id } : {}) },
      warnings,
    };
  }
  if (result.reason === "ambiguous_pack") {
    return {
      type: "clarify",
      field: "cantidad",
      question: `¿En qué formato son las ${p.amount} ${p.unit ?? "unidades"} de ${p.product.name}?`,
      options: result.options.slice(0, 3).map((k) => ({ id: `pack:${k.id}`, label: k.name, probability: null })),
      segmentIndex: p.segmentIndex,
    };
  }
  const why = result.reason === "incompatible" ? `${p.product.name} se mide en ${p.product.baseUnit}` : "no reconozco la unidad";
  return { type: "clarify", field: "cantidad", question: `¿Qué cantidad de ${p.product.name}? (${why})`, options: [], segmentIndex: p.segmentIndex };
}
