# Contrato Nexo Copiloto ↔ Nexo Inventario

Versión del contrato: **1.0.0-draft**. La app solo depende de este documento. El servicio publica estos mismos tipos en `src/contract/` (TypeScript + zod) y valida con ellos toda la entrada y la salida.

## Reglas generales

- **Transporte:** JSON sobre HTTPS. `/chat` responde con `text/event-stream` (SSE).
- **Autenticación:** `Authorization: Bearer <access_token de Supabase del usuario>`. La app lo reenvía desde su route handler proxy. El servicio nunca recibe ni devuelve la API key de Jev ni ninguna clave de servicio.
- **Organización:** cada petición lleva `orgId`. El servicio comprueba la pertenencia con el JWT del usuario (RLS).
- **Cantidades y dinero:** siempre como **cadena decimal** (`"2"`, `"1400.0000"`, `"12.35"`), en unidad base (`g`, `ml`, `ud`) salvo que el campo diga otra cosa. La app las lee con `decimal.js`, nunca con `Number()`.
- **Probabilidades y confianza:** `number` entre 0 y 1. No son cantidades de inventario.
- **Fechas:** ISO 8601 con zona horaria (`2026-09-23T10:15:00+02:00`). Los días de negocio van como `YYYY-MM-DD`.
- **Idioma:** los textos para mostrar (`label`, `text`, `message`) llegan ya en español.
- **Compatibilidad:** los campos nuevos serán opcionales. Un cambio incompatible sube la versión mayor, que el servicio anuncia en la cabecera `X-Nexo-Contract`.

## Tipos comunes

```ts
type Decimal = string;                    // "12.5000"
type Uuid = string;
type Role = "owner" | "admin" | "manager" | "staff";   // enum member_role de la BD
type AppRoute = "/" | "/productos" | "/stock" | "/recepciones" | "/traspasos" | "/inventarios" | "/mermas" | "/informes";
type BaseUnit = "g" | "ml" | "ud";

type GateOutcome = "actuar" | "confirmar" | "preguntar";

interface Decision {
  id: string;                  // id de la pregunta Jev, p. ej. "intent", "producto_0"
  label: string;               // "Intención", "Producto"…
  value: string;               // opción elegida (clave interna)
  valueLabel: string;          // texto legible: "Registrar merma", "Ron Barceló 70 cl"
  probability: number;         // probabilidad de la opción elegida (o valor noul)
  confidence: number | null;   // confianza de Jev (null en noul)
  gate: GateOutcome;
}
```

## POST /chat

### Request

```ts
interface ChatRequest {
  orgId: Uuid;
  sessionId: Uuid;               // lo genera la app y lo mantiene mientras el panel siga abierto
  message: string;               // 1..1000 caracteres
  page: AppRoute;                // página actual
  pageContext?: {                // filtros activos en la página, si los hay
    locationId?: Uuid;
    areaId?: Uuid;
  };
  clarification?: {              // respuesta a un evento `clarify` anterior
    clarifyId: string;
    optionId: string;            // una de las opciones ofrecidas o "otra"
    freeText?: string;           // solo si optionId === "otra"
  };
}
```

Los atajos deterministas viajan como `message` normal y el servicio los resuelve sin llamar a Jev:

| Atajo | Qué hace |
| --- | --- |
| `/stock [producto] [local]` | Consulta stock (sin texto: navega a /stock) |
| `/movimientos [producto]` | Movimientos de los últimos 7 días |
| `/precios [producto]` | Precios y subidas |
| `/pendientes` | Traspasos en tránsito |
| `/desvios` | Desvíos de inventario |
| `/reponer`, `/falta` | Qué reponer en los próximos 3 días |
| `/inicio`, `/productos`, `/recepciones`, `/traspasos`, `/inventarios`, `/mermas` | Navegación |
| `/ayuda` | Qué sabe hacer el asistente |

Para responder a un `clarify`, la app envía el mismo `sessionId`, `clarification: { clarifyId, optionId }` y, en `message`, la etiqueta elegida (se usa solo si `optionId` es `"otra"`).

### Eventos SSE

Cada evento tiene `event: <tipo>` y `data: <JSON>`. Orden típico: `decision` → `chart`? → (`navigate` | `draft` | `clarify`)? → `text`* → `done`. `error` puede llegar en cualquier momento y cierra el stream.

