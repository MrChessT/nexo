// Conversión a unidad base (g, ml, ud) con decimal.js y los formatos de product_packs.
import Decimal from "decimal.js";
import type { Pack, Product } from "../domain";
import { normalize } from "./normalize";
import { formatStock as formatCounting } from "../../lib/units";

export type ToBaseResult =
  | { ok: true; qtyBase: Decimal; pack: Pack | null; assumed: boolean }
  | { ok: false; reason: "ambiguous_pack"; options: Pack[] }
  | { ok: false; reason: "incompatible" | "unknown_unit" | "invalid_amount" };

const METRIC: Record<string, { dimension: Product["dimension"]; factor: string }> = {
  kg: { dimension: "mass", factor: "1000" },
  g: { dimension: "mass", factor: "1" },
  l: { dimension: "volume", factor: "1000" },
  cl: { dimension: "volume", factor: "10" },
  ml: { dimension: "volume", factor: "1" },
};

/** Palabras que suelen aparecer en el nombre de un formato para cada unidad. */
const PACK_HINTS: Record<string, string[]> = {
  botella: ["botella", "bot", "botellin"],
  caja: ["caja", "cj"],
  barril: ["barril", "keg"],
  lata: ["lata"],
  pack: ["pack"],
  paquete: ["paquete", "paq"],
  bolsa: ["bolsa"],
  bote: ["bote"],
  garrafa: ["garrafa"],
  saco: ["saco"],
  bandeja: ["bandeja"],
  tercio: ["tercio", "botellin", "33"],
};

/** ¿Este formato es de esa unidad? ("caja" → "Caja 6 botellas"). */
export function packMatchesUnit(pack: Pick<Pack, "name">, unit: string): boolean {
  const name = normalize(pack.name);
  return (PACK_HINTS[unit] ?? [unit]).some((hint) => name.includes(hint));
}

/**
 * Lecturas posibles de una cantidad sin unidad («5 de ron»): los formatos del producto (el de conteo
 * primero) y, si se cuenta por unidades y ningún formato es la unidad suelta, también esta ("base").
 */
export function unitReadings(product: Product): Array<Pack | "base"> {
  const packs = [...product.packs].sort((a, b) => Number(b.isCountDefault) - Number(a.isCountDefault) || Number(b.isPurchaseDefault) - Number(a.isPurchaseDefault));
  if (product.dimension !== "count" || packs.some((p) => new Decimal(p.qtyBase).eq(1))) return packs;
  return ["base", ...packs];
}

function defaultPack(product: Product): Pack | null {
  const active = product.packs;
  return (
    active.find((p) => p.isCountDefault) ??
    active.find((p) => p.isPurchaseDefault) ??
    (active.length === 1 ? active[0]! : null)
  );
}

export function toBase(amountText: string, unit: string | null, product: Product): ToBaseResult {
  let amount: Decimal;
  try {
    amount = new Decimal(amountText);
  } catch {
    return { ok: false, reason: "invalid_amount" };
  }
  if (!amount.isFinite() || amount.lte(0)) return { ok: false, reason: "invalid_amount" };

  if (unit !== null && METRIC[unit]) {
    const metric = METRIC[unit]!;
    if (metric.dimension !== product.dimension) return { ok: false, reason: "incompatible" };
    return { ok: true, qtyBase: amount.mul(metric.factor), pack: null, assumed: false };
  }

  if (unit === "ud" || unit === null) {
    if (product.dimension === "count") return { ok: true, qtyBase: amount, pack: null, assumed: unit === null };
    // "2 ud de ron" en un producto por volumen: se entiende el formato habitual (botella). Sin unidad,
    // los borradores preguntan antes el formato si hay varios (ver resolveQuantity).
    const pack = defaultPack(product);
    if (pack) return { ok: true, qtyBase: amount.mul(pack.qtyBase), pack, assumed: true };
    return product.packs.length > 1 ? { ok: false, reason: "ambiguous_pack", options: product.packs } : { ok: false, reason: "unknown_unit" };
  }

  const hints = PACK_HINTS[unit] ?? [unit];
  const matches = product.packs.filter((pack) => {
    const name = normalize(pack.name);
    return hints.some((hint) => name.includes(hint));
  });
  if (matches.length === 1) {
    return { ok: true, qtyBase: amount.mul(matches[0]!.qtyBase), pack: matches[0]!, assumed: false };
  }
  if (matches.length > 1) {
    // "botella" → "Botella 70 cl" antes que "Caja 6 botellas".
    const leading = matches.filter((pack) => hints.some((hint) => normalize(pack.name).startsWith(hint)));
    if (leading.length === 1) return { ok: true, qtyBase: amount.mul(leading[0]!.qtyBase), pack: leading[0]!, assumed: false };
    const preferred = matches.find((p) => p.isCountDefault) ?? matches.find((p) => p.isPurchaseDefault);
    if (preferred) return { ok: true, qtyBase: amount.mul(preferred.qtyBase), pack: preferred, assumed: true };
    return { ok: false, reason: "ambiguous_pack", options: matches };
  }
  // "botella" sin formato "botella" definido, pero el producto solo tiene un formato de conteo.
  if (unit === "botella" && product.dimension === "volume") {
    const pack = defaultPack(product);
    if (pack) return { ok: true, qtyBase: amount.mul(pack.qtyBase), pack, assumed: true };
  }
  return { ok: false, reason: "unknown_unit" };
}

/**
 * Cantidad como se cuenta en barra, igual que en la app (src/lib/units.ts): refrescos y cervezas en
 * cajas y unidades («2 cajas + 5 ud»), destilados y vino en botellas («12 botellas»), barriles,
 * kilos… Sin ml ni gramos cuando hay un formato.
 */
export function formatStock(qty: Decimal.Value, product: Pick<Product, "dimension" | "packs">): string {
  const count = product.packs.find((p) => p.isCountDefault);
  const box = product.packs
    .filter((p) => new Decimal(p.qtyBase).gt(1))
    .sort((a, b) => Number(b.isPurchaseDefault) - Number(a.isPurchaseDefault) || new Decimal(b.qtyBase).cmp(a.qtyBase))[0];
  return formatCounting(qty, {
    dimension: product.dimension,
    countPack: count ? { name: count.name, qtyBase: count.qtyBase } : null,
    purchasePack: box ? { name: box.name, qtyBase: box.qtyBase } : null,
  });
}

/** "1400" ml → "1,4 l" para mostrar. Solo formato; el valor sigue siendo decimal exacto. */
export function formatBase(qty: Decimal.Value, baseUnit: Product["baseUnit"]): string {
  const value = new Decimal(qty);
  if (baseUnit === "ml" && value.abs().gte(1000)) return `${formatDecimal(value.div(1000))} l`;
  if (baseUnit === "g" && value.abs().gte(1000)) return `${formatDecimal(value.div(1000))} kg`;
  return `${formatDecimal(value)} ${baseUnit}`;
}

/** Formato es-ES sin pasar por number: "1234.5" → "1.234,5". */
export function formatDecimal(value: Decimal.Value, maxDecimals = 2, fixed = false): string {
  const d = new Decimal(value).toDecimalPlaces(maxDecimals);
  const negative = d.isNegative() && !d.isZero();
  const [intPart, fracPart] = (fixed ? d.abs().toFixed(maxDecimals) : d.abs().toFixed()).split(".");
  const grouped = intPart!.replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return `${negative ? "-" : ""}${grouped}${fracPart ? `,${fracPart}` : ""}`;
}

export function formatMoney(value: Decimal.Value): string {
  return `${formatDecimal(value, 2, true)} €`;
}
