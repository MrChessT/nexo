// Operaciones sobre documentos que ya existen: recibir o cancelar un traspaso; enviar, recibir o
// cancelar un pedido. Busca el documento (por local y, en pedidos, por proveedor si se nombra); si hay
// varios pregunta cuál, y si no hay ninguno lo dice. El borrador solo ejecuta tras la confirmación.
import Decimal from "decimal.js";
import type { DocumentDraft, NavigateEvent } from "../contract/index";
import type { DocumentPlan } from "../agent/interpret";
import { hasRole, type SessionContext } from "../domain";
import { mentionedSupplier } from "../entities/catalog-parser";
import { formatDecimal, formatStock } from "../entities/units";
import type { InventoryDataSource, OrderRaw, TransferRaw } from "../tools/types";
import { draftBase, type BuildResult } from "./builder";
import { validateDraft } from "./schemas";

export interface DocumentBuildInput {
  plan: DocumentPlan;
  message: string;
  ctx: SessionContext;
  source: InventoryDataSource;
  overrides: Record<string, string>;
  now: Date;
}

const TITLE: Record<DocumentDraft["operation"], string> = {
  recibir_traspaso: "Recibir traspaso",
  cancelar_traspaso: "Cancelar traspaso",
  enviar_pedido: "Enviar pedido",
  recibir_pedido: "Recibir pedido",
  cancelar_pedido: "Cancelar pedido",
};

/** Solo un encargado envía pedidos o cancela; recibir lo puede hacer cualquiera del local. */
const MANAGER_ONLY = new Set<DocumentDraft["operation"]>(["cancelar_traspaso", "enviar_pedido", "cancelar_pedido"]);

function locationName(ctx: SessionContext, id: string): string {
  return ctx.locations.find((l) => l.id === id)?.name ?? "local";
}

function ago(iso: string | null, now: Date): string {
  if (!iso) return "sin enviar";
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "enviado hoy" : days === 1 ? "enviado ayer" : `enviado hace ${days} días`;
}

function shortDate(day: string | null): string {
  return day ? `${day.slice(8, 10)}/${day.slice(5, 7)}` : "sin fecha";
}

export class DocumentDraftBuilder {
  async build({ plan, message, ctx, source, overrides, now }: DocumentBuildInput): Promise<BuildResult> {
    return plan.accion === "recibir_traspaso" || plan.accion === "cancelar_traspaso"
      ? this.transfer(plan, ctx, source, overrides, now)
      : this.order(plan, message, ctx, source, overrides, now);
  }

  private async transfer(plan: DocumentPlan, ctx: SessionContext, source: InventoryDataSource, overrides: Record<string, string>, now: Date): Promise<BuildResult> {
    const receiving = plan.accion === "recibir_traspaso";
    const all = await source.transfers({ locationIds: plan.locationIds, status: receiving ? ["in_transit"] : ["draft", "in_transit"] });
    const found = all.filter((t) => plan.locationIds.includes(t.fromLocationId) || plan.locationIds.includes(t.toLocationId));
    const where = plan.locationIds.length === 1 ? ` en ${locationName(ctx, plan.locationIds[0]!)}` : "";
    const describe = (t: TransferRaw) => `${locationName(ctx, t.fromLocationId)} → ${locationName(ctx, t.toLocationId)} · ${ago(t.sentAt, now)}`;
    const picked = pick(found, overrides.documento);
    if (!picked) {
      return found.length === 0
        ? { kind: "error", message: receiving ? `No hay traspasos pendientes de recibir${where}.` : `No hay traspasos que cancelar${where}.`, navigate: nav("/traspasos") }
        : clarify(receiving ? "¿Qué traspaso ha llegado?" : "¿Qué traspaso cancelo?", found.map((t) => ({ id: t.id, label: `${describe(t)} (${t.lines.length} ${t.lines.length === 1 ? "producto" : "productos"})` })));
    }
    const products = new Map(ctx.products.map((p) => [p.id, p]));
    const lines = picked.lines.map((l) => {
      const product = products.get(l.productId);
      return { label: product?.name ?? "Producto", qty: product ? formatStock(l.qtySent, product) : l.qtySent };
    });
    const warnings = picked.status === "in_transit" && !receiving ? ["Cancelarlo devuelve la mercancía al local de origen."] : [];
    return this.draft(plan, ctx, now, picked.id, receiving ? picked.toLocationId : picked.fromLocationId, `${TITLE[plan.accion]}: ${describe(picked)}`, describe(picked), lines, warnings);
  }

