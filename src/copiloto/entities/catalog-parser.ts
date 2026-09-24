// Extracción determinista para las acciones de catálogo: nombre de un producto nuevo, precio,
// tamaño, formato, proveedor mencionado y si se habla del mínimo o del objetivo. Nunca pasa por
// number: las cifras salen como cadenas decimales (decimal.js). Jev no extrae texto: solo decide.
import Decimal from "decimal.js";
import type { Dimension, NamedRef, Pack, Product } from "../domain";
import { normalize } from "./normalize";
import { canonicalUnit, parseNumber, parseQuantities } from "./quantity-parser";

/** Último importe en euros del mensaje: "a 15 €", "15,50€", "por 12 euros", "€ 9". */
export function parseMoney(message: string): string | null {
  const text = message.normalize("NFC");
  const re = /(?:€\s*(\d+(?:[.,]\d{1,2})?))|(\d+(?:[.,]\d{1,2})?)\s*(?:€|euros?\b|eur\b|pavos\b)/gi;
  let last: string | null = null;
  for (const match of text.matchAll(re)) {
    const raw = match[1] ?? match[2];
    const value = raw ? parseNumber(raw) : null;
    if (value) last = value.toString();
  }
  return last;
}

export interface Size {
  dimension: Exclude<Dimension, "count">;
  qtyBase: Decimal;
  /** Tal y como se escribe en un nombre: "70 cl", "1 l", "500 g". */
  label: string;
}

const SIZE_UNITS: Record<string, { dimension: Size["dimension"]; factor: number; label: string }> = {
  ml: { dimension: "volume", factor: 1, label: "ml" },
  cl: { dimension: "volume", factor: 10, label: "cl" },
  l: { dimension: "volume", factor: 1000, label: "l" },
  g: { dimension: "mass", factor: 1, label: "g" },
  kg: { dimension: "mass", factor: 1000, label: "kg" },
};

/** Tamaño dentro de un texto: "Ginebra Nordés 70 cl" → 700 ml. */
export function sizeFromText(text: string): Size | null {
  const re = /(\d+(?:[.,]\d+)?)\s*(ml|cl|l|lt|litros?|g|gr|grs|gramos?|kg|kilos?)\b/gi;
  for (const match of text.normalize("NFC").matchAll(re)) {
    const amount = parseNumber(match[1]!);
    const unit = canonicalUnit(match[2]!);
    const spec = unit ? SIZE_UNITS[unit] : undefined;
    if (amount && spec && amount.gt(0)) {
      return { dimension: spec.dimension, qtyBase: amount.mul(spec.factor), label: `${amount.toString().replace(".", ",")} ${spec.label}` };
    }
  }
  return null;
}

/** "caja de 24", "pack de 6", "caja 12 uds" → contenedor y unidades por contenedor. */
export function containerFromText(text: string): { word: string; units: Decimal } | null {
  const re = /\b(caja|pack|paquete|bandeja|fardo|lote)\s+(?:de\s+)?(\d+)\b/i;
  const match = re.exec(normalize(text));
  if (!match) return null;
  const units = parseNumber(match[2]!);
  if (!units || units.lte(1)) return null;
  const word = match[1]!;
  return { word: word.charAt(0).toUpperCase() + word.slice(1), units };
}

