// Tipos y esquemas de CONTRACT.md. Cualquier cambio aquí debe reflejarse en CONTRACT.md.
import { z } from "zod";

export const CONTRACT_VERSION = "1.0.0-draft";

export const DecimalString = z.string().regex(/^-?\d+(\.\d+)?$/, "cantidad decimal no válida");
export const Uuid = z.uuid();

export const ROLES = ["owner", "admin", "manager", "staff"] as const;
export const Role = z.enum(ROLES);
export type Role = z.infer<typeof Role>;

export const APP_ROUTES = ["/", "/productos", "/stock", "/recepciones", "/traspasos", "/inventarios", "/mermas", "/informes"] as const;
export const AppRoute = z.enum(APP_ROUTES);
export type AppRoute = z.infer<typeof AppRoute>;

export type BaseUnit = "g" | "ml" | "ud";
export type GateOutcome = "actuar" | "confirmar" | "preguntar";

export interface Decision {
  id: string;
  label: string;
  value: string;
  valueLabel: string;
  probability: number;
  confidence: number | null;
  gate: GateOutcome;
}

// POST /chat ---------------------------------------------------------------

export const ChatRequest = z.object({
  orgId: Uuid,
  sessionId: Uuid,
  message: z.string().trim().min(1).max(1000).transform((m) => m.normalize("NFC")),
  page: AppRoute,
  pageContext: z
    .object({ locationId: Uuid.optional(), areaId: Uuid.optional() })
    .optional(),
  clarification: z
    .object({
      clarifyId: z.string().min(1).max(64),
      optionId: z.string().min(1).max(200),
      freeText: z.string().max(300).optional(),
    })
    .optional(),
});
export type ChatRequest = z.infer<typeof ChatRequest>;

export interface DecisionEvent {
  messageId: string;
  intent: Decision;
  decisions: Decision[];
  shortcut: boolean;
}

export interface TextEvent {
  delta: string;
  /** true: descarta el texto recibido hasta ahora (el verificador lo ha rechazado). */
  reset?: boolean;
}

export interface NavigateFilters {
  locationId?: string;
  areaId?: string;
  productId?: string;
  status?: string;
  from?: string;
  to?: string;
  q?: string;
  /** Vista de /informes: resumen, consumo, mermas, stock, precios, reposicion, desvios. */
  view?: AnalyticsView;
  /** Días del periodo en /informes (7, 30 o 90). */
  days?: number;
}

export interface NavigateEvent {
  route: AppRoute;
  filters: NavigateFilters;
  auto: boolean;
}

export type ClarifyField =
  | "intent"
  | "local"
  | "espacio"
  | "producto"
  | "cantidad"
  | "tipo_accion"
  | "destino"
  | "local_destino"
  | "herramienta"
  | "proveedor"
  | "formato"
  | "duplicado"
  | "sentido";

export interface ClarifyEvent {
  clarifyId: string;
  question: string;
  field: ClarifyField;
  options: Array<{ id: string; label: string; probability: number | null }>;
  allowFreeText: boolean;
}

export type ErrorCode =
  | "unauthenticated"
  | "forbidden"
  | "rate_limited"
  | "invalid_request"
  | "jev_unavailable"
  | "data_unavailable"
  | "internal";

export interface ErrorEvent {
  code: ErrorCode;
  message: string;
  retryable: boolean;
}

export interface DoneEvent {
  messageId: string;
  text: string;
  textSource: "llm" | "plantilla";
  latencyMs: number;
}

// Borradores -----------------------------------------------------------------

export interface QuantityInput {
  amount: string;
  unit: string;
  packId?: string;
}

/**
 * Comprobación visible en el borrador: qué se ha verificado y con qué resultado.
 * ok: todo bien · aviso: conviene mirarlo · revisar: el usuario debe marcar «lo he revisado» para confirmar.
 */
export interface DraftCheck {
  id: string;
  label: string;
  status: "ok" | "aviso" | "revisar";
  detail: string;
  /** Probabilidad de Jev asociada (null si es una regla del código). */
  probability: number | null;
}

export const CATALOG_KINDS = ["precio", "producto_nuevo", "minimo", "archivar"] as const;
export type CatalogKind = (typeof CATALOG_KINDS)[number];

export interface DraftBase {
  draftId: string;
  kind: "merma" | "traspaso" | "recepcion" | "cierre_inventario" | CatalogKind;
  title: string;
  requiredRole: Role;
  canConfirm: boolean;
  coherence: number;
  warnings: string[];
  editable: string[];
  expiresAt: string;
  checks?: DraftCheck[];
  /** El usuario ha marcado «lo he revisado» (obligatorio si hay comprobaciones en «revisar»). */
  acknowledged?: boolean;
}

export interface WasteDraft extends DraftBase {
  kind: "merma";
  locationId: string;
  locationName: string;
  areaId: string | null;
  areaName: string | null;
  productId: string;
  productName: string;
  qtyBase: string;
  baseUnit: BaseUnit;
  input: QuantityInput;
  reason: string | null;
}

export interface TransferDraft extends DraftBase {
  kind: "traspaso";
  fromLocationId: string;
  fromLocationName: string;
  toLocationId: string;
  toLocationName: string;
  lines: Array<{ productId: string; productName: string; qtyBase: string; baseUnit: BaseUnit; input: QuantityInput }>;
  send: boolean;
  note: string | null;
}

