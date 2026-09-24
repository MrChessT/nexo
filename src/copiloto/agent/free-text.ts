// Respuesta escrita a mano a una aclaración abierta. Se intenta entender como respuesta a ESA
// pregunta (una de sus opciones o una cantidad) para no tener que reinterpretar la orden entera.
import type { ClarifyField } from "../contract/index";
import type { SessionContext } from "../domain";
import { tokenize } from "../entities/normalize";
import { canonicalUnit, parseNumber } from "../entities/quantity-parser";
import { packMatchesUnit } from "../entities/units";
import type { PendingClarify } from "./session";

export type FreeTextAnswer =
  /** Equivale a pulsar esa opción. */
  | { kind: "option"; optionId: string }
  /** Cantidad (y unidad, si la dice) para la pregunta «¿qué cantidad?». */
  | { kind: "quantity"; amount: string; unit: string | null }
  | { kind: "unknown" };

/**
 * Preguntas sobre un dato de la orden (qué producto, cuánto, qué local): si lo escrito no encaja con
 * ninguna opción, se añade a la orden original. En el resto (qué operación, qué pantalla, «¿lo
 * confirmo?») lo escrito se trata como un mensaje nuevo: así una orden distinta no arrastra la anterior.
 */
export const ENTITY_FIELDS: ReadonlySet<ClarifyField> = new Set(["producto", "cantidad", "local", "local_destino", "espacio", "formato"]);

const YES = new Set(["si", "vale", "ok", "okay", "venga", "adelante", "correcto", "exacto", "eso", "confirma", "confirmalo", "hazlo", "dale", "perfecto"]);

function isYes(text: string): boolean {
  const words = tokenize(text);
  return words.length > 0 && words.length <= 4 && YES.has(words[0]!);
}

/** ¿El texto nombra esta opción? Coincidencia completa o la opción entera dentro del texto. */
function mentions(text: string, label: string): boolean {
  const t = ` ${tokenize(text).join(" ")} `;
  const l = tokenize(label).join(" ");
  if (l.length < 3) return t.trim() === l;
  return t.trim() === l || t.includes(` ${l} `);
}

export function readFreeText(pending: PendingClarify, text: string, ctx: SessionContext): FreeTextAnswer {
  const labels = pending.optionLabels ?? pending.optionIds;
  const words = text.normalize("NFC").match(/\d+(?:[.,/]\d+)?|[\p{L}\p{M}\p{N}]+/gu) ?? [];

  if (pending.field === "cantidad") {
    const amount = words.map((w) => parseNumber(w)).find((n) => n !== null && n.gt(0)) ?? null;
    const unit = words.map((w) => canonicalUnit(w)).find((u) => u !== null) ?? null;
    if (amount) return { kind: "quantity", amount: amount.toString(), unit };
    // «cajas» respondiendo a «¿en qué formato?».
    if (unit) {
      const packs = new Map(ctx.products.flatMap((p) => p.packs).map((k) => [`pack:${k.id}`, k]));
      const match = pending.optionIds.filter((id) => (id === "pack:base" ? unit === "ud" : packs.has(id) && packMatchesUnit(packs.get(id)!, unit)));
      if (match.length === 1) return { kind: "option", optionId: match[0]! };
    }
  }

  // «sí» a una pregunta de sí o no («¿son 2 botellas?», «¿lo confirmo?»).
  const yes = pending.optionIds.find((id) => id === "si" || (pending.field === "borrador" && id === "confirmar"));
  if (yes && isYes(text)) return { kind: "option", optionId: yes };

  const named = pending.optionIds.filter((_, i) => mentions(text, labels[i] ?? ""));
  if (named.length === 1) return { kind: "option", optionId: named[0]! };

  // Un local escrito a mano aunque no estuviera entre las opciones mostradas.
  if (pending.field === "local" || pending.field === "local_destino") {
    const locations = ctx.locations.filter((l) => mentions(text, l.name));
    if (locations.length === 1) return { kind: "option", optionId: locations[0]!.name };
  }
  return { kind: "unknown" };
}

/** Respuestas de aclaraciones anteriores que no dependen de la posición de un producto en el mensaje. */
export function fieldOverrides(overrides: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => !/_\d+$/.test(key)));
}
