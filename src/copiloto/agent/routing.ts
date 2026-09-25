// Preparación de la llamada nº 1: segmentos, candidatos de producto, state mínimo y preguntas.
import type { JsonValue, Questions } from "@typesafe-ai/sdk";
import type { AppRoute } from "../contract/index";
import { areaLabel, type Product, type SessionContext } from "../domain";
import { parseQuantities, type Segment } from "../entities/quantity-parser";
import { tokenSimilarity, type Retriever } from "../entities/retriever";
import { namesAll } from "../entities/mentions";
import { tokenize } from "../entities/normalize";
import { RESERVED_KEYS, routingQuestions, type RoutingState } from "../jev/catalog";
import type { Turn } from "./session";

export const CANDIDATES_PER_SEGMENT = 20;
/** Como mucho estos candidatos por fragmento llegan a Jev (cada uno lleva categoría, notas y formatos). */
const MAX_SHOWN = 12;

/**
 * Candidatos que merece la pena enseñar a Jev: los que se parecen al mejor (≥ 40 % de su puntuación).
 * Si uno destaca («beefeater»), va casi solo: menos tokens y menos opciones con las que dudar.
 */
export function shortlist<C extends { score: number }>(found: C[]): C[] {
  const top = found[0]?.score ?? 0;
  return found.filter((c) => c.score >= top * 0.4).slice(0, MAX_SHOWN);
}

const CONNECTORS = new Set(["a", "al", "de", "del", "desde", "en", "hacia", "para", "el", "la", "los", "las"]);

/**
 * El fragmento tal como lo ve Jev, sin nombres de local o espacio: con «6 cocas de Parador» Jev decía
 * que ningún producto encajaba (0,80); con «6 cocas», Coca-Cola.
 */
export function withoutPlaces(text: string, placeWords: Set<string>): string {
  const words = text.split(/\s+/).filter((w) => {
    const tokens = tokenize(w);
    return tokens.length === 0 || !tokens.every((t) => placeWords.has(t));
  });
  while (words.length > 0 && CONNECTORS.has(tokenize(words[words.length - 1]!).join(" "))) words.pop();
  const kept = words.join(" ").trim();
  return kept.length > 0 ? kept : text;
}

export interface RoutingSegment {
  segment: Segment;
  /** Clave de opción Jev → producto. */
  candidates: Map<string, Product>;
  /** Puntuación de recuperación por clave de opción (para resolver "varios"). */
  scores: Map<string, number>;
}

export interface RoutingMeta {
  segments: RoutingSegment[];
  /** Clave de opción Jev → id de local / espacio. */
  locationKeys: Map<string, string>;
  areaKeys: Map<string, string>;
  /** Mensaje interpretado: la política de confianza busca en él evidencia literal (locales, productos). */
  message?: string;
}

export interface RoutingRequest {
  state: RoutingState;
  questions: Questions;
  meta: RoutingMeta;
}

function optionKey(name: string): string {
  return RESERVED_KEYS.has(name) ? `${name} (producto)` : name;
}

/** Palabras que sitúan en el tiempo («hoy», «la semana pasada», «el finde», «del 3/9»). */
const PERIOD_WORDS = new Set([
  "hoy", "ayer", "anoche", "manana", "semana", "semanas", "semanal", "mes", "meses", "mensual", "finde", "fin", "ano", "dia", "dias",
  "lunes", "martes", "miercoles", "jueves", "viernes", "sabado", "domingo", "quincena", "trimestre", "noche", "ultimo", "ultimos",
  "ultima", "ultimas", "pasado", "pasada", "enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre",
  "setiembre", "octubre", "noviembre", "diciembre", "desde", "hasta", "fecha", "fechas",
]);

export function mentionsPeriod(message: string): boolean {
  return /\b\d{1,2}[/-]\d{1,2}\b/.test(message) || tokenize(message).some((w) => PERIOD_WORDS.has(w));
}

/** Pide ir a una pantalla («llévame a mermas», «abre los informes»): solo entonces se pregunta cuál. */
const SCREEN_WORDS = new Set([
  "lleva", "llevame", "llevarme", "abre", "abreme", "abrir", "ir", "ve", "vete", "voy", "vamos", "pantalla", "pagina", "menu", "entra",
  "entrar", "informe", "informes", "grafica", "graficas", "grafico", "graficos", "navega", "ensename", "pestana",
]);

