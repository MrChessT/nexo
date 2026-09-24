// Sonda puntual: probabilidades de intent y tipo_accion para unas frases (no forma parte del set).
import type { EntryType } from "@typesafe-ai/sdk";
import { getVercelOidcToken } from "@vercel/oidc";
import { buildRouting } from "../agent/routing";
import { LruCache } from "../cache/lru";
import { loadConfig } from "../config";
import { fixtureContext } from "../dev/fixture";
import { LexicalRetriever } from "../entities/retriever";
import { asChoice } from "../gates/gate";
import { JevClient, type JevResult } from "../jev/client";
import { Metrics } from "../metrics/metrics";

const config = loadConfig();
const jev = new JevClient({
  apiKey: config.jev.oidc ? () => getVercelOidcToken() : config.jev.apiKey,
  baseURL: config.jev.baseURL, model: config.jev.model, timeoutMs: 20_000, maxRetries: 3, cacheTtlMs: 0,
  cache: new LruCache<JevResult>(1, 1), metrics: new Metrics(config.JEV_PRICE_PER_MTOK_USD),
});
const phrases = process.argv.slice(2);
async function main() {
for (const message of phrases) {
  const turns = process.env.PROBE_TURNS ? JSON.parse(process.env.PROBE_TURNS) : [];
  const built = await buildRouting(message, "/", undefined, turns, fixtureContext(), new LexicalRetriever(), true);
  const r = await jev.evaluate(built.state as unknown as EntryType, built.questions);
  for (const id of (process.env.PROBE_IDS ?? "intent,tipo_accion").split(",")) {
    const raw = r.answers[id];
    if (raw?.type === "noul") {
      console.log(`${message} | ${id}: ${raw.noul.toFixed(2)}`);
      continue;
    }
    const a = asChoice(raw)!;
    const top = Object.entries(a.probabilities as Record<string, number>).sort((x, y) => y[1] - x[1]).slice(0, 3).map(([k, v]) => `${k} ${v.toFixed(2)}`);
    console.log(`${message} | ${id}: conf ${a.confidence.toFixed(2)} · ${top.join(" · ")}`);
  }
}
}
void main();
