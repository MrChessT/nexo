// Evaluación del enrutado contra Jev REAL (no usa caché). Uso:
//   npm run eval                 → todas las frases de eval/frases.jsonl
//   npm run eval -- --only 5     → las 5 primeras
// Escribe el resumen en consola y en eval/resultados.md.
import { getVercelOidcToken } from "@vercel/oidc";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryType } from "@typesafe-ai/sdk";
import { CATALOG_ACCIONES, Interpreter, type Plan } from "../agent/interpret";
import { buildRouting } from "../agent/routing";
import { LruCache } from "../cache/lru";
import { loadConfig } from "../config";
import { fixtureContext } from "../dev/fixture";
import { LexicalRetriever } from "../entities/retriever";
import { asChoice, asNoul } from "../gates/gate";
import { loadThresholds } from "../gates/thresholds";
import { CATALOG_VERSION } from "../jev/catalog";
import { JevClient, type JevResult } from "../jev/client";
import { Metrics } from "../metrics/metrics";

interface Case {
  message: string;
  intent: string;
  herramienta?: string;
  tipo_accion?: string;
  local?: string;
  local_destino?: string;
  producto?: string;
  periodo?: string;
  destino?: string;
  inyeccion?: boolean;
  /** Se espera una pregunta de aclaración (frase ambigua a propósito). */
  aclarar?: boolean;
}

const FIELDS = ["intent", "herramienta", "tipo_accion", "local", "local_destino", "producto", "periodo", "destino"] as const;
type Field = (typeof FIELDS)[number];
const QUESTION: Record<Field, string> = {
  intent: "intent",
  herramienta: "herramienta",
  tipo_accion: "tipo_accion",
  local: "local",
  local_destino: "local_destino",
  producto: "producto_0",
  periodo: "periodo",
  destino: "destino",
};
const EXPECTED_PLAN: Record<string, Plan["type"]> = {
  consultar: "consultar",
  pedir_sugerencias: "consultar",
  proponer_accion: "accion",
  navegar: "navegar",
  conversar: "conversar",
  fuera_de_ambito: "fuera_de_ambito",
};

