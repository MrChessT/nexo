// Motor de sugerencias proactivas: el código calcula los candidatos → Jev valora relevancia y urgencia
// en UNA petición → se ordenan → una línea por sugerencia (LLM verificada o plantilla).
import Decimal from "decimal.js";
import { LruCache } from "../cache/lru";
import { formatMoney } from "../entities/units";
import type { AppRoute, NavigateEvent } from "../contract/index";
import type { SessionContext } from "../domain";
import { asNoul, asScore } from "../gates/gate";
import type { Thresholds } from "../gates/thresholds";
import { evaluationQuestions, URGENCY_KEYS, type EvalKind, type Urgency } from "../jev/catalog";
import type { JevPort } from "../jev/client";
import type { Metrics } from "../metrics/metrics";
import { addDays, businessDay } from "../tools/periods";
import type { ToolName, Tools } from "../tools/tools";
import type { EvalItem, ToolParams } from "../tools/types";
import type { Writer } from "../writer/writer";

export interface Suggestion {
  id: string;
  kind: "stock_bajo" | "traspaso_pendiente" | "desvio_inventario" | "subida_precio" | "pedido_pendiente" | "inventario_pendiente";
  urgency: Urgency;
  urgencyScore: number;
  confidence: number;
  relevance: number;
  text: string;
  data: Record<string, string>;
  locationId: string | null;
  action?: NavigateEvent;
}

export interface SuggestionsResponse {
  generatedAt: string;
  items: Suggestion[];
}

/** Máximo de candidatos que se valoran en la única llamada a Jev. */
const MAX_CANDIDATES = 40;
const CACHE_TTL_MS = 5 * 60 * 1000;

const KIND: Record<EvalKind, Suggestion["kind"]> = {
  reponer: "stock_bajo",
  atasco: "traspaso_pendiente",
  desvio: "desvio_inventario",
  subida: "subida_precio",
  pedido: "pedido_pendiente",
  conteo: "inventario_pendiente",
};

const ROUTE: Record<EvalKind, AppRoute> = {
  reponer: "/stock",
  atasco: "/traspasos",
  desvio: "/inventarios",
  subida: "/productos",
  pedido: "/pedidos",
  conteo: "/inventarios",
};

const SOURCES: ToolName[] = ["query_reorder", "query_pending_transfers", "query_count_variance", "query_prices", "query_orders"];

/** Días sin inventario a partir de los cuales se propone contar. */
const COUNT_STALE_DAYS = 14;

/** Línea determinista por tipo; solo usa cifras de `data`. */
export function suggestionTemplate(kind: EvalKind, d: Record<string, string>): string {
  switch (kind) {
    case "reponer":
      return `${d.product} en ${d.venue}: quedan ${d.stock} (mínimo ${d.minimum}); conviene pedir ${d.suggested}.`;
    case "atasco":
      return `Traspaso ${d.from} → ${d.to} sin recibir desde hace ${d.sent_ago} (${d.value}).`;
    case "desvio":
      return `Desvío en ${d.product} (${d.venue}): ${d.diff}, ${d.diff_value}.`;
    case "subida":
      return `${d.product} ha subido de ${d.old_price} a ${d.new_price} (${d.change_pct}) con ${d.supplier}.`;
    case "pedido":
      return d.state === "borrador"
        ? `Pedido a ${d.supplier} para ${d.venue} en borrador desde hace ${d.age}: envíalo o descártalo.`
        : `Pedido a ${d.supplier} para ${d.venue} con retraso (entrega ${d.expected}, ${d.value}).`;
    case "conteo":
      return `${d.venue}: ${d.days_since_count} sin inventario, con ${d.stock_value} en stock.`;
  }
}

export interface SuggestionDeps {
  jev: JevPort;
  writer: Writer;
  metrics: Metrics;
  thresholds: Thresholds;
  now?: () => Date;
}

export class SuggestionEngine {
  readonly #cache = new LruCache<SuggestionsResponse>(1000, CACHE_TTL_MS);

  constructor(private readonly deps: SuggestionDeps) {}

