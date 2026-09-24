// Fuente de datos real: consultas tipadas de SOLO LECTURA con el cliente del usuario (RLS activo).
// Las cifras se piden como texto (`col::text`) para no pasar nunca por number.
import Decimal from "decimal.js";
import type { SupabaseClient } from "@supabase/supabase-js";
import type {
  AreaBalanceRaw,
  BalanceRaw,
  CountResultRaw,
  DataFilter,
  InventoryDataSource,
  LocationProductRaw,
  MovementRaw,
  OpenCountRaw,
  OpenOrderRaw,
  PriceRaw,
  SupplierPriceRaw,
  TransferRaw,
} from "../tools/types";
import { DataError } from "./client";

const PAGE = 1000;
/** Tope de filas por consulta paginada (movimientos). */
const MAX_ROWS = 20_000;

type Row = Record<string, unknown>;

function check<T>(what: string, result: { data: T | null; error: unknown }): T {
  if (result.error) throw new DataError(`No se pudo leer ${what}`, { cause: result.error });
  return result.data ?? ([] as T);
}

const str = (v: unknown): string => (v === null || v === undefined ? "0" : String(v));
const strOrNull = (v: unknown): string | null => (v === null || v === undefined ? null : String(v));

export class SupabaseDataSource implements InventoryDataSource {
  constructor(private readonly db: SupabaseClient) {}

  async openCount(locationId: string): Promise<OpenCountRaw | null> {
    const rows = check<Row[]>(
      "el inventario abierto",
      await this.db
        .from("inventory_counts")
        .select("id,location_id,started_at,lines:count_lines(product_id,qty:qty::text)")
        .eq("location_id", locationId)
        .eq("status", "open")
        .limit(1),
    );
    const r = rows[0];
    if (!r) return null;
    return {
      id: String(r.id),
      locationId: String(r.location_id),
      startedAt: String(r.started_at),
      lines: ((r.lines as Row[] | null) ?? []).map((l) => ({ productId: String(l.product_id), qty: str(l.qty) })),
    };
  }

  async supplierPrices(packIds: string[]): Promise<SupplierPriceRaw[]> {
    if (packIds.length === 0) return [];
    const rows = check<Row[]>(
      "los últimos precios",
      await this.db
        .from("supplier_prices")
        .select("supplier_id,pack_id,last_price:last_price::text,last_price_at,supplier:suppliers(name)")
        .in("pack_id", packIds)
        .not("last_price", "is", null)
        .order("last_price_at", { ascending: false }),
    );
    return rows.map((r) => ({
      supplierId: String(r.supplier_id),
      supplierName: (r.supplier as { name?: string } | null)?.name ?? "proveedor",
      packId: String(r.pack_id),
      lastPrice: str(r.last_price),
      lastPriceAt: strOrNull(r.last_price_at),
    }));
  }

  async balances(filter: DataFilter): Promise<BalanceRaw[]> {
    if (filter.locationIds.length === 0) return [];
    let q = this.db.from("stock_balances").select("location_id,product_id,qty:qty::text,avg_cost:avg_cost::text").in("location_id", filter.locationIds);
    if (filter.productIds) q = q.in("product_id", filter.productIds);
    const rows = check<Row[]>("el stock", await q);
    return rows.map((r) => ({ locationId: String(r.location_id), productId: String(r.product_id), qty: str(r.qty), avgCost: str(r.avg_cost) }));
  }

  async areaBalances(areaId: string, productIds?: string[]): Promise<AreaBalanceRaw[]> {
    let q = this.db.from("stock_area_balances").select("area_id,product_id,qty:qty::text,avg_cost:avg_cost::text").eq("area_id", areaId);
    if (productIds) q = q.in("product_id", productIds);
    const rows = check<Row[]>("el stock por espacio", await q);
    return rows.map((r) => ({ areaId: String(r.area_id), productId: String(r.product_id), qty: str(r.qty), avgCost: str(r.avg_cost) }));
  }

  async locationProducts(filter: DataFilter): Promise<LocationProductRaw[]> {
    if (filter.locationIds.length === 0) return [];
    let q = this.db
      .from("location_products")
      .select("location_id,product_id,min_qty:min_qty::text,par_qty:par_qty::text")
      .in("location_id", filter.locationIds)
      .eq("active", true);
    if (filter.productIds) q = q.in("product_id", filter.productIds);
    const rows = check<Row[]>("los mínimos", await q);
    return rows.map((r) => ({ locationId: String(r.location_id), productId: String(r.product_id), minQty: str(r.min_qty), parQty: str(r.par_qty) }));
  }