  private async order(plan: DocumentPlan, message: string, ctx: SessionContext, source: InventoryDataSource, overrides: Record<string, string>, now: Date): Promise<BuildResult> {
    const statuses: OrderRaw["status"][] = plan.accion === "enviar_pedido" ? ["draft"] : plan.accion === "recibir_pedido" ? ["sent", "partial"] : ["draft", "sent", "partial"];
    const supplier = mentionedSupplier(message, ctx.suppliers);
    const orders = (await source.orders({ locationIds: plan.locationIds, statuses })).filter((o) => !supplier || o.supplierName === supplier.name);
    const describe = (o: OrderRaw) => `${o.supplierName} · ${locationName(ctx, o.locationId)} · ${o.status === "draft" ? "sin enviar" : `entrega ${shortDate(o.expectedDate)}`}`;
    const picked = pick(orders, overrides.documento);
    if (!picked) {
      const whom = supplier ? ` de ${supplier.name}` : "";
      const none = plan.accion === "enviar_pedido" ? `No hay pedidos${whom} preparados sin enviar.` : plan.accion === "recibir_pedido" ? `No hay pedidos${whom} pendientes de recibir.` : `No hay pedidos${whom} que cancelar.`;
      return orders.length === 0
        ? { kind: "error", message: none, navigate: nav("/pedidos") }
        : clarify("¿Qué pedido?", orders.map((o) => ({ id: o.id, label: describe(o) })));
    }
    const products = new Map(ctx.products.map((p) => [p.id, p]));
    const pending = picked.lines
      .map((l) => ({ ...l, left: Decimal.max(0, new Decimal(l.packsQty).minus(l.receivedPacks)) }))
      .filter((l) => plan.accion !== "recibir_pedido" || l.left.gt(0));
    const lines = pending.map((l) => ({
      label: products.get(l.productId)?.name ?? "Producto",
      qty: `${formatDecimal(plan.accion === "recibir_pedido" ? l.left : l.packsQty, 2)} × ${l.packName || "formato"}`,
    }));
    const warnings: string[] = [];
    let receive: DocumentDraft["receive"];
    if (plan.accion === "recibir_pedido") {
      receive = pending.filter((l) => l.packId).map((l) => ({ packId: l.packId!, packsQty: l.left.toString(), packPrice: l.packPrice }));
      warnings.push("Se recibe todo lo pendiente al precio del pedido. Si llegó otra cantidad, ajústalo en Pedidos.");
      if (receive.length === 0) return { kind: "error", message: "Ese pedido no tiene nada pendiente de recibir.", navigate: nav("/pedidos") };
    }
    return this.draft(plan, ctx, now, picked.id, picked.locationId, `${TITLE[plan.accion]}: ${describe(picked)}`, describe(picked), lines, warnings, receive);
  }

  private draft(
    plan: DocumentPlan,
    ctx: SessionContext,
    now: Date,
    documentId: string,
    locationId: string,
    title: string,
    summary: string,
    lines: DocumentDraft["lines"],
    warnings: string[],
    receive?: DocumentDraft["receive"],
  ): BuildResult {
    const base = draftBase("documento", title, ctx, warnings, now);
    const requiredRole: DocumentDraft["requiredRole"] = MANAGER_ONLY.has(plan.accion) ? "manager" : base.requiredRole;
    const draft: DocumentDraft = {
      ...base,
      requiredRole,
      canConfirm: hasRole(ctx.role, requiredRole),
      kind: "documento",
      operation: plan.accion,
      documentId,
      locationId,
      summary,
      lines,
      ...(receive ? { receive } : {}),
    };
    return { kind: "draft", draft: validateDraft(draft), summary: { operation: TITLE[plan.accion].toLowerCase(), document: summary, lines: lines.map((l) => `${l.label}: ${l.qty}`).join("; ") } };
  }
}

/** El documento elegido en una aclaración o, si solo hay uno, ese. */
function pick<T extends { id: string }>(list: T[], chosen: string | undefined): T | undefined {
  if (chosen) return list.find((d) => d.id === chosen);
  return list.length === 1 ? list[0] : undefined;
}

function clarify(question: string, options: Array<{ id: string; label: string }>): BuildResult {
  return { kind: "clarify", plan: { type: "clarify", field: "documento", question, options: options.slice(0, 5).map((o) => ({ ...o, probability: null })) } };
}

function nav(route: NavigateEvent["route"]): NavigateEvent {
  return { route, filters: {}, auto: false };
}