  async suggest(ctx: SessionContext, tools: Tools, options: { locationId?: string; limit: number }): Promise<SuggestionsResponse> {
    const key = `${ctx.userId}:${ctx.orgId}:${options.locationId ?? "*"}:${options.limit}`;
    const cached = this.#cache.get(key);
    if (cached) return cached;

    const now = this.deps.now?.() ?? new Date();
    const locationIds = options.locationId ? [options.locationId] : ctx.locations.map((l) => l.id);
    const today = businessDay(now, "Europe/Madrid", "06:00");
    const params: ToolParams = {
      locationIds,
      areaId: null,
      productIds: [],
      period: { from: addDays(today, -30), to: today, label: "los últimos 30 días" },
      horizonDays: 3,
      horizonLabel: "los próximos 3 días",
      now,
    };

    // 1. Candidatos calculados por el código (sin Jev).
    const results = await Promise.all(SOURCES.map((tool) => tools.run(tool, params, ctx)));
    const candidates: EvalItem[] = [...results.flatMap((r) => r.evalItems), ...(await this.staleCounts(tools, locationIds, ctx, now))].slice(0, MAX_CANDIDATES);
    if (candidates.length === 0) return this.remember(key, { generatedAt: now.toISOString(), items: [] });

    // 2. Jev: relevancia (noul) + urgencia (score) de todos en UNA petición.
    const state = { request: "What should the manager of these hospitality venues pay attention to now?", horizon: params.horizonLabel, items: candidates.map((c) => c.data) };
    const { answers } = await this.deps.jev.evaluate(state, evaluationQuestions(candidates.map((c) => c.kind), false));

    const min = this.deps.thresholds.sugerencia.act;
    const scored = candidates
      .map((item, i) => {
        const relevance = asNoul(answers[`${item.kind}_${i}`])?.noul ?? 0;
        const urgency = asScore(answers[`urgencia_${i}`]);
        const urgencyScore = urgency?.score ?? 0;
        return { item, relevance, urgencyScore, confidence: urgency?.confidence ?? 0, level: URGENCY_KEYS[Math.max(0, Math.min(3, Math.round(urgencyScore)))]! };
      })
      .filter((s) => s.relevance >= min)
      .sort((a, b) => b.urgencyScore * b.relevance - a.urgencyScore * a.relevance || b.confidence - a.confidence)
      .slice(0, options.limit);

    // 3. Una línea por sugerencia: LLM verificada contra sus cifras o plantilla.
    const items: Suggestion[] = await Promise.all(
      scored.map(async (s) => {
        const template = suggestionTemplate(s.item.kind, s.item.data);
        const text = await this.deps.writer.line(s.item.data, template);
        return {
          id: s.item.key,
          kind: KIND[s.item.kind],
          urgency: s.level,
          urgencyScore: Math.round(s.urgencyScore * 100) / 100,
          confidence: Math.round(s.confidence * 100) / 100,
          relevance: Math.round(s.relevance * 100) / 100,
          text,
          data: s.item.data,
          locationId: s.item.locationId,
          action: { route: ROUTE[s.item.kind], filters: s.item.locationId ? { locationId: s.item.locationId } : {}, auto: false },
        };
      }),
    );
    return this.remember(key, { generatedAt: now.toISOString(), items });
  }

  /** Locales con stock que llevan más de COUNT_STALE_DAYS sin cerrar un inventario. */
  private async staleCounts(tools: Tools, locationIds: string[], ctx: SessionContext, now: Date): Promise<EvalItem[]> {
    const since = new Date(now.getTime() - 60 * 86_400_000).toISOString();
    const [results, balances] = await Promise.all([tools.source.countResults({ locationIds, since }), tools.source.balances({ locationIds })]);
    const lastCount = new Map<string, string>();
    for (const r of results) if ((lastCount.get(r.locationId) ?? "") < r.closedAt) lastCount.set(r.locationId, r.closedAt);
    const items: EvalItem[] = [];
    for (const locationId of locationIds) {
      const value = balances.filter((b) => b.locationId === locationId).reduce((acc, b) => acc.plus(new Decimal(b.qty).mul(b.avgCost)), new Decimal(0));
      if (value.lte(0)) continue;
      const last = lastCount.get(locationId);
      const days = last ? Math.floor((now.getTime() - new Date(last).getTime()) / 86_400_000) : null;
      if (days !== null && days < COUNT_STALE_DAYS) continue;
      items.push({
        kind: "conteo",
        key: `conteo:${locationId}`,
        locationId,
        data: {
          venue: ctx.locations.find((l) => l.id === locationId)?.name ?? "local",
          days_since_count: days === null ? "más de 60 días" : `${days} días`,
          stock_value: formatMoney(value),
        },
      });
    }
    return items;
  }

  private remember(key: string, value: SuggestionsResponse): SuggestionsResponse {
    this.#cache.set(key, value);
    return value;
  }
}
