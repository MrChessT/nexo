// Conversaciones de varios turnos con el catálogo real de Vivero 55, de principio a fin por el agente
// (aclaraciones, respuestas escritas o con botón, borradores, confirmación por chat).
//
//   npm run copiloto:conversaciones            → Jev simulado con el guion de cada turno (sin claves):
//                                                prueba el recorrido, no las decisiones de Jev.
//   npm run copiloto:conversaciones -- --real  → Jev REAL (TYPESAFE_API_KEY, AI_GATEWAY_API_KEY o
//                                                VERCEL_OIDC_TOKEN): mide las decisiones de verdad.
//
// Escribe la transcripción en consola (y con --real también en docs/copiloto/CONVERSACIONES.md).
import { randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryType, Questions } from "@typesafe-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { HabitsStore } from "../agent/habits";
import { Agent } from "../agent/loop";
import { SessionStore } from "../agent/session";
import { MemoryAuditSink } from "../audit/audit";
import { LruCache } from "../cache/lru";
import { loadConfig } from "../config";
import type { ClarifyEvent, SseEvent } from "../contract/index";
import { FakeJev, type Script } from "../dev/fake-jev";
import { FixtureDataSource, fixtureContext, ORG_ID } from "../dev/fixture";
import { FixtureWriter } from "../dev/fixture-writer";
import { viveroProducts } from "../dev/vivero-catalog";
import type { Product, SessionContext } from "../domain";
import { DraftBuilder } from "../drafts/builder";
import { ConfirmService } from "../drafts/confirm";
import { DraftStore } from "../drafts/store";
import { LexicalRetriever } from "../entities/retriever";
import { loadThresholds } from "../gates/thresholds";
import { CATALOG_VERSION } from "../jev/catalog";
import { JevClient, type JevPort, type JevResult } from "../jev/client";
import { Metrics } from "../metrics/metrics";
import { InventoryTools } from "../tools/tools";
import type { BalanceRaw, DataFilter } from "../tools/types";
import { Writer } from "../writer/writer";

interface Expectation {
  aclaracion?: string;
  /** Opciones que deben aparecer (por su texto) en la aclaración. */
  opciones?: string[];
  borrador?: string;
  /** Texto que debe contener el título del borrador. */
  titulo?: string;
  consulta?: boolean;
  resuelto?: "confirmado" | "descartado";
  navegar?: string;
  /** Texto que debe contener la respuesta final. */
  texto?: string;
}

interface Turn {
  /** Mensaje del usuario. Si hay una aclaración abierta, se manda como respuesta escrita. */
  usuario?: string;
  /** Pulsa la opción de la aclaración abierta con este texto. */
  boton?: string;
  /** Guion de Jev para la llamada nº 1 de este turno (solo en modo simulado). */
  jev?: Script;
  espera: Expectation;
}

interface Conversation {
  nombre: string;
  turnos: Turn[];
}

const NOW = new Date("2026-09-23T12:00:00Z");

function loadConversations(): Conversation[] {
  return JSON.parse(readFileSync(join(process.cwd(), "src/copiloto/eval/conversaciones.json"), "utf8")) as Conversation[];
}

/** Datos del ejemplo más stock inventado (una caja) de cada producto del catálogo real en cada local. */
class ViveroDataSource extends FixtureDataSource {
  constructor(
    now: Date,
    private readonly products: Product[],
    private readonly locationIds: string[],
    private readonly areas: SessionContext["areas"],
  ) {
    super(now);
  }

  override async balances(filter: DataFilter): Promise<BalanceRaw[]> {
    const own = await super.balances(filter);
    const extra = this.products
      .filter((p) => !filter.productIds || filter.productIds.includes(p.id))
      .flatMap((p) => {
        const pack = p.packs.find((k) => !k.isCountDefault) ?? p.packs[0];
        const qty = String(Number(pack?.qtyBase ?? "1") * 2);
        return this.locationIds.filter((l) => filter.locationIds.includes(l)).map((locationId) => ({ locationId, productId: p.id, qty, avgCost: "0.02" }));
      });
    return [...own, ...extra];
  }

