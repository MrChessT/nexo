// Umbrales ÚNICOS por decisión (docs/CATALOGO_JEV.md). Se pueden cambiar por .env con
// GATE_<CLAVE>_ACT, GATE_<CLAVE>_ASK y GATE_<CLAVE>_MARGIN (clave en mayúsculas).

export interface GateSpec {
  /** Por encima o igual: actuar. */
  act: number;
  /** Entre ask y act: confirmar o aclarar. Por debajo: preguntar. */
  ask: number;
  /** Solo choice: diferencia mínima entre las dos opciones más probables para poder actuar. */
  minMargin?: number;
}

const DEFAULTS = {
  // 0,7 → 0,6 tras la evaluación del 2026-09-23: misma precisión (100 %) y cobertura del 91 % al 98 %.
  intent_lectura: { act: 0.6, ask: 0.45 },
  intent_accion: { act: 0.85, ask: 0.5 },
  intent_fuera: { act: 0.8, ask: 0.5 },
  destino: { act: 0.8, ask: 0.5 },
  herramienta: { act: 0.65, ask: 0.4 },
  local_consulta: { act: 0.75, ask: 0.45 },
  local_borrador: { act: 0.9, ask: 0.6 },
  tipo_accion: { act: 0.9, ask: 0.6 },
  cierre_inventario: { act: 0.95, ask: 0.6 },
  producto_consulta: { act: 0.75, ask: 0.45, minMargin: 0.25 },
  producto_borrador: { act: 0.92, ask: 0.6, minMargin: 0.4 },
  // Noul, "sí" es bueno: valor ≥ act → actuar.
  cantidad: { act: 0.9, ask: 0.6 },
  coherencia: { act: 0.85, ask: 0.6 },
  sugerencia: { act: 0.5, ask: 0.5 },
  // Noul, "sí" es malo: valor ≤ act → seguir; > ask → parar.
  ambiguo: { act: 0.3, ask: 0.6 },
  inyeccion: { act: 0.7, ask: 0.7 },
  // Acciones de catálogo (llamada nº 2).
  // Duplicado (noul, "sí" es malo): ≤ act → distinto; ≤ ask → se marca para revisar; > ask → se pregunta.
  duplicado: { act: 0.4, ask: 0.75 },
  // Tiene sentido (noul, "sí" es bueno): ≥ act → bien; ≥ ask → revisar; < ask → se pregunta antes de seguir.
  sentido: { act: 0.7, ask: 0.35 },
  // Plausibilidad de precios y mínimos: ≥ act → bien; ≥ ask → aviso; < ask → revisar obligatorio.
  plausible: { act: 0.65, ask: 0.35 },
  // Categoría y medida del producto nuevo: por debajo de act se deja sin categoría / se pide revisar.
  categoria: { act: 0.6, ask: 0.35 },
  // Autoconsistencia: probabilidad mínima de que intent_alt coincida con intent.
  consistencia: { act: 0.5, ask: 0.5 },
} satisfies Record<string, GateSpec>;

export type GateKey = keyof typeof DEFAULTS;
export type Thresholds = Record<GateKey, GateSpec>;

export function loadThresholds(env: Record<string, string | undefined> = process.env): Thresholds {
  const result = {} as Thresholds;
  for (const [key, spec] of Object.entries(DEFAULTS) as Array<[GateKey, GateSpec]>) {
    const read = (suffix: string, fallback: number | undefined): number | undefined => {
      const raw = env[`GATE_${key.toUpperCase()}_${suffix}`];
      if (raw === undefined || raw === "") return fallback;
      const value = Number(raw);
      if (!Number.isFinite(value) || value < 0 || value > 1) throw new Error(`GATE_${key.toUpperCase()}_${suffix} debe estar entre 0 y 1`);
      return value;
    };
    const merged: GateSpec = { act: read("ACT", spec.act)!, ask: read("ASK", spec.ask)! };
    const margin = read("MARGIN", spec.minMargin);
    if (margin !== undefined) merged.minMargin = margin;
    result[key] = merged;
  }
  return result;
}

export const DEFAULT_THRESHOLDS: Thresholds = loadThresholds({});