export function mentionsScreen(message: string): boolean {
  return tokenize(message).some((w) => SCREEN_WORDS.has(w));
}

/** Por qué se da de baja algo: roturas, caducidad, derrames, invitaciones, errores de servicio. */
export function mentionsReason(message: string): boolean {
  return /romp|\brot[oa]s?\b|caduc|derram|invit|error|equivoc|estrope|podri|venci|mal servid|se (?:ha|han) caido|cayo|tirad/.test(tokenize(message).join(" "));
}

/**
 * Palabras que solo se usan para dar algo de baja: el motivo («roto», «caducado», «invitación») o el
 * acto («tira», «tírame», «dala de baja», «pochos»). Sirven para confirmar una merma que Jev ya pone
 * primera; «quita» o «saca» no cuentan (también se dicen de un traspaso).
 */
export function mentionsWaste(message: string): boolean {
  const text = tokenize(message).join(" ");
  return mentionsReason(message) || /\btir(a|as|ame|ala|alo|alas|alos|ar|o|aron|amos)\b|\bde baja\b|\bpoch[oa]s?\b|\bmal(o|a|os|as)\b|\ba la basura\b/.test(text);
}

/**
 * Papel de cada local nombrado según la preposición que lo precede: «del Parador», «desde Pickels» →
 * origen; «al Vivero», «a La Oliva», «hacia…», «para…» → destino. Solo corrobora lo que Jev elige.
 */
export function venueRoles(message: string, locations: string[]): { origin: string | null; destination: string | null } {
  const words = tokenize(message);
  const ORIGIN = new Set(["del", "desde", "de"]);
  const DESTINATION = new Set(["al", "a", "hacia", "para"]);
  const ARTICLES = new Set(["el", "la", "los", "las"]);
  let origin: string | null = null;
  let destination: string | null = null;
  for (const name of locations) {
    const first = tokenize(name).filter((t) => !ARTICLES.has(t))[0];
    if (!first) continue;
    const at = words.findIndex((w) => w === first || (w.length >= 4 && tokenSimilarity(w, first) >= 0.85));
    if (at < 0) continue;
    let k = at - 1;
    while (k >= 0 && ARTICLES.has(words[k]!)) k -= 1;
    const prev = words[k] ?? "";
    if (ORIGIN.has(prev) && origin === null) origin = name;
    else if (DESTINATION.has(prev) && destination === null) destination = name;
  }
  return { origin, destination };
}

/** Palabras genéricas de espacio: «¿qué hay en cada sección?» también pide ver los espacios. */
const AREA_WORDS = ["seccion", "secciones", "espacio", "espacios", "zona", "zonas"];

/** ¿El mensaje nombra algún espacio? Una palabra con sentido de su nombre («barra», «almacen», «camara»). */
export function mentionsArea(message: string, ctx: Pick<SessionContext, "areas">): boolean {
  const words = tokenize(message);
  if (words.some((w) => AREA_WORDS.includes(w))) return true;
  return ctx.areas.some((a) => tokenize(a.name).some((n) => n.length >= 4 && !/^\d+$/.test(n) && words.some((w) => tokenSimilarity(w, n) >= 0.85)));
}

function describe(product: Product): JsonValue {
  return {
    category: product.category,
    ...(product.notes ? { notes: product.notes } : {}),
    formats: product.packs.map((p) => p.name),
  };
}

