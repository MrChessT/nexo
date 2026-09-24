// Piezas compartidas por todas las peticiones de una instancia (Vercel reutiliza instancias):
// cliente de Jev con caché, métricas, redactor, recuperación de productos, agente y servicios.
// Lo que depende del usuario (datos, borradores, sesiones, auditoría) se crea por petición en http.ts.
import { getVercelOidcToken } from "@vercel/oidc";
import { Agent } from "./agent/loop";
import { SessionStore } from "./agent/session";
import { ConsoleAuditSink } from "./audit/audit";
import { LruCache } from "./cache/lru";
import { loadConfig, type Config } from "./config";
import type { SessionContext } from "./domain";
import { DraftBuilder } from "./drafts/builder";
import { ConfirmService } from "./drafts/confirm";
import { DraftStore } from "./drafts/store";
import { HybridRetriever, OllamaEmbeddings, OpenAIEmbeddings, type EmbeddingProvider } from "./entities/embeddings";
import { LexicalRetriever, type Retriever } from "./entities/retriever";
import { loadThresholds, type Thresholds } from "./gates/thresholds";
import { JevClient, type ApiKeySource, type JevResult } from "./jev/client";
import { Metrics } from "./metrics/metrics";
import { RateLimiter } from "./security/rate-limit";
import { SuggestionEngine } from "./suggestions/engine";
import type { SupabaseSettings } from "./supabase/client";
import { OllamaProvider, OpenAICompatibleProvider, type WriterProvider } from "./writer/provider";
import { Writer } from "./writer/writer";

export interface Runtime {
  config: Config;
  thresholds: Thresholds;
  metrics: Metrics;
  jev: JevClient;
  writerProvider: WriterProvider | null;
  embedder: EmbeddingProvider | null;
  agent: Agent;
  suggestions: SuggestionEngine;
  confirm: ConfirmService;
  supabase: SupabaseSettings;
  contexts: LruCache<SessionContext>;
  limiters: { chat: RateLimiter; confirm: RateLimiter; suggestions: RateLimiter; analytics: RateLimiter };
}

let current: Runtime | null = null;

export function runtime(): Runtime {
  current ??= build();
  return current;
}

function build(): Runtime {
  const config = loadConfig();
  if (!config.SUPABASE_URL || !config.SUPABASE_ANON_KEY) throw new Error("Faltan NEXT_PUBLIC_SUPABASE_URL y NEXT_PUBLIC_SUPABASE_ANON_KEY");
  const thresholds = loadThresholds();
  const metrics = new Metrics(config.JEV_PRICE_PER_MTOK_USD);

  const apiKey: ApiKeySource = config.jev.oidc ? () => getVercelOidcToken().catch(() => undefined) : config.jev.apiKey;
  const jev = new JevClient({
    apiKey,
    baseURL: config.jev.baseURL,
    model: config.jev.model,
    timeoutMs: config.JEV_TIMEOUT_MS,
    maxRetries: config.JEV_MAX_RETRIES,
    cacheTtlMs: config.JEV_CACHE_TTL_S * 1000,
    cache: new LruCache<JevResult>(5000, config.JEV_CACHE_TTL_S * 1000),
    metrics,
  });

  const providerOptions = {
    url: config.writerUrl,
    model: config.WRITER_MODEL,
    ...(config.WRITER_API_KEY ? { apiKey: config.WRITER_API_KEY } : {}),
    maxTokens: config.WRITER_MAX_TOKENS,
    temperature: config.WRITER_TEMPERATURE,
    numCtx: config.WRITER_NUM_CTX,
    keepAlive: config.WRITER_KEEP_ALIVE,
  };
  const writerProvider: WriterProvider | null =
    config.WRITER_PROVIDER === "ollama" ? new OllamaProvider(providerOptions) : config.WRITER_PROVIDER === "openai" ? new OpenAICompatibleProvider(providerOptions) : null;

  const embedOptions = { url: config.embedUrl, model: config.EMBED_MODEL, ...(config.EMBED_API_KEY ? { apiKey: config.EMBED_API_KEY } : {}) };
  const embedder: EmbeddingProvider | null =
    config.EMBED_PROVIDER === "ollama" ? new OllamaEmbeddings(embedOptions) : config.EMBED_PROVIDER === "openai" ? new OpenAIEmbeddings(embedOptions) : null;
  const retriever: Retriever = embedder ? new HybridRetriever(embedder, metrics) : new LexicalRetriever();

  const writer = new Writer(writerProvider, metrics, { timeoutMs: config.WRITER_TIMEOUT_MS, attempts: 2 });
  const audit = new ConsoleAuditSink();
  // Las peticiones reales pasan sus propios almacenes (Supabase); estos solo son el valor por defecto.
  const drafts = new DraftStore();
  const agent = new Agent({
    jev,
    retriever,
    writer,
    metrics,
    thresholds,
    sessions: new SessionStore(),
    audit,
    selfConsistency: config.JEV_SELF_CONSISTENCY,
    drafts,
    builder: new DraftBuilder(),
  });

  return {
    config,
    thresholds,
    metrics,
    jev,
    writerProvider,
    embedder,
    agent,
    suggestions: new SuggestionEngine({ jev, writer, metrics, thresholds }),
    confirm: new ConfirmService(drafts, audit),
    supabase: { url: config.SUPABASE_URL, anonKey: config.SUPABASE_ANON_KEY },
    contexts: new LruCache<SessionContext>(2000, 5 * 60 * 1000),
    limiters: {
      chat: new RateLimiter(config.RATE_CHAT_PER_MIN),
      confirm: new RateLimiter(config.RATE_CONFIRM_PER_MIN),
      suggestions: new RateLimiter(config.RATE_SUGGESTIONS_PER_MIN),
      analytics: new RateLimiter(60),
    },
  };
}
