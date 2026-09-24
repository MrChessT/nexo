import { z } from "zod";

const bool = z
  .enum(["true", "false", "1", "0"])
  .transform((value) => value === "true" || value === "1");

const EnvSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  PORT: z.coerce.number().int().positive().default(8787),
  APP_ORIGIN: z.string().url().default("http://localhost:3000"),

  TYPESAFE_API_KEY: z.string().min(1).optional(),
  // Alternativa: Jev a través de Vercel AI Gateway (misma API, facturado en Vercel).
  AI_GATEWAY_API_KEY: z.string().min(1).optional(),
  JEV_BASE_URL: z.string().url().optional(),
  JEV_MODEL: z.string().optional(),
  JEV_TIMEOUT_MS: z.coerce.number().int().positive().default(8000),
  JEV_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(2),
  JEV_CACHE_TTL_S: z.coerce.number().int().min(0).default(600),
  JEV_SELF_CONSISTENCY: bool.default(true),
  // Precio por millón de tokens de entrada (Jev 1.13: 0,042 $). Solo para métricas.
  JEV_PRICE_PER_MTOK_USD: z.string().default("0.042"),

  WRITER_PROVIDER: z.enum(["ollama", "openai", "none"]).default("ollama"),
  OLLAMA_URL: z.string().url().default("http://localhost:11434"),
  WRITER_URL: z.string().url().optional(),
  WRITER_MODEL: z.string().default("qwen2.5:3b"),
  WRITER_API_KEY: z.string().optional(),
  WRITER_MAX_TOKENS: z.coerce.number().int().positive().default(220),
  WRITER_TEMPERATURE: z.coerce.number().min(0).max(1).default(0.2),
  WRITER_NUM_CTX: z.coerce.number().int().positive().default(2048),
  WRITER_KEEP_ALIVE: z.string().default("30m"),
  WRITER_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),

  EMBED_PROVIDER: z.enum(["ollama", "openai", "none"]).default("ollama"),
  EMBED_URL: z.string().url().optional(),
  EMBED_MODEL: z.string().default("nomic-embed-text"),
  EMBED_API_KEY: z.string().optional(),

  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),

  METRICS_TOKEN: z.string().min(16).optional(),
  RATE_CHAT_PER_MIN: z.coerce.number().int().positive().default(20),
  RATE_CONFIRM_PER_MIN: z.coerce.number().int().positive().default(10),
  RATE_SUGGESTIONS_PER_MIN: z.coerce.number().int().positive().default(6),
});

export type Config = z.infer<typeof EnvSchema> & {
  writerUrl: string;
  embedUrl: string;
  jev: { apiKey: string | undefined; baseURL: string; model: string; via: "typesafe" | "ai-gateway"; oidc: boolean };
};

const GATEWAY_URL = "https://ai-gateway.vercel.sh/typesafe";

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  // "CLAVE=" vacía en .env cuenta como no definida.
  const cleaned: Record<string, string> = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined && entry[1].trim() !== ""),
  );
  // Dentro de la app se reutilizan las variables públicas de Supabase.
  cleaned.SUPABASE_URL ??= cleaned.NEXT_PUBLIC_SUPABASE_URL ?? "";
  cleaned.SUPABASE_ANON_KEY ??= cleaned.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? "";
  for (const key of ["SUPABASE_URL", "SUPABASE_ANON_KEY"]) if (!cleaned[key]) delete cleaned[key];
  // Por defecto, sin LLM de redacción ni embeddings (plantillas y búsqueda léxica): nada que instalar.
  cleaned.WRITER_PROVIDER ??= "none";
  cleaned.EMBED_PROVIDER ??= "none";
  const parsed = EnvSchema.safeParse(cleaned);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`);
    throw new Error(`Configuración no válida:\n${issues.join("\n")}`);
  }
  const cfg = parsed.data;
  if (cfg.NODE_ENV === "production") {
    const missing = (["SUPABASE_URL", "SUPABASE_ANON_KEY"] as const).filter((key) => !cfg[key]);
    if (missing.length > 0) throw new Error(`Faltan variables obligatorias en producción: ${missing.join(", ")}`);
  }
  // TypeSafe directo tiene prioridad; si solo hay clave del gateway, se usa el gateway.
  // En Vercel, sin claves: Jev por AI Gateway con el token OIDC del propio despliegue.
  const oidc = !cfg.TYPESAFE_API_KEY && !cfg.AI_GATEWAY_API_KEY && (cleaned.VERCEL === "1" || Boolean(cleaned.VERCEL_OIDC_TOKEN));
  const viaGateway = !cfg.TYPESAFE_API_KEY && (Boolean(cfg.AI_GATEWAY_API_KEY) || oidc);
  const jev = viaGateway
    ? { apiKey: cfg.AI_GATEWAY_API_KEY, baseURL: cfg.JEV_BASE_URL ?? GATEWAY_URL, model: cfg.JEV_MODEL ?? "typesafe-ai/jev", via: "ai-gateway" as const, oidc }
    : { apiKey: cfg.TYPESAFE_API_KEY, baseURL: cfg.JEV_BASE_URL ?? "https://api.typesafe.ai", model: cfg.JEV_MODEL ?? "jev-latest", via: "typesafe" as const, oidc: false };
  // Redacción y embeddings a través de Vercel AI Gateway: reutilizan AI_GATEWAY_API_KEY si no tienen clave propia.
  const viaGatewayUrl = (url: string | undefined) => Boolean(url?.includes("ai-gateway.vercel.sh"));
  const writerApiKey = cfg.WRITER_API_KEY ?? (viaGatewayUrl(cfg.WRITER_URL) ? cfg.AI_GATEWAY_API_KEY : undefined);
  const embedApiKey = cfg.EMBED_API_KEY ?? (viaGatewayUrl(cfg.EMBED_URL) ? cfg.AI_GATEWAY_API_KEY : undefined);
  return {
    ...cfg,
    WRITER_API_KEY: writerApiKey,
    EMBED_API_KEY: embedApiKey,
    jev,
    writerUrl: cfg.WRITER_URL ?? (cfg.WRITER_PROVIDER === "ollama" ? cfg.OLLAMA_URL : "https://api.openai.com"),
    embedUrl: cfg.EMBED_URL ?? (cfg.EMBED_PROVIDER === "ollama" ? cfg.OLLAMA_URL : "https://api.openai.com"),
  };
}
