import Decimal from "decimal.js";
import type { GateOutcome } from "../contract/index";

export const STAGES = ["contexto", "jev1", "entidades", "herramientas", "jev2", "redaccion", "total"] as const;
export type Stage = (typeof STAGES)[number];

const WINDOW = 1000;

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)]!;
}

/** Métricas en memoria desde el arranque. Ventana deslizante de las últimas 1000 muestras por etapa. */
export class Metrics {
  readonly since = new Date().toISOString();
  messages = 0;
  shortcuts = 0;
  jevCalls = 0;
  jevInputTokens = 0;
  jevOutputTokens = 0;
  jevCacheHits = 0;
  embedCacheHits = 0;
  contextCacheHits = 0;
  readonly gates: Record<GateOutcome, number> = { actuar: 0, confirmar: 0, preguntar: 0 };
  readonly writer = { llm: 0, plantilla: 0, regenerado: 0 };
  readonly #latency = new Map<Stage, number[]>();

  constructor(private readonly pricePerMtokUsd: string) {}

  recordLatency(stage: Stage, ms: number): void {
    const samples = this.#latency.get(stage) ?? [];
    samples.push(ms);
    if (samples.length > WINDOW) samples.shift();
    this.#latency.set(stage, samples);
  }

  recordJev(usage: { input_tokens: number; output_tokens: number }, cached: boolean): void {
    if (cached) {
      this.jevCacheHits += 1;
      return;
    }
    this.jevCalls += 1;
    this.jevInputTokens += usage.input_tokens;
    this.jevOutputTokens += usage.output_tokens;
  }

  snapshot() {
    const latencyMs = Object.fromEntries(
      STAGES.map((stage) => {
        const sorted = [...(this.#latency.get(stage) ?? [])].sort((a, b) => a - b);
        return [stage, { p50: percentile(sorted, 50), p95: percentile(sorted, 95) }];
      }),
    ) as Record<Stage, { p50: number; p95: number }>;
    return {
      since: this.since,
      messages: this.messages,
      jev: {
        calls: this.jevCalls,
        inputTokens: this.jevInputTokens,
        outputTokens: this.jevOutputTokens,
        estimatedCostUsd: new Decimal(this.jevInputTokens).div(1_000_000).mul(this.pricePerMtokUsd).toFixed(6),
        cacheHits: this.jevCacheHits,
      },
      latencyMs,
      gates: { ...this.gates },
      writer: { ...this.writer },
      shortcuts: this.shortcuts,
      caches: { embeddings: this.embedCacheHits, context: this.contextCacheHits },
    };
  }
}

/** Cronómetro de etapas de un mensaje. */
export class StageTimer {
  readonly #start = performance.now();
  readonly durations: Partial<Record<Stage, number>> = {};

  async time<T>(stage: Stage, fn: () => Promise<T>): Promise<T> {
    const t0 = performance.now();
    try {
      return await fn();
    } finally {
      this.durations[stage] = (this.durations[stage] ?? 0) + Math.round(performance.now() - t0);
    }
  }

  total(): number {
    return Math.round(performance.now() - this.#start);
  }

  flush(metrics: Metrics): void {
    for (const [stage, ms] of Object.entries(this.durations)) metrics.recordLatency(stage as Stage, ms);
    metrics.recordLatency("total", this.total());
  }
}
