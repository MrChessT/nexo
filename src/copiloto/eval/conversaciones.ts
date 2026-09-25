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
import type { ClarifyEvent, DecisionEvent, SseEvent, TableEvent } from "../contract/index";
import { FakeJev, type Script } from "../dev/fake-jev";
import { FixtureDataSource, fixtureContext, ORG_ID } from "../dev/fixture";
import { FixtureWriter } from "../dev/fixture-writer";
import { viveroProducts, viveroRows, type ViveroRow } from "../dev/vivero-catalog";
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
import type { BalanceRaw, DataFilter, LocationProductRaw, PriceRaw, SupplierPriceRaw } from "../tools/types";
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
  /** Textos que NO debe contener (lo que sobra: «€» en una pregunta de cantidad, la ficha entera…). */
  sin?: string[];
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

/**
 * Datos del ejemplo más el catálogo real de Vivero 55 con sus precios y proveedores de verdad. Como en
 * el negocio real, cada local trabaja su surtido: el Vivero, todo; los demás, unos dos tercios, con
 * cantidades distintas en cada uno (no «lo mismo en todas partes»).
 */
export class ViveroDataSource extends FixtureDataSource {
  readonly #rows: ViveroRow[] = viveroRows();
  /** Los ids del catálogo real coinciden con los del ejemplo: lo del ejemplo con esos ids no cuenta. */
  readonly #productIds: Set<string>;
  readonly #packIds: Set<string>;

  constructor(
    now: Date,
    private readonly products: Product[],
    private readonly locationIds: string[],
    private readonly areas: SessionContext["areas"],
    private readonly viveroId: string,
  ) {
    super(now);
    this.#productIds = new Set(products.map((p) => p.id));
    this.#packIds = new Set(products.flatMap((p) => p.packs.map((k) => k.id)));
  }

