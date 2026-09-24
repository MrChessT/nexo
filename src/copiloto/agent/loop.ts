// Bucle del agente por mensaje: Jev DECIDE → el código CALCULA y EJECUTA → la LLM REDACTA.
import { randomUUID } from "node:crypto";
import type { EntryType } from "@typesafe-ai/sdk";
import type { AuditSink } from "../audit/audit";
import type { AppRoute, ChatRequest, ClarifyEvent, Decision, Emit, ErrorEvent } from "../contract/index";
import type { SessionContext } from "../domain";
import type { Retriever } from "../entities/retriever";
import { asNoul, asScore, gateNoulYes } from "../gates/gate";
import type { Thresholds } from "../gates/thresholds";
import { CATALOG_VERSION, evaluationQuestions, label, URGENCY_KEYS, type Intent } from "../jev/catalog";
import { JevError, type JevPort, type JevResult } from "../jev/client";
import { StageTimer, type Metrics } from "../metrics/metrics";
import { DataError } from "../supabase/client";
import { Analytics, VIEW_FOR_TOOL } from "../analytics/analytics";
import { businessDay, horizon, pastPeriod } from "../tools/periods";
import type { ToolName, Tools } from "../tools/tools";
import type { EvalItem, ToolParams } from "../tools/types";
import type { Writer } from "../writer/writer";
import { Interpreter, locationLabel, type ActionPlan, type CatalogPlan, type ClarifyPlan, type Plan, type QueryPlan } from "./interpret";
import { validateDraft } from "../drafts/schemas";
import type { DraftBuilder } from "../drafts/builder";
import type { DraftStore } from "../drafts/store";
import type { DecisionReport, Evaluation, ReportOutcome } from "./report";
import { buildRouting, type RoutingMeta } from "./routing";
import { activeFocus, type Focus, type PendingClarify, type Session, type SessionStore } from "./session";
import { HabitsStore } from "./habits";
import type { Draft } from "../contract/index";
import type { ConfirmResponse } from "../drafts/confirm";
import { isShortcut, resolveShortcut } from "./shortcuts";
import { ENTITY_FIELDS, fieldOverrides, readFreeText, type FreeTextAnswer } from "./free-text";
import { tokenize } from "../entities/normalize";

/** Confirma un borrador con el mismo servicio (y las mismas comprobaciones) que el botón. */
export type ConfirmDraft = (draftId: string) => Promise<ConfirmResponse>;

export interface RequestScope {
  tools?: Tools;
  audit?: AuditSink;
  sessions?: SessionStore;
  drafts?: DraftStore;
  confirmDraft?: ConfirmDraft;
  habits?: HabitsStore;
}

export interface AgentDeps {
  jev: JevPort;
  /** Herramientas por defecto (tests y desarrollo). En producción se pasan por petición con el JWT del usuario. */
  tools?: Tools;
  retriever: Retriever;
  writer: Writer;
  metrics: Metrics;
  thresholds: Thresholds;
  sessions: SessionStore;
  audit: AuditSink;
  selfConsistency: boolean;
  drafts: DraftStore;
  builder: DraftBuilder;
  /** Confirmación por chat en desarrollo y tests (en producción llega por petición). */
  confirmDraft?: ConfirmDraft;
  /** Hábitos del usuario (en producción, con Supabase por petición). */
  habits?: HabitsStore;
  now?: () => Date;
}

/** Máximo de ítems evaluados por Jev en la llamada nº 2. */
const MAX_EVAL_ITEMS = 15;

/** Pantalla a la que lleva cada consulta ("Ver en…"). Las que tienen gráfica van a /informes. */
const TOOL_ROUTE: Record<ToolName, AppRoute> = {
  query_stock: "/stock",
  query_movements: "/informes",
  query_prices: "/informes",
  query_pending_transfers: "/traspasos",
  query_count_variance: "/informes",
  query_reorder: "/informes",
  query_orders: "/pedidos",
  query_spend: "/recepciones",
};

const DEFAULT_PERIOD: Partial<Record<ToolName, "semana" | "mes">> = { query_movements: "semana", query_spend: "mes" };

