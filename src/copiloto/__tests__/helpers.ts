import type { ChoiceResponse, EntryType, NoulResponse, Questions, ScoreResponse } from "@typesafe-ai/sdk";
import { Agent } from "../agent/loop";
import { SessionStore } from "../agent/session";
import { LruCache } from "../cache/lru";
import { MemoryAuditSink } from "../audit/audit";
import type { ChatRequest, SseEvent } from "../contract/index";
import { FixtureDataSource, fixtureContext, ORG_ID } from "../dev/fixture";
import { LexicalRetriever } from "../entities/retriever";
import { DEFAULT_THRESHOLDS } from "../gates/thresholds";
import type { JevAnswer, JevPort, JevResult } from "../jev/client";
import { JevError } from "../jev/client";
import { Metrics } from "../metrics/metrics";
import { InventoryTools } from "../tools/tools";
import type { ChatMessages, WriterProvider } from "../writer/provider";
import { Writer } from "../writer/writer";
import { DraftBuilder } from "../drafts/builder";
import { DraftStore } from "../drafts/store";
import { ConfirmService } from "../drafts/confirm";
import { FixtureWriter } from "../dev/fixture-writer";
import { randomUUID } from "node:crypto";
import { HabitsStore } from "../agent/habits";

export const NOW = new Date("2026-09-23T12:00:00Z"); // miércoles

export function choiceAnswer(options: string[], winner: string, p = 0.95): ChoiceResponse {
  const n = options.length;
  const rest = n > 1 ? (1 - p) / (n - 1) : 0;
  const probabilities = Object.fromEntries(options.map((o) => [o, o === winner ? p : rest]));
  return { type: "choice", choice: winner, probabilities, confidence: n > 1 ? Math.max(0, (n * p - 1) / (n - 1)) : 1 };
}

/** Distribución explícita (se normaliza el resto entre las demás opciones). */
export function choiceDist(options: string[], dist: Record<string, number>): ChoiceResponse {
  const assigned = Object.values(dist).reduce((a, b) => a + b, 0);
  const others = options.filter((o) => !(o in dist));
  const rest = others.length > 0 ? (1 - assigned) / others.length : 0;
  const probabilities = Object.fromEntries(options.map((o) => [o, dist[o] ?? rest]));
  const [winner, p] = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0]!;
  const n = options.length;
  return { type: "choice", choice: winner, probabilities, confidence: Math.max(0, (n * p - 1) / (n - 1)) };
}

export function noulAnswer(value: number): NoulResponse {
  return { type: "noul", noul: value };
}

export function scoreAnswer(levels: number, value: number, confidence = 0.9): ScoreResponse {
  const probabilities = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), i === Math.round(value) ? 1 : 0]));
  const legend = Object.fromEntries(Array.from({ length: levels }, (_, i) => [String(i), `nivel ${i}`]));
  return { type: "score", score: value, confidence, probabilities, legend } as ScoreResponse;
}

export type Script = Record<string, string | number | { dist: Record<string, number> } | { winner: string; p: number }>;

const DEFAULT_CHOICES = ["no_indicado", "ninguno", "ninguna", "no_aplica"];

/**
 * Jev simulado. Para cada pregunta usa el guion; si no hay guion:
 * choice → opción "vacía" (no_indicado/ninguno…) con 0,95; noul → 0,05; score → 0.
 */
export class FakeJev implements JevPort {
  readonly calls: Array<{ state: EntryType; questions: Questions }> = [];
  fail: JevError | null = null;

  constructor(private readonly scripts: Script[] = []) {}

  private scriptFor(callIndex: number): Script {
    return this.scripts[callIndex] ?? {};
  }

