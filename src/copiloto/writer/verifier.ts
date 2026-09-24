// Verificador de cifras: todo número que aparezca en el texto redactado debe existir en el informe.
import Decimal from "decimal.js";

const NUMBER_RE = /\d+(?:[.,]\d+)*/g;

/** Interpretaciones posibles de un número escrito: es-ES ("1.400,5") y en ("1,400.5"). */
export function interpretations(token: string): string[] {
  const out = new Set<string>();
  const add = (candidate: string) => {
    if (!/^\d+(\.\d+)?$/.test(candidate)) return;
    out.add(new Decimal(candidate).toString());
  };
  add(token.replace(/\./g, "").replace(",", "."));
  add(token.replace(/,/g, ""));
  if (!token.includes(",") && (token.match(/\./g) ?? []).length === 1) add(token);
  return [...out];
}

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (typeof value === "number" || typeof value === "boolean") out.push(String(value));
  else if (Array.isArray(value)) for (const v of value) collectStrings(v, out);
  else if (value && typeof value === "object") for (const v of Object.values(value)) collectStrings(v, out);
}

export function allowedNumbers(report: unknown): Set<string> {
  const strings: string[] = [];
  collectStrings(report, strings);
  const allowed = new Set<string>();
  for (const s of strings) for (const token of s.match(NUMBER_RE) ?? []) for (const n of interpretations(token)) allowed.add(n);
  return allowed;
}

export interface VerifyResult {
  ok: boolean;
  unknown: string[];
}

export function verifyNumbers(text: string, allowed: Set<string>): VerifyResult {
  const unknown: string[] = [];
  for (const token of text.match(NUMBER_RE) ?? []) {
    if (!interpretations(token).some((n) => allowed.has(n))) unknown.push(token);
  }
  return { ok: unknown.length === 0, unknown };
}