/** Palabra del envase individual si el mensaje la dice ("lata", "barril"…). */
export function unitWordFromText(text: string): string | null {
  const words = ["lata", "barril", "garrafa", "bote", "bolsa", "saco", "botellin", "tercio", "brick", "tarro"];
  const tokens = normalize(text).split(/[^a-z0-9]+/);
  const found = words.find((w) => tokens.includes(w) || tokens.includes(`${w}s`) || tokens.includes(`${w}es`));
  if (!found) return null;
  const pretty = found === "botellin" ? "Botellín" : found;
  return pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

const TRIGGER =
  /\b(?:añade(?:me)?|añadir|agrega(?:r)?|crea(?:r|me)?|cr[eé]ame|da(?:r)?\s+de\s+alta|alta\s+(?:de|del|a)|mete(?:r)?|incluye|incluir|registra(?:r)?|nuevo\s+producto|nueva\s+referencia)\b/iu;

const LEADING =
  /^(?:\s*(?:un|una|el|la|al|los|las|nuevo|nueva|producto|articulo|artículo|referencia|item|llamad[oa]|que\s+se\s+llame|con\s+el\s+nombre(?:\s+de)?|como|:|-))+\s*/iu;

/** Donde termina el nombre: precio, formato, categoría, proveedor, local o fin de frase. */
const NAME_END = [
  /\s+(?:a|por|al\s+precio\s+de|con\s+precio(?:\s+de)?|precio|que\s+cuesta|cuesta|vale)\s+(?:€\s*)?\d/iu,
  /\s*\d+(?:[.,]\d+)?\s*(?:€|euros?\b)/iu,
  /\s+(?:en\s+la\s+)?categor[ií]a\b/iu,
  /\s+(?:del|de\s+la|de|al|el)?\s*proveedor\b/iu,
  /\s+(?:en|a|al|del|dentro\s+de)\s+(?:el\s+)?cat[aá]logo\b/iu,
  /\s+(?:en|de)\s+(?:caja|pack|paquete|bandeja|fardo)s?\b/iu,
  /,?\s+(?:caja|pack|paquete|bandeja|fardo)s?\s+(?:de\s+)?\d/iu,
  /\s+para\s+(?:el|la|los|las)?\s*(?:local|bar|barra)\b/iu,
  /[,;.\n]/u,
];

/**
 * Nombre del producto que se quiere dar de alta. Prioriza el texto entre comillas; si no, lo que
 * sigue a "añade / crea / da de alta…" hasta el precio, el formato, la categoría o el proveedor.
 */
export function extractNewProductName(message: string, suppliers: NamedRef[] = [], locations: NamedRef[] = []): string | null {
  const text = message.normalize("NFC").trim();
  const quoted = /["“«'‘]([^"”»'’]{2,80})["”»'’]/u.exec(text);
  let name: string;
  if (quoted) {
    name = quoted[1]!;
  } else {
    const trigger = TRIGGER.exec(text);
    if (!trigger) return null;
    name = text.slice(trigger.index + trigger[0].length).replace(LEADING, "");
    let end = name.length;
    for (const re of NAME_END) {
      const m = re.exec(name);
      if (m && m.index < end && m.index > 0) end = m.index;
    }
    name = name.slice(0, end);
    // "… de Makro" o "… en Parador" al final: es el proveedor o el local, no parte del nombre.
    for (const ref of [...suppliers, ...locations]) {
      const re = new RegExp(`\\s+(?:de|del|a|en|para)\\s+${escapeRegex(ref.name)}\\s*$`, "iu");
      name = name.replace(re, "");
    }
  }
  name = name.replace(/\s+/g, " ").replace(/^[\s"'«“]+|[\s"'»”.,;:!?]+$/gu, "").trim();
  if (!name || name.length > 80 || name.split(" ").length > 10) return null;
  if ((name.match(/\p{L}/gu) ?? []).length < 2) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Palabras que no identifican a un proveedor por sí solas. */
const GENERIC_SUPPLIER_WORDS = new Set([
  "distribuciones", "distribucion", "bebidas", "comercial", "comerciales", "alimentacion", "hosteleria", "grupo", "hermanos",
  "hnos", "sociedad", "limitada", "sl", "sa", "slu", "del", "los", "las", "sur", "norte",
]);

/** Proveedor nombrado en el mensaje (nombre completo o una palabra distintiva de 4+ letras). */
export function mentionedSupplier(message: string, suppliers: NamedRef[]): NamedRef | null {
  const text = ` ${normalize(message).replace(/[^a-z0-9]+/g, " ")} `;
  const full = suppliers.find((s) => text.includes(` ${normalize(s.name).replace(/[^a-z0-9]+/g, " ").trim()} `));
  if (full) return full;
  const hits = suppliers.filter((s) =>
    normalize(s.name)
      .split(/[^a-z0-9]+/)
      .some((w) => w.length >= 4 && !GENERIC_SUPPLIER_WORDS.has(w) && text.includes(` ${w} `)),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/** Formato del producto que nombra el mensaje ("la caja", "botella"), si solo encaja uno. */
export function mentionedPack(message: string, product: Product): Pack | null {
  const words = new Set(normalize(message).split(/[^a-z0-9]+/).map((w) => canonicalUnit(w)).filter((u): u is string => !!u));
  if (words.size === 0) return null;
  const matches = product.packs.filter((p) => {
    const first = canonicalUnit(normalize(p.name).split(/[^a-z0-9]+/)[0] ?? "");
    return first !== null && words.has(first);
  });
  return matches.length === 1 ? matches[0]! : null;
}

/** ¿Habla del objetivo (par) en lugar del mínimo? */
export function minimumField(message: string): "min_qty" | "par_qty" {
  return /\b(objetivo|par|ideal|maximo|tope|reponer hasta|llenar hasta|nivel optimo)\b/.test(normalize(message)) ? "par_qty" : "min_qty";
}

/** Cantidad del mensaje para un mínimo: la última con número ("… a 6 botellas"), sin contar tamaños del nombre. */
export function lastQuantity(message: string): { amount: string; unit: string | null } | null {
  const segments = parseQuantities(message, 8).filter((s) => s.amount !== null);
  // "70 cl" dentro del nombre del producto es un tamaño, no la cantidad pedida.
  const candidates = segments.filter((s) => !(s.unit && ["cl", "ml"].includes(s.unit) && !s.productText));
  const pick = (candidates.length > 0 ? candidates : segments).at(-1);
  return pick ? { amount: pick.amount!, unit: pick.unit } : null;
}

/** ¿Pide borrar definitivamente (en lugar de archivar)? El asistente siempre archiva. */
export function asksHardDelete(message: string): boolean {
  return /\b(borra|borrar|elimina|eliminar|suprime|quita|quitar)\b/.test(normalize(message));
}