  /** ¿El local trabaja el producto nº i? ¿Cuántas unidades (botellas, kg, ud) tiene? */
  #stock(i: number, locationId: string): number {
    const j = this.locationIds.indexOf(locationId);
    if (locationId !== this.viveroId && (i + j) % 3 === 0) return 0;
    return 2 + ((i * 7 + j * 3) % 11);
  }

  /** Unidad base por unidad de catálogo: ml de la botella, 1000 g del kg, 1 ud. */
  #factor(p: Product): number {
    return Number(p.packs.find((k) => k.isCountDefault)?.qtyBase ?? "1");
  }

  #catalog(filter: DataFilter): Array<{ p: Product; i: number; locationId: string; units: number }> {
    return this.products.flatMap((p, i) =>
      !filter.productIds || filter.productIds.includes(p.id)
        ? this.locationIds.filter((l) => filter.locationIds.includes(l)).map((locationId) => ({ p, i, locationId, units: this.#stock(i, locationId) })).filter((x) => x.units > 0)
        : [],
    );
  }

  override async balances(filter: DataFilter): Promise<BalanceRaw[]> {
    const extra = this.#catalog(filter).map(({ p, i, locationId, units }) => ({
      locationId,
      productId: p.id,
      qty: String(units * this.#factor(p)),
      avgCost: String(this.#rows[i]!.cost / this.#factor(p)),
    }));
    return [...(await super.balances(filter)).filter((b) => !this.#productIds.has(b.productId)), ...extra];
  }

  override async locationProducts(filter: DataFilter): Promise<LocationProductRaw[]> {
    const extra = this.#catalog(filter).map(({ p, i, locationId }) => ({
      locationId,
      productId: p.id,
      minQty: String(this.#rows[i]!.min * this.#factor(p)),
      parQty: String(this.#rows[i]!.par * this.#factor(p)),
    }));
    return [...(await super.locationProducts(filter)).filter((l) => !this.#productIds.has(l.productId)), ...extra];
  }

  /** Último precio de compra del formato de compra, como lo carga el seed. */
  override async supplierPrices(packIds: string[]): Promise<SupplierPriceRaw[]> {
    const extra = this.products.flatMap((p, i) => {
      const pack = p.packs.find((k) => k.isPurchaseDefault);
      const row = this.#rows[i]!;
      if (!pack || !packIds.includes(pack.id)) return [];
      return [{ supplierId: `sup-${row.supplier}`, supplierName: row.supplier, packId: pack.id, lastPrice: (row.cost * row.pack).toFixed(4), lastPriceAt: new Date(this.now.getTime() - 20 * 86_400_000).toISOString() }];
    });
    return [...(await super.supplierPrices(packIds)).filter((p) => !this.#packIds.has(p.packId)), ...extra];
  }

  override async prices(packIds: string[] | null, since: string): Promise<PriceRaw[]> {
    const current = await this.supplierPrices(packIds ?? this.products.flatMap((p) => p.packs.map((k) => k.id)));
    const extra = current
      .filter((c) => (c.lastPriceAt ?? "") >= since && c.supplierId.startsWith("sup-"))
      .map((c) => ({ supplierId: c.supplierId, supplierName: c.supplierName, packId: c.packId, price: c.lastPrice, recordedAt: c.lastPriceAt! }));
    return [...(await super.prices(packIds, since)).filter((p) => !this.#packIds.has(p.packId)), ...extra];
  }

  /** En cada local, los productos del catálogo real se reparten entre sus espacios. */
  override async areaBalances(areaId: string, productIds?: string[]) {
    const own = (await super.areaBalances(areaId, productIds)).filter((b) => !this.#productIds.has(b.productId));
    const area = this.areas.find((a) => a.id === areaId);
    if (!area) return own;
    const siblings = this.areas.filter((a) => a.locationId === area.locationId);
    const extra = this.products
      .map((p, i) => ({ p, i, units: this.#stock(i, area.locationId) }))
      .filter(({ p, i, units }) => units > 0 && (!productIds || productIds.includes(p.id)) && siblings[i % siblings.length]?.id === areaId)
      .map(({ p, i, units }) => ({ areaId, productId: p.id, qty: String(units * this.#factor(p)), avgCost: String(this.#rows[i]!.cost / this.#factor(p)) }));
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
  for (const extra of e.sin ?? []) if (done?.text.includes(extra)) problems.push(`sobra «${extra}» en la respuesta`);
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
      tools: new InventoryTools(new ViveroDataSource(NOW, products, ctx.locations.map((l) => l.id), ctx.areas, ctx.locations.find((l) => l.name === "Vivero")!.id)),
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
      // Lo que ve el usuario: «Entendido: …» (lo dudoso entre ¿?), el texto y la tabla si la hay.
      const decision = events.find((e) => e.event === "decision")?.data as DecisionEvent | undefined;
      if (decision && !decision.shortcut) {
        const parts = [decision.intent, ...decision.decisions]
          .filter((d) => !["intent", "seguimiento", "coherencia"].includes(d.id) || (d.id === "intent" && decision.decisions.length === 0))
          .filter((d) => !["no_indicado", "ninguno", "ninguna", "no_aplica"].includes(d.value));
        lines.push(`&nbsp;&nbsp;*Entendido: ${parts.map((d) => (d.gate === "actuar" ? d.valueLabel : `¿${d.valueLabel}?`)).join(" · ")}*  `);
      }
      lines.push(`**Asistente:** ${done?.text.replace(/\n+/g, " ") ?? "(sin respuesta)"}  `);
      const table = events.find((e) => e.event === "table")?.data as TableEvent | undefined;
      if (table) {
        lines.push(``, `| ${table.columns.map((c) => c.label).join(" | ")} |`, `| ${table.columns.map(() => "---").join(" | ")} |`);
        for (const row of table.rows.slice(0, 4)) lines.push(`| ${table.columns.map((c) => row[c.key] ?? "").join(" | ")} |`);
        if (table.rows.length > 4 || table.more) lines.push(`| … ${table.rows.length - 4 + (table.more ?? 0)} filas más |`);
        lines.push(``);
      }
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
