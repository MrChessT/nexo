import type { BaseUnit } from "../contract/index";
import type { EvalKind, Herramienta } from "../jev/catalog";

// Datos crudos (todas las cifras como cadena decimal; nunca number) -----------------

export type MovementType =
  | "opening" | "purchase" | "consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjustment" | "manual_adjustment";

export interface BalanceRaw { locationId: string; productId: string; qty: string; avgCost: string }
export interface AreaBalanceRaw { areaId: string; productId: string; qty: string; avgCost: string }
export interface LocationProductRaw { locationId: string; productId: string; minQty: string; parQty: string }
export interface MovementRaw {
  locationId: string; productId: string; areaId: string | null; type: MovementType;
  qty: string; unitCost: string | null; occurredAt: string;
}
export interface PriceRaw { supplierId: string; supplierName: string; packId: string; price: string; recordedAt: string }
export interface TransferRaw {
  id: string; fromLocationId: string; toLocationId: string; status: "draft" | "in_transit" | "received" | "cancelled";
  sentAt: string | null; lines: Array<{ productId: string; qtySent: string; unitCost: string | null }>;
}
export interface CountResultRaw {
  countId: string; locationId: string; closedAt: string; productId: string;
  expectedQty: string; countedQty: string; unitCost: string;
}

export interface DataFilter {
  locationIds: string[];
  productIds?: string[];
  /** ISO, incluido. */
  since?: string;
}

export interface OpenCountRaw {
  id: string;
  locationId: string;
  startedAt: string;
  lines: Array<{ productId: string; qty: string }>;
}

/** Pedido a proveedor con sus líneas (cifras como cadena decimal). */
export interface OrderRaw {
  id: string;
  locationId: string;
  supplierName: string;
  status: "draft" | "sent" | "partial" | "received" | "cancelled";
  createdAt: string;
  sentAt: string | null;
  /** YYYY-MM-DD o null. */
  expectedDate: string | null;
  lines: Array<{ productId: string; packsQty: string; packPrice: string | null; receivedPacks: string; packId?: string; packName?: string }>;
}

/** Recepción contabilizada: lo que se gastó con un proveedor en una fecha. */
export interface PurchaseRaw {
  receiptId: string;
  locationId: string;
  supplierId: string | null;
  supplierName: string | null;
  /** YYYY-MM-DD. */
  docDate: string;
  total: string;
}

/** Cantidad aún por recibir de pedidos abiertos (borrador, enviado o parcial), en unidad base. */
export interface OpenOrderRaw {
  locationId: string;
  productId: string;
  qtyBase: string;
}

export interface SupplierPriceRaw {
  supplierId: string;
  supplierName: string;
  packId: string;
  lastPrice: string;
  lastPriceAt: string | null;
}

/** Acceso de solo lectura. La implementación real (fase 3) usa el cliente Supabase con el JWT del usuario. */
export interface InventoryDataSource {
  openCount(locationId: string): Promise<OpenCountRaw | null>;
  supplierPrices(packIds: string[]): Promise<SupplierPriceRaw[]>;
  balances(filter: DataFilter): Promise<BalanceRaw[]>;
  areaBalances(areaId: string, productIds?: string[]): Promise<AreaBalanceRaw[]>;
  locationProducts(filter: DataFilter): Promise<LocationProductRaw[]>;
  movements(filter: DataFilter & { since: string }): Promise<MovementRaw[]>;
  prices(packIds: string[] | null, since: string): Promise<PriceRaw[]>;
  transfers(filter: { locationIds: string[]; status: TransferRaw["status"][] }): Promise<TransferRaw[]>;
  countResults(filter: DataFilter & { since: string }): Promise<CountResultRaw[]>;
  openOrders(filter: { locationIds: string[] }): Promise<OpenOrderRaw[]>;
  orders(filter: { locationIds: string[]; statuses: OrderRaw["status"][] }): Promise<OrderRaw[]>;
  /** Recepciones cerradas desde `since` (YYYY-MM-DD, incluido). */
  purchases(filter: { locationIds: string[]; since: string }): Promise<PurchaseRaw[]>;
}

// Parámetros y resultados ---------------------------------------------------------

export interface Period {
  from: string; // YYYY-MM-DD (día de negocio)
  to: string;
  label: string;
}

export interface ToolParams {
  locationIds: string[];
  areaId: string | null;
  productIds: string[];
  period: Period | null;
  /** Horizonte de reposición en días (query_reorder). */
  horizonDays: number;
  horizonLabel: string;
  now: Date;
  /** Stock desglosado por espacio («¿qué hay en cada sección?»). */
  byArea?: boolean;
}

export interface EvalItem {
  kind: EvalKind;
  /** Datos formateados que ve Jev; las claves coinciden con las rutas del catálogo. */
  data: Record<string, string>;
  /** Clave estable para sugerencias: "stock_bajo:<loc>:<prod>". */
  key: string;
  locationId: string | null;
}

export interface ToolRow {
  [key: string]: string | boolean | null;
}

export interface ToolResult {
  tool: Exclude<Herramienta, "ninguna">;
  /** Filas ya formateadas para mostrar/redactar (cifras como texto es-ES). */
  rows: ToolRow[];
  /** Totales formateados. */
  totals: Record<string, string>;
  /** Filas totales antes de recortar. */
  count: number;
  truncated: boolean;
  evalItems: EvalItem[];
  baseUnits?: BaseUnit[];
}
