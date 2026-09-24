import { createHash } from "node:crypto";
import {
  APIConnectionError,
  APITimeoutError,
  AuthenticationError,
  RateLimitError,
  TypeSafeClient,
  TypeSafeError,
  UnprocessableEntityError,
  type ChoiceResponse,
  type EntryType,
  type NoulResponse,
  type Questions,
  type ScoreResponse,
  type Usage,
} from "@typesafe-ai/sdk";
import type { Cache } from "../cache/lru";
import type { Metrics } from "../metrics/metrics";
import { CATALOG_VERSION } from "./catalog";

export type JevAnswer = NoulResponse | ChoiceResponse | ScoreResponse;

export interface JevResult {
  model: string;
  answers: Record<string, JevAnswer>;
  usage: Usage;
  cached: boolean;
}

export interface JevPort {
  evaluate(state: EntryType, questions: Questions, signal?: AbortSignal): Promise<JevResult>;
  ping(): Promise<{ ok: boolean; model: string | null; latencyMs: number | null }>;
}

export type JevErrorCode = "auth" | "invalid_request" | "rate_limited" | "timeout" | "unavailable";

export class JevError extends Error {
  constructor(
    readonly code: JevErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "JevError";
  }
}

export function toJevError(err: unknown): JevError {
  if (err instanceof JevError) return err;
  if (err instanceof AuthenticationError) return new JevError("auth", "API key de TypeSafe no válida", { cause: err });
  if (err instanceof UnprocessableEntityError) return new JevError("invalid_request", `Jev rechazó la petición: ${err.message}`, { cause: err });
  if (err instanceof RateLimitError) return new JevError("rate_limited", "Límite de peticiones de Jev", { cause: err });
  if (err instanceof APITimeoutError) return new JevError("timeout", "Jev no respondió a tiempo", { cause: err });
  if (err instanceof APIConnectionError || err instanceof TypeSafeError) return new JevError("unavailable", err.message, { cause: err });
  return new JevError("unavailable", err instanceof Error ? err.message : String(err), { cause: err });
}

/** JSON con claves ordenadas, para que la clave de caché no dependa del orden de construcción. */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}

export function cacheKey(model: string, state: EntryType, questions: Questions): string {
  return createHash("sha256")
    .update(stableStringify({ model, catalog: CATALOG_VERSION, state, questions }))
    .digest("hex");
}

export type ApiKeySource = string | undefined | (() => Promise<string | undefined>);

export interface JevClientOptions {
  /** Clave fija, o función (p. ej. el token OIDC de Vercel, que caduca y se renueva). */
  apiKey: ApiKeySource;
  baseURL: string;
  model: string;
  timeoutMs: number;
  maxRetries: number;
  cacheTtlMs: number;
  cache: Cache<JevResult>;
  metrics: Metrics;
}

/** Envoltorio del SDK: caché por hash de state + preguntas, métricas de tokens y errores tipados. */
export class JevClient implements JevPort {
  #client: TypeSafeClient | null = null;
  #clientKey: string | null = null;

  constructor(private readonly options: JevClientOptions) {}

  private async client(): Promise<TypeSafeClient> {
    const key = typeof this.options.apiKey === "function" ? await this.options.apiKey() : this.options.apiKey;
    if (!key) throw new JevError("auth", "Falta TYPESAFE_API_KEY o AI_GATEWAY_API_KEY");
    if (this.#client && this.#clientKey === key) return this.#client;
    this.#clientKey = key;
    this.#client = new TypeSafeClient({
      apiKey: key,
      baseURL: this.options.baseURL,
      defaultModel: this.options.model,
      timeout: this.options.timeoutMs,
      retry: { maxRetries: this.options.maxRetries },
      logLevel: "off",
    });
    return this.#client;
  }

  async evaluate(state: EntryType, questions: Questions, signal?: AbortSignal): Promise<JevResult> {
    const key = cacheKey(this.options.model, state, questions);
    const hit = this.options.cache.get(key);
    if (hit) {
      this.options.metrics.recordJev(hit.usage, true);
      return { ...hit, cached: true };
    }
    try {
      const response = await (await this.client()).systemOne({ state, questions }, { signal });
      const result: JevResult = {
        model: response.model,
        answers: response.answers as Record<string, JevAnswer>,
        usage: response.usage,
        cached: false,
      };
      this.options.metrics.recordJev(result.usage, false);
      this.options.cache.set(key, result, this.options.cacheTtlMs);
      return result;
    } catch (err) {
      throw toJevError(err);
    }
  }

  async ping(): Promise<{ ok: boolean; model: string | null; latencyMs: number | null }> {
    const t0 = performance.now();
    try {
      const models = await (await this.client()).models.list({ timeout: 3000, retry: { maxRetries: 0 } });
      return { ok: models.length > 0, model: this.options.model, latencyMs: Math.round(performance.now() - t0) };
    } catch {
      return { ok: false, model: null, latencyMs: null };
    }
  }
}
