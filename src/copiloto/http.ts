// Endpoints del asistente como funciones de la app (sin servidor aparte). Cada petición trabaja con el
// JWT del usuario: RLS activo, sin service role. El contrato está en docs/copiloto/CONTRACT.md.
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { Analytics } from "./analytics/analytics";
import { SessionStore } from "./agent/session";
import { CompositeAuditSink, ConsoleAuditSink } from "./audit/audit";
import { ANALYTICS_VIEWS, CATALOG_KINDS, ChatRequest, CONTRACT_VERSION, type ErrorEvent, type HealthResponse } from "./contract/index";
import type { SessionContext } from "./domain";
import { ConfirmRequest } from "./drafts/confirm";
import { DraftStore } from "./drafts/store";
import { SupabaseInventoryWriter } from "./drafts/writer-port";
import { runtime } from "./runtime";
import { AuthError, type AuthUser } from "./security/auth";
import type { RateLimiter } from "./security/rate-limit";
import { SupabaseAuditSink } from "./supabase/audit-sink";
import { DataError, pingSupabase, userClient } from "./supabase/client";
import { SupabaseContext } from "./supabase/context";
import { SupabaseDataSource } from "./supabase/data-source";
import { memoizeSource } from "./supabase/memo-source";
import { SupabaseDraftPersistence, SupabaseHabitsPersistence, SupabaseSessionPersistence } from "./supabase/state";
import { HabitsStore } from "./agent/habits";
import { computeReorder, InventoryTools } from "./tools/tools";

export interface RequestUser extends AuthUser {
  orgId: string;
}

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", "X-Nexo-Contract": CONTRACT_VERSION, ...headers } });

const fail = (status: number, error: ErrorEvent, headers: Record<string, string> = {}) => json(error, status, headers);

function limited(limiter: RateLimiter, key: string): Response | null {
  const wait = limiter.take(key);
  return wait > 0 ? fail(429, { code: "rate_limited", message: `Demasiadas peticiones. Espera ${wait} s.`, retryable: true }, { "Retry-After": String(wait) }) : null;
}

/** Recursos de la petición, todos con el JWT del usuario. */
function scopeFor(user: RequestUser) {
  const rt = runtime();
  const db = userClient(rt.supabase, user.token);
  return {
    db,
    // Lecturas repetidas dentro de la misma petición (herramienta + gráfica, KPIs + gráficas) se hacen una vez.
    tools: new InventoryTools(memoizeSource(new SupabaseDataSource(db))),
    audit: new CompositeAuditSink([new ConsoleAuditSink(), new SupabaseAuditSink(db)]),
    sessions: new SessionStore(new SupabaseSessionPersistence(db)),
    drafts: new DraftStore(new SupabaseDraftPersistence(db)),
    habits: new HabitsStore(new SupabaseHabitsPersistence(db)),
    writer: new SupabaseInventoryWriter(db),
  };
}

async function loadContext(user: RequestUser, fresh = false): Promise<SessionContext> {
  const rt = runtime();
  const key = `${user.userId}:${user.orgId}`;
  if (!fresh) {
    const cached = rt.contexts.get(key);
    if (cached) {
      rt.metrics.contextCacheHits += 1;
      return cached;
    }
  }
  const ctx = await new SupabaseContext(rt.supabase).load(user, user.orgId);
  rt.contexts.set(key, ctx);
  return ctx;
}

async function chat(request: Request, user: RequestUser): Promise<Response> {
  const rt = runtime();
  const blocked = limited(rt.limiters.chat, `chat:${user.userId}`);
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = ChatRequest.safeParse({ ...(body ?? {}), orgId: user.orgId });
  if (!parsed.success) return fail(400, { code: "invalid_request", message: "Petición no válida", retryable: false });
  const ctx = await loadContext(user);
  const scope = scopeFor(user);
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        await rt.agent.handle(
          parsed.data,
          ctx,
          (event) => {
            controller.enqueue(encoder.encode(`event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`));
          },
          {
            tools: scope.tools,
            audit: scope.audit,
            sessions: scope.sessions,
            drafts: scope.drafts,
            habits: scope.habits,
            // «Sí, adelante»: mismo servicio que el botón, con el rol comprobado sobre datos frescos.
            confirmDraft: async (draftId) => {
              const fresh = await loadContext(user, true);
              const result = await rt.confirm.confirm({ orgId: user.orgId, draftId, idempotencyKey: randomUUID() }, fresh, scope.writer, scope.audit, scope.drafts);
              if (result.ok && (CATALOG_KINDS as readonly string[]).includes(result.kind)) rt.contexts.delete(`${user.userId}:${user.orgId}`);
              return result;
            },
          },
        );
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
      "X-Nexo-Contract": CONTRACT_VERSION,
    },
  });
}

