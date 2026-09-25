// Evaluación del enrutado contra Jev REAL (no usa caché). Uso:
//   npm run copiloto:eval                  → todas las frases de eval/frases.jsonl
//   npm run copiloto:eval -- --only 5      → las 5 primeras
//   npm run copiloto:eval -- --grupo jerga → solo un grupo (natural, jerga, erratas, dato…)
// Escribe el resumen en consola y en docs/copiloto/EVALUACION.md, con la calibración de cada
// decisión (¿acierta tanto como dice?) y el umbral que recomienda cada contexto.
import { getVercelOidcToken } from "@vercel/oidc";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EntryType } from "@typesafe-ai/sdk";
import { CATALOG_ACCIONES, DOCUMENT_ACCIONES, Interpreter, type Plan } from "../agent/interpret";
import { buildRouting } from "../agent/routing";
import { LruCache } from "../cache/lru";
import { loadConfig } from "../config";
import { fixtureContext } from "../dev/fixture";
import { LexicalRetriever } from "../entities/retriever";
import { asChoice, asNoul } from "../gates/gate";
import { loadThresholds, type GateKey } from "../gates/thresholds";
import { CATALOG_VERSION } from "../jev/catalog";
import { JevClient, JevError, type JevResult } from "../jev/client";
import { Metrics } from "../metrics/metrics";
import { BIN_EDGES, expectedCalibrationError, recommendThreshold, reliability, sweep, type Point } from "./calibration";

/** Una respuesta válida o varias («¿a cómo sale el Brugal?» vale como ficha o como precios). */
type Label = string | string[];

interface Case {
  message: string;
  intent: Label;
  herramienta?: Label;
  tipo_accion?: Label;
  local?: Label;
  local_destino?: Label;
  producto?: Label;
  periodo?: Label;
  destino?: Label;
  /** Qué dato pide una consulta (cantidad, valor, precio, proveedor, formatos, mínimo). */
  dato?: Label;
  inyeccion?: boolean;
  /** Se espera una pregunta de aclaración (frase ambigua a propósito). */
  aclarar?: boolean;
  /** base, natural, jerga, erratas, dato, excepcion, fuera… (para ver dónde falla). */
  grupo?: string;
}

const FIELDS = ["intent", "herramienta", "tipo_accion", "local", "local_destino", "producto", "periodo", "destino", "dato"] as const;
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
  dato: "dato",
};
const EXPECTED_PLAN: Record<string, Plan["type"]> = {
  consultar: "consultar",
  pedir_sugerencias: "consultar",
  proponer_accion: "accion",
  navegar: "navegar",
  conversar: "conversar",
  fuera_de_ambito: "fuera_de_ambito",
};

const labels = (l: Label | undefined): string[] => (l === undefined ? [] : Array.isArray(l) ? l : [l]);

const args = process.argv.slice(2);
const arg = (name: string) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const only = arg("--only") ? Number(arg("--only")) : Infinity;
// --desde N: empieza en la frase N (0 = la primera). --lote N: frases en paralelo (5 por defecto).
const from = arg("--desde") ? Number(arg("--desde")) : 0;
const batch = arg("--lote") ? Math.max(1, Number(arg("--lote"))) : 5;
const group = arg("--grupo");
const cases: Case[] = readFileSync(join(process.cwd(), "src/copiloto/eval/frases.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith("//"))
  .map((l) => JSON.parse(l) as Case)
  .filter((c) => !group || (c.grupo ?? "base") === group)
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

interface Answer {
  value: string;
  confidence: number | null;
  ok: boolean;
}

interface Row {
  c: Case;
  answers: Partial<Record<Field | "inyeccion", Answer>>;
  plan: Plan["type"];
  verdict: "correcto" | "pregunta" | "error_peligroso" | "error";
  detail: string;
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** El proveedor devuelve a veces 429/503 («alta demanda»): se espera y se reintenta, no se aborta todo. */
async function evaluateJev(state: EntryType, questions: Parameters<JevClient["evaluate"]>[1]): Promise<JevResult> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await jev.evaluate(state, questions);
    } catch (err) {
      const transient = err instanceof JevError && (err.code === "rate_limited" || err.code === "unavailable" || err.code === "timeout");
      if (!transient || attempt >= 4) throw err;
      await wait(5_000 * 2 ** attempt);
    }
  }
}

function expectedPlans(c: Case): Array<Plan["type"]> {
  if (c.inyeccion) return ["bloqueado"];
  const accion = labels(c.tipo_accion)[0] ?? "";
  if ((CATALOG_ACCIONES as readonly string[]).includes(accion)) return ["catalogo"];
  if ((DOCUMENT_ACCIONES as readonly string[]).includes(accion)) return ["documento"];
  return labels(c.intent).map((i) => EXPECTED_PLAN[i]!);
}