  async evaluate(state: EntryType, questions: Questions): Promise<JevResult> {
    if (this.fail) throw this.fail;
    const script = this.scriptFor(this.calls.length);
    this.calls.push({ state, questions });
    const answers: Record<string, JevAnswer> = {};
    for (const [id, q] of Object.entries(questions)) {
      const s = script[id];
      if (q.type === "choice") {
        const options = Object.keys(q.criteria);
        if (s && typeof s === "object" && "dist" in s) answers[id] = choiceDist(options, s.dist);
        else if (s && typeof s === "object" && "winner" in s) answers[id] = choiceAnswer(options, s.winner, s.p);
        else if (typeof s === "string") {
          if (!options.includes(s)) throw new Error(`Opción ${s} no existe en ${id}: ${options.join(", ")}`);
          answers[id] = choiceAnswer(options, s);
        } else answers[id] = choiceAnswer(options, options.find((o) => DEFAULT_CHOICES.includes(o)) ?? options[0]!);
      } else if (q.type === "noul") {
        answers[id] = noulAnswer(typeof s === "number" ? s : 0.05);
      } else {
        answers[id] = scoreAnswer(q.criteria.length, typeof s === "number" ? s : 0);
      }
    }
    return { model: "jev-fake", answers, usage: { input_tokens: 100, output_tokens: 10 }, cached: false };
  }

  async ping() {
    return { ok: true, model: "jev-fake", latencyMs: 1 };
  }
}

/** LLM simulada: devuelve los fragmentos indicados, uno por intento. */
export class FakeProvider implements WriterProvider {
  readonly name = "fake";
  readonly model = "fake";
  readonly prompts: ChatMessages[] = [];
  fail = false;

  constructor(private readonly attempts: string[][]) {}

  async *stream(messages: ChatMessages): AsyncIterable<string> {
    this.prompts.push(messages);
    if (this.fail) throw new Error("caído");
    const chunks = this.attempts[Math.min(this.prompts.length - 1, this.attempts.length - 1)] ?? [];
    for (const chunk of chunks) yield chunk;
  }

  async ping() {
    return !this.fail;
  }
}

export function makeAgent(jev: JevPort, provider: WriterProvider | null = null) {
  const metrics = new Metrics("0.042");
  const audit = new MemoryAuditSink();
  const sessions = new SessionStore(undefined, new LruCache(100, 60_000));
  const drafts = new DraftStore();
  // Confirmación por chat como en producción: mismo servicio que el botón, escritura simulada.
  const writer = new FixtureWriter();
  const confirmService = new ConfirmService(drafts, audit, () => NOW);
  const agent = new Agent({
    jev,
    tools: new InventoryTools(new FixtureDataSource(NOW)),
    retriever: new LexicalRetriever(),
    writer: new Writer(provider, metrics, { timeoutMs: 2000, attempts: 2 }),
    metrics,
    thresholds: DEFAULT_THRESHOLDS,
    sessions,
    audit,
    selfConsistency: true,
    drafts,
    builder: new DraftBuilder(),
    // Memoria de hábitos aislada por agente: los tests no se contaminan entre sí.
    habits: new HabitsStore(undefined, new LruCache(100, 60_000)),
    confirmDraft: (draftId) => confirmService.confirm({ orgId: ORG_ID, draftId, idempotencyKey: randomUUID() }, fixtureContext(), writer),
    now: () => NOW,
  });
  return { agent, metrics, audit, sessions, drafts, writer, confirmService };
}

export const SESSION_ID = "5b1a3f4e-9c2d-4e8f-a1b2-c3d4e5f6a7b8";

export function chat(message: string, extra: Partial<ChatRequest> = {}): ChatRequest {
  return { orgId: ORG_ID, sessionId: SESSION_ID, message, page: "/", ...extra };
}

export async function run(agent: Agent, req: ChatRequest, role: "staff" | "manager" = "manager"): Promise<SseEvent[]> {
  const events: SseEvent[] = [];
  await agent.handle(req, fixtureContext(role), (e) => {
    events.push(e);
  });
  return events;
}

type EventData = { [K in SseEvent as K["event"]]: K["data"] };

export function find<E extends keyof EventData>(events: SseEvent[], type: E): EventData[E] | undefined {
  return events.find((e) => e.event === type)?.data as EventData[E] | undefined;
}
