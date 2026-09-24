// Sonda puntual de las preguntas de valoración (llamada nº 2) con ítems de ejemplo.
import { getVercelOidcToken } from "@vercel/oidc";
import { LruCache } from "../cache/lru";
import { loadConfig } from "../config";
import { asNoul, asScore } from "../gates/gate";
import { evaluationQuestions, type EvalKind } from "../jev/catalog";
import { JevClient, type JevResult } from "../jev/client";
import { Metrics } from "../metrics/metrics";

const config = loadConfig();
const jev = new JevClient({
  apiKey: config.jev.oidc ? () => getVercelOidcToken() : config.jev.apiKey,
  baseURL: config.jev.baseURL, model: config.jev.model, timeoutMs: 20_000, maxRetries: 3, cacheTtlMs: 0,
  cache: new LruCache<JevResult>(1, 1), metrics: new Metrics(config.JEV_PRICE_PER_MTOK_USD),
});
const items: Array<{ kind: EvalKind; data: Record<string, string> }> = [
  { kind: "pedido", data: { supplier: "Makro", venue: "Parador", state: "retrasado", age: "5 días", expected: "21 sep", value: "412,00 €" } },
  { kind: "pedido", data: { supplier: "Bebidas del Sur", venue: "Vivero", state: "borrador", age: "1 días", expected: "sin fecha", value: "66,00 €" } },
  { kind: "conteo", data: { venue: "Pickels", days_since_count: "más de 60 días", stock_value: "3.240,00 €" } },
  { kind: "conteo", data: { venue: "La Oliva", days_since_count: "16 días", stock_value: "180,00 €" } },
];
async function main() {
  const { answers } = await jev.evaluate(
    { request: "What should the manager of these hospitality venues pay attention to now?", horizon: "los próximos 3 días", items: items.map((i) => i.data) },
    evaluationQuestions(items.map((i) => i.kind), false),
  );
  items.forEach((it, i) => {
    console.log(`${it.kind} ${JSON.stringify(it.data)} → relevancia ${asNoul(answers[`${it.kind}_${i}`])?.noul.toFixed(2)} · urgencia ${asScore(answers[`urgencia_${i}`])?.score.toFixed(2)}`);
  });
}
void main();
