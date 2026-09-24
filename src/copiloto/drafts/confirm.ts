// POST /actions/confirm: ejecuta un borrador guardado tras el clic del usuario.
// Comprueba dueño, caducidad, rol y ediciones; luego llama a las RPC con el JWT del usuario.
import Decimal from "decimal.js";
import { z } from "zod";
import type { AuditSink } from "../audit/audit";
import type { AppRoute, Draft, NavigateEvent } from "../contract/index";
import { hasRole, type SessionContext } from "../domain";
import { LruCache } from "../cache/lru";
import { applyEdits, EditError } from "./schemas";
import type { DraftStore } from "./store";
import { RpcError, type InventoryWriter, type RpcErrorCode } from "./writer-port";

export const ConfirmRequest = z.object({
  orgId: z.uuid(),
  draftId: z.uuid(),
  idempotencyKey: z.uuid(),
  edits: z.record(z.string().max(60), z.union([z.string().max(300), z.boolean(), z.null()])).optional(),
});
export type ConfirmRequest = z.infer<typeof ConfirmRequest>;

export type ConfirmErrorCode = "draft_not_found" | "draft_expired" | "invalid_edit" | RpcErrorCode;

export type ConfirmResponse =
  | { ok: true; kind: Draft["kind"]; documentId: string | null; movementIds: string[]; message: string; navigate?: NavigateEvent }
  | { ok: false; code: ConfirmErrorCode; message: string };

const ROUTE: Record<Draft["kind"], AppRoute> = {
  merma: "/mermas",
  traspaso: "/traspasos",
  recepcion: "/recepciones",
  cierre_inventario: "/inventarios",
  precio: "/productos",
  producto_nuevo: "/productos",
  minimo: "/stock",
  archivar: "/productos",
  pedido: "/pedidos",
  documento: "/pedidos",
  conteo: "/inventarios",
};

/** Mensajes en español de los códigos de las RPC. */
const RPC_MESSAGES: Record<RpcErrorCode, string> = {
  unauthenticated: "Tu sesión ha caducado. Vuelve a iniciar sesión.",
  forbidden: "No tienes permisos para realizar esta acción.",
  not_found: "No hemos encontrado el documento solicitado.",
  invalid_status: "El documento ya no está en un estado editable.",
  empty_transfer: "Añade al menos un producto al traspaso.",
  empty_receipt: "Añade al menos una línea al albarán.",
  type_not_allowed: "Este tipo de movimiento no está disponible aquí.",
  invalid_quantity: "La cantidad recibida no puede ser negativa ni superar la cantidad enviada.",
  cross_organization_link: "Los datos pertenecen a otra organización.",
  cross_location_link: "La zona no pertenece al local seleccionado.",
  duplicate: "Ya existe un producto con ese nombre en el catálogo.",
  internal: "No se ha podido completar la operación. Inténtalo de nuevo.",
};

export class ConfirmService {
  readonly #results = new LruCache<ConfirmResponse>(10_000, 24 * 60 * 60 * 1000);

  constructor(
    private readonly drafts: DraftStore,
    private readonly audit: AuditSink,
    private readonly now: () => Date = () => new Date(),
  ) {}

