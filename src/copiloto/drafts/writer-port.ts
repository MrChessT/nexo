// Escrituras permitidas al agente. El stock SOLO cambia con las RPC de la app:
// register_movement, send_transfer, post_receipt y close_count. Las inserciones previas crean
// documentos en estado borrador/abierto (lo que el RLS permite) y no mueven stock.
// El catálogo (precios, altas, mínimos, archivar) se escribe con el cliente del usuario: RLS exige
// rol de encargado; si una escritura no afecta a ninguna fila se trata como falta de permiso.
import type { SupabaseClient } from "@supabase/supabase-js";

export const RPC_ERROR_CODES = [
  "unauthenticated",
  "forbidden",
  "not_found",
  "invalid_status",
  "empty_transfer",
  "empty_receipt",
  "type_not_allowed",
  "invalid_quantity",
  "cross_organization_link",
  "cross_location_link",
  "duplicate",
] as const;
export type RpcErrorCode = (typeof RPC_ERROR_CODES)[number] | "internal";

export class RpcError extends Error {
  constructor(
    readonly code: RpcErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "RpcError";
  }
}

/** Extrae el código que lanzan las funciones de la BD (`raise exception 'forbidden'`). */
export function rpcCode(error: { message?: string; code?: string } | null | undefined): RpcErrorCode {
  const message = error?.message ?? "";
  const found = RPC_ERROR_CODES.find((code) => message === code || message.startsWith(`${code}:`) || message.includes(` ${code}`));
  if (found) return found;
  if (error?.code === "42501") return "forbidden";
  if (error?.code === "23505") return "duplicate";
  return "internal";
}

export interface InventoryWriter {
  registerWaste(args: {
    locationId: string;
    productId: string;
    qtyBase: string;
    reason: string | null;
    areaId: string | null;
    clientRef: string;
  }): Promise<{ movementId: string }>;
  createTransfer(args: {
    orgId: string;
    fromLocationId: string;
    toLocationId: string;
    note: string | null;
    lines: Array<{ productId: string; qtySent: string }>;
  }): Promise<{ transferId: string }>;
  sendTransfer(transferId: string): Promise<void>;
  deleteDraftTransfer(transferId: string): Promise<void>;
  createReceipt(args: {
    orgId: string;
    locationId: string;
    supplierId: string | null;
    docNumber: string | null;
    docDate: string;
    lines: Array<{ packId: string; packsQty: string; packPrice: string }>;
  }): Promise<{ receiptId: string }>;
  postReceipt(receiptId: string): Promise<void>;
  deleteOpenReceipt(receiptId: string): Promise<void>;
  closeCount(countId: string, zeroUncounted: boolean, asConsumption: boolean): Promise<void>;
  setSupplierPrice(args: { supplierId: string; packId: string; price: string }): Promise<void>;
  createProduct(args: {
    orgId: string;
    name: string;
    dimension: "mass" | "volume" | "count";
    categoryId: string | null;
    pack: { name: string; qtyBase: string } | null;
    supplierId: string | null;
    price: string | null;
    locationIds: string[];
  }): Promise<{ productId: string }>;
  setLocationLevel(args: { locationId: string; productId: string; field: "min_qty" | "par_qty"; value: string }): Promise<void>;
  receiveTransfer(transferId: string): Promise<void>;
  cancelTransfer(transferId: string): Promise<void>;
  sendOrder(orderId: string): Promise<void>;
  receiveOrder(orderId: string, lines: Array<{ packId: string; packsQty: string; packPrice: string | null }>): Promise<{ receiptId: string | null }>;
  cancelOrder(orderId: string): Promise<void>;
  archiveProduct(productId: string): Promise<void>;
  /** Pedido a proveedor en borrador (no se envía: eso es de un encargado desde /pedidos). */
  createOrder(args: {
    orgId: string;
    locationId: string;
    supplierId: string;
    lines: Array<{ packId: string; packsQty: string; packPrice: string | null }>;
  }): Promise<{ orderId: string }>;
}

function raise(what: string, error: { message?: string; code?: string }): never {
  throw new RpcError(rpcCode(error), `${what}: ${error.message ?? "error"}`, { cause: error });
}

/** Implementación con el cliente del usuario: RLS y comprobaciones de rol de las RPC siempre activas. */
export class SupabaseInventoryWriter implements InventoryWriter {
  constructor(private readonly db: SupabaseClient) {}

