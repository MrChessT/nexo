// Calibración de las decisiones de Jev con un conjunto etiquetado: ¿cuando dice 0,9 acierta el 90 %?
// y ¿qué umbral de «actuar» da la mayor cobertura sin errores? Funciones puras (sin Jev).

export interface Point {
  /** Confianza de Jev en su opción más probable (0-1). */
  confidence: number;
  /** ¿Esa opción era la correcta? */
  ok: boolean;
}

export interface Bin {
  from: number;
  to: number;
  n: number;
  /** Aciertos / n (null si el tramo está vacío). */
  accuracy: number | null;
  meanConfidence: number | null;
}

export const BIN_EDGES = [0, 0.5, 0.7, 0.85, 0.95, 1.0001];

/** Tabla de fiabilidad: por tramo de confianza, cuánto acierta de verdad. */
export function reliability(points: Point[], edges: number[] = BIN_EDGES): Bin[] {
  const bins: Bin[] = [];
  for (let i = 0; i < edges.length - 1; i += 1) {
    const from = edges[i]!;
    const to = edges[i + 1]!;
    const inBin = points.filter((p) => p.confidence >= from && p.confidence < to);
    const n = inBin.length;
    bins.push({
      from,
      to: Math.min(to, 1),
      n,
      accuracy: n ? inBin.filter((p) => p.ok).length / n : null,
      meanConfidence: n ? inBin.reduce((s, p) => s + p.confidence, 0) / n : null,
    });
  }
  return bins;
}

/**
 * Error de calibración esperado (ECE): media, ponderada por nº de casos, de |acierto − confianza| en
 * cada tramo. 0 = la confianza de Jev es fiel; 0,2 = se equivoca en un 20 % respecto a lo que dice.
 */
export function expectedCalibrationError(points: Point[], edges: number[] = BIN_EDGES): number {
  if (points.length === 0) return 0;
  return reliability(points, edges).reduce((sum, b) => (b.n ? sum + (b.n / points.length) * Math.abs(b.accuracy! - b.meanConfidence!) : sum), 0);
}

export interface SweepRow {
  threshold: number;
  /** Parte de los casos en que se actuaría (confianza ≥ umbral). */
  coverage: number;
  /** Aciertos entre los casos en que se actúa (null si no se actúa en ninguno). */
  precision: number | null;
  errors: number;
}

export function sweep(points: Point[], thresholds: number[]): SweepRow[] {
  return thresholds.map((threshold) => {
    const acted = points.filter((p) => p.confidence >= threshold);
    const hits = acted.filter((p) => p.ok).length;
    return {
      threshold,
      coverage: points.length ? acted.length / points.length : 0,
      precision: acted.length ? hits / acted.length : null,
      errors: acted.length - hits,
    };
  });
}

export const SWEEP_THRESHOLDS = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95];

/**
 * Umbral recomendado: el más bajo (más cobertura) con el que no se actúa en ningún error, y con un
 * margen de seguridad (+0,05) porque el conjunto es pequeño. Nunca por debajo de `floor`. null si ni
 * el umbral más alto evita todos los errores (hay que mejorar la pregunta, no el umbral).
 */
export function recommendThreshold(points: Point[], floor = 0.5, thresholds: number[] = SWEEP_THRESHOLDS): number | null {
  if (points.length === 0) return null;
  const clean = sweep(points, thresholds).filter((r) => r.errors === 0);
  if (clean.length === 0) return null;
  const lowest = Math.min(...clean.map((r) => r.threshold));
  // El umbral debe seguir limpio con el margen: si no, el siguiente limpio por encima.
  const withMargin = Math.min(0.95, Math.round((lowest + 0.05) * 100) / 100);
  const safe = clean.find((r) => r.threshold >= withMargin)?.threshold ?? withMargin;
  return Math.max(floor, safe);
}
