// Preparación de la llamada nº 1: segmentos, candidatos de producto, state mínimo y preguntas.
import type { JsonValue, Questions } from "@typesafe-ai/sdk";
import type { AppRoute } from "../contract/index";
import { areaLabel, type Product, type SessionContext } from "../domain";
import { parseQuantities, type Segment } from "../entities/quantity-parser";
import { tokenSimilarity, type Retriever } from "../entities/retriever";
import { tokenize } from "../entities/normalize";
import { RESERVED_KEYS, routingQuestions, type RoutingState } from "../jev/catalog";
import type { Turn } from "./session";

export const CANDIDATES_PER_SEGMENT = 20;

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
}

export interface RoutingRequest {
  state: RoutingState;
  questions: Questions;
  meta: RoutingMeta;
}

function optionKey(name: string): string {
  return RESERVED_KEYS.has(name) ? `${name} (producto)` : name;
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

  const routingSegments: RoutingSegment[] = [];
  for (const segment of segments) {
    const found = await retriever.retrieve(ctx.products, segment.productText || segment.text, CANDIDATES_PER_SEGMENT, ctx.catalogHash);
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
    const found = await retriever.retrieve(ctx.products, message, CANDIDATES_PER_SEGMENT, ctx.catalogHash);
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
    segments: routingSegments.map((rs) => ({ text: rs.segment.text, amount: rs.segment.amount, unit: rs.segment.unit })),
  };

  const questions = routingQuestions({
    pendingDraft: !!pendingDraft,
    locations: [...locationKeys.keys()],
    areas: [...areaKeys.keys()],
    segments: routingSegments.map((rs) => ({
      candidates: Object.fromEntries([...rs.candidates.entries()].map(([key, product]) => [key, describe(product)])),
      hasAmount: rs.segment.amount !== null,
    })),
    selfConsistency,
  });

  return { state, questions, meta: { segments: routingSegments, locationKeys, areaKeys } };
}