function errorEvent(err: unknown): ErrorEvent {
  if (err instanceof JevError) {
    return err.code === "auth" || err.code === "invalid_request"
      ? { code: "internal", message: "El asistente no está bien configurado. Avisa al administrador.", retryable: false }
      : { code: "jev_unavailable", message: "El motor de decisiones no responde ahora mismo. Puedes usar atajos como «/stock agua» o «/pendientes».", retryable: true };
  }
  if (err instanceof DataError) {
    return { code: "data_unavailable", message: "No he podido leer los datos del inventario. Inténtalo de nuevo en un momento.", retryable: true };
  }
  return { code: "internal", message: "Algo ha fallado al procesar tu mensaje. Inténtalo de nuevo.", retryable: true };
}

export class Agent {
  constructor(private readonly deps: AgentDeps) {}

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  /**
   * @param scope Recursos de la petición con el JWT del usuario (herramientas y auditoría).
   *              Sin ellos se usan los de `deps` (desarrollo y tests).
   */
  async handle(req: ChatRequest, ctx: SessionContext, emit: Emit, scope: RequestScope = {}): Promise<void> {
    const toolset = scope.tools ?? this.deps.tools;
    if (!toolset) throw new Error("Faltan las herramientas de datos");
    const deps = {
      ...this.deps,
      audit: scope.audit ?? this.deps.audit,
      sessions: scope.sessions ?? this.deps.sessions,
      drafts: scope.drafts ?? this.deps.drafts,
      confirmDraft: scope.confirmDraft ?? this.deps.confirmDraft,
      habits: scope.habits ?? this.deps.habits ?? new HabitsStore(),
    };
    const timer = new StageTimer();
    const messageId = randomUUID();
    const [session, habits] = await Promise.all([deps.sessions.get(req.sessionId, ctx.userId), deps.habits.get(ctx.orgId, ctx.userId)]);
    deps.metrics.messages += 1;

    try {
      let message = req.message;
      let page = req.page;
      let pageContext = req.pageContext;
      let overrides: Record<string, string> = {};
      let reuse: PendingClarify["routing"];
      let plan: Plan | null = null;
      let shortcut = false;

      // Un borrador que ya se confirmó (con el botón), se descartó o caducó no espera respuesta.
      await this.dropStaleDraft(session, ctx, deps.drafts);

      // Respuesta a una aclaración: se reutiliza la llamada nº 1 con la decisión forzada.
      const pending = req.clarification ? session.clarifies.get(req.clarification.clarifyId) : undefined;
      if (pending && req.clarification) {
        session.clarifies.delete(pending.clarifyId);
        let option: string | null = req.clarification.optionId;
        let typed: Extract<FreeTextAnswer, { kind: "quantity" }> | null = null;
        const text = (req.clarification.freeText ?? req.message).trim();
        if (option === "otra" || !pending.optionIds.includes(option)) {
          // Escrito a mano: primero como respuesta a esta pregunta (una opción o una cantidad).
          const read = readFreeText(pending, text, ctx);
          option = read.kind === "option" ? read.optionId : null;
          if (read.kind === "quantity" && pending.routing) typed = read;
        }
        if (option !== null && pending.fromShortcut) {
          message = pending.message;
          page = pending.page;
          pageContext = pending.pageContext;
          const product = ctx.products.find((p) => p.name === option);
          plan = await resolveShortcut(pending.message, ctx, deps.retriever, pageContext?.locationId, product);
          shortcut = true;
        } else if ((option !== null || typed) && pending.routing) {
          message = pending.message;
          page = pending.page;
          pageContext = pending.pageContext;
          overrides = option !== null ? { ...pending.overrides, [overrideKey(pending, option)]: overrideValue(option) } : quantityOverrides(pending, typed!);
          reuse = pending.routing;
        } else if (ENTITY_FIELDS.has(pending.field) && !pending.restart) {
          // Falta un dato de la orden y no encaja con ninguna opción: se completa la orden original.
          message = `${pending.message}. ${text}`.slice(0, 1000);
          page = pending.page;
          pageContext = pending.pageContext;
          overrides = fieldOverrides(pending.overrides);
        }
        // Si no, lo escrito es un mensaje nuevo: la orden anterior no se arrastra.
      }

      if (!plan && !reuse && isShortcut(message)) {
        plan = await resolveShortcut(message, ctx, deps.retriever, pageContext?.locationId);
        shortcut = plan !== null;
      }

      let intent: Intent;
      let decisions: Decision[] = [];
      let routing: { meta: RoutingMeta; jev: JevResult } | undefined = reuse;

      if (plan) {
        deps.metrics.shortcuts += 1;
        intent = plan.type === "navegar" ? "navegar" : plan.type === "conversar" ? "conversar" : "consultar";
      } else {
        if (!routing) {
          const built = await timer.time("entidades", () =>
            buildRouting(message, page, pageContext?.locationId, session.turns, ctx, deps.retriever, deps.selfConsistency, activeFocus(session, this.now().getTime())?.draftTitle),
          );
          const jev = await timer.time("jev1", () => deps.jev.evaluate(built.state as unknown as EntryType, built.questions));
          routing = { meta: built.meta, jev };
        }
        const interpretation = new Interpreter(routing.jev.answers, routing.meta, ctx, deps.thresholds, overrides, pageContext?.locationId, activeFocus(session, this.now().getTime()), habits).run();
        intent = interpretation.intent;
        decisions = interpretation.decisions;
        plan = interpretation.plan;
      }

      for (const d of decisions) deps.metrics.gates[d.gate] += 1;
      const intentDecision: Decision =
        decisions.find((d) => d.id === "intent") ??
        { id: "intent", label: "Intención", value: intent, valueLabel: label(intent), probability: 1, confidence: 1, gate: "actuar" };
      await emit({
        event: "decision",
        data: { messageId, intent: intentDecision, decisions: decisions.filter((d) => d.id !== "intent"), shortcut },
      });

      const outcome = await this.execute(plan, { message, messageId, page, pageContext, overrides, routing, ctx, session, emit, timer, tools: toolset, decisions, audit: deps.audit, drafts: deps.drafts, confirmDraft: deps.confirmDraft });

      const report: DecisionReport = {
        version: 1,
        messageId,
        catalogVersion: CATALOG_VERSION,
        jevModel: routing?.jev.model ?? null,
        intent,
        decisions,
        outcome,
      };

      const previousFocus = session.focus;
      session.focus = nextFocus(plan, outcome, previousFocus, this.now().getTime());
      // Se aprende de lo que el usuario consulta o propone (locales y productos concretos).
      if (session.focus && session.focus !== previousFocus && (outcome.kind === "consulta" || outcome.kind === "borrador")) {
        await deps.habits.record(ctx.orgId, ctx.userId, { locationIds: session.focus.locationIds, productIds: session.focus.productIds }).catch(() => undefined);
      }

      const written = await timer.time("redaccion", () => deps.writer.write(report, emit));
      // En el historial va lo que el usuario dijo (no la orden original que se reutiliza al aclarar).
      deps.sessions.addTurn(session, { role: "user", text: req.clarification ? req.clarification.freeText ?? req.message : message });
      deps.sessions.addTurn(session, { role: "assistant", text: written.text });
      timer.flush(deps.metrics);
      await deps.sessions.save(req.sessionId, ctx.orgId, session).catch(() => undefined);
      await emit({ event: "done", data: { messageId, text: written.text, textSource: written.source, latencyMs: timer.total() } });

      const at = new Date().toISOString();
      const audit =
        plan.type === "bloqueado"
          ? deps.audit.record({ type: "bloqueo", at, userId: ctx.userId, orgId: ctx.orgId, messageId, reason: "inyeccion" })
          : deps.audit.record({
              type: "mensaje",
              at,
              userId: ctx.userId,
              orgId: ctx.orgId,
              sessionId: req.sessionId,
              messageId,
              message,
              intent,
              decisions,
              outcome: outcome.kind,
              jevModel: report.jevModel,
              catalogVersion: CATALOG_VERSION,
              shortcut,
            });
      await audit.catch(() => undefined);
    } catch (err) {
      await emit({ event: "error", data: errorEvent(err) });
    }
  }