  /** En cada local, los productos del catálogo real se reparten entre sus espacios. */
  override async areaBalances(areaId: string, productIds?: string[]) {
    const own = await super.areaBalances(areaId, productIds);
    const area = this.areas.find((a) => a.id === areaId);
    if (!area) return own;
    const siblings = this.areas.filter((a) => a.locationId === area.locationId);
    const extra = this.products
      .filter((p, i) => (!productIds || productIds.includes(p.id)) && siblings[i % siblings.length]?.id === areaId)
      .map((p) => {
        const pack = p.packs.find((k) => !k.isCountDefault) ?? p.packs[0];
        return { areaId, productId: p.id, qty: String(Number(pack?.qtyBase ?? "1") * 2), avgCost: "0.02" };
      });
    return [...own, ...extra];
  }
}

/** Jev simulado por turno: la llamada nº 1 usa el guion del turno; la coherencia sale bien. */
class TurnJev implements JevPort {
  script: Script = {};
  async evaluate(state: EntryType, questions: Questions): Promise<JevResult> {
    const script: Script = "intent" in questions ? this.script : "coherencia" in questions ? { coherencia: 0.95 } : {};
    return new FakeJev([script]).evaluate(state, questions);
  }
  async ping() {
    return { ok: true, model: "simulado", latencyMs: 0 };
  }
}

function realJev(metrics: Metrics): JevPort {
  const config = loadConfig();
  if (!config.jev.apiKey && !config.jev.oidc) throw new Error("Falta TYPESAFE_API_KEY, AI_GATEWAY_API_KEY o VERCEL_OIDC_TOKEN en .env.local");
  return new JevClient({
    apiKey: config.jev.oidc ? () => getVercelOidcToken() : config.jev.apiKey,
    baseURL: config.jev.baseURL,
    model: config.jev.model,
    timeoutMs: 20_000,
    maxRetries: 3,
    cacheTtlMs: 0,
    cache: new LruCache<JevResult>(1, 1),
    metrics,
  });
}

function check(e: Expectation, events: SseEvent[]): string[] {
  const get = <T>(type: SseEvent["event"]) => events.find((x) => x.event === type)?.data as T | undefined;
  const clarify = get<ClarifyEvent>("clarify");
  const draft = get<{ kind: string; title: string }>("draft");
  const resolved = get<{ status: string }>("resolved");
  const done = get<{ text: string }>("done");
  const error = get<{ message: string }>("error");
  const navigate = events.filter((x) => x.event === "navigate").map((x) => x.data as { route: string; auto: boolean });
  const problems: string[] = [];
  if (error) problems.push(`error: ${error.message}`);
  if (e.aclaracion !== undefined) {
    if (clarify?.field !== e.aclaracion) problems.push(`esperaba una pregunta de «${e.aclaracion}» y ${clarify ? `preguntó por «${clarify.field}»` : "no preguntó"}`);
    for (const o of e.opciones ?? []) if (!clarify?.options.some((x) => x.label === o)) problems.push(`falta la opción «${o}»`);
  } else if (clarify) problems.push(`preguntó de más: «${clarify.question}»`);
  if (e.borrador !== undefined) {
    if (draft?.kind !== e.borrador) problems.push(`esperaba un borrador de ${e.borrador}${draft ? `, no de ${draft.kind}` : ""}`);
    else if (e.titulo && !draft.title.includes(e.titulo)) problems.push(`el borrador no dice «${e.titulo}»: ${draft.title}`);
  }
  if (e.resuelto !== undefined && resolved?.status !== e.resuelto) problems.push(`esperaba el borrador ${e.resuelto}`);
  if (e.navegar !== undefined && !navigate.some((n) => n.route === e.navegar && n.auto)) problems.push(`esperaba ir a ${e.navegar}`);
  if (e.consulta && (!done || clarify || draft)) problems.push("esperaba una consulta respondida");
  if (e.texto && !done?.text.includes(e.texto)) problems.push(`la respuesta no dice «${e.texto}»`);
  return problems;
}