  /**
   * @param drafts Almacén de la petición (Supabase con el JWT del usuario en producción).
   */
  async confirm(
    req: ConfirmRequest,
    ctx: SessionContext,
    writer: InventoryWriter,
    audit: AuditSink = this.audit,
    drafts: DraftStore = this.drafts,
  ): Promise<ConfirmResponse> {
    const idemKey = `${ctx.userId}:${req.idempotencyKey}`;
    const previous = this.#results.get(idemKey);
    if (previous) return previous;

    const stored = await drafts.get(req.draftId, ctx.userId, req.orgId);
    // Mismo clic repetido (otra instancia, reintento de red): mismo resultado.
    if (stored?.status === "confirmado" && stored.idempotencyKey === req.idempotencyKey && stored.result) return stored.result;
    if (!stored || stored.status === "confirmado") {
      return { ok: false, code: "draft_not_found", message: "Este borrador ya no existe o ya se confirmó. Vuelve a pedírmelo." };
    }
    if (new Date(stored.draft.expiresAt).getTime() < this.now().getTime()) {
      drafts.delete(req.draftId);
      return { ok: false, code: "draft_expired", message: "El borrador ha caducado. Vuelve a pedírmelo." };
    }

    let draft: Draft;
    try {
      draft = req.edits && Object.keys(req.edits).length > 0 ? applyEdits(stored.draft, req.edits, ctx) : stored.draft;
    } catch (err) {
      return { ok: false, code: "invalid_edit", message: err instanceof EditError ? err.message : "Edición no válida" };
    }
    if (!hasRole(ctx.role, draft.requiredRole)) {
      return { ok: false, code: "forbidden", message: RPC_MESSAGES.forbidden };
    }
    // Si alguna comprobación exige revisión, el usuario tiene que haberla marcado.
    if (draft.checks?.some((c) => c.status === "revisar") && !draft.acknowledged) {
      return { ok: false, code: "invalid_edit", message: "Marca «He revisado los avisos» para confirmar." };
    }
    if (draft.kind === "recepcion" && draft.lines.some((l) => l.packPrice === null)) {
      return { ok: false, code: "invalid_edit", message: "Falta el precio de alguna línea." };
    }
    if (!(await drafts.claim(req.draftId))) {
      return { ok: false, code: "invalid_status", message: "Este borrador se está confirmando." };
    }

    let result: ConfirmResponse;
    try {
      result = await this.execute(draft, ctx, writer, req.idempotencyKey);
    } catch (err) {
      const code: RpcErrorCode = err instanceof RpcError ? err.code : "internal";
      result = { ok: false, code, message: RPC_MESSAGES[code] };
    }
    // Si falla, el borrador vuelve a estar disponible para otro intento.
    await drafts.finish(req.draftId, result.ok ? "confirmado" : "pendiente", result, req.idempotencyKey).catch(() => undefined);

    this.#results.set(idemKey, result);
    await audit
      .record({
        type: "confirmacion",
        at: this.now().toISOString(),
        userId: ctx.userId,
        orgId: ctx.orgId,
        draftId: draft.draftId,
        kind: draft.kind,
        ok: result.ok,
        ...(result.ok ? {} : { code: result.code }),
      })
      .catch(() => undefined);
    return result;
  }

