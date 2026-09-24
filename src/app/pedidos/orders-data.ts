// Datos y utilidades compartidas de la pantalla de pedidos.
import Decimal from "decimal.js";
import { createClient } from "@/lib/supabase/client";

export type OrderStatus = "draft" | "sent" | "partial" | "received" | "cancelled";
export type Role = "owner" | "admin" | "manager" | "staff";

export type Location = { id: string; name: string };
export type Supplier = { id: string; name: string; email: string | null; phone: string | null };
export type Pack = { id: string; productId: string; productName: string; name: string; qtyBase: string; baseUnit: string };

export type OrderLine = { id?: string; packId: string; packsQty: string; packPrice: string; receivedPacks: string };
export type Order = {
  id: string;
  status: OrderStatus;
  locationId: string;
  locationName: string;
  supplierId: string;
  supplierName: string;
  note: string;
  expectedDate: string;
  createdAt: string;
  sentAt: string | null;
  lines: OrderLine[];
};

export type Reference = {
  orgId: string;
  orgName: string;
  userName: string;
  role: Role;
  locations: Location[];
  suppliers: Supplier[];
  packs: Map<string, Pack>;
  /** Último precio por proveedor y formato: `${supplierId}:${packId}` → precio. */
  lastPrices: Map<string, string>;
};

export const STATUS_LABEL: Record<OrderStatus, string> = {
  draft: "Borrador",
  sent: "Enviado",
  partial: "Recibido en parte",
  received: "Recibido",
  cancelled: "Cancelado",
};

export const canManage = (role: Role) => role !== "staff";

export function euros(value: Decimal.Value) {
  return `${new Decimal(value).toFixed(2).replace(".", ",")} €`;
}

export function num(value: Decimal.Value) {
  return new Decimal(value).toDecimalPlaces(2).toString().replace(".", ",");
}

/** "1,5" o "1.5" → Decimal; null si no es un número ≥ 0. */
export function parse(text: string): Decimal | null {
  const clean = text.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(clean) ? new Decimal(clean) : null;
}

export function orderTotal(order: Pick<Order, "lines">): Decimal {
  return order.lines.reduce((acc, l) => acc.plus(new Decimal(parse(l.packsQty) ?? 0).mul(parse(l.packPrice) ?? 0)), new Decimal(0));
}

export async function loadReference(): Promise<Reference> {
  const supabase = createClient();
  if (!supabase) throw new Error("Configura las variables de Supabase.");
  const { data: session } = await supabase.auth.getSession();
  const user = session.session?.user;
  if (!user) throw new Error("Inicia sesión de nuevo.");
  const [membership, profile, locations, suppliers, packs, prices] = await Promise.all([
    supabase.from("memberships").select("org_id, role, organizations(name)").eq("user_id", user.id).limit(1).maybeSingle(),
    supabase.from("profiles").select("full_name").eq("user_id", user.id).maybeSingle(),
    supabase.from("locations").select("id, name").eq("active", true).order("name"),
    supabase.from("suppliers").select("id, name, email, phone").eq("active", true).order("name"),
    supabase.from("product_packs").select("id, product_id, name, qty_base, products!inner(name, base_unit, active)").eq("active", true).eq("products.active", true),
    supabase.from("supplier_prices").select("supplier_id, pack_id, last_price").not("last_price", "is", null),
  ]);
  const member = membership.data as { org_id: string; role: Role; organizations: { name: string } | null } | null;
  if (!member) throw new Error("No perteneces a ninguna organización.");
  const packMap = new Map<string, Pack>();
  for (const p of (packs.data ?? []) as unknown as Array<{ id: string; product_id: string; name: string; qty_base: number; products: { name: string; base_unit: string } }>) {
    packMap.set(p.id, { id: p.id, productId: p.product_id, productName: p.products.name, name: p.name, qtyBase: String(p.qty_base), baseUnit: p.products.base_unit });
  }
  return {
    orgId: member.org_id,
    orgName: member.organizations?.name ?? "",
    userName: profile.data?.full_name?.trim() || user.email?.split("@")[0] || "",
    role: member.role,
    locations: (locations.data ?? []) as Location[],
    suppliers: (suppliers.data ?? []) as Supplier[],
    packs: packMap,
    lastPrices: new Map((prices.data ?? []).map((p) => [`${p.supplier_id}:${p.pack_id}`, String(p.last_price)])),
  };
}

