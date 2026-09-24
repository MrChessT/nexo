// Embeddings del catálogo: proveedor intercambiable (Ollama u OpenAI-compatible) y recuperación híbrida
// (similitud semántica + coincidencia léxica). Si el proveedor cae, se usa solo la parte léxica.
import { LruCache } from "../cache/lru";
import type { Product } from "../domain";
import type { Metrics } from "../metrics/metrics";
import { lexicalScore, LexicalRetriever, type Candidate, type Retriever } from "./retriever";

export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  embed(texts: string[], kind: "document" | "query"): Promise<number[][]>;
  ping(): Promise<boolean>;
}

interface EmbedOptions {
  url: string;
  model: string;
  apiKey?: string;
  timeoutMs?: number;
}

/** nomic-embed-text pide prefijos de tarea para separar documentos y consultas. */
function withPrefix(model: string, texts: string[], kind: "document" | "query"): string[] {
  if (!model.includes("nomic")) return texts;
  const prefix = kind === "document" ? "search_document: " : "search_query: ";
  return texts.map((t) => prefix + t);
}

export class OllamaEmbeddings implements EmbeddingProvider {
  readonly name = "ollama";
  constructor(private readonly options: EmbedOptions) {}

  get model(): string {
    return this.options.model;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const response = await fetch(`${this.options.url}/api/embed`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.options.model, input: withPrefix(this.options.model, texts, kind), keep_alive: "30m" }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new Error(`Ollama embeddings respondió ${response.status}`);
    const data = (await response.json()) as { embeddings?: number[][] };
    if (!data.embeddings || data.embeddings.length !== texts.length) throw new Error("Respuesta de embeddings incompleta");
    return data.embeddings;
  }

  async ping(): Promise<boolean> {
    try {
      await this.embed(["ping"], "query");
      return true;
    } catch {
      return false;
    }
  }
}

export class OpenAIEmbeddings implements EmbeddingProvider {
  readonly name = "openai";
  constructor(private readonly options: EmbedOptions) {}

  get model(): string {
    return this.options.model;
  }

  async embed(texts: string[], kind: "document" | "query"): Promise<number[][]> {
    const response = await fetch(`${this.options.url}/v1/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}) },
      body: JSON.stringify({ model: this.options.model, input: withPrefix(this.options.model, texts, kind) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 20_000),
    });
    if (!response.ok) throw new Error(`Embeddings respondió ${response.status}`);
    const data = (await response.json()) as { data?: Array<{ index: number; embedding: number[] }> };
    const rows = [...(data.data ?? [])].sort((a, b) => a.index - b.index).map((d) => d.embedding);
    if (rows.length !== texts.length) throw new Error("Respuesta de embeddings incompleta");
    return rows;
  }

  async ping(): Promise<boolean> {
    try {
      await this.embed(["ping"], "query");
      return true;
    } catch {
      return false;
    }
  }
}

function normalizeVector(v: number[]): Float32Array {
  let norm = 0;
  for (const x of v) norm += x * x;
  norm = Math.sqrt(norm) || 1;
  return Float32Array.from(v, (x) => x / norm);
}

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0;
  for (let i = 0; i < a.length; i += 1) s += a[i]! * b[i]!;
  return s;
}

export function productDocument(product: Product): string {
  const packs = product.packs.map((p) => p.name).join(", ");
  return `${product.name}. Categoría: ${product.category ?? "sin categoría"}.${product.notes ? ` ${product.notes}.` : ""}${packs ? ` Formatos: ${packs}.` : ""}`;
}

export interface HybridOptions {
  /** Similitud coseno mínima para que un candidato solo semántico entre en la lista. */
  minSimilarity: number;
  /** Peso de la parte semántica (el resto es léxico). */
  semanticWeight: number;
}

interface CatalogIndex {
  ids: string[];
  vectors: Float32Array[];
}

export class HybridRetriever implements Retriever {
  readonly #catalogs = new LruCache<Promise<CatalogIndex>>(50, 24 * 60 * 60 * 1000);
  readonly #queries = new LruCache<Float32Array>(2000, 60 * 60 * 1000);
  readonly #lexical = new LexicalRetriever();
  lastError: string | null = null;

  constructor(
    private readonly provider: EmbeddingProvider,
    private readonly metrics: Metrics,
    private readonly options: HybridOptions = { minSimilarity: 0.35, semanticWeight: 0.6 },
  ) {}

  /** Embeddings del catálogo, uno por huella: solo se recalculan cuando cambia `products`. */
  private catalog(products: Product[], catalogHash: string): Promise<CatalogIndex> {
    const key = `${this.provider.name}:${this.provider.model}:${catalogHash}`;
    const cached = this.#catalogs.get(key);
    if (cached) {
      this.metrics.embedCacheHits += 1;
      return cached;
    }
    const building = (async () => {
      const vectors: Float32Array[] = [];
      for (let i = 0; i < products.length; i += 64) {
        const batch = products.slice(i, i + 64);
        const embedded = await this.provider.embed(batch.map(productDocument), "document");
        vectors.push(...embedded.map(normalizeVector));
      }
      return { ids: products.map((p) => p.id), vectors };
    })();
    this.#catalogs.set(key, building);
    building.catch(() => this.#catalogs.delete(key));
    return building;
  }

  private async query(text: string): Promise<Float32Array> {
    const key = text.trim().toLowerCase();
    const cached = this.#queries.get(key);
    if (cached) {
      this.metrics.embedCacheHits += 1;
      return cached;
    }
    const [vector] = await this.provider.embed([text], "query");
    const normalized = normalizeVector(vector!);
    this.#queries.set(key, normalized);
    return normalized;
  }

  async retrieve(products: Product[], queryText: string, k: number, catalogHash: string): Promise<Candidate[]> {
    if (products.length === 0) return [];
    let semantic: Map<string, number>;
    try {
      const [index, q] = await Promise.all([this.catalog(products, catalogHash), this.query(queryText)]);
      semantic = new Map(index.ids.map((id, i) => [id, dot(index.vectors[i]!, q)]));
      this.lastError = null;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      return this.#lexical.retrieve(products, queryText, k);
    }

    const lexical = new Map(products.map((p) => [p.id, lexicalScore(queryText, p)]));
    const maxLex = Math.max(0, ...lexical.values());
    const { minSimilarity, semanticWeight } = this.options;
    return products
      .map((product) => {
        const sim = semantic.get(product.id) ?? 0;
        const lex = maxLex > 0 ? (lexical.get(product.id) ?? 0) / maxLex : 0;
        return { product, sim, lex, score: semanticWeight * sim + (1 - semanticWeight) * lex };
      })
      .filter((c) => c.lex > 0 || c.sim >= minSimilarity)
      .sort((a, b) => b.score - a.score)
      .slice(0, k)
      .map(({ product, score }) => ({ product, score }));
  }
}
