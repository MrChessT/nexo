import { Agent } from "../agent/loop";
import { SessionStore } from "../agent/session";
import { LruCache } from "../cache/lru";
import { MemoryAuditSink } from "../audit/audit";
import type { ChatRequest, SseEvent } from "../contract/index";
import { FixtureDataSource, fixtureContext, ORG_ID } from "../dev/fixture";
import { LexicalRetriever } from "../entities/retriever";
import { DEFAULT_THRESHOLDS } from "../gates/thresholds";
import type { JevPort } from "../jev/client";
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

export { choiceAnswer, choiceDist, FakeJev, noulAnswer, scoreAnswer, type Script } from "../dev/fake-jev";

export const NOW = new Date("2026-09-23T12:00:00Z"); // miércoles

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