  async registerWaste(args: Parameters<InventoryWriter["registerWaste"]>[0]): Promise<{ movementId: string }> {
    const { data, error } = await this.db.rpc("register_movement", {
      p_location: args.locationId,
      p_product: args.productId,
      p_type: "waste",
      // Cadena decimal: PostgREST la convierte a numeric sin pasar por coma flotante.
      p_qty: args.qtyBase,
      p_reason: args.reason,
      p_area: args.areaId,
      p_client_ref: args.clientRef,
    });
    if (error) raise("register_movement", error);
    return { movementId: String(data) };
  }

  async createTransfer(args: Parameters<InventoryWriter["createTransfer"]>[0]): Promise<{ transferId: string }> {
    const header = await this.db
      .from("transfers")
      .insert({ org_id: args.orgId, from_location_id: args.fromLocationId, to_location_id: args.toLocationId, note: args.note })
      .select("id")
      .single();
    if (header.error || !header.data) raise("transfers", header.error ?? {});
    const transferId = String(header.data.id);
    const lines = await this.db
      .from("transfer_lines")
      .insert(args.lines.map((l) => ({ transfer_id: transferId, product_id: l.productId, qty_sent: l.qtySent })));
    if (lines.error) {
      await this.deleteDraftTransfer(transferId).catch(() => undefined);
      raise("transfer_lines", lines.error);
    }
    return { transferId };
  }

  async receiveTransfer(transferId: string): Promise<void> {
    // Sin líneas: se recibe lo enviado (receive_transfer usa qty_sent por defecto).
    const { error } = await this.db.rpc("receive_transfer", { p_transfer: transferId, p_lines: [] });
    if (error) raise("receive_transfer", error);
  }

  async cancelTransfer(transferId: string): Promise<void> {
    const { error } = await this.db.rpc("cancel_transfer", { p_transfer: transferId });
    if (error) raise("cancel_transfer", error);
  }

  async sendOrder(orderId: string): Promise<void> {
    const { error } = await this.db.rpc("send_order", { p_order: orderId });
    if (error) raise("send_order", error);
  }

  async receiveOrder(orderId: string, lines: Array<{ packId: string; packsQty: string; packPrice: string | null }>): Promise<{ receiptId: string | null }> {
    const { data, error } = await this.db.rpc("receive_order", {
      p_order: orderId,
      p_lines: lines.map((l) => ({ pack_id: l.packId, packs_qty: l.packsQty, ...(l.packPrice ? { pack_price: l.packPrice } : {}) })),
    });
    if (error) raise("receive_order", error);
    return { receiptId: data ? String(data) : null };
  }

  async cancelOrder(orderId: string): Promise<void> {
    const { error } = await this.db.rpc("cancel_order", { p_order: orderId });
    if (error) raise("cancel_order", error);
  }

  async sendTransfer(transferId: string): Promise<void> {
    const { error } = await this.db.rpc("send_transfer", { p_transfer: transferId });
    if (error) raise("send_transfer", error);
  }

  async deleteDraftTransfer(transferId: string): Promise<void> {
    const { error } = await this.db.from("transfers").delete().eq("id", transferId).eq("status", "draft");
    if (error) raise("transfers.delete", error);
  }

  async createReceipt(args: Parameters<InventoryWriter["createReceipt"]>[0]): Promise<{ receiptId: string }> {
    const header = await this.db
      .from("goods_receipts")
      .insert({ org_id: args.orgId, location_id: args.locationId, supplier_id: args.supplierId, doc_number: args.docNumber, doc_date: args.docDate })
      .select("id")
      .single();
    if (header.error || !header.data) raise("goods_receipts", header.error ?? {});
    const receiptId = String(header.data.id);
    const lines = await this.db
      .from("receipt_lines")
      .insert(args.lines.map((l) => ({ receipt_id: receiptId, pack_id: l.packId, packs_qty: l.packsQty, pack_price: l.packPrice })));
    if (lines.error) {
      await this.deleteOpenReceipt(receiptId).catch(() => undefined);
      raise("receipt_lines", lines.error);
    }
    return { receiptId };
  }

  async postReceipt(receiptId: string): Promise<void> {
    const { error } = await this.db.rpc("post_receipt", { p_receipt: receiptId });
    if (error) raise("post_receipt", error);
  }