```ts
// event: decision — lo que ha decidido Jev (una vez por mensaje)
interface DecisionEvent {
  messageId: Uuid;
  intent: Decision;
  decisions: Decision[];       // resto de decisiones relevantes (local, producto, herramienta…)
  shortcut: boolean;           // true si se resolvió por atajo, sin Jev
}

// event: text — fragmentos de la respuesta redactada (cada fragmento ya ha pasado el verificador de cifras)
interface TextEvent {
  delta: string;
  reset?: boolean;             // true: borra el texto recibido hasta ahora y empieza por este fragmento
}

// event: navigate — la app navega (o propone navegar) a una ruta con filtros
interface NavigateEvent {
  route: AppRoute;
  filters: {
    locationId?: Uuid;
    areaId?: Uuid;
    productId?: Uuid;
    status?: string;           // p. ej. "in_transit" en /traspasos
    from?: string;             // YYYY-MM-DD
    to?: string;               // YYYY-MM-DD
    q?: string;                // texto de búsqueda
    view?: AnalyticsView;      // vista de /informes (resumen, consumo, mermas, stock, precios, reposicion, desvios)
    days?: number;             // periodo de /informes: 7, 30 o 90
  };
  auto: boolean;               // true: navegar ya. false: mostrar botón "Ir a…"
}

// event: draft — borrador validado, pendiente del clic del usuario
type DraftEvent = Draft;

// event: clarify — falta información o la confianza no llega al umbral
interface ClarifyEvent {
  clarifyId: string;
  question: string;            // "¿Qué ron quieres dar de baja?"
  field: "intent" | "local" | "espacio" | "producto" | "cantidad" | "tipo_accion" | "destino" | "local_destino" | "herramienta";
  options: Array<{ id: string; label: string; probability: number | null }>;   // 2-3 opciones más probables
  allowFreeText: boolean;
}

// event: chart — gráfica calculada por el servicio (decimal.js) que acompaña a una consulta
type ChartEvent = ChartSpec;   // ver «Gráficas y análisis»

// event: error
interface ErrorEvent {
  code: "unauthenticated" | "forbidden" | "rate_limited" | "invalid_request"
      | "jev_unavailable" | "data_unavailable" | "internal";
  message: string;             // en español, apto para mostrar
  retryable: boolean;
}

// event: done — cierre del mensaje
interface DoneEvent {
  messageId: Uuid;
  text: string;                // texto final completo (tras el verificador)
  textSource: "llm" | "plantilla";
  latencyMs: number;
}
```

## Borradores

Los genera el servicio y los guarda en su lado con un TTL de 15 minutos. La app solo recibe una copia para mostrarla: al confirmar envía el `draftId` y, como mucho, los campos editables de la lista blanca. Así el borrador no se puede alterar desde el cliente.

```ts
interface QuantityInput {
  amount: Decimal;             // lo que dijo el usuario: "2"
  unit: string;                // "botella", "caja", "kg", "ud"…
  packId?: Uuid;               // formato usado para convertir, si lo hay
}

interface DraftBase {
  draftId: Uuid;
  kind: "merma" | "traspaso" | "recepcion" | "cierre_inventario";
  title: string;               // "Merma: 2 botellas de Ron Barceló 70 cl"
  requiredRole: Role;          // rol mínimo para confirmar
  canConfirm: boolean;         // el rol del usuario ya se ha comprobado
  coherence: number;           // noul de Jev: ¿el borrador hace lo que pidió el usuario?
  warnings: string[];          // p. ej. "El precio viene del último albarán; revísalo"
  editable: string[];          // rutas de campos que el usuario puede editar antes de confirmar
  expiresAt: string;
}

interface WasteDraft extends DraftBase {
  kind: "merma";
  locationId: Uuid; locationName: string;
  areaId: Uuid | null; areaName: string | null;
  productId: Uuid; productName: string;
  qtyBase: Decimal; baseUnit: BaseUnit;
  input: QuantityInput;
  reason: string | null;       // "rotura", "caducidad"…
}                              // → RPC register_movement(p_type = 'waste')

interface TransferDraft extends DraftBase {
  kind: "traspaso";
  fromLocationId: Uuid; fromLocationName: string;
  toLocationId: Uuid; toLocationName: string;
  lines: Array<{ productId: Uuid; productName: string; qtyBase: Decimal; baseUnit: BaseUnit; input: QuantityInput }>;
  send: boolean;               // true = crear y enviar (send_transfer, requiere manager); false = solo borrador
  note: string | null;
}                              // → insert transfers/transfer_lines (draft) + RPC send_transfer

interface ReceiptDraft extends DraftBase {
  kind: "recepcion";
  locationId: Uuid; locationName: string;
  supplierId: Uuid | null; supplierName: string | null;
  docNumber: string | null; docDate: string;
  lines: Array<{
    packId: Uuid; packName: string; productId: Uuid; productName: string;
    packsQty: Decimal;
    packPrice: Decimal | null; // null = desconocido: la app obliga a rellenarlo
    priceSource: "ultimo_precio" | "usuario" | null;
  }>;
}                              // → insert goods_receipts/receipt_lines + RPC post_receipt

interface CountCloseDraft extends DraftBase {
  kind: "cierre_inventario";
  countId: Uuid; locationId: Uuid; locationName: string;
  zeroUncounted: boolean;      // por defecto false; la app lo muestra de forma explícita
  preview: {
    countedProducts: number;
    adjustments: Array<{ productId: Uuid; productName: string; expected: Decimal; counted: Decimal; diff: Decimal; baseUnit: BaseUnit; diffValue: Decimal }>;
    totalDiffValue: Decimal;
  };
}                              // → RPC close_count

type Draft = WasteDraft | TransferDraft | ReceiptDraft | CountCloseDraft;
```

