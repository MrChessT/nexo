// Recuperación de candidatos de producto. Fase 2: coincidencia léxica difusa.
// En la fase 3 se combina con embeddings (misma interfaz).
import type { Product } from "../domain";
import { STOPWORDS, tokenize } from "./normalize";

export interface Candidate {
  product: Product;
  score: number;
}

export interface Retriever {
  retrieve(products: Product[], query: string, k: number, catalogHash: string): Promise<Candidate[]>;
}

function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const grams = new Set<string>();
  for (let i = 0; i < padded.length - 2; i += 1) grams.add(padded.slice(i, i + 3));
  return grams;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  let inter = 0;
  for (const g of a) if (b.has(g)) inter += 1;
  return inter / (a.size + b.size - inter);
}

function commonPrefix(a: string, b: string): number {
  let n = 0;
  while (n < a.length && n < b.length && a[n] === b[n]) n += 1;
  return n;
}

/** Parecido entre una palabra del mensaje y una del nombre, de 0 a 1. */
function tokenSimilarity(q: string, n: string): number {
  if (q === n) return 1;
  if (/^\d+$/.test(q) || /^\d+$/.test(n)) return 0;
  const prefix = commonPrefix(q, n);
  if (prefix >= 4 || (prefix >= 3 && Math.min(q.length, n.length) <= 4)) return 0.85;
  const sim = jaccard(trigrams(q), trigrams(n));
  return sim >= 0.35 ? sim * 0.8 : 0;
}

export function lexicalScore(query: string, product: Product): number {
  const qTokens = tokenize(query).filter((t) => t.length >= 2 && !STOPWORDS.has(t));
  if (qTokens.length === 0) return 0;
  const nameTokens = tokenize(`${product.name} ${product.category ?? ""}`);
  let score = 0;
  for (const q of qTokens) {
    let best = 0;
    for (const n of nameTokens) best = Math.max(best, tokenSimilarity(q, n));
    score += best;
  }
  return score;
}

export class LexicalRetriever implements Retriever {
  async retrieve(products: Product[], query: string, k: number): Promise<Candidate[]> {
    return products
      .map((product) => ({ product, score: lexicalScore(query, product) }))
      .filter((c) => c.score > 0)
      .sort((a, b) => b.score - a.score || a.product.name.localeCompare(b.product.name))
      .slice(0, k);
  }
}