  async deleteOpenReceipt(receiptId: string): Promise<void> {
    const { error } = await this.db.from("goods_receipts").delete().eq("id", receiptId).eq("status", "open");
    if (error) raise("goods_receipts.delete", error);
  }

  async closeCount(countId: string, zeroUncounted: boolean, asConsumption: boolean): Promise<void> {
    const { error } = await this.db.rpc("close_count", { p_count: countId, p_zero_uncounted: zeroUncounted, p_as_consumption: asConsumption });
    if (error) raise("close_count", error);
  }

  async setSupplierPrice(args: Parameters<InventoryWriter["setSupplierPrice"]>[0]): Promise<void> {
    const { data, error } = await this.db
      .from("supplier_prices")
      .upsert({ supplier_id: args.supplierId, pack_id: args.packId, last_price: args.price, last_price_at: new Date().toISOString() }, { onConflict: "supplier_id,pack_id" })
      .select("pack_id");
    if (error) raise("supplier_prices", error);
    if (!data?.length) raise("supplier_prices", { code: "42501", message: "forbidden" });
  }

  async createProduct(args: Parameters<InventoryWriter["createProduct"]>[0]): Promise<{ productId: string }> {
    const product = await this.db
      .from("products")
      .insert({ org_id: args.orgId, name: args.name, dimension: args.dimension, category_id: args.categoryId })
      .select("id")
      .single();
    if (product.error || !product.data) raise("products", product.error ?? { code: "42501", message: "forbidden" });
    const productId = String(product.data.id);
    // Todo o nada: si falla un paso posterior, se borra el producto (formatos y precios caen en cascada).
    try {
      if (args.pack) {
        const pack = await this.db
          .from("product_packs")
          .insert({ product_id: productId, name: args.pack.name, qty_base: args.pack.qtyBase, is_purchase_default: true, is_count_default: true })
          .select("id")
          .single();
        if (pack.error || !pack.data) raise("product_packs", pack.error ?? { code: "42501", message: "forbidden" });
        if (args.price !== null && args.supplierId) {
          await this.setSupplierPrice({ supplierId: args.supplierId, packId: String(pack.data.id), price: args.price });
        }
      }
      if (args.locationIds.length > 0) {
        const { error } = await this.db
          .from("location_products")
          .upsert(args.locationIds.map((locationId) => ({ location_id: locationId, product_id: productId, active: true })), { onConflict: "location_id,product_id" });
        if (error) raise("location_products", error);
      }
    } catch (err) {
      await this.db.from("products").delete().eq("id", productId);
      throw err;
    }
    return { productId };
  }

  async setLocationLevel(args: Parameters<InventoryWriter["setLocationLevel"]>[0]): Promise<void> {
    const { data, error } = await this.db
      .from("location_products")
      .upsert({ location_id: args.locationId, product_id: args.productId, [args.field]: args.value, active: true }, { onConflict: "location_id,product_id" })
      .select("product_id");
    if (error) raise("location_products", error);
    if (!data?.length) raise("location_products", { code: "42501", message: "forbidden" });
  }

  async createOrder(args: Parameters<InventoryWriter["createOrder"]>[0]): Promise<{ orderId: string }> {
    const header = await this.db
      .from("purchase_orders")
      .insert({ org_id: args.orgId, location_id: args.locationId, supplier_id: args.supplierId })
      .select("id")
      .single();
    if (header.error || !header.data) raise("purchase_orders", header.error ?? { code: "42501", message: "forbidden" });
    const orderId = String(header.data.id);
    const lines = await this.db
      .from("purchase_order_lines")
      .insert(args.lines.map((l) => ({ order_id: orderId, pack_id: l.packId, packs_qty: l.packsQty, pack_price: l.packPrice })));
    if (lines.error) {
      // Sin restos: una cabecera sin líneas no sirve.
      await this.db.from("purchase_orders").delete().eq("id", orderId).eq("status", "draft");
      raise("purchase_order_lines", lines.error);
    }
    return { orderId };
  }

  async archiveProduct(productId: string): Promise<void> {
    const { data, error } = await this.db.from("products").update({ active: false }).eq("id", productId).select("id");
    if (error) raise("products", error);
    if (!data?.length) raise("products", { code: "42501", message: "forbidden" });
  }
}