async function confirm(request: Request, user: RequestUser): Promise<Response> {
  const rt = runtime();
  const blocked = limited(rt.limiters.confirm, `confirm:${user.userId}`);
  if (blocked) return blocked;
  const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
  const parsed = ConfirmRequest.safeParse({ ...(body ?? {}), orgId: user.orgId });
  if (!parsed.success) return fail(400, { code: "invalid_request", message: "Petición no válida", retryable: false });
  // Sin caché: el rol se comprueba con datos frescos antes de escribir.
  const ctx = await loadContext(user, true);
  const scope = scopeFor(user);
  const result = await rt.confirm.confirm(parsed.data, ctx, scope.writer, scope.audit, scope.drafts);
  // El catálogo ha cambiado (producto nuevo, archivado…): el siguiente mensaje debe verlo.
  if (result.ok && (CATALOG_KINDS as readonly string[]).includes(result.kind)) rt.contexts.delete(`${user.userId}:${user.orgId}`);
  const status = result.ok ? 200 : result.code === "forbidden" ? 403 : result.code === "draft_not_found" || result.code === "draft_expired" ? 404 : 422;
  return json(result, status);
}

const SuggestionsQuery = z.object({
  locationId: z.uuid().optional(),
  limit: z.coerce.number().int().min(1).max(20).default(8),
});

async function suggestions(url: URL, user: RequestUser): Promise<Response> {
  const rt = runtime();
  const blocked = limited(rt.limiters.suggestions, `suggestions:${user.userId}`);
  if (blocked) return blocked;
  const parsed = SuggestionsQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return fail(400, { code: "invalid_request", message: "Petición no válida", retryable: false });
  const ctx = await loadContext(user);
  if (parsed.data.locationId && !ctx.locations.some((l) => l.id === parsed.data.locationId)) {
    return fail(403, { code: "forbidden", message: "No tienes acceso a ese local", retryable: false });
  }
  try {
    const result = await rt.suggestions.suggest(ctx, scopeFor(user).tools, {
      limit: parsed.data.limit,
      ...(parsed.data.locationId ? { locationId: parsed.data.locationId } : {}),
    });
    return json(result);
  } catch (err) {
    if (err instanceof DataError) throw err;
    return fail(503, { code: "jev_unavailable", message: "No se pudieron calcular las sugerencias ahora", retryable: true });
  }
}

const AnalyticsQuery = z.object({
  vista: z.enum(ANALYTICS_VIEWS).default("resumen"),
  locationId: z.uuid().optional(),
  productId: z.uuid().optional(),
  dias: z.coerce
    .number()
    .int()
    .refine((d) => [7, 30, 90].includes(d))
    .default(30),
});

async function analytics(url: URL, user: RequestUser): Promise<Response> {
  const rt = runtime();
  const blocked = limited(rt.limiters.analytics, `analytics:${user.userId}`);
  if (blocked) return blocked;
  const parsed = AnalyticsQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return fail(400, { code: "invalid_request", message: "Petición no válida", retryable: false });
  const ctx = await loadContext(user);
  if (parsed.data.locationId && !ctx.locations.some((l) => l.id === parsed.data.locationId)) {
    return fail(403, { code: "forbidden", message: "No tienes acceso a ese local", retryable: false });
  }
  const result = await new Analytics(scopeFor(user).tools.source).view(parsed.data.vista, {
    ctx,
    locationIds: parsed.data.locationId ? [parsed.data.locationId] : ctx.locations.map((l) => l.id),
    productIds: parsed.data.productId ? [parsed.data.productId] : [],
    days: parsed.data.dias,
    now: new Date(),
  });
  return json({ ...result, locations: ctx.locations.map((l) => ({ id: l.id, name: l.name })) });
}

const ReorderQuery = z.object({
  locationId: z.uuid(),
  dias: z.coerce
    .number()
    .int()
    .refine((d) => [3, 7, 14].includes(d))
    .default(7),
});

/**
 * Sugerencia de pedido para un local: mismo cálculo que «¿qué me falta?» (consumo real, mínimos,
 * objetivo y lo que ya está en camino), convertido a formatos de compra con el último proveedor y precio.
 */