## POST /actions/confirm

```ts
interface ConfirmRequest {
  orgId: Uuid;
  draftId: Uuid;
  idempotencyKey: Uuid;        // lo genera la app por clic; se usa como p_client_ref cuando la RPC lo admite
  edits?: Record<string, string | boolean | null>;   // solo rutas presentes en draft.editable
}

type ConfirmResponse =
  | { ok: true; kind: Draft["kind"]; documentId: Uuid | null; movementIds: string[]; message: string; navigate?: NavigateEvent }
  | { ok: false; code: ConfirmErrorCode; message: string };

type ConfirmErrorCode =
  | "draft_not_found" | "draft_expired" | "invalid_edit" | "forbidden"
  // códigos de las RPC (src/lib/errors.ts de la app):
  | "unauthenticated" | "not_found" | "invalid_status" | "empty_transfer" | "empty_receipt"
  | "type_not_allowed" | "invalid_quantity" | "cross_organization_link" | "cross_location_link"
  | "internal";
```

La confirmación se ejecuta con el JWT del usuario. Las RPC y el RLS vuelven a comprobar los permisos. Repetir la petición con el mismo `idempotencyKey` devuelve el mismo resultado.

**Estados HTTP:**

| Estado | Cuándo |
| --- | --- |
| 200 | `ok: true`. |
| 403 | `forbidden`: el rol no alcanza `requiredRole` o la RPC lo rechaza. |
| 404 | `draft_not_found` o `draft_expired`: el borrador caduca a los 15 min y solo se confirma una vez. |
| 422 | Cualquier otro error: la edición no es válida, falta un precio o la RPC falla. |

**Ediciones (`edits`):**
- Solo se admiten las rutas que aparecen en `draft.editable`. En las líneas, `*` es el índice: `lines.0.packPrice`.
- Las cantidades y los precios van como cadena decimal con punto (`"12.50"`).
- Tras editar, el borrador se valida de nuevo con zod.
- Un `staff` no puede poner `send: true` en un traspaso.

**Ejecución por tipo:**

| Tipo | Qué hace |
| --- | --- |
| `merma` | `register_movement(p_type = 'waste')`, con `p_client_ref = idempotencyKey`. |
| `traspaso` | Inserta `transfers` y `transfer_lines` en `draft`. Si `send`, llama a `send_transfer`; si el envío falla, borra el borrador creado. |
| `recepcion` | Inserta `goods_receipts` y `receipt_lines`, y llama a `post_receipt`. Si falla, borra la recepción abierta. |
| `cierre_inventario` | `close_count(p_count, p_zero_uncounted)`. |

## Respuestas a `clarify`

| Caso | Qué envía la app |
| --- | --- |
| Opción de la lista | `optionId` = el `id` de la opción. |
| Formato de cantidad | Las opciones llegan como `"pack:<uuid>"`; la app devuelve ese mismo `id`. |
| Cantidad dudosa | La opción `"si"` confirma la cantidad que se entendió. |
| Texto libre | `optionId: "otra"` y el texto en `freeText`. También se usa cuando `options` viene vacío. El servicio lo añade al mensaje original y vuelve a enrutar. |

## Gráficas y análisis

Las cifras se calculan en el servicio con decimal.js. `value` es la cadena decimal exacta y `display` el texto ya formateado en es-ES. La UI solo convierte `value` a número para posicionar las marcas.