const args = process.argv.slice(2);
const only = args.includes("--only") ? Number(args[args.indexOf("--only") + 1]) : Infinity;
// --desde N: empieza en la frase N (0 = la primera). --lote N: frases en paralelo (5 por defecto).
const from = args.includes("--desde") ? Number(args[args.indexOf("--desde") + 1]) : 0;
const batch = args.includes("--lote") ? Math.max(1, Number(args[args.indexOf("--lote") + 1])) : 5;
const cases: Case[] = readFileSync(join(process.cwd(), "src/copiloto/eval/frases.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Case)
  .slice(from)
  .slice(0, only);

const config = loadConfig();
if (!config.jev.apiKey && !config.jev.oidc) throw new Error("Falta TYPESAFE_API_KEY, AI_GATEWAY_API_KEY o VERCEL_OIDC_TOKEN en .env.local");
const metrics = new Metrics(config.JEV_PRICE_PER_MTOK_USD);
const jev = new JevClient({
  apiKey: config.jev.oidc ? () => getVercelOidcToken() : config.jev.apiKey,
  baseURL: config.jev.baseURL,
  model: config.jev.model,
  timeoutMs: 20_000,
  maxRetries: 3,
  cacheTtlMs: 0,
  cache: new LruCache<JevResult>(1, 1),
  metrics,
});
const thresholds = loadThresholds();
const ctx = fixtureContext("manager");
const retriever = new LexicalRetriever();

interface Row {
  c: Case;
  answers: Record<string, { value: string; confidence: number | null; ok: boolean }>;
  plan: Plan["type"];
  verdict: "correcto" | "pregunta" | "error_peligroso" | "error";
  detail: string;
}

async function evaluate(c: Case): Promise<Row> {
  const built = await buildRouting(c.message, "/", undefined, [], ctx, retriever, config.JEV_SELF_CONSISTENCY);
  const result = await jev.evaluate(built.state as unknown as EntryType, built.questions);
  const answers: Row["answers"] = {};
  for (const field of FIELDS) {
    const label = c[field];
    if (label === undefined) continue;
    const a = asChoice(result.answers[QUESTION[field]]);
    answers[field] = a ? { value: a.choice, confidence: a.confidence, ok: a.choice === label } : { value: "(sin pregunta)", confidence: null, ok: false };
  }
  const injection = asNoul(result.answers.inyeccion)?.noul ?? 0;
  answers.inyeccion = { value: injection.toFixed(2), confidence: null, ok: (injection > thresholds.inyeccion.ask) === Boolean(c.inyeccion) };

  const plan = new Interpreter(result.answers, built.meta, ctx, thresholds, {}, undefined).run().plan;
  const catalog = (CATALOG_ACCIONES as readonly string[]).includes(c.tipo_accion ?? "");
  const expected = c.inyeccion ? "bloqueado" : catalog ? "catalogo" : EXPECTED_PLAN[c.intent]!;
  const writes = plan.type === "accion" || plan.type === "catalogo";
  const wrongFields = Object.entries(answers).filter(([, a]) => !a.ok).map(([f, a]) => `${f}=${a.value}`);
  let verdict: Row["verdict"];
  if (c.aclarar) verdict = plan.type === "clarify" ? "correcto" : writes ? "error_peligroso" : "error";
  else if (plan.type === "clarify") verdict = "pregunta";
  else if (plan.type === expected && wrongFields.length === 0) verdict = "correcto";
  else verdict = writes ? "error_peligroso" : "error";
  const detail = plan.type === "clarify" ? `pregunta por ${plan.field}` : wrongFields.join(", ");
  return { c, answers, plan: plan.type, verdict, detail };
}

async function main() {
const rows: Row[] = [];
for (let i = 0; i < cases.length; i += batch) {
  rows.push(...(await Promise.all(cases.slice(i, i + batch).map(evaluate))));
  process.stdout.write(`\r${rows.length}/${cases.length}`);
}
process.stdout.write("\n");

const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 100)} %`);
const lines: string[] = [];
const out = (s = "") => lines.push(s);

out(`# Resultados de evaluación`);
out();
out(`Catálogo ${CATALOG_VERSION} · modelo ${config.jev.model} (${config.jev.via}) · ${rows.length} frases · ${new Date().toISOString()}`);
out();
out(`## Por mensaje`);
out();
const count = (v: Row["verdict"]) => rows.filter((r) => r.verdict === v).length;
out(`| Resultado | Frases |`);
out(`| --- | --- |`);
out(`| Correcto | ${count("correcto")} (${pct(count("correcto"), rows.length)}) |`);
out(`| Pregunta de más (seguro) | ${count("pregunta")} (${pct(count("pregunta"), rows.length)}) |`);
out(`| Error sin escritura | ${count("error")} |`);
out(`| **Error con borrador equivocado** | **${count("error_peligroso")}** |`);
out();
out(`## Por decisión (elección más probable de Jev)`);
out();
out(`| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla |`);
out(`| --- | --- | --- | --- |`);
for (const field of [...FIELDS, "inyeccion"]) {
  const got = rows.map((r) => r.answers[field]).filter((a): a is NonNullable<typeof a> => Boolean(a));
  if (got.length === 0) continue;
  const ok = got.filter((a) => a.ok);
  const bad = got.filter((a) => !a.ok);
  const mean = (list: typeof got) => {
    const v = list.map((a) => a.confidence).filter((x): x is number => x !== null);
    return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : "-";
  };
  out(`| ${field} | ${ok.length}/${got.length} (${pct(ok.length, got.length)}) | ${mean(ok)} | ${mean(bad)} |`);
}
out();
out(`## Barrido de umbral para la intención`);
out();
out(`| Umbral act | Cobertura (actúa) | Precisión cuando actúa |`);
out(`| --- | --- | --- |`);
for (const t of [0.5, 0.6, 0.7, 0.8, 0.9]) {
  const acted = rows.map((r) => r.answers.intent!).filter((a) => (a.confidence ?? 0) >= t);
  out(`| ${t.toFixed(1)} | ${pct(acted.length, rows.length)} | ${pct(acted.filter((a) => a.ok).length, acted.length)} |`);
}
out();
out(`## Detalle de lo que no fue «correcto»`);
out();
out(`| Frase | Resultado | Plan | Detalle |`);
out(`| --- | --- | --- | --- |`);
for (const r of rows.filter((x) => x.verdict !== "correcto")) out(`| ${r.c.message} | ${r.verdict} | ${r.plan} | ${r.detail} |`);
out();
const snap = metrics.snapshot();
out(`Coste Jev de esta evaluación: ${snap.jev.calls} llamadas, ${snap.jev.inputTokens} tokens de entrada, ~${snap.jev.estimatedCostUsd} $.`);

const report = lines.join("\n");
writeFileSync(join(process.cwd(), "docs/copiloto/EVALUACION.md"), `${report}\n`, "utf8");
console.log(report);
}

void main();