  private async dropStaleDraft(session: Session, ctx: SessionContext, drafts: DraftStore): Promise<void> {
    const draftId = session.focus?.draftId;
    if (!draftId || !session.focus) return;
    const stored = await drafts.get(draftId, ctx.userId, ctx.orgId).catch(() => undefined);
    if (stored && stored.status === "pendiente" && new Date(stored.draft.expiresAt).getTime() >= this.now().getTime()) return;
    const { draftId: _draftId, draftTitle: _draftTitle, ...rest } = session.focus;
    void _draftId;
    void _draftTitle;
    session.focus = rest;
  }

  private async clarify(plan: ClarifyPlan, env: ExecEnv): Promise<ReportOutcome> {
    const clarify: ClarifyEvent = {
      clarifyId: randomUUID().slice(0, 12),
      question: plan.question,
      field: plan.field,
      options: plan.options,
      allowFreeText: true,
    };
    this.deps.sessions.addClarify(env.session, {
      clarifyId: clarify.clarifyId,
      field: plan.field,
      ...(plan.segmentIndex !== undefined ? { segmentIndex: plan.segmentIndex } : {}),
      optionIds: plan.options.map((o) => o.id),
      optionLabels: plan.options.map((o) => o.label),
      ...(plan.restart ? { restart: true } : {}),
      message: env.message,
      page: env.page,
      ...(env.pageContext ? { pageContext: env.pageContext } : {}),
      ...(env.routing ? { routing: env.routing } : { fromShortcut: true }),
      overrides: env.overrides,
    });
    await env.emit({ event: "clarify", data: clarify });
    return { kind: "aclaracion", clarify };
  }