```ts
type AnalyticsView = "resumen" | "consumo" | "mermas" | "stock" | "precios" | "reposicion" | "desvios";

interface ChartSpec {
  id: string;
  kind: "line" | "column" | "bar" | "diverging";   // evolución · categorías · ranking · ± alrededor de 0
  title: string;
  subtitle: string;
  format: "money" | "number" | "days" | "percent";
  series: Array<{ key: string; name: string; points: Array<{ x: string; label: string; value: Decimal; display: string }> }>;
  reference?: { value: Decimal; label: string };  // p. ej. horizonte de reposición
  empty?: string;                                  // sin datos
}

interface Kpi { id: string; label: string; value: string; hint?: string; delta?: { display: string; direction: "up" | "down" | "flat"; good: boolean } }
```

### GET /analytics

`GET /analytics?orgId=<uuid>&vista=<AnalyticsView>&dias=7|30|90&locationId=<uuid opcional>&productId=<uuid opcional>`

```ts
interface AnalyticsResponse {
  view: AnalyticsView;
  title: string;
  periodLabel: string;
  locationName: string | null;
  kpis: Kpi[];
  charts: ChartSpec[];
  generatedAt: string;
  locations: Array<{ id: string; name: string }>;   // para el selector de local
}
```

Qué incluye cada vista:

| Vista | Contenido |
| --- | --- |
| `resumen` | Valor del stock, consumo, mermas y bajo mínimo; consumo diario por local, stock por local y productos con más merma |
| `consumo` | Consumo diario y productos con más consumo |
| `mermas` | Mermas diarias y productos con más merma |
| `stock` | Valor por local y productos con más valor |
| `precios` | Variación del último precio (divergente) y evolución del precio de compra |
| `reposicion` | Días de cobertura con el horizonte como referencia |
| `desvios` | Desvíos de inventario en valor (divergente) |

La serie diaria termina ayer, porque el día en curso está incompleto. Cada gráfica lleva como máximo 4 series, con colores en orden fijo y validados para daltonismo.

## GET /suggestions

`GET /suggestions?orgId=<uuid>&locationId=<uuid opcional>&limit=<1..20, por defecto 8>`

```ts
interface SuggestionsResponse {
  generatedAt: string;
  items: Suggestion[];         // ya ordenadas por urgencia y confianza
}

interface Suggestion {
  id: string;                  // estable para el mismo candidato: "stock_bajo:<loc>:<prod>"
  kind: "stock_bajo" | "traspaso_pendiente" | "desvio_inventario" | "subida_precio";
  urgency: "baja" | "media" | "alta" | "critica";
  urgencyScore: number;        // score de Jev, de 0 a 3
  confidence: number;          // confianza del score
  relevance: number;           // noul de Jev: ¿merece atención?
  text: string;                // una línea redactada, verificada contra `data`
  data: Record<string, Decimal | string>;   // cifras calculadas por el código
  locationId: Uuid | null;
  action?: NavigateEvent;      // "Ver en Stock", "Ir al traspaso"
}
```

## GET /health

```ts
interface HealthResponse {
  status: "ok" | "degradado" | "caido";
  jev: { ok: boolean; model: string | null; latencyMs: number | null };
  writer: { ok: boolean; provider: string; model: string };     // si falla → plantillas
  embeddings: { ok: boolean; provider: string; model: string }; // si falla → búsqueda léxica
  supabase: { ok: boolean };
  contract: string;
}
```

## GET /metrics

Solo para administración: requiere `METRICS_TOKEN` en la cabecera `Authorization`. La app no lo usa.

```ts
interface MetricsResponse {
  since: string;
  messages: number;
  jev: { calls: number; inputTokens: number; outputTokens: number; estimatedCostUsd: string; cacheHits: number };
  latencyMs: Record<"contexto" | "jev1" | "entidades" | "herramientas" | "jev2" | "redaccion" | "total", { p50: number; p95: number }>;
  gates: Record<GateOutcome, number>;
  writer: { llm: number; plantilla: number; regenerado: number };
  shortcuts: number;
}
```

## Errores HTTP

| Estado | Cuándo |
| --- | --- |
| 400 | La petición no cumple el esquema zod. |
| 401 | Falta el JWT o no es válido. |
| 403 | El usuario no pertenece a `orgId` o no tiene el rol necesario. |
| 429 | Se ha superado el límite por usuario. Incluye la cabecera `Retry-After`. |
| 503 | Jev o Supabase no están disponibles. `/chat` degrada a atajos y plantillas siempre que puede. |