/** Ejecuta todas las conversaciones. Devuelve la transcripción y cuántos turnos no salieron como se esperaba. */
export async function runConversations(real = false): Promise<{ report: string; turns: number; failed: number }> {
  const conversations = loadConversations();
  const metrics = new Metrics("0.042");
  const products = viveroProducts();
  const base = fixtureContext("manager");
  const ctx: SessionContext = { ...base, products, catalogHash: `vivero-${CATALOG_VERSION}` };
  const turnJev = new TurnJev();
  const jev = real ? realJev(metrics) : turnJev;
  const lines: string[] = [`# Conversaciones de prueba`, ``, `Catálogo real de Vivero 55 · ${real ? "Jev REAL" : "Jev simulado (guion por turno)"} · catálogo Jev ${CATALOG_VERSION} · ${new Date().toISOString()}`, ``];
  let turns = 0;
  let failed = 0;

  for (const conv of conversations) {
    const audit = new MemoryAuditSink();
    const drafts = new DraftStore();
    const confirmService = new ConfirmService(drafts, audit, () => NOW);
    const agent = new Agent({
      jev,
      tools: new InventoryTools(new ViveroDataSource(NOW, products, ctx.locations.map((l) => l.id), ctx.areas)),
      retriever: new LexicalRetriever(),
      writer: new Writer(null, metrics, { timeoutMs: 2000, attempts: 1 }),
      metrics,
      thresholds: loadThresholds(),
      sessions: new SessionStore(undefined, new LruCache(100, 60_000)),
      audit,
      selfConsistency: true,
      drafts,
      builder: new DraftBuilder(),
      habits: new HabitsStore(undefined, new LruCache(100, 60_000)),
      confirmDraft: (draftId) => confirmService.confirm({ orgId: ORG_ID, draftId, idempotencyKey: randomUUID() }, ctx, new FixtureWriter()),
      now: () => NOW,
    });
    const sessionId = randomUUID();
    let open: ClarifyEvent | undefined;
    lines.push(`## ${conv.nombre}`, ``);

    for (const turn of conv.turnos) {
      turns += 1;
      turnJev.script = turn.jev ?? {};
      let said: string;
      let clarification: { clarifyId: string; optionId: string; freeText?: string } | undefined;
      if (turn.boton !== undefined) {
        const option = open?.options.find((o) => o.label === turn.boton);
        said = turn.boton;
        clarification = open && option ? { clarifyId: open.clarifyId, optionId: option.id } : undefined;
        if (!clarification) lines.push(`> ⚠️ No había un botón «${turn.boton}».`);
      } else {
        said = turn.usuario ?? "";
        // Igual que la app: con una pregunta abierta, lo escrito va como respuesta a esa pregunta.
        clarification = open ? { clarifyId: open.clarifyId, optionId: "otra", freeText: said } : undefined;
      }
      const events: SseEvent[] = [];
      await agent.handle({ orgId: ORG_ID, sessionId, message: said, page: "/", ...(clarification ? { clarification } : {}) }, ctx, (e) => {
        events.push(e);
      });
      open = events.find((e) => e.event === "clarify")?.data as ClarifyEvent | undefined;

      const done = events.find((e) => e.event === "done")?.data as { text: string } | undefined;
      const draft = events.find((e) => e.event === "draft")?.data as { title: string; warnings: string[] } | undefined;
      const problems = check(turn.espera, events);
      if (problems.length) failed += 1;
      lines.push(`**Usuario:** ${turn.boton !== undefined ? `[botón] ${said}` : said}  `);
      lines.push(`**Asistente:** ${done?.text.replace(/\n+/g, " ") ?? "(sin respuesta)"}  `);
      if (open?.options.length) lines.push(`&nbsp;&nbsp;Opciones: ${open.options.map((o) => `[${o.label}]`).join(" ")}  `);
      if (draft) lines.push(`&nbsp;&nbsp;Borrador: *${draft.title}*${draft.warnings.length ? ` — avisos: ${draft.warnings.join(" / ")}` : ""}  `);
      lines.push(problems.length ? `❌ ${problems.join("; ")}` : `✅`, ``);
    }
  }
  lines.push(`**${turns - failed}/${turns} turnos como se esperaba.**`);
  if (real) {
    const snap = metrics.snapshot();
    lines.push(``, `Coste Jev: ${snap.jev.calls} llamadas, ${snap.jev.inputTokens} tokens de entrada, ~${snap.jev.estimatedCostUsd} $.`);
  }
  return { report: lines.join("\n"), turns, failed };
}

if (process.argv[1]?.endsWith("conversaciones.ts")) {
  const real = process.argv.includes("--real");
  void runConversations(real).then(({ report, failed }) => {
    console.log(report);
    if (real) writeFileSync(join(process.cwd(), "docs/copiloto/CONVERSACIONES.md"), `${report}\n`, "utf8");
    const out = process.argv.includes("--salida") ? process.argv[process.argv.indexOf("--salida") + 1] : undefined;
    if (out) writeFileSync(out, `${report}\n`, "utf8");
    process.exitCode = failed ? 1 : 0;
  });
}