export async function loadOrders(statuses: OrderStatus[], locationId: string): Promise<Order[]> {
  const supabase = createClient();
  if (!supabase) throw new Error("Configura las variables de Supabase.");
  let query = supabase
    .from("purchase_orders")
    .select("id, status, location_id, supplier_id, note, expected_date, created_at, sent_at, suppliers(name), locations(name), lines:purchase_order_lines(id, pack_id, packs_qty, pack_price, received_packs)")
    .in("status", statuses)
    .order("created_at", { ascending: false })
    .limit(200);
  if (locationId) query = query.eq("location_id", locationId);
  const { data, error } = await query;
  if (error) {
    throw new Error(error.code === "42P01" || error.code === "PGRST205" ? "Falta aplicar la migración 0012_pedidos.sql en Supabase." : "No se pudieron cargar los pedidos.");
  }
  type Row = {
    id: string; status: OrderStatus; location_id: string; supplier_id: string; note: string | null; expected_date: string | null;
    created_at: string; sent_at: string | null; suppliers: { name: string } | null; locations: { name: string } | null;
    lines: Array<{ id: string; pack_id: string; packs_qty: number; pack_price: number | null; received_packs: number }>;
  };
  return ((data ?? []) as unknown as Row[]).map((o) => ({
    id: o.id,
    status: o.status,
    locationId: o.location_id,
    locationName: o.locations?.name ?? "",
    supplierId: o.supplier_id,
    supplierName: o.suppliers?.name ?? "",
    note: o.note ?? "",
    expectedDate: o.expected_date ?? "",
    createdAt: o.created_at,
    sentAt: o.sent_at,
    lines: o.lines.map((l) => ({ id: l.id, packId: l.pack_id, packsQty: String(l.packs_qty), packPrice: l.pack_price === null ? "" : String(l.pack_price), receivedPacks: String(l.received_packs) })),
  }));
}

/** Guarda un borrador: cabecera y líneas (en borrador no hay recepciones, se reemplazan todas). */
export async function saveDraft(ref: Reference, order: Omit<Order, "id" | "status" | "createdAt" | "sentAt" | "locationName" | "supplierName"> & { id?: string }): Promise<string> {
  const supabase = createClient();
  if (!supabase) throw new Error("Configura las variables de Supabase.");
  const header = { supplier_id: order.supplierId, note: order.note.trim() || null, expected_date: order.expectedDate || null };
  let id = order.id;
  if (id) {
    const { data, error } = await supabase.from("purchase_orders").update(header).eq("id", id).select("id");
    if (error || !data?.length) throw new Error("No se pudo guardar: el pedido ya no está en borrador o no tienes acceso.");
    const { error: delError } = await supabase.from("purchase_order_lines").delete().eq("order_id", id);
    if (delError) throw new Error("No se pudieron actualizar las líneas.");
  } else {
    const { data, error } = await supabase.from("purchase_orders").insert({ org_id: ref.orgId, location_id: order.locationId, ...header }).select("id").single();
    if (error || !data) throw new Error("No se pudo crear el pedido.");
    id = data.id;
  }
  const lines = order.lines
    .filter((l) => (parse(l.packsQty) ?? new Decimal(0)).gt(0))
    .map((l) => ({ order_id: id!, pack_id: l.packId, packs_qty: parse(l.packsQty)!.toNumber(), pack_price: parse(l.packPrice)?.toNumber() ?? null }));
  if (lines.length > 0) {
    const { error } = await supabase.from("purchase_order_lines").insert(lines);
    if (error) throw new Error(error.code === "23505" ? "Hay un formato repetido en el pedido." : "No se pudieron guardar las líneas.");
  }
  return id!;
}

/** Texto del pedido para email o WhatsApp. */
export function orderText(ref: Reference, order: Order): string {
  const lines = order.lines.map((l) => {
    const pack = ref.packs.get(l.packId);
    return `• ${num(l.packsQty)} × ${pack?.name ?? "formato"} — ${pack?.productName ?? "producto"}`;
  });
  const when = order.expectedDate ? `, con entrega el ${new Date(`${order.expectedDate}T12:00:00`).toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long" })}` : "";
  return [
    `Hola ${order.supplierName}:`,
    "",
    `Os hacemos el siguiente pedido para ${order.locationName}${when}:`,
    "",
    ...lines,
    ...(order.note ? ["", order.note] : []),
    "",
    "Gracias.",
    [ref.userName, ref.orgName].filter(Boolean).join(" · "),
  ].join("\n");
}
