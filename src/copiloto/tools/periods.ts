import type { Periodo } from "../jev/catalog";
import type { Period } from "./types";

/** Día de negocio (misma lógica que src/lib/business-day.ts de la app). */
export function businessDay(occurredAt: Date, timezone: string, cutoff: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .formatToParts(occurredAt)
    .reduce<Record<string, string>>((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const [ch = 0, cm = 0] = cutoff.split(":").map(Number);
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (localMinutes < ch * 60 + cm) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

export function addDays(day: string, days: number): string {
  const date = new Date(`${day}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function weekday(day: string): number {
  // 0 = domingo … 6 = sábado
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}

/** Días de un periodo contando los dos extremos (del 1 al 3 → 3). */
export function daysInclusive(from: string, to: string): number {
  return Math.round((new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000) + 1;
}

export function formatDay(day: string): string {
  const [y, m, d] = day.split("-");
  return `${d}/${m}/${y}`;
}

/** Fechas explícitas del mensaje: "12/09", "12/09/2026", "del 1 al 15". */
export function extractDates(message: string, today: string): string[] {
  const year = today.slice(0, 4);
  const found: string[] = [];
  for (const match of message.matchAll(/\b(\d{1,2})[/-](\d{1,2})(?:[/-](\d{2,4}))?\b/g)) {
    const d = match[1]!.padStart(2, "0");
    const m = match[2]!.padStart(2, "0");
    const y = match[3] ? (match[3].length === 2 ? `20${match[3]}` : match[3]) : year;
    found.push(`${y}-${m}-${d}`);
  }
  if (found.length === 0) {
    const range = /\bdel\s+(\d{1,2})\s+al\s+(\d{1,2})\b/i.exec(message);
    if (range) {
      const ym = today.slice(0, 7);
      found.push(`${ym}-${range[1]!.padStart(2, "0")}`, `${ym}-${range[2]!.padStart(2, "0")}`);
    }
  }
  return found.filter((day) => !Number.isNaN(new Date(`${day}T00:00:00Z`).getTime())).sort();
}

/** Ventana hacia atrás, para movimientos, precios o desvíos. */
export function pastPeriod(periodo: Periodo, today: string, message: string, fallback: "semana" | "mes"): Period {
  switch (periodo) {
    case "hoy":
      return { from: today, to: today, label: "hoy" };
    case "ayer": {
      const y = addDays(today, -1);
      return { from: y, to: y, label: "ayer" };
    }
    case "semana":
      return { from: addDays(today, -6), to: today, label: "los últimos 7 días" };
    case "mes":
      return { from: addDays(today, -29), to: today, label: "los últimos 30 días" };
    case "fin_de_semana": {
      // Último viernes a domingo ya empezado.
      let friday = today;
      while (weekday(friday) !== 5) friday = addDays(friday, -1);
      const sunday = addDays(friday, 2);
      return { from: friday, to: sunday < today ? sunday : today, label: "el fin de semana" };
    }
    case "personalizado": {
      const dates = extractDates(message, today);
      if (dates.length >= 2) return { from: dates[0]!, to: dates[dates.length - 1]!, label: `del ${formatDay(dates[0]!)} al ${formatDay(dates[dates.length - 1]!)}` };
      if (dates.length === 1) return { from: dates[0]!, to: dates[0]!, label: `el ${formatDay(dates[0]!)}` };
      return pastPeriod(fallback, today, message, fallback);
    }
    case "no_indicado":
      return pastPeriod(fallback, today, message, fallback);
  }
}

/** Horizonte hacia delante para reponer. */
export function horizon(periodo: Periodo, today: string): { days: number; label: string } {
  switch (periodo) {
    case "hoy":
      return { days: 1, label: "hoy" };
    case "ayer":
      return { days: 1, label: "hoy" };
    case "fin_de_semana": {
      // Días hasta el domingo incluido (si ya es fin de semana, lo que queda de él).
      const wd = weekday(today);
      const days = wd === 0 ? 1 : 7 - wd + 1;
      return { days: Math.min(days, 7), label: "el fin de semana" };
    }
    case "mes":
      return { days: 30, label: "el próximo mes" };
    case "semana":
      return { days: 7, label: "la próxima semana" };
    case "personalizado":
    case "no_indicado":
      return { days: 3, label: "los próximos 3 días" };
  }
}
