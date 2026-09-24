// Batería de frases reales contra la parte DETERMINISTA del asistente (sin Jev): troceo de cantidades,
// búsqueda de productos en el catálogo real de Vivero 55 y lectura de respuestas escritas a mano.
// Uso: npm run copiloto:bateria   (no necesita claves; sale con código 1 si algo falla)
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { readFreeText } from "../agent/free-text";
import type { PendingClarify } from "../agent/session";
import { fixtureContext } from "../dev/fixture";
import { viveroProducts } from "../dev/vivero-catalog";
import { parseQuantities } from "../entities/quantity-parser";
import { LexicalRetriever, type Retriever } from "../entities/retriever";

interface ProductCase { kind: "producto"; message: string; /** Todos deben estar entre los candidatos «parecidos al mejor». */ expect: string[]; /** Ninguno debe estar. */ not?: string[] }
interface QuantityCase { kind: "cantidad"; message: string; expect: Array<{ amount: string; unit: string | null; product: string }> }
interface AnswerCase { kind: "respuesta"; field: PendingClarify["field"]; options?: Array<[string, string]>; text: string; expect: string }
type Case = ProductCase | QuantityCase | AnswerCase;

const cases: Case[] = readFileSync(join(process.cwd(), "src/copiloto/eval/bateria.jsonl"), "utf8")
  .split(/\r?\n/)
  .filter((l) => l.trim() && !l.startsWith("//"))
  .map((l) => JSON.parse(l) as Case);

const products = viveroProducts();
const ctx = { ...fixtureContext(), products };
const retriever: Retriever = new LexicalRetriever();

/** Candidatos que el asistente pondría delante de Jev como «el producto» (≥ 50 % del mejor). */
async function family(text: string): Promise<string[]> {
  const found = await retriever.retrieve(products, text, 20, "");
  const top = found[0]?.score ?? 0;
  return found.filter((c) => c.score >= top * 0.5).map((c) => c.product.name);
}

async function productQuery(message: string): Promise<string> {
  const segs = parseQuantities(message);
  return segs[0]?.productText || segs[0]?.text || message;
}

/** Ejecuta la batería. Devuelve las frases que fallan (vacío si todo va bien). */
export async function runBattery(): Promise<{ total: number; fails: string[] }> {
  const fails: string[] = [];
  let ok = 0;
  for (const c of cases) {
    let got: string;
    let pass: boolean;
    if (c.kind === "producto") {
      const names = await family(await productQuery(c.message));
      pass = c.expect.every((e) => names.includes(e)) && !(c.not ?? []).some((n) => names.includes(n)) && (c.expect.length > 0 || names.length === 0);
      got = names.slice(0, 6).join(" | ") + (names.length > 6 ? ` (+${names.length - 6})` : "") || "(nada)";
    } else if (c.kind === "cantidad") {
      const segs = parseQuantities(c.message);
      const shown = segs.map((s) => ({ amount: s.amount!, unit: s.unit, product: s.productText }));
      pass = JSON.stringify(shown) === JSON.stringify(c.expect);
      got = JSON.stringify(shown);
    } else {
      const options = c.options ?? [];
      const pending: PendingClarify = { clarifyId: "x", field: c.field, optionIds: options.map((o) => o[0]), optionLabels: options.map((o) => o[1]), message: "", page: "/", overrides: {} };
      const r = readFreeText(pending, c.text, ctx);
      got = r.kind === "option" ? `opcion:${r.optionId}` : r.kind === "quantity" ? `cantidad:${r.amount}${r.unit ? ` ${r.unit}` : ""}` : "nuevo";
      pass = got === c.expect;
    }
    if (pass) ok += 1;
    else fails.push(`✗ [${c.kind}] «${"message" in c ? c.message : c.text}»\n    esperado: ${JSON.stringify("expect" in c ? c.expect : "")}\n    obtenido: ${got}`);
  }
  return { total: ok + fails.length, fails };
}

if (process.argv[1]?.endsWith("bateria.ts")) {
  void runBattery().then(({ total, fails }) => {
    if (fails.length) console.log(fails.join("\n"));
    console.log(`\n${total - fails.length}/${total} correctas (${Math.round(((total - fails.length) / total) * 100)} %)`);
    process.exitCode = fails.length ? 1 : 0;
  });
}