  /**
   * Borrador: el código lo construye y valida; Jev comprueba su coherencia (y, en el catálogo, revisa
   * duplicados, sentido y plausibilidad en la misma llamada); el usuario lo confirma.
   */
  private async draft(plan: ActionPlan | CatalogPlan, env: ExecEnv): Promise<ReportOutcome> {
    const { deps } = this;
    const built = await env.timer.time("herramientas", () =>
      deps.builder.build({ plan, message: env.message, ctx: env.ctx, source: env.tools.source, overrides: env.overrides, now: this.now() } as Parameters<DraftBuilder["build"]>[0]),
    );
    if (built.kind === "clarify") return this.clarify(built.plan, env);
    if (built.kind === "error") {
      if (built.navigate) await env.emit({ event: "navigate", data: built.navigate });
      return { kind: "error", message: built.message };
    }

    let draft = built.draft;
    const review = built.review;
    let coherence: number | null;
    let answers: Awaited<ReturnType<JevPort["evaluate"]>>["answers"] = {};
    try {
      const state = { request: env.message, draft: built.summary, ...(review?.state ?? {}) };
      const questions = { ...evaluationQuestions([], true), ...(review?.questions ?? {}) };
      ({ answers } = await env.timer.time("jev2", () => deps.jev.evaluate(state, questions)));
      coherence = asNoul(answers.coherencia)?.noul ?? null;
    } catch {
      coherence = null;
    }
    if (review) {
      const reviewed = review.apply(answers, deps.thresholds);
      if (reviewed.kind === "clarify") return this.clarify(reviewed.plan, env);
      if (reviewed.kind === "error") {
        if (reviewed.navigate) await env.emit({ event: "navigate", data: reviewed.navigate });
        return { kind: "error", message: reviewed.message };
      }
    }
    draft = validateDraft(draft);
    if (plan.type === "accion" && plan.reviewAll) draft.warnings.unshift("Revisa los datos antes de confirmar: puede que falte algo de lo que querías.");
    if (coherence === null) {
      draft.warnings.unshift("No he podido comprobar el borrador: revísalo con atención.");
    } else {
      draft.coherence = coherence;
      const gate = gateNoulYes({ type: "noul", noul: coherence }, deps.thresholds.coherencia);
      env.decisions.push({ id: "coherencia", label: "Coherencia del borrador", value: gate, valueLabel: gate === "actuar" ? "Coincide con la petición" : "Revisar", probability: coherence, confidence: null, gate });
      if (gate === "preguntar") {
        return this.clarify(
          { type: "clarify", field: "tipo_accion", question: "No estoy seguro de haber entendido la operación. ¿Me la repites con el producto, la cantidad y el local?", options: [], restart: true },
          env,
        );
      }
      if (gate === "confirmar") draft.warnings.unshift("Revisa los datos: puede que no coincida del todo con lo que pediste.");
    }

    await env.drafts.save({ draft, orgId: env.ctx.orgId, userId: env.ctx.userId, messageId: env.messageId, request: env.message });
    await env.emit({ event: "draft", data: draft });
    await env.audit
      .record({ type: "borrador", at: this.now().toISOString(), userId: env.ctx.userId, orgId: env.ctx.orgId, messageId: env.messageId, draftId: draft.draftId, kind: draft.kind, coherence: draft.coherence })
      .catch(() => undefined);
    return { kind: "borrador", draft };
  }