  private async execute(draft: Draft, ctx: SessionContext, writer: InventoryWriter, idempotencyKey: string): Promise<ConfirmResponse> {
    const navigate = (filters: NavigateEvent["filters"]): NavigateEvent => ({ route: ROUTE[draft.kind], filters, auto: false });
    switch (draft.kind) {
      case "merma": {
        const { movementId } = await writer.registerWaste({
          locationId: draft.locationId,
          productId: draft.productId,
          qtyBase: draft.qtyBase,
          reason: draft.reason,
          areaId: draft.areaId,
          clientRef: idempotencyKey,
        });
        return { ok: true, kind: "merma", documentId: null, movementIds: [movementId], message: "Merma registrada.", navigate: navigate({ locationId: draft.locationId }) };
      }
      case "traspaso": {
        const { transferId } = await writer.createTransfer({
          orgId: ctx.orgId,
          fromLocationId: draft.fromLocationId,
          toLocationId: draft.toLocationId,
          note: draft.note,
          lines: draft.lines.map((l) => ({ productId: l.productId, qtySent: l.qtyBase })),
        });
        if (draft.send) {
          try {
            await writer.sendTransfer(transferId);
          } catch (err) {
            // Sin restos: si no se puede enviar, se borra el borrador recién creado.
            await writer.deleteDraftTransfer(transferId).catch(() => undefined);
            throw err;
          }
        }
        return {
          ok: true,
          kind: "traspaso",
          documentId: transferId,
          movementIds: [],
          message: draft.send ? "Traspaso enviado." : "Traspaso guardado como borrador.",
          navigate: navigate({ status: draft.send ? "in_transit" : "draft" }),
        };
      }
      case "recepcion": {
        const { receiptId } = await writer.createReceipt({
          orgId: ctx.orgId,
          locationId: draft.locationId,
          supplierId: draft.supplierId,
          docNumber: draft.docNumber,
          docDate: draft.docDate,
          lines: draft.lines.map((l) => ({ packId: l.packId, packsQty: l.packsQty, packPrice: l.packPrice! })),
        });
        try {
          await writer.postReceipt(receiptId);
        } catch (err) {
          await writer.deleteOpenReceipt(receiptId).catch(() => undefined);
          throw err;
        }
        return { ok: true, kind: "recepcion", documentId: receiptId, movementIds: [], message: "Recepción registrada y stock actualizado.", navigate: navigate({ locationId: draft.locationId }) };
      }
      case "cierre_inventario": {
        await writer.closeCount(draft.countId, draft.zeroUncounted, draft.asConsumption);
        return { ok: true, kind: "cierre_inventario", documentId: draft.countId, movementIds: [], message: "Inventario cerrado y ajustes aplicados.", navigate: navigate({ locationId: draft.locationId }) };
      }
      case "precio": {
        await writer.setSupplierPrice({ supplierId: draft.supplierId, packId: draft.packId, price: draft.newPrice });
        return { ok: true, kind: "precio", documentId: draft.productId, movementIds: [], message: `Precio actualizado: ${draft.packName} de ${draft.productName} con ${draft.supplierName}.`, navigate: navigate({ productId: draft.productId }) };
      }
      case "producto_nuevo": {
        const { productId } = await writer.createProduct({
          orgId: ctx.orgId,
          name: draft.name.trim(),
          dimension: draft.dimension,
          categoryId: draft.categoryId,
          pack: draft.packName && draft.packQtyBase ? { name: draft.packName, qtyBase: draft.packQtyBase } : null,
          supplierId: draft.supplierId,
          price: draft.price,
          locationIds: draft.locationIds,
        });
        return { ok: true, kind: "producto_nuevo", documentId: productId, movementIds: [], message: `«${draft.name.trim()}» creado en el catálogo.`, navigate: navigate({ productId }) };
      }
      case "minimo": {
        await writer.setLocationLevel({ locationId: draft.locationId, productId: draft.productId, field: draft.field, value: draft.newValue });
        return { ok: true, kind: "minimo", documentId: draft.productId, movementIds: [], message: `${draft.field === "min_qty" ? "Mínimo" : "Objetivo"} de ${draft.productName} en ${draft.locationName} actualizado.`, navigate: navigate({ locationId: draft.locationId }) };
      }
      case "pedido": {
        const orders = draft.orders
          .map((o) => ({ ...o, lines: o.lines.filter((l) => new Decimal(l.packsQty).gt(0)) }))
          .filter((o) => o.lines.length > 0);
        if (orders.length === 0) return { ok: false, code: "invalid_edit", message: "Has dejado todas las cantidades a 0: no hay nada que pedir." };
        const ids: string[] = [];
        for (const o of orders) {
          const { orderId } = await writer.createOrder({
            orgId: ctx.orgId,
            locationId: draft.locationId,
            supplierId: o.supplierId,
            lines: o.lines.map((l) => ({ packId: l.packId, packsQty: l.packsQty, packPrice: l.packPrice })),
          });
          ids.push(orderId);
        }
        return {
          ok: true,
          kind: "pedido",
          documentId: ids[0] ?? null,
          movementIds: [],
          message: ids.length === 1 ? "Pedido creado en borrador. Revísalo y envíalo desde Pedidos." : `${ids.length} pedidos creados en borrador. Revísalos y envíalos desde Pedidos.`,
          navigate: navigate({ locationId: draft.locationId, status: "draft" }),
        };
      }
      case "conteo": {
        if (draft.operation === "abrir") {
          const { countId } = await writer.openCount({ orgId: ctx.orgId, locationId: draft.locationId });
          return {
            ok: true,
            kind: "conteo",
            documentId: countId,
            movementIds: [],
            message: `Inventario abierto en ${draft.locationName}. Ve apuntando lo que cuentes: «en la barra hay 5 botellas de Beefeater».`,
            navigate: navigate({ locationId: draft.locationId }),
          };
        }
        await writer.addCountLines({
          countId: draft.countId!,
          areaId: draft.areaId,
          lines: draft.lines.map((l) => ({ productId: l.productId, qtyBase: l.qtyBase, input: l.input })),
          clientRef: idempotencyKey,
        });
        return { ok: true, kind: "conteo", documentId: draft.countId, movementIds: [], message: `Apuntado en el inventario de ${draft.locationName}.`, navigate: navigate({ locationId: draft.locationId }) };
      }
      case "documento": {
        const route: AppRoute = draft.operation.endsWith("traspaso") ? "/traspasos" : "/pedidos";
        const done = (message: string, documentId: string = draft.documentId): ConfirmResponse => ({ ok: true, kind: "documento", documentId, movementIds: [], message, navigate: { route, filters: { locationId: draft.locationId }, auto: false } });
        switch (draft.operation) {
          case "recibir_traspaso":
            await writer.receiveTransfer(draft.documentId);
            return done("Traspaso recibido: el stock ya está en el local de destino.");
          case "cancelar_traspaso":
            await writer.cancelTransfer(draft.documentId);
            return done("Traspaso cancelado.");
          case "enviar_pedido":
            await writer.sendOrder(draft.documentId);
            return done("Pedido enviado al proveedor.");
          case "recibir_pedido": {
            const { receiptId } = await writer.receiveOrder(draft.documentId, draft.receive ?? []);
            return done("Pedido recibido: stock y precios actualizados.", receiptId ?? draft.documentId);
          }
          case "cancelar_pedido":
            await writer.cancelOrder(draft.documentId);
            return done("Pedido cancelado.");
        }
        break;
      }
      case "archivar": {
        await writer.archiveProduct(draft.productId);
        return { ok: true, kind: "archivar", documentId: draft.productId, movementIds: [], message: `${draft.productName} archivado. Puedes restaurarlo desde su ficha.`, navigate: navigate({ productId: draft.productId }) };
      }
    }
  }
}