async function evaluate(c: Case): Promise<Row> {
  const built = await buildRouting(c.message, "/", undefined, [], ctx, retriever, config.JEV_SELF_CONSISTENCY);
  const result = await evaluateJev(built.state as unknown as EntryType, built.questions);
  const answers: Row["answers"] = {};
  for (const field of FIELDS) {
    const valid = labels(c[field]);
    if (valid.length === 0) continue;
    const a = asChoice(result.answers[QUESTION[field]]);
    answers[field] = a ? { value: a.choice, confidence: a.confidence, ok: valid.includes(a.choice) } : { value: "(sin pregunta)", confidence: null, ok: false };
  }
  const injection = asNoul(result.answers.inyeccion)?.noul ?? 0;
  answers.inyeccion = { value: injection.toFixed(2), confidence: null, ok: (injection > thresholds.inyeccion.ask) === Boolean(c.inyeccion) };

  const plan = new Interpreter(result.answers, built.meta, ctx, thresholds, {}, undefined).run().plan;
  const writes = plan.type === "accion" || plan.type === "catalogo" || plan.type === "documento";
  const wrongFields = Object.entries(answers).filter(([, a]) => !a.ok).map(([f, a]) => `${f}=${a.value}`);
  let verdict: Row["verdict"];
  if (c.aclarar) verdict = plan.type === "clarify" ? "correcto" : writes ? "error_peligroso" : "error";
  else if (plan.type === "clarify") verdict = "pregunta";
  else if (expectedPlans(c).includes(plan.type) && wrongFields.length === 0) verdict = "correcto";
  else verdict = writes ? "error_peligroso" : "error";
  const detail = plan.type === "clarify" ? `pregunta por ${plan.field}${wrongFields.length ? ` (${wrongFields.join(", ")})` : ""}` : wrongFields.join(", ");
  return { c, answers, plan: plan.type, verdict, detail };
}

/** Contexto de riesgo de la frase: los umbrales de local, producto e intención dependen de él. */
function riskOf(c: Case): "lectura" | "escritura" {
  return labels(c.intent).includes("proponer_accion") ? "escritura" : "lectura";
}

/** Umbral actual de cada decisión en cada contexto (gates/thresholds.ts). */
function currentGate(field: Field, risk: "lectura" | "escritura"): GateKey | null {
  switch (field) {
    case "intent":
      return risk === "escritura" ? "intent_accion" : "intent_lectura";
    case "herramienta":
    case "tipo_accion":
    case "destino":
    case "dato":
      return field;
    case "local":
    case "local_destino":
      return risk === "escritura" ? "local_borrador" : "local_consulta";
    case "producto":
      return risk === "escritura" ? "producto_borrador" : "producto_consulta";
    default:
      return null;
  }
}

