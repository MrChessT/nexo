// Formato y lectura de cifras para la interfaz (es-ES). Todo con decimal.js: nunca se pasa por
// number para calcular; number solo entra como dato ya leído de Supabase.
import Decimal from "decimal.js";

type Value = Decimal.Value | null | undefined;

const toDecimal = (value: Value) => new Decimal(value === null || value === undefined || value === "" ? 0 : String(value));

/** "1234.5" → "1.234,5" (hasta `decimals` decimales, sin ceros sobrantes salvo `fixed`). */
export function decimalText(value: Value, decimals = 2, fixed = false): string {
  const d = toDecimal(value).toDecimalPlaces(decimals);
  const negative = d.isNegative() && !d.isZero();
  const [int, frac] = (fixed ? d.abs().toFixed(decimals) : d.abs().toFixed()).split(".");
  return `${negative ? "-" : ""}${int!.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}${frac ? `,${frac}` : ""}`;
}

/** 1234.5 → "1.234,50 €". */
export function euros(value: Value): string {
  return `${decimalText(value, 2, true)} €`;
}

/** Cantidad en unidad base, legible: 2100 ml → "2,1 l"; 350 g → "350 g"; 24 ud → "24 ud". */
export function quantity(value: Value, unit: string, decimals = 2): string {
  const v = toDecimal(value);
  const big = v.abs().gte(1000) && (unit === "ml" || unit === "g");
  return `${decimalText(big ? v.div(1000) : v, decimals)} ${big ? (unit === "ml" ? "l" : "kg") : unit}`;
}

/** Lo que escribe el usuario: "1,5" o "1.5" → Decimal. null si no es un número ≥ 0. */
export function parseDecimal(text: string): Decimal | null {
  const clean = text.trim().replace(",", ".");
  return /^\d+(\.\d+)?$/.test(clean) ? new Decimal(clean) : null;
}

/** Texto comparable para buscar: minúsculas y sin tildes ("Limón" ~ "limon"). */
export function normalizeText(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
}

/** Fecha local YYYY-MM-DD (no UTC: a las 00:30 en España sigue siendo hoy). */
export function localDay(date: Date): string {
  return date.toLocaleDateString("sv-SE");
}

/** "hoy", "ayer", "hace 5 días". */
export function daysAgo(iso: string, now: Date = new Date()): string {
  const days = Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000);
  return days <= 0 ? "hoy" : days === 1 ? "ayer" : `hace ${days} días`;
}

/** Valor para rellenar un campo editable: "1234.5" → "1234,5" (sin separador de miles, que al
 *  volver a leerlo se confundiría con decimales). */
export function inputText(value: Value, decimals = 4): string {
  return toDecimal(value).toDecimalPlaces(decimals).toString().replace(".", ",");
}