  /**
   * «Sí, adelante» / «cancélalo» sobre el borrador pendiente. Confirmar pasa por el mismo servicio
   * que el botón (dueño, caducidad, rol, idempotencia). Con avisos en «revisar» no se confirma por
   * chat: hay que marcarlos en la tarjeta.
   */
  private async answerDraft(plan: Extract<Plan, { type: "borrador" }>, env: ExecEnv): Promise<ReportOutcome> {
    const stored = await env.drafts.get(plan.draftId, env.ctx.userId, env.ctx.orgId);
    if (!stored || stored.status !== "pendiente" || new Date(stored.draft.expiresAt).getTime() < this.now().getTime()) {
      return { kind: "error", message: "Ese borrador ya no está disponible (se confirmó, se descartó o caducó). Pídemelo de nuevo." };
    }
    const title = stored.draft.title;
    const resolved = async (status: "confirmado" | "descartado", message: string): Promise<ReportOutcome> => {
      await env.emit({ event: "resolved", data: { draftId: plan.draftId, status, message } });
      return { kind: "resuelto", status, message };
    };

    if (plan.action === "cancelar") {
      // Se bloquea en el servidor para que la tarjeta antigua ya no pueda confirmarlo.
      await env.drafts.claim(plan.draftId);
      env.drafts.delete(plan.draftId);
      return resolved("descartado", `Descartado: ${title}.`);
    }

    if (stored.draft.checks?.some((c) => c.status === "revisar")) {
      return { kind: "error", message: "Ese borrador tiene avisos que revisar: márcalos en la tarjeta y confírmalo desde allí." };
    }
    if (!env.confirmDraft) return { kind: "error", message: "Confírmalo con el botón de la tarjeta." };
    const result = await env.confirmDraft(plan.draftId);
    if (!result.ok) return { kind: "error", message: result.message };
    if (result.navigate) await env.emit({ event: "navigate", data: result.navigate });
    return resolved("confirmado", result.message);
  }

  private async execute(plan: Plan, env: ExecEnv): Promise<ReportOutcome> {
    const { ctx, emit } = env;
    switch (plan.type) {
      case "clarify":
        return this.clarify(plan, env);
      case "conversar": {
        const charla = smallTalk(env.message);
        return charla ? { kind: "conversacion", charla } : { kind: "conversacion" };
      }
      case "fuera_de_ambito":
        return { kind: "fuera_de_ambito" };
      case "bloqueado":
        return { kind: "bloqueado" };
      case "navegar": {
        const navigate = { route: plan.route, filters: plan.filters, auto: plan.auto };
        await emit({ event: "navigate", data: navigate });
        return { kind: "navegacion", navigate, destino: label(plan.route) };
      }
      case "accion":
      case "catalogo":
        return this.draft(plan, env);
      case "borrador":
        return this.answerDraft(plan, env);
      case "consultar":
        return this.query(plan, env.message, ctx, emit, env.timer, env.tools);
    }
  }