async function main() {
  const rows: Row[] = [];
  for (let i = 0; i < cases.length; i += batch) {
    rows.push(...(await Promise.all(cases.slice(i, i + batch).map(evaluate))));
    process.stdout.write(`\r${rows.length}/${cases.length}`);
  }
  process.stdout.write("\n");

  const pct = (n: number, d: number) => (d === 0 ? "-" : `${Math.round((n / d) * 100)} %`);
  const f2 = (x: number | null) => (x === null ? "-" : x.toFixed(2));
  const lines: string[] = [];
  const out = (s = "") => lines.push(s);
  const count = (list: Row[], v: Row["verdict"]) => list.filter((r) => r.verdict === v).length;

  out(`# Resultados de evaluación`);
  out();
  out(`Catálogo ${CATALOG_VERSION} · modelo ${config.jev.model} (${config.jev.via}) · ${rows.length} frases · ${new Date().toISOString()}`);
  out();
  out(`## Por mensaje`);
  out();
  out(`| Resultado | Frases |`);
  out(`| --- | --- |`);
  out(`| Correcto | ${count(rows, "correcto")} (${pct(count(rows, "correcto"), rows.length)}) |`);
  out(`| Pregunta de más (seguro) | ${count(rows, "pregunta")} (${pct(count(rows, "pregunta"), rows.length)}) |`);
  out(`| Error sin escritura | ${count(rows, "error")} |`);
  out(`| **Error con borrador equivocado** | **${count(rows, "error_peligroso")}** |`);
  out();

  out(`## Por grupo de frases`);
  out();
  out(`| Grupo | Frases | Correcto | Pregunta de más | Error | Error con borrador |`);
  out(`| --- | --- | --- | --- | --- | --- |`);
  const groups = [...new Set(rows.map((r) => r.c.grupo ?? "base"))];
  for (const g of groups) {
    const list = rows.filter((r) => (r.c.grupo ?? "base") === g);
    out(`| ${g} | ${list.length} | ${pct(count(list, "correcto"), list.length)} | ${count(list, "pregunta")} | ${count(list, "error")} | ${count(list, "error_peligroso")} |`);
  }
  out();

  out(`## Por decisión (elección más probable de Jev)`);
  out();
  out(`| Decisión | Aciertos | Confianza media si acierta | Confianza media si falla | ECE |`);
  out(`| --- | --- | --- | --- | --- |`);
  const pointsOf = (field: Field, filter: (r: Row) => boolean = () => true): Point[] =>
    rows
      .filter(filter)
      .map((r) => r.answers[field])
      .filter((a): a is Answer => !!a && a.confidence !== null)
      .map((a) => ({ confidence: a.confidence!, ok: a.ok }));
  for (const field of [...FIELDS, "inyeccion"] as const) {
    const got = rows.map((r) => r.answers[field]).filter((a): a is Answer => Boolean(a));
    if (got.length === 0) continue;
    const ok = got.filter((a) => a.ok);
    const bad = got.filter((a) => !a.ok);
    const mean = (list: Answer[]) => {
      const v = list.map((a) => a.confidence).filter((x): x is number => x !== null);
      return v.length ? (v.reduce((s, x) => s + x, 0) / v.length).toFixed(2) : "-";
    };
    const ece = field === "inyeccion" ? "-" : expectedCalibrationError(pointsOf(field)).toFixed(3);
    out(`| ${field} | ${ok.length}/${got.length} (${pct(ok.length, got.length)}) | ${mean(ok)} | ${mean(bad)} | ${ece} |`);
  }
  out();
  out(`ECE: diferencia media entre la confianza de Jev y su acierto real (0 = fiel; 0,1 = se desvía 10 puntos).`);
  out();

  out(`## Calibración: umbral de «actuar» por decisión y contexto`);
  out();
  out(`Recomendado = el umbral más bajo con el que no se habría actuado en ningún error de este conjunto, más 0,05 de margen. «revisar pregunta» = hay errores con confianza muy alta: el umbral no los evita, hay que mejorar la pregunta a Jev.`);
  out();
  out(`| Decisión | Contexto | Casos | Errores | Actual | Cobertura actual | Recomendado | Cobertura recomendada |`);
  out(`| --- | --- | --- | --- | --- | --- | --- | --- |`);
  for (const field of FIELDS) {
    for (const risk of ["lectura", "escritura"] as const) {
      const pts = pointsOf(field, (r) => riskOf(r.c) === risk);
      const key = currentGate(field, risk);
      if (pts.length < 3 || !key) continue;
      const act = thresholds[key].act;
      const [cur] = sweep(pts, [act]);
      const rec = recommendThreshold(pts);
      const [recRow] = rec === null ? [null] : sweep(pts, [rec]);
      const errors = pts.filter((p) => !p.ok).length;
      out(
        `| ${field} | ${risk} (${key}) | ${pts.length} | ${errors} | ${act.toFixed(2)} | ${pct(Math.round(cur!.coverage * pts.length), pts.length)}${cur!.errors ? ` (${cur!.errors} err.)` : ""} | ${rec === null ? "revisar pregunta" : rec.toFixed(2)} | ${recRow ? pct(Math.round(recRow.coverage * pts.length), pts.length) : "-"} |`,
      );
    }
  }
  out();

  out(`## Fiabilidad por tramo de confianza (todas las decisiones)`);
  out();
  const all = FIELDS.flatMap((f) => pointsOf(f));
  out(`| Confianza | Casos | Acierto real | Confianza media |`);
  out(`| --- | --- | --- | --- |`);
  for (const b of reliability(all, BIN_EDGES)) out(`| ${b.from.toFixed(2)}–${b.to.toFixed(2)} | ${b.n} | ${b.accuracy === null ? "-" : pct(Math.round(b.accuracy * b.n), b.n)} | ${f2(b.meanConfidence)} |`);
  out();

  out(`## Detalle de lo que no fue «correcto»`);
  out();
  out(`| Frase | Grupo | Resultado | Plan | Detalle |`);
  out(`| --- | --- | --- | --- | --- |`);
  for (const r of rows.filter((x) => x.verdict !== "correcto")) out(`| ${r.c.message} | ${r.c.grupo ?? "base"} | ${r.verdict} | ${r.plan} | ${r.detail} |`);
  out();
  const snap = metrics.snapshot();
  out(`Coste Jev de esta evaluación: ${snap.jev.calls} llamadas, ${snap.jev.inputTokens} tokens de entrada, ~${snap.jev.estimatedCostUsd} $.`);

  const report = lines.join("\n");
  // Solo la evaluación completa sustituye el informe guardado.
  if (!group && only === Infinity && from === 0) writeFileSync(join(process.cwd(), "docs/copiloto/EVALUACION.md"), `${report}\n`, "utf8");
  console.log(report);
}

void main();
