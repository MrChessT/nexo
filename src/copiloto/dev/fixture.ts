// Datos simulados de Parador Eventos para desarrollo y tests (fase 2). En la fase 3 se usa Supabase.
import type { Area, Location, Product, SessionContext } from "../domain";
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
  OrderRaw,
  PurchaseRaw,
  PriceRaw,
  SupplierPriceRaw,
  TransferRaw,
} from "../tools/types";

const id = (prefix: string, n: number) => `${prefix}-0000-4000-8000-${String(n).padStart(12, "0")}`;

export const ORG_ID = id("00000000", 1);
export const USER_ID = id("11111111", 1);

export const LOCATIONS: Location[] = [
  { id: id("aaaaaaaa", 1), name: "Parador", timezone: "Europe/Madrid", dayCutoff: "06:00" },
  { id: id("aaaaaaaa", 2), name: "Pickels", timezone: "Europe/Madrid", dayCutoff: "06:00" },
  { id: id("aaaaaaaa", 3), name: "Vivero", timezone: "Europe/Madrid", dayCutoff: "06:00" },
  { id: id("aaaaaaaa", 4), name: "La Oliva", timezone: "Europe/Madrid", dayCutoff: "06:00" },
];
const [PARADOR, PICKELS, VIVERO] = LOCATIONS as [Location, Location, Location, Location];

export const AREAS: Area[] = [
  { id: id("bbbbbbbb", 1), locationId: PARADOR.id, name: "Barra 1" },
  { id: id("bbbbbbbb", 2), locationId: PARADOR.id, name: "Barra 2" },
  { id: id("bbbbbbbb", 3), locationId: PARADOR.id, name: "Almacén" },
  { id: id("bbbbbbbb", 4), locationId: VIVERO.id, name: "Barra" },
  { id: id("bbbbbbbb", 5), locationId: VIVERO.id, name: "Cámara" },
];

function product(n: number, name: string, dimension: Product["dimension"], category: string, packs: Array<[string, string, boolean?, boolean?]>): Product {
  return {
    id: id("cccccccc", n),
    name,
    dimension,
    baseUnit: dimension === "mass" ? "g" : dimension === "volume" ? "ml" : "ud",
    category,
    packs: packs.map(([packName, qtyBase, count = false, purchase = false], i) => ({
      id: id("dddddddd", n * 10 + i),
      name: packName,
      qtyBase,
      isCountDefault: count,
      isPurchaseDefault: purchase,
    })),
  };
}

export const PRODUCTS: Product[] = [
  product(1, "Ron Barceló Añejo 70 cl", "volume", "Destilados", [["Botella 70 cl", "700", true], ["Caja 6 botellas", "4200", false, true]]),
  product(2, "Ron Brugal Añejo 70 cl", "volume", "Destilados", [["Botella 70 cl", "700", true], ["Caja 6 botellas", "4200", false, true]]),
  product(3, "Ginebra Tanqueray 70 cl", "volume", "Destilados", [["Botella 70 cl", "700", true], ["Caja 6 botellas", "4200", false, true]]),
  product(4, "Coca-Cola 20 cl", "count", "Refrescos", [["Caja 24 ud", "24", false, true]]),
  product(5, "Tónica Schweppes 20 cl", "count", "Refrescos", [["Caja 24 ud", "24", false, true]]),
  product(6, "Agua Solán de Cabras 50 cl", "count", "Aguas", [["Pack 12 ud", "12", false, true]]),
  product(7, "Cerveza Mahou barril 30 l", "volume", "Cervezas", [["Barril 30 l", "30000", true, true]]),
  product(8, "Limones", "mass", "Fruta", [["Saco 5 kg", "5000", false, true]]),
  product(9, "Hielo en cubitos", "mass", "Hielo", [["Bolsa 2 kg", "2000", true, true]]),
];
export const SUPPLIERS = [
  { id: id("99999999", 1), name: "Distribuciones Canarias" },
  { id: id("99999999", 2), name: "Bebidas del Sur" },
  { id: id("99999999", 3), name: "Makro" },
];

export const CATEGORIES = ["Destilados", "Refrescos", "Aguas", "Cervezas", "Fruta", "Hielo"].map((name, i) => ({ id: id("77777777", i + 1), name }));