  private async query(plan: QueryPlan, message: string, ctx: SessionContext, emit: Emit, timer: StageTimer, tools: Tools): Promise<ReportOutcome> {
    const now = this.now();
    const tzLocation = ctx.locations.find((l) => l.id === plan.locationIds[0]);
    const today = businessDay(now, tzLocation?.timezone ?? "Europe/Madrid", tzLocation?.dayCutoff ?? "06:00");
    const fallback = DEFAULT_PERIOD[plan.tool];
    const period = fallback || plan.periodo !== "no_indicado" ? pastPeriod(plan.periodo, today, message, fallback ?? "mes") : null;
    const h = horizon(plan.periodo, today);
    const params: ToolParams = {
      locationIds: plan.locationIds,
      areaId: plan.areaId,
      productIds: plan.products.map((p) => p.product.id),
      period,
      horizonDays: h.days,
      horizonLabel: h.label,
      now,
      ...(plan.tool === "query_stock" && wantsAreaBreakdown(message) ? { byArea: true } : {}),
    };

    const result = await timer.time("herramientas", () => tools.run(plan.tool, params, ctx));
    const notices: string[] = [];
    if (plan.inherited?.length) notices.push(`Sigo con ${plan.inherited.join(" · ")}, de lo que hablábamos.`);
    if (plan.locationsDefaulted && ctx.locations.length > 1 && plan.locationIds.length > 1) {
      notices.push("No has indicado local: te lo muestro de todos, desglosado por local.");
    }

    const evaluations = await timer.time("jev2", () => this.evaluate(result.evalItems, message, h.label));
    if (result.evalItems.length > 0 && evaluations === null) notices.push("No he podido valorar la urgencia; te muestro los datos tal cual.");

    const scope = {
      locales: plan.locationIds.map((id) => locationLabel(ctx, id)),
      espacio: plan.areaId ? ctx.areas.find((a) => a.id === plan.areaId)?.name ?? null : null,
      productos: plan.products.map((p) => p.product.name),
      periodo: plan.tool === "query_reorder" ? h.label : period?.label ?? null,
    };

    // Gráfica calculada por el código (decimal.js) para acompañar la respuesta.
    const days = period ? daysInclusive(period.from, period.to) : 30;
    const chart = await timer
      .time("herramientas", () =>
        new Analytics(tools.source).chartForTool(
          plan.tool,
          { ctx, locationIds: plan.locationIds, productIds: plan.products.map((p) => p.product.id), days: Math.max(days, 7), now },
          h.days,
        ),
      )
      .catch(() => null);
    if (chart) await emit({ event: "chart", data: chart });

    const route = TOOL_ROUTE[plan.tool];
    await emit({
      event: "navigate",
      data: {
        route,
        filters: {
          ...(route === "/informes" ? { view: VIEW_FOR_TOOL[plan.tool], days: Math.max(days, 7) } : {}),
          ...(plan.locationIds.length === 1 ? { locationId: plan.locationIds[0]! } : {}),
          ...(plan.areaId ? { areaId: plan.areaId } : {}),
          ...(plan.products.length === 1 ? { productId: plan.products[0]!.product.id } : {}),
          ...(plan.tool === "query_pending_transfers" ? { status: "in_transit" } : {}),
        },
        auto: false,
      },
    });

    return { kind: "consulta", tool: plan.tool, scope, result, evaluations: evaluations ?? [], notices };
  }

  /** Llamada nº 2: Jev juzga las cifras calculadas. Devuelve null si Jev falla (se degrada sin valoración). */
  private async evaluate(items: EvalItem[], request: string, horizonLabel: string): Promise<Evaluation[] | null> {
    if (items.length === 0) return [];
    const selected = items.slice(0, MAX_EVAL_ITEMS);
    const state = { request, horizon: horizonLabel, items: selected.map((i) => i.data) };
    try {
      const { answers } = await this.deps.jev.evaluate(state, evaluationQuestions(selected.map((i) => i.kind), false));
      return selected.map((item, i) => {
        const relevance = asNoul(answers[`${item.kind}_${i}`])?.noul ?? 0;
        const urgency = asScore(answers[`urgencia_${i}`]);
        const level = Math.max(0, Math.min(3, Math.round(urgency?.score ?? 0)));
        return {
          kind: item.kind,
          data: item.data,
          relevance,
          urgency: URGENCY_KEYS[level]!,
          urgencyScore: urgency?.score ?? 0,
          confidence: urgency?.confidence ?? 0,
        };
      });
    } catch {
      return null;
    }
  }
}

interface ExecEnv {
  message: string;
  messageId: string;
  page: AppRoute;
  pageContext: ChatRequest["pageContext"];
  overrides: Record<string, string>;
  routing: { meta: RoutingMeta; jev: JevResult } | undefined;
  ctx: SessionContext;
  session: Session;
  emit: Emit;
  timer: StageTimer;
  tools: Tools;
  /** Decisiones del mensaje; la coherencia del borrador se añade aquí para el informe y la auditoría. */
  decisions: Decision[];
  audit: AuditSink;
  drafts: DraftStore;
  confirmDraft?: ConfirmDraft;
}

function overrideKey(pending: PendingClarify, option: string): string {
  const i = pending.segmentIndex ?? 0;
  if (pending.field === "producto") return `producto_${i}`;
  if (pending.field === "cantidad") return option.startsWith("pack:") ? `unidad_${i}` : `cantidad_ok_${i}`;
  return pending.field;
}