export interface ReceiptDraft extends DraftBase {
  kind: "recepcion";
  locationId: string;
  locationName: string;
  supplierId: string | null;
  supplierName: string | null;
  docNumber: string | null;
  docDate: string;
  lines: Array<{
    packId: string;
    packName: string;
    productId: string;
    productName: string;
    packsQty: string;
    packPrice: string | null;
    priceSource: "ultimo_precio" | "usuario" | null;
  }>;
}

export interface CountCloseDraft extends DraftBase {
  kind: "cierre_inventario";
  countId: string;
  locationId: string;
  locationName: string;
  zeroUncounted: boolean;
  /** Las diferencias negativas se registran como consumo (no como ajuste). */
  asConsumption: boolean;
  preview: {
    countedProducts: number;
    adjustments: Array<{
      productId: string;
      productName: string;
      expected: string;
      counted: string;
      diff: string;
      baseUnit: BaseUnit;
      diffValue: string;
    }>;
    totalDiffValue: string;
  };
}

/** Cambio del último precio de compra de un formato con un proveedor. */
export interface PriceDraft extends DraftBase {
  kind: "precio";
  productId: string;
  productName: string;
  packId: string;
  packName: string;
  /** Contenido del formato en unidad base, para recalcular el coste unitario si se edita el precio. */
  packQtyBase: string;
  baseUnit: BaseUnit;
  supplierId: string;
  supplierName: string;
  oldPrice: string | null;
  newPrice: string;
  /** Coste por unidad base con el precio nuevo ("0,02 €/ml"), solo para mostrar. */
  unitCost: string;
}

/** Alta de un producto nuevo con, opcionalmente, su formato de compra, precio y locales. */
export interface NewProductDraft extends DraftBase {
  kind: "producto_nuevo";
  name: string;
  dimension: "mass" | "volume" | "count";
  baseUnit: BaseUnit;
  categoryId: string | null;
  categoryName: string | null;
  packName: string | null;
  packQtyBase: string | null;
  supplierId: string | null;
  supplierName: string | null;
  price: string | null;
  locationIds: string[];
  locationNames: string[];
}

/** Mínimo (alerta) o cantidad objetivo de un producto en un local. */
export interface MinimumDraft extends DraftBase {
  kind: "minimo";
  locationId: string;
  locationName: string;
  productId: string;
  productName: string;
  field: "min_qty" | "par_qty";
  oldValue: string | null;
  newValue: string;
  baseUnit: BaseUnit;
  input: QuantityInput;
}

/** Archivar un producto: deja de aparecer en la operativa; conserva historial. */
export interface ArchiveDraft extends DraftBase {
  kind: "archivar";
  productId: string;
  productName: string;
  stockQty: string;
  baseUnit: BaseUnit;
}

export type CatalogDraft = PriceDraft | NewProductDraft | MinimumDraft | ArchiveDraft;

export type Draft = WasteDraft | TransferDraft | ReceiptDraft | CountCloseDraft | CatalogDraft;

// Gráficas y análisis -----------------------------------------------------------

export const ANALYTICS_VIEWS = ["resumen", "consumo", "mermas", "stock", "precios", "reposicion", "desvios"] as const;
export type AnalyticsView = (typeof ANALYTICS_VIEWS)[number];

/** Cómo se formatean los valores de una gráfica (las cifras ya vienen formateadas en display). */
export type ChartFormat = "money" | "number" | "days" | "percent";

export interface ChartPoint {
  /** Clave del eje X: fecha YYYY-MM-DD o categoría. */
  x: string;
  /** Etiqueta del eje X para mostrar: "23 sep", "Parador". */
  label: string;
  /** Valor como cadena decimal (calculado con decimal.js). La UI solo lo convierte para posicionar. */
  value: string;
  /** Valor ya formateado en es-ES: "45,00 €", "1,2 días". */
  display: string;
}

export interface ChartSeries {
  key: string;
  name: string;
  points: ChartPoint[];
}

export interface ChartSpec {
  id: string;
  /** line: evolución; column: categorías en vertical; bar: ranking horizontal; diverging: ± alrededor de 0. */
  kind: "line" | "column" | "bar" | "diverging";
  title: string;
  subtitle: string;
  format: ChartFormat;
  series: ChartSeries[];
  /** Línea de referencia (por ejemplo, el horizonte de reposición). */
  reference?: { value: string; label: string };
  /** Texto si no hay datos. */
  empty?: string;
}

export interface Kpi {
  id: string;
  label: string;
  value: string;
  hint?: string;
  delta?: { display: string; direction: "up" | "down" | "flat"; good: boolean };
}

export interface AnalyticsResponse {
  view: AnalyticsView;
  title: string;
  periodLabel: string;
  locationName: string | null;
  kpis: Kpi[];
  charts: ChartSpec[];
  generatedAt: string;
}

// Eventos SSE ----------------------------------------------------------------

export type SseEvent =
  | { event: "decision"; data: DecisionEvent }
  | { event: "text"; data: TextEvent }
  | { event: "navigate"; data: NavigateEvent }
  | { event: "draft"; data: Draft }
  | { event: "chart"; data: ChartSpec }
  | { event: "clarify"; data: ClarifyEvent }
  | { event: "error"; data: ErrorEvent }
  | { event: "done"; data: DoneEvent };

export type Emit = (event: SseEvent) => Promise<void> | void;

// GET /health ----------------------------------------------------------------

export interface HealthResponse {
  status: "ok" | "degradado" | "caido";
  jev: { ok: boolean; model: string | null; latencyMs: number | null };
  writer: { ok: boolean; provider: string; model: string };
  embeddings: { ok: boolean; provider: string; model: string };
  supabase: { ok: boolean };
  contract: string;
}