const P = Object.fromEntries(PRODUCTS.map((p, i) => [i + 1, p])) as Record<number, Product>;

export function fixtureContext(role: SessionContext["role"] = "manager"): SessionContext {
  return {
    userId: USER_ID,
    orgId: ORG_ID,
    role,
    locations: LOCATIONS,
    areas: AREAS,
    products: PRODUCTS,
    suppliers: SUPPLIERS,
    categories: CATEGORIES,
    archivedProducts: [{ id: id("cccccccc", 99), name: "Ginebra Bombay Sapphire 70 cl" }],
    catalogHash: "fixture-v1",
  };
}

// Movimientos de las últimas 4 semanas, generados de forma determinista respecto a `now`.
function hoursAgo(now: Date, hours: number): string {
  return new Date(now.getTime() - hours * 3_600_000).toISOString();
}

export class FixtureDataSource implements InventoryDataSource {
  readonly #balances: BalanceRaw[] = [
    { locationId: PARADOR.id, productId: P[1]!.id, qty: "2100", avgCost: "0.021429" },
    { locationId: PARADOR.id, productId: P[2]!.id, qty: "4900", avgCost: "0.020000" },
    { locationId: PARADOR.id, productId: P[3]!.id, qty: "1400", avgCost: "0.024286" },
    { locationId: PARADOR.id, productId: P[4]!.id, qty: "30", avgCost: "0.550000" },
    { locationId: PARADOR.id, productId: P[5]!.id, qty: "70", avgCost: "0.480000" },
    { locationId: PARADOR.id, productId: P[7]!.id, qty: "45000", avgCost: "0.003300" },
    { locationId: VIVERO.id, productId: P[4]!.id, qty: "48", avgCost: "0.550000" },
    { locationId: VIVERO.id, productId: P[6]!.id, qty: "20", avgCost: "0.350000" },
    { locationId: VIVERO.id, productId: P[8]!.id, qty: "1500", avgCost: "0.002100" },
    { locationId: VIVERO.id, productId: P[9]!.id, qty: "4000", avgCost: "0.000400" },
    { locationId: PICKELS.id, productId: P[1]!.id, qty: "700", avgCost: "0.021429" },
  ];

  readonly #areaBalances: AreaBalanceRaw[] = [
    { areaId: AREAS[0]!.id, productId: P[1]!.id, qty: "1400", avgCost: "0.021429" },
    { areaId: AREAS[2]!.id, productId: P[1]!.id, qty: "700", avgCost: "0.021429" },
    { areaId: AREAS[0]!.id, productId: P[4]!.id, qty: "30", avgCost: "0.550000" },
  ];

  readonly #locationProducts: LocationProductRaw[] = [
    { locationId: PARADOR.id, productId: P[1]!.id, minQty: "2800", parQty: "5600" },
    { locationId: PARADOR.id, productId: P[2]!.id, minQty: "1400", parQty: "4200" },
    { locationId: PARADOR.id, productId: P[4]!.id, minQty: "48", parQty: "120" },
    { locationId: PARADOR.id, productId: P[5]!.id, minQty: "48", parQty: "96" },
    { locationId: PARADOR.id, productId: P[7]!.id, minQty: "30000", parQty: "90000" },
    { locationId: VIVERO.id, productId: P[4]!.id, minQty: "96", parQty: "192" },
    { locationId: VIVERO.id, productId: P[6]!.id, minQty: "24", parQty: "60" },
    { locationId: VIVERO.id, productId: P[9]!.id, minQty: "4000", parQty: "10000" },
  ];

  /** Pedidos abiertos simulados (vacío salvo que un test los añada). */
  openOrderLines: OpenOrderRaw[] = [];

  constructor(private readonly now: Date = new Date()) {}

  async orders(filter: { locationIds: string[]; statuses: OrderRaw["status"][] }): Promise<OrderRaw[]> {
    const day = (h: number) => hoursAgo(this.now, h).slice(0, 10);
    const all: OrderRaw[] = [
      // Enviado hace 5 días, entrega prevista hace 2: con retraso.
      {
        id: id("abababab", 1), locationId: PARADOR.id, supplierName: "Distribuciones Canarias", status: "sent",
        createdAt: hoursAgo(this.now, 24 * 5), sentAt: hoursAgo(this.now, 24 * 5), expectedDate: day(48),
        lines: [{ productId: P[1]!.id, packsQty: "2", packPrice: "92.40", receivedPacks: "0" }],
      },
      // Borrador sin enviar en Vivero.
      {
        id: id("abababab", 2), locationId: VIVERO.id, supplierName: "Bebidas del Sur", status: "draft",
        createdAt: hoursAgo(this.now, 20), sentAt: null, expectedDate: null,
        lines: [{ productId: P[4]!.id, packsQty: "5", packPrice: "13.20", receivedPacks: "0" }],
      },
    ];
    return all.filter((o) => filter.locationIds.includes(o.locationId) && filter.statuses.includes(o.status));
  }

  async purchases(filter: { locationIds: string[]; since: string }): Promise<PurchaseRaw[]> {
    const day = (d: number) => hoursAgo(this.now, 24 * d).slice(0, 10);
    const all: PurchaseRaw[] = [
      { receiptId: "r1", locationId: PARADOR.id, supplierId: id("99999999", 1), supplierName: "Distribuciones Canarias", docDate: day(3), total: "184.80" },
      { receiptId: "r2", locationId: PARADOR.id, supplierId: id("99999999", 2), supplierName: "Bebidas del Sur", docDate: day(3), total: "132.00" },
      { receiptId: "r3", locationId: VIVERO.id, supplierId: id("99999999", 2), supplierName: "Bebidas del Sur", docDate: day(10), total: "66.00" },
      { receiptId: "r4", locationId: PARADOR.id, supplierId: id("99999999", 1), supplierName: "Distribuciones Canarias", docDate: day(60), total: "300.00" },
    ];
    return all.filter((p) => filter.locationIds.includes(p.locationId) && p.docDate >= filter.since);
  }

  async openOrders(filter: { locationIds: string[] }): Promise<OpenOrderRaw[]> {
    return this.openOrderLines.filter((o) => filter.locationIds.includes(o.locationId));
  }

  async openCount(locationId: string): Promise<OpenCountRaw | null> {
    if (locationId !== VIVERO.id) return null;
    return {
      id: id("ffffffff", 1),
      locationId,
      startedAt: hoursAgo(this.now, 2),
      lines: [
        { productId: P[4]!.id, qty: "40" },
        { productId: P[6]!.id, qty: "20" },
      ],
    };
  }

  async supplierPrices(packIds: string[]): Promise<SupplierPriceRaw[]> {
    const all: SupplierPriceRaw[] = [
      { supplierId: id("99999999", 1), supplierName: "Distribuciones Canarias", packId: P[1]!.packs[1]!.id, lastPrice: "92.40", lastPriceAt: hoursAgo(this.now, 72) },
      { supplierId: id("99999999", 2), supplierName: "Bebidas del Sur", packId: P[4]!.packs[0]!.id, lastPrice: "13.20", lastPriceAt: hoursAgo(this.now, 72) },
    ];
    return all.filter((p) => packIds.includes(p.packId));
  }

  private movementsAll(): MovementRaw[] {
    const out: MovementRaw[] = [];
    // Consumo diario: Coca-Cola en Vivero 40 ud/día, Parador 20 ud/día; ron 350 ml/día en Parador.
    for (let day = 1; day <= 28; day += 1) {
      out.push({ locationId: VIVERO.id, productId: P[4]!.id, areaId: null, type: "consumption", qty: "-40", unitCost: "0.55", occurredAt: hoursAgo(this.now, day * 24) });
      out.push({ locationId: PARADOR.id, productId: P[4]!.id, areaId: null, type: "consumption", qty: "-20", unitCost: "0.55", occurredAt: hoursAgo(this.now, day * 24) });
      out.push({ locationId: PARADOR.id, productId: P[1]!.id, areaId: null, type: "consumption", qty: "-350", unitCost: "0.021429", occurredAt: hoursAgo(this.now, day * 24) });
    }
    out.push({ locationId: PARADOR.id, productId: P[1]!.id, areaId: AREAS[0]!.id, type: "waste", qty: "-1400", unitCost: "0.021429", occurredAt: hoursAgo(this.now, 30) });
    out.push({ locationId: VIVERO.id, productId: P[9]!.id, areaId: null, type: "waste", qty: "-2000", unitCost: "0.0004", occurredAt: hoursAgo(this.now, 50) });
    out.push({ locationId: PARADOR.id, productId: P[4]!.id, areaId: null, type: "purchase", qty: "240", unitCost: "0.55", occurredAt: hoursAgo(this.now, 72) });
    return out;
  }

  async balances(filter: DataFilter): Promise<BalanceRaw[]> {
    return this.#balances.filter((b) => filter.locationIds.includes(b.locationId) && (!filter.productIds || filter.productIds.includes(b.productId)));
  }

  async areaBalances(areaId: string, productIds?: string[]): Promise<AreaBalanceRaw[]> {
    return this.#areaBalances.filter((b) => b.areaId === areaId && (!productIds || productIds.includes(b.productId)));
  }

  async locationProducts(filter: DataFilter): Promise<LocationProductRaw[]> {
    return this.#locationProducts.filter((lp) => filter.locationIds.includes(lp.locationId) && (!filter.productIds || filter.productIds.includes(lp.productId)));
  }

  async movements(filter: DataFilter & { since: string }): Promise<MovementRaw[]> {
    return this.movementsAll().filter(
      (m) => filter.locationIds.includes(m.locationId) && (!filter.productIds || filter.productIds.includes(m.productId)) && m.occurredAt >= filter.since,
    );
  }

  async prices(packIds: string[] | null, since: string): Promise<PriceRaw[]> {
    const rum = P[1]!.packs[1]!;
    const tonic = P[5]!.packs[0]!;
    const all: PriceRaw[] = [
      { supplierId: "s1", supplierName: "Distribuciones Canarias", packId: rum.id, price: "84.00", recordedAt: hoursAgo(this.now, 24 * 40) },
      { supplierId: "s1", supplierName: "Distribuciones Canarias", packId: rum.id, price: "92.40", recordedAt: hoursAgo(this.now, 24 * 3) },
      { supplierId: "s2", supplierName: "Bebidas del Sur", packId: tonic.id, price: "11.52", recordedAt: hoursAgo(this.now, 24 * 20) },
      { supplierId: "s2", supplierName: "Bebidas del Sur", packId: tonic.id, price: "11.52", recordedAt: hoursAgo(this.now, 24 * 2) },
    ];
    return all.filter((p) => (!packIds || packIds.includes(p.packId)) && p.recordedAt >= since);
  }

  async transfers(filter: { locationIds: string[]; status: TransferRaw["status"][] }): Promise<TransferRaw[]> {
    const all: TransferRaw[] = [
      {
        id: id("eeeeeeee", 1),
        fromLocationId: PARADOR.id,
        toLocationId: VIVERO.id,
        status: "in_transit",
        sentAt: hoursAgo(this.now, 76),
        lines: [
          { productId: P[4]!.id, qtySent: "48", unitCost: "0.55" },
          { productId: P[1]!.id, qtySent: "1400", unitCost: "0.021429" },
        ],
      },
    ];
    return all.filter(
      (t) => filter.status.includes(t.status) && (filter.locationIds.includes(t.fromLocationId) || filter.locationIds.includes(t.toLocationId)),
    );
  }

  async countResults(filter: DataFilter & { since: string }): Promise<CountResultRaw[]> {
    const closedAt = hoursAgo(this.now, 24 * 5);
    const all: CountResultRaw[] = [
      { countId: "c1", locationId: PARADOR.id, closedAt, productId: P[3]!.id, expectedQty: "2800", countedQty: "1400", unitCost: "0.024286" },
      { countId: "c1", locationId: PARADOR.id, closedAt, productId: P[5]!.id, expectedQty: "72", countedQty: "70", unitCost: "0.48" },
    ];
    return all.filter(
      (r) => filter.locationIds.includes(r.locationId) && (!filter.productIds || filter.productIds.includes(r.productId)) && r.closedAt >= filter.since,
    );
  }
}