async function reorder(url: URL, user: RequestUser): Promise<Response> {
  const rt = runtime();
  const blocked = limited(rt.limiters.analytics, `reorder:${user.userId}`);
  if (blocked) return blocked;
  const parsed = ReorderQuery.safeParse(Object.fromEntries(url.searchParams));
  if (!parsed.success) return fail(400, { code: "invalid_request", message: "Petición no válida", retryable: false });
  const ctx = await loadContext(user);
  if (!ctx.locations.some((l) => l.id === parsed.data.locationId)) {
    return fail(403, { code: "forbidden", message: "No tienes acceso a ese local", retryable: false });
  }
  const { source } = scopeFor(user).tools;
  const days = parsed.data.dias;
  const lines = (
    await computeReorder(
      source,
      { locationIds: [parsed.data.locationId], areaId: null, productIds: [], period: null, horizonDays: days, horizonLabel: `${days} días`, now: new Date() },
      ctx,
    )
  ).filter((l) => l.suggested.gt(0));

  const packOf = (p: (typeof lines)[number]["product"]) => p.packs.find((k) => k.isPurchaseDefault) ?? (p.packs.length === 1 ? p.packs[0]! : null);
  const packIds = lines.map((l) => packOf(l.product)?.id).filter((id): id is string => !!id);
  // supplierPrices viene ordenado por fecha: el primero de cada formato es el último precio.
  const latest = new Map<string, Awaited<ReturnType<typeof source.supplierPrices>>[number]>();
  for (const price of await source.supplierPrices(packIds)) if (!latest.has(price.packId)) latest.set(price.packId, price);

  return json({
    locationId: parsed.data.locationId,
    days,
    lines: lines.map((l) => {
      const pack = packOf(l.product);
      const price = pack ? latest.get(pack.id) : undefined;
      return {
        productId: l.product.id,
        productName: l.product.name,
        baseUnit: l.product.baseUnit,
        stock: l.qty.toString(),
        min: l.min.toString(),
        par: l.par.toString(),
        pendingIn: l.pendingIn.toString(),
        avgDaily: l.avg.toDecimalPlaces(4).toString(),
        coverageDays: l.coverage ? l.coverage.toDecimalPlaces(1).toString() : null,
        suggestedBase: l.suggested.toString(),
        pack: pack ? { id: pack.id, name: pack.name, qtyBase: pack.qtyBase } : null,
        // Siempre formatos enteros, redondeando hacia arriba.
        packs: pack ? l.suggested.div(pack.qtyBase).ceil().toString() : null,
        supplier: price ? { id: price.supplierId, name: price.supplierName } : null,
        price: price?.lastPrice ?? null,
      };
    }),
  });
}

async function health(): Promise<Response> {
  const rt = runtime();
  const [jev, writerOk, embedOk, supabaseOk] = await Promise.all([
    rt.jev.ping(),
    rt.writerProvider ? rt.writerProvider.ping() : Promise.resolve(false),
    rt.embedder ? rt.embedder.ping() : Promise.resolve(false),
    pingSupabase(rt.supabase),
  ]);
  const body: HealthResponse = {
    status: !jev.ok || !supabaseOk ? "caido" : (writerOk || !rt.writerProvider) && (embedOk || !rt.embedder) ? "ok" : "degradado",
    jev,
    writer: { ok: writerOk, provider: rt.config.WRITER_PROVIDER, model: rt.writerProvider ? rt.config.WRITER_MODEL : "plantillas" },
    embeddings: { ok: embedOk, provider: rt.embedder ? rt.config.EMBED_PROVIDER : "lexico", model: rt.embedder ? rt.config.EMBED_MODEL : "-" },
    supabase: { ok: supabaseOk },
    contract: CONTRACT_VERSION,
  };
  return json({ ...body, via: rt.config.jev.via, oidc: rt.config.jev.oidc }, body.status === "caido" ? 503 : 200);
}

/** Punto de entrada: `route` es lo que va detrás de /api/copiloto/. */
export async function handleCopiloto(route: string, request: Request, user: RequestUser): Promise<Response> {
  try {
    const url = new URL(request.url);
    const key = `${request.method} ${route}`;
    switch (key) {
      case "POST chat":
        return await chat(request, user);
      case "POST actions/confirm":
        return await confirm(request, user);
      case "GET suggestions":
        return await suggestions(url, user);
      case "GET analytics":
        return await analytics(url, user);
      case "GET reorder":
        return await reorder(url, user);
      case "GET health":
        return await health();
      default:
        return fail(404, { code: "invalid_request", message: "Ruta no disponible", retryable: false });
    }
  } catch (err) {
    if (err instanceof AuthError) return fail(err.code === "unauthenticated" ? 401 : 403, { code: err.code, message: err.message, retryable: false });
    if (err instanceof DataError) return fail(503, { code: "data_unavailable", message: "No se pudieron leer los datos del inventario", retryable: true });
    console.error("copiloto", err);
    return fail(500, { code: "internal", message: "Error interno del asistente", retryable: true });
  }
}