function overrideValue(option: string): string {
  return option.startsWith("pack:") ? option.slice(5) : option;
}

/** Cantidad escrita a mano: sustituye a la del mensaje (y a la confirmación o el formato anteriores). */
function quantityOverrides(pending: PendingClarify, typed: { amount: string; unit: string | null }): Record<string, string> {
  const i = pending.segmentIndex ?? 0;
  const { [`cantidad_ok_${i}`]: _ok, [`unidad_${i}`]: _pack, [`unidad_texto_${i}`]: _unit, ...rest } = pending.overrides;
  void _ok;
  void _pack;
  void _unit;
  return { ...rest, [`cantidad_${i}`]: typed.amount, ...(typed.unit ? { [`unidad_texto_${i}`]: typed.unit } : {}) };
}

/** «¿Qué hay en cada sección / por zonas / en cada barra?»: el stock se desglosa por espacio. */
export function wantsAreaBreakdown(message: string): boolean {
  const text = tokenize(message).join(" ");
  return /\b(cada|por|las|todas las|todos los|sus) (seccion|secciones|espacio|espacios|zona|zonas|barra|barras)\b/.test(text) || /\b(secciones|espacios|zonas)\b/.test(text);
}

/** Saludo, agradecimiento o despedida corta («gracias!», «buenas», «hasta luego»). */
export function smallTalk(message: string): "hola" | "gracias" | "adios" | undefined {
  const words = tokenize(message);
  if (words.length === 0 || words.length > 5) return undefined;
  const text = words.join(" ");
  if (/^(muchas |mil )?gracias\b|^(genial|perfecto|vale|ok|estupendo)( muchas)? gracias\b|^thanks?\b/.test(text)) return "gracias";
  if (/^(adios|hasta luego|hasta manana|chao|nos vemos|bye)\b/.test(text)) return "adios";
  if (/^(hola|buenas|buenos dias|buenas tardes|buenas noches|hey|ey)\b/.test(text)) return "hola";
  return undefined;
}

function daysInclusive(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

/** Productos y locales que menciona un borrador (para heredarlos en el siguiente mensaje). */
function draftRefs(draft: Draft): { locationIds: string[]; productIds: string[] } {
  const d = draft as unknown as Record<string, unknown>;
  const locationIds = [d.locationId, d.fromLocationId].filter((v): v is string => typeof v === "string");
  const lines = (Array.isArray(d.lines) ? d.lines : Array.isArray(d.orders) ? (d.orders as Array<{ lines: unknown[] }>).flatMap((o) => o.lines) : []) as Array<{ productId?: string }>;
  const productIds = [d.productId, ...lines.map((l) => l.productId)].filter((v): v is string => typeof v === "string");
  return { locationIds, productIds: [...new Set(productIds)] };
}

/** Foco tras responder: lo consultado o propuesto. Aclaraciones y charla no lo cambian. */
function nextFocus(plan: Plan, outcome: ReportOutcome, previous: Focus | undefined, now: number): Focus | undefined {
  if (outcome.kind === "consulta" && plan.type === "consultar") {
    return {
      kind: "consulta",
      tool: plan.tool,
      locationIds: plan.locationsDefaulted ? [] : plan.locationIds,
      productIds: plan.products.map((p) => p.product.id),
      periodo: plan.periodo,
      at: now,
    };
  }
  if (outcome.kind === "resuelto") {
    // El borrador ya no está pendiente; el tema sigue siendo lo que trataba.
    if (!previous) return undefined;
    const { draftId: _draftId, draftTitle: _draftTitle, ...rest } = previous;
    void _draftId;
    void _draftTitle;
    return { ...rest, at: now };
  }
  if (outcome.kind === "borrador") {
    return {
      kind: "borrador",
      accion: outcome.draft.kind,
      ...draftRefs(outcome.draft),
      periodo: "no_indicado",
      draftId: outcome.draft.draftId,
      draftTitle: outcome.draft.title,
      at: now,
    };
  }
  // Tras una aclaración, una navegación o una charla, lo anterior sigue siendo el tema.
  return previous ? { ...previous, at: previous.at } : undefined;
}