export async function buildRouting(
  message: string,
  page: AppRoute,
  pageLocationId: string | undefined,
  turns: Turn[],
  ctx: SessionContext,
  retriever: Retriever,
  selfConsistency: boolean,
  /** Título del borrador que espera respuesta: se pregunta si el mensaje lo confirma o cancela. */
  pendingDraft?: string,
): Promise<RoutingRequest> {
  const parsed = parseQuantities(message);
  // Sin cantidades: un segmento "mención" con el mensaje completo, para consultas del tipo "¿cuánto ron queda?".
  const segments: Segment[] = parsed.length > 0 ? parsed : [{ text: message, amount: null, unit: null, productText: message, price: null }];

  // Los nombres de local y de espacio no describen productos («6 cocas de Parador»): fuera de la búsqueda.
  const placeWords = new Set([...ctx.locations.map((l) => l.name), ...ctx.areas.map((a) => a.name)].flatMap((n) => tokenize(n)).filter((w) => w.length >= 3));
  const productQuery = (text: string) => tokenize(text).filter((w) => !placeWords.has(w)).join(" ");
  const routingSegments: RoutingSegment[] = [];
  for (const segment of segments) {
    const found = shortlist(await retriever.retrieve(ctx.products, productQuery(segment.productText || segment.text), CANDIDATES_PER_SEGMENT, ctx.catalogHash));
    if (found.length === 0) continue;
    const candidates = new Map<string, Product>();
    const scores = new Map<string, number>();
    for (const c of found) {
      candidates.set(optionKey(c.product.name), c.product);
      scores.set(optionKey(c.product.name), c.score);
    }
    routingSegments.push({ segment, candidates, scores });
  }
  // Hay cifras pero ninguna va pegada a un producto conocido ("pon el mínimo del Barceló a 6 botellas"):
  // se busca el producto en el mensaje completo, sin cantidad asociada.
  if (routingSegments.length === 0 && parsed.length > 0) {
    const found = shortlist(await retriever.retrieve(ctx.products, productQuery(message), CANDIDATES_PER_SEGMENT, ctx.catalogHash));
    if (found.length > 0) {
      routingSegments.push({
        segment: { text: message, amount: null, unit: null, productText: message, price: null },
        candidates: new Map(found.map((c) => [optionKey(c.product.name), c.product])),
        scores: new Map(found.map((c) => [optionKey(c.product.name), c.score])),
      });
    }
  }

  const locationKeys = new Map(ctx.locations.map((l) => [l.name, l.id]));
  // El espacio solo se pregunta si el mensaje nombra alguno («barra 1», «el almacén»). Si no, Jev tendía
  // a elegir uno por el nombre del local («vivero» → «Vivero · Almacén general») y marcaba dudas.
  const areaKeys = new Map(mentionsArea(message, ctx) ? ctx.areas.map((a) => [areaLabel(a, ctx.locations), a.id]) : []);
  const currentLocation = ctx.locations.find((l) => l.id === pageLocationId)?.name ?? null;

  const state: RoutingState = {
    message,
    ...(pendingDraft ? { pending_draft: pendingDraft } : {}),
    current_page: page,
    current_location: currentLocation,
    recent_turns: turns.slice(-4),
    segments: routingSegments.map((rs) => ({ text: withoutPlaces(rs.segment.text, placeWords), amount: rs.segment.amount, unit: rs.segment.unit })),
  };
  // Solo si el mensaje nombra alguno: Jev no puede saber que «Distribuciones Canarias» es un proveedor.
  const suppliers = ctx.suppliers.filter((s) => namesAll(message, s.name)).map((s) => s.name);
  if (suppliers.length > 0) state.named_suppliers = suppliers;
  const venues = ctx.locations.filter((l) => namesAll(message, l.name)).map((l) => l.name);
  if (venues.length > 0) state.named_venues = venues;

  const questions = routingQuestions({
    pendingDraft: !!pendingDraft,
    // Solo se pregunta lo que el mensaje puede contestar: menos tokens y menos ruido.
    askLocation: ctx.locations.length > 1,
    askPeriod: mentionsPeriod(message),
    askReason: mentionsReason(message),
    askScreen: mentionsScreen(message),
    askFollowUp: turns.length > 0,
    // Con cantidades («pasa 6 cocas») es una operación: no hay «qué dato» que preguntar.
    askAspect: !routingSegments.some((rs) => rs.segment.amount !== null),
    locations: [...locationKeys.keys()],
    areas: [...areaKeys.keys()],
    segments: routingSegments.map((rs) => ({
      candidates: Object.fromEntries([...rs.candidates.entries()].map(([key, product]) => [key, describe(product)])),
      hasAmount: rs.segment.amount !== null,
    })),
    selfConsistency,
  });

  return { state, questions, meta: { segments: routingSegments, locationKeys, areaKeys, message } };
}
