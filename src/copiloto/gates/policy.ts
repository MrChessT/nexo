// Política de confianza por contexto. Lo que hay que saber y con qué seguridad depende de lo que se
// va a hacer: el local de una consulta de stock puede quedarse en «todos»; el de una merma hay que
// saberlo; el de un cambio de precio no importa. Aquí se decide, para cada contexto:
//   · qué datos son requeridos, opcionales o irrelevantes (lo irrelevante ni se evalúa ni se enseña);
//   · el riesgo (lectura, escritura o crítica), que fija el umbral de cada dato;
//   · cuánto se relaja el umbral cuando el mensaje nombra el dato tal cual (evidencia literal).
import type { Accion } from "../jev/catalog";
import type { ToolName } from "../tools/tools";
import type { GateSpec, Thresholds } from "./thresholds";

export type Risk = "lectura" | "escritura" | "critica";
export type Need = "requerido" | "opcional" | "irrelevante";
export type Slot = "local" | "local_destino" | "espacio" | "producto" | "cantidad" | "periodo" | "motivo";
export type ContextKey = `consulta:${ToolName}` | `accion:${Exclude<Accion, "ninguna">}` | "navegar";

export interface ContextPolicy {
  risk: Risk;
  slots: Record<Slot, Need>;
}

const R = "requerido" as const;
const O = "opcional" as const;
const I = "irrelevante" as const;

function slots(local: Need, local_destino: Need, espacio: Need, producto: Need, cantidad: Need, periodo: Need, motivo: Need): Record<Slot, Need> {
  return { local, local_destino, espacio, producto, cantidad, periodo, motivo };
}

//                                                      local destino espacio producto cantidad periodo motivo
export const POLICIES: Record<ContextKey, ContextPolicy> = {
  "consulta:query_stock": { risk: "lectura", slots: slots(O, I, O, O, I, I, I) },
  "consulta:query_movements": { risk: "lectura", slots: slots(O, I, O, O, I, O, I) },
  "consulta:query_prices": { risk: "lectura", slots: slots(I, I, I, O, I, O, I) },
  "consulta:query_pending_transfers": { risk: "lectura", slots: slots(O, I, I, I, I, I, I) },
  "consulta:query_count_variance": { risk: "lectura", slots: slots(O, I, I, O, I, O, I) },
  "consulta:query_reorder": { risk: "lectura", slots: slots(O, I, I, O, I, O, I) },
  "consulta:query_orders": { risk: "lectura", slots: slots(O, I, I, I, I, I, I) },
  "consulta:query_spend": { risk: "lectura", slots: slots(O, I, I, I, I, O, I) },
  navegar: { risk: "lectura", slots: slots(O, I, I, O, I, O, I) },
  "accion:merma": { risk: "escritura", slots: slots(R, I, O, R, R, I, O) },
  "accion:traspaso": { risk: "escritura", slots: slots(R, R, I, R, R, I, I) },
  "accion:recepcion": { risk: "escritura", slots: slots(R, I, I, R, R, I, I) },
  "accion:cierre_inventario": { risk: "critica", slots: slots(R, I, I, I, I, I, I) },
  "accion:cambiar_precio": { risk: "escritura", slots: slots(I, I, I, R, I, I, I) },
  "accion:nuevo_producto": { risk: "escritura", slots: slots(O, I, I, I, I, I, I) },
  "accion:cambiar_minimo": { risk: "escritura", slots: slots(R, I, I, R, O, I, I) },
  "accion:archivar_producto": { risk: "critica", slots: slots(I, I, I, R, I, I, I) },
  "accion:preparar_pedido": { risk: "escritura", slots: slots(R, O, I, O, O, O, I) },
};

export function need(context: ContextKey, slot: Slot): Need {
  return POLICIES[context].slots[slot];
}

export function relevant(context: ContextKey, slot: Slot): boolean {
  return need(context, slot) !== "irrelevante";
}

/** En operaciones críticas (cerrar inventario, archivar) no basta con lo habitual de una escritura. */
const CRITICAL_ACT = 0.95;

/**
 * Evidencia literal: el mensaje nombra el dato tal cual («del Parador», «beefeater»). Jev solo tiene
 * que confirmar lo que ya está escrito, así que basta menos seguridad. Nunca en operaciones críticas.
 */
const LITERAL: Record<Risk, { act: number; ask: number } | null> = {
  lectura: { act: 0.55, ask: 0.35 },
  escritura: { act: 0.75, ask: 0.5 },
  critica: null,
};

/** Umbral de un dato en un contexto: depende del riesgo de la operación y de si el mensaje lo nombra. */
export function slotSpec(t: Thresholds, context: ContextKey, slot: "local" | "local_destino" | "espacio" | "producto", literal = false): GateSpec {
  const risk = POLICIES[context].risk;
  const base =
    slot === "producto"
      ? risk === "lectura" ? t.producto_consulta : t.producto_borrador
      : risk === "lectura" ? t.local_consulta : t.local_borrador;
  let spec: GateSpec = { ...base };
  if (risk === "critica") spec = { ...spec, act: Math.max(spec.act, CRITICAL_ACT) };
  const relax = literal ? LITERAL[risk] : null;
  if (relax) {
    spec = {
      act: Math.min(spec.act, relax.act),
      ask: Math.min(spec.ask, relax.ask),
      ...(spec.minMargin !== undefined ? { minMargin: spec.minMargin / 2 } : {}),
    };
  }
  return spec;
}
