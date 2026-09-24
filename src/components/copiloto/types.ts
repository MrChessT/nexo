// Tipos de CONTRACT.md de Nexo Copiloto (versión 1.0.0-draft). La app solo depende de este contrato.

export type AppRoute = "/" | "/productos" | "/stock" | "/recepciones" | "/traspasos" | "/inventarios" | "/mermas" | "/informes";

export type AnalyticsView = "resumen" | "consumo" | "mermas" | "stock" | "precios" | "reposicion" | "desvios";

export interface ChartPoint {
  x: string;
  label: string;
  /** Cadena decimal calculada en el servicio con decimal.js. */
  value: string;
  display: string;
}

export interface ChartSpec {
  id: string;
  kind: "line" | "column" | "bar" | "diverging";
  title: string;
  subtitle: string;
  format: "money" | "number" | "days" | "percent";
  series: Array<{ key: string; name: string; points: ChartPoint[] }>;
  reference?: { value: string; label: string };
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
  locations: Array<{ id: string; name: string }>;
}
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

export interface DecisionEvent {
  messageId: string;
  intent: Decision;
  decisions: Decision[];
  shortcut: boolean;
}

export interface NavigateEvent {
  route: AppRoute;
  filters: { locationId?: string; areaId?: string; productId?: string; status?: string; from?: string; to?: string; q?: string; view?: AnalyticsView; days?: number };
  auto: boolean;
}

export interface ClarifyEvent {
  clarifyId: string;
  question: string;
  field: string;
  options: Array<{ id: string; label: string; probability: number | null }>;
  allowFreeText: boolean;
}

interface QuantityInput {
  amount: string;
  unit: string;
  packId?: string;
}

export interface DraftCheck {
  id: string;
  label: string;
  status: "ok" | "aviso" | "revisar";
  detail: string;
  probability: number | null;
}

interface DraftBase {
  draftId: string;
  title: string;
  requiredRole: string;
  canConfirm: boolean;
  coherence: number;
  warnings: string[];
  editable: string[];
  expiresAt: string;
  checks?: DraftCheck[];
  acknowledged?: boolean;
}

export type Draft =
  | (DraftBase & { kind: "merma"; locationName: string; areaName: string | null; productName: string; qtyBase: string; baseUnit: string; input: QuantityInput; reason: string | null })
  | (DraftBase & {
      kind: "traspaso";
      fromLocationName: string;
      toLocationName: string;
      lines: Array<{ productName: string; qtyBase: string; baseUnit: string; input: QuantityInput }>;
      send: boolean;
    })
  | (DraftBase & {
      kind: "recepcion";
      locationName: string;
      supplierName: string | null;
      docDate: string;
      lines: Array<{ packName: string; productName: string; packsQty: string; packPrice: string | null; priceSource: string | null }>;
    })
  | (DraftBase & {
      kind: "cierre_inventario";
      locationName: string;
      zeroUncounted: boolean;
      asConsumption: boolean;
      preview: {
        countedProducts: number;
        adjustments: Array<{ productName: string; expected: string; counted: string; diff: string; baseUnit: string; diffValue: string }>;
        totalDiffValue: string;
      };
    })
  | (DraftBase & {
      kind: "precio";
      productName: string;
      packName: string;
      packQtyBase: string;
      baseUnit: string;
      supplierName: string;
      oldPrice: string | null;
      newPrice: string;
      unitCost: string;
    })
  | (DraftBase & {
      kind: "producto_nuevo";
      name: string;
      dimension: "mass" | "volume" | "count";
      baseUnit: string;
      categoryName: string | null;
      packName: string | null;
      packQtyBase: string | null;
      supplierName: string | null;
      price: string | null;
      locationNames: string[];
    })
  | (DraftBase & {
      kind: "minimo";
      locationName: string;
      productName: string;
      field: "min_qty" | "par_qty";
      oldValue: string | null;
      newValue: string;
      baseUnit: string;
    })
  | (DraftBase & { kind: "archivar"; productName: string; stockQty: string; baseUnit: string });

export interface ErrorEvent {
  code: string;
  message: string;
  retryable: boolean;
}

export interface DoneEvent {
  messageId: string;
  text: string;
  textSource: "llm" | "plantilla";
  latencyMs: number;
}

export type ConfirmResponse =
  | { ok: true; kind: Draft["kind"]; documentId: string | null; movementIds: string[]; message: string; navigate?: NavigateEvent }
  | { ok: false; code: string; message: string };

export interface Suggestion {
  id: string;
  kind: "stock_bajo" | "traspaso_pendiente" | "desvio_inventario" | "subida_precio";
  urgency: "baja" | "media" | "alta" | "critica";
  text: string;
  action?: NavigateEvent;
}