  async movements(filter: DataFilter & { since: string }): Promise<MovementRaw[]> {
    if (filter.locationIds.length === 0) return [];
    const out: MovementRaw[] = [];
    for (let from = 0; from < MAX_ROWS; from += PAGE) {
      let q = this.db
        .from("stock_movements")
        .select("id,location_id,product_id,area_id,type,qty:qty::text,unit_cost:unit_cost::text,occurred_at")
        .in("location_id", filter.locationIds)
        .gte("occurred_at", filter.since)
        .order("id")
        .range(from, from + PAGE - 1);
      if (filter.productIds) q = q.in("product_id", filter.productIds);
      const rows = check<Row[]>("los movimientos", await q);
      for (const r of rows) {
        out.push({
          locationId: String(r.location_id),
          productId: String(r.product_id),
          areaId: strOrNull(r.area_id),
          type: r.type as MovementRaw["type"],
          qty: str(r.qty),
          unitCost: strOrNull(r.unit_cost),
          occurredAt: String(r.occurred_at),
        });
      }
      if (rows.length < PAGE) break;
    }
    return out;
  }

  async prices(packIds: string[] | null, since: string): Promise<PriceRaw[]> {
    let q = this.db
      .from("price_history")
      .select("supplier_id,pack_id,price:price::text,recorded_at,supplier:suppliers(name)")
      .gte("recorded_at", since)
      .order("recorded_at")
      .limit(5000);
    if (packIds) q = q.in("pack_id", packIds);
    const rows = check<Row[]>("los precios", await q);
    return rows.map((r) => ({
      supplierId: String(r.supplier_id),
      supplierName: (r.supplier as { name?: string } | null)?.name ?? "proveedor",
      packId: String(r.pack_id),
      price: str(r.price),
      recordedAt: String(r.recorded_at),
    }));
  }

  async transfers(filter: { locationIds: string[]; status: TransferRaw["status"][] }): Promise<TransferRaw[]> {
    if (filter.locationIds.length === 0) return [];
    const list = filter.locationIds.join(",");
    const rows = check<Row[]>(
      "los traspasos",
      await this.db
        .from("transfers")
        .select("id,from_location_id,to_location_id,status,sent_at,lines:transfer_lines(product_id,qty_sent:qty_sent::text,unit_cost:unit_cost::text)")
        .in("status", filter.status)
        .or(`from_location_id.in.(${list}),to_location_id.in.(${list})`)
        .order("sent_at", { ascending: true })
        .limit(500),
    );
    return rows.map((r) => ({
      id: String(r.id),
      fromLocationId: String(r.from_location_id),
      toLocationId: String(r.to_location_id),
      status: r.status as TransferRaw["status"],
      sentAt: strOrNull(r.sent_at),
      lines: ((r.lines as Row[] | null) ?? []).map((l) => ({ productId: String(l.product_id), qtySent: str(l.qty_sent), unitCost: strOrNull(l.unit_cost) })),
    }));
  }

  /**
   * Lo pendiente de recibir de pedidos abiertos. Si la tabla aún no existe (migración 0012 sin
   * aplicar) devuelve vacío: la reposición sigue funcionando, solo sin descontar pedidos.
   */
  async openOrders(filter: { locationIds: string[] }): Promise<OpenOrderRaw[]> {
    if (filter.locationIds.length === 0) return [];
    const { data, error } = await this.db
      .from("purchase_order_lines")
      .select("packs_qty:packs_qty::text,received_packs:received_packs::text,pack:product_packs(product_id,qty_base:qty_base::text),order:purchase_orders!inner(location_id,status)")
      .in("order.location_id", filter.locationIds)
      .in("order.status", ["draft", "sent", "partial"]);
    if (error) return [];
    const out: OpenOrderRaw[] = [];
    for (const r of (data ?? []) as Row[]) {
      const pack = r.pack as { product_id: string; qty_base: string } | null;
      const order = r.order as { location_id: string } | null;
      if (!pack || !order) continue;
      const pendingPacks = new Decimal(str(r.packs_qty)).minus(str(r.received_packs));
      if (pendingPacks.lte(0)) continue;
      // Cadena decimal exacta: packs pendientes × contenido del formato.
      out.push({ locationId: order.location_id, productId: pack.product_id, qtyBase: pendingPacks.mul(pack.qty_base).toString() });
    }
    return out;
  }

  async countResults(filter: DataFilter & { since: string }): Promise<CountResultRaw[]> {
    if (filter.locationIds.length === 0) return [];
    let q = this.db
      .from("count_results")
      .select(
        "count_id,product_id,expected_qty:expected_qty::text,counted_qty:counted_qty::text,unit_cost:unit_cost::text,count:inventory_counts!inner(location_id,closed_at,status)",
      )
      .in("count.location_id", filter.locationIds)
      .eq("count.status", "closed")
      .gte("count.closed_at", filter.since)
      .limit(5000);
    if (filter.productIds) q = q.in("product_id", filter.productIds);
    const rows = check<Row[]>("los resultados de inventario", await q);
    return rows.map((r) => {
      const count = r.count as { location_id: string; closed_at: string };
      return {
        countId: String(r.count_id),
        locationId: count.location_id,
        closedAt: count.closed_at,
        productId: String(r.product_id),
        expectedQty: str(r.expected_qty),
        countedQty: str(r.counted_qty),
        unitCost: str(r.unit_cost),
      };
    });
  }
}
