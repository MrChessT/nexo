// Respuestas de la llamada nº 1 → plan, aplicando la compuerta de confianza de cada decisión.
// Cero adivinanzas: si una decisión en juego no llega a su umbral, el plan es una aclaración.
import type { ChoiceResponse } from "@typesafe-ai/sdk";
import type { AppRoute, ClarifyField, Decision, GateOutcome, NavigateFilters } from "../contract/index";
import type { Product, SessionContext } from "../domain";
import { asChoice, asNoul, gateChoice, gateNoulNo, gateNoulYes, worst, type ChoiceGate, type RankedOption } from "../gates/gate";
import type { GateSpec, Thresholds } from "../gates/thresholds";
import {
  label,
  NINGUNO,
  NO_APLICA,
  NO_INDICADO,
  TODOS,
  VARIOS,
  type Accion,
  type Destino,
  type Herramienta,
  type Intent,
  type MotivoMerma,
  type Periodo,
} from "../jev/catalog";
import type { JevAnswer } from "../jev/client";
import type { ToolName } from "../tools/tools";
import type { RoutingMeta } from "./routing";
import { VIEW_FOR_TOOL } from "../analytics/analytics";

export interface ClarifyPlan {
  type: "clarify";
  field: ClarifyField;
  question: string;
  options: Array<{ id: string; label: string; probability: number | null }>;
  segmentIndex?: number;
}

export interface ResolvedProduct {
  product: Product;
  segmentIndex: number;
  amount: string | null;
  unit: string | null;
  price: string | null;
  quantityOutcome: GateOutcome | null;
  /** "confirmar": Jev lo eligió sin llegar al umbral de actuar; el borrador lo marca para revisar. */
  productOutcome?: GateOutcome;
}

export interface QueryPlan {
  type: "consultar";
  tool: ToolName;
  locationIds: string[];
  locationsDefaulted: boolean;
  areaId: string | null;
  products: ResolvedProduct[];
  periodo: Periodo;
}

export interface NavigatePlan {
  type: "navegar";
  route: AppRoute;
  filters: NavigateFilters;
  auto: boolean;
}

export interface ActionPlan {
  type: "accion";
  accion: Exclude<Accion, "ninguna" | CatalogAccion>;
  locationId: string;
  locationOutcome: GateOutcome;
  toLocationId: string | null;
  toLocationOutcome: GateOutcome;
  areaId: string | null;
  products: ResolvedProduct[];
  motivo: MotivoMerma;
  ambiguous: number;
}

/** Operaciones sobre el catálogo (no mueven stock). */
export const CATALOG_ACCIONES = ["cambiar_precio", "nuevo_producto", "cambiar_minimo", "archivar_producto"] as const;
export type CatalogAccion = (typeof CATALOG_ACCIONES)[number];

export interface CatalogPlan {
  type: "catalogo";
  accion: CatalogAccion;
  /** Local: obligatorio para el mínimo; opcional en el alta (se activa el producto en él). */
  locationId: string | null;
  locationOutcome: GateOutcome;
  /** Producto existente al que se refiere (precio, mínimo, archivar). Vacío en el alta. */
  products: ResolvedProduct[];
}

export type Plan =
  | ClarifyPlan
  | CatalogPlan
  | QueryPlan
  | NavigatePlan
  | ActionPlan
  | { type: "conversar" }
  | { type: "fuera_de_ambito" }
  | { type: "bloqueado" };

export interface Interpretation {
  intent: Intent;
  decisions: Decision[];
  plan: Plan;
}

/** Respuestas de intent_alt compatibles con cada intención (navegar o conversar pueden leerse como "leer"). */
const INTENT_ALT_EXPECTED: Record<Intent, string[]> = {
  consultar: ["leer"],
  // Ir a una pantalla es reversible: cualquier respuesta es compatible ("llévame a mermas" suena a "cambiar").
  navegar: ["leer", "ninguno", "cambiar"],
  pedir_sugerencias: ["leer"],
  proponer_accion: ["cambiar"],
  conversar: ["ninguno", "leer"],
  fuera_de_ambito: ["ninguno", "leer"],
};

/** Una respuesta forzada por el usuario (aclaración) cuenta como certeza total. */
function forced(value: string, options: string[]): ChoiceResponse {
  const probabilities = Object.fromEntries(options.map((o) => [o, o === value ? 1 : 0]));
  return { type: "choice", choice: value, confidence: 1, probabilities };
}

export class Interpreter {
  readonly decisions: Decision[] = [];

  constructor(
    private readonly answers: Record<string, JevAnswer>,
    private readonly meta: RoutingMeta,
    private readonly ctx: SessionContext,
    private readonly thresholds: Thresholds,
    private readonly overrides: Record<string, string>,
    private readonly pageLocationId: string | undefined,
  ) {}

  private choice(id: string): ChoiceResponse | undefined {
    const answer = asChoice(this.answers[id]);
    const override = this.overrides[id];
    if (override !== undefined && answer) return forced(override, Object.keys(answer.probabilities));
    return answer;
  }

  private gate(id: string, decisionLabel: string, spec: GateSpec, valueLabel: (v: string) => string = label): ChoiceGate | null {
    const answer = this.choice(id);
    if (!answer) return null;
    const g = gateChoice(answer, spec);
    this.decisions.push({
      id,
      label: decisionLabel,
      value: g.choice,
      valueLabel: valueLabel(g.choice),
      probability: g.probability,
      confidence: g.confidence,
      gate: g.outcome,
    });
    return g;
  }

  private clarify(field: ClarifyField, question: string, ranked: RankedOption[], exclude: string[] = [], labeler: (v: string) => string = label, segmentIndex?: number): ClarifyPlan {
    const options = ranked
      .filter((r) => !exclude.includes(r.option))
      .slice(0, 3)
      .map((r) => ({ id: r.option, label: labeler(r.option), probability: Math.round(r.probability * 100) / 100 }));
    return { type: "clarify", field, question, options, ...(segmentIndex !== undefined ? { segmentIndex } : {}) };
  }

  run(): Interpretation {
    const t = this.thresholds;

    const injection = asNoul(this.answers.inyeccion);
    if (injection && gateNoulNo(injection, t.inyeccion) === "preguntar") {
      this.decisions.push({ id: "inyeccion", label: "Seguridad", value: "bloqueado", valueLabel: "Petición bloqueada", probability: injection.noul, confidence: null, gate: "preguntar" });
      return { intent: "fuera_de_ambito", decisions: this.decisions, plan: { type: "bloqueado" } };
    }

    const rawIntent = this.choice("intent");
    if (!rawIntent) throw new Error("Falta la respuesta de intent");
    const intentValue = rawIntent.choice as Intent;
    const spec = intentValue === "proponer_accion" ? t.intent_accion : intentValue === "fuera_de_ambito" ? t.intent_fuera : t.intent_lectura;
    const intentGate = this.gate("intent", "Intención", spec)!;
    let intentOutcome = intentGate.outcome;

    // Autoconsistencia: la segunda formulación debe estar de acuerdo.
    const alt = asChoice(this.answers.intent_alt);
    if (alt && this.overrides.intent === undefined) {
      const probabilities = alt.probabilities as Record<string, number>;
      const agreement = INTENT_ALT_EXPECTED[intentValue].reduce((sum, key) => sum + (probabilities[key] ?? 0), 0);
      if (agreement < t.consistencia.act) intentOutcome = worst(intentOutcome, "confirmar");
    }

    if (intentValue === "fuera_de_ambito") {
      return this.done(intentValue, intentOutcome === "actuar" ? { type: "fuera_de_ambito" } : { type: "conversar" });
    }
    if (intentOutcome !== "actuar") {
      return this.done(intentValue, this.clarify("intent", "¿Qué quieres hacer?", intentGate.ranked, ["fuera_de_ambito"]));
    }

    switch (intentValue) {
      case "conversar":
        return this.done(intentValue, { type: "conversar" });
      case "navegar":
        return this.done(intentValue, this.navigate());
      case "consultar":
      case "pedir_sugerencias":
        return this.done(intentValue, this.query(intentValue));
      case "proponer_accion":
        return this.done(intentValue, this.action());
    }
  }

  private done(intent: Intent, plan: Plan): Interpretation {
    return { intent, decisions: this.decisions, plan };
  }

  private navigate(): Plan {
    const g = this.gate("destino", "Pantalla", this.thresholds.destino);
    if (!g || g.choice === "ninguna" || g.outcome === "preguntar") {
      return this.clarify("destino", "¿A qué pantalla quieres ir?", g?.ranked ?? [], ["ninguna"]);
    }
    const filters: NavigateFilters = {};
    const loc = this.readLocation(this.thresholds.local_consulta);
    if (loc.ids.length === 1 && !loc.defaulted) filters.locationId = loc.ids[0]!;
    const products = this.resolveProducts(this.thresholds.producto_consulta, false);
    if (!("type" in products) && products.length === 1) filters.productId = products[0]!.product.id;
    if (g.choice === "/informes") {
      // Navegar es reversible: basta la consulta más probable para elegir la vista.
      const tool = this.choice("herramienta")?.choice as Herramienta | undefined;
      if (tool && tool !== "ninguna") filters.view = VIEW_FOR_TOOL[tool];
      const periodo = this.choice("periodo")?.choice;
      filters.days = periodo === "semana" || periodo === "fin_de_semana" || periodo === "hoy" || periodo === "ayer" ? 7 : periodo === "mes" ? 30 : 30;
    }
    return { type: "navegar", route: g.choice as Destino as AppRoute, filters, auto: g.outcome === "actuar" };
  }

  /** Local para una lectura: si no está claro, todos los accesibles (fallback seguro, se avisa). */
  private readLocation(spec: GateSpec): { ids: string[]; defaulted: boolean } {
    const all = this.ctx.locations.map((l) => l.id);
    const g = this.gate("local", "Local", spec);
    if (!g) return { ids: all, defaulted: true };
    const id = this.meta.locationKeys.get(g.choice);
    if (g.outcome === "actuar" && id) return { ids: [id], defaulted: false };
    if (g.outcome === "actuar" && g.choice === TODOS) return { ids: all, defaulted: false };
    if (g.choice === NO_INDICADO && this.pageLocationId && all.includes(this.pageLocationId)) {
      return { ids: [this.pageLocationId], defaulted: false };
    }
    return { ids: all, defaulted: true };
  }

  private readArea(spec: GateSpec): { id: string | null; outcome: GateOutcome } {
    const g = this.gate("espacio", "Espacio", spec);
    if (!g || g.choice === NO_INDICADO) return { id: null, outcome: "actuar" };
    return { id: this.meta.areaKeys.get(g.choice) ?? null, outcome: g.outcome };
  }

  /** Productos de cada segmento. Devuelve una aclaración si alguno no llega al umbral. */
  /** Candidatos parecidos al mejor (≥ 50 % de su puntuación de recuperación), como mucho 10. */
  private family(segmentIndex: number): Product[] {
    const rs = this.meta.segments[segmentIndex]!;
    const top = Math.max(0, ...rs.scores.values());
    return [...rs.candidates.entries()]
      .filter(([key]) => (rs.scores.get(key) ?? 0) >= top * 0.5)
      .sort(([a], [b]) => (rs.scores.get(b) ?? 0) - (rs.scores.get(a) ?? 0))
      .slice(0, 10)
      .map(([, product]) => product);
  }

  private resolveProducts(spec: GateSpec, forAction: boolean): ResolvedProduct[] | ClarifyPlan {
    const resolved: ResolvedProduct[] = [];
    for (const [i, rs] of this.meta.segments.entries()) {
      const id = `producto_${i}`;
      const g = this.gate(id, "Producto", spec, (v) => (v === NINGUNO || v === VARIOS ? label(v) : v));
      if (!g) continue;
      if (g.choice === NINGUNO && g.outcome === "actuar") continue;
      // "ron" con varios rones: en una consulta se incluyen todos; en una escritura se pregunta cuál.
      if (g.choice === VARIOS && g.outcome !== "preguntar") {
        const family = this.family(i);
        if (!forAction) {
          for (const product of family) resolved.push({ product, segmentIndex: i, amount: null, unit: null, price: null, quantityOutcome: null });
          continue;
        }
        return {
          type: "clarify",
          field: "producto",
          question: rs.segment.amount !== null ? `¿Cuál de estos productos es «${rs.segment.text}»?` : "¿Cuál de estos productos?",
          options: family.slice(0, 4).map((p) => ({ id: p.name, label: p.name, probability: null })),
          segmentIndex: i,
        };
      }
      // Entre ask y act con un producto concreto se sigue: en una escritura el borrador lo marca para
      // revisar (el propio borrador es la confirmación). Por debajo de ask, o "ninguno", se pregunta.
      if (g.choice === NINGUNO || g.outcome === "preguntar") {
        // En una consulta sin cantidad, la duda entre "ninguno" y "varios" no bloquea: sin filtro, o la familia.
        if (!forAction && rs.segment.amount === null && g.ranked[0]?.option === NINGUNO) continue;
        if (!forAction && rs.segment.amount === null && g.ranked[0]?.option === VARIOS) {
          for (const product of this.family(i)) resolved.push({ product, segmentIndex: i, amount: null, unit: null, price: null, quantityOutcome: null });
          continue;
        }
        const question = rs.segment.amount !== null ? `¿A qué producto te refieres con «${rs.segment.text}»?` : "¿A qué producto te refieres?";
        return this.clarify("producto", question, g.ranked, [NINGUNO, VARIOS], (v) => v, i);
      }
      const product = rs.candidates.get(g.choice);
      if (!product) continue;
      let quantityOutcome: GateOutcome | null = null;
      const q = asNoul(this.answers[`cantidad_ok_${i}`]);
      if (q && rs.segment.amount !== null) {
        quantityOutcome = this.overrides[`cantidad_ok_${i}`] ? "actuar" : gateNoulYes(q, this.thresholds.cantidad);
        this.decisions.push({
          id: `cantidad_ok_${i}`,
          label: "Cantidad",
          value: `${rs.segment.amount} ${rs.segment.unit ?? ""}`.trim(),
          valueLabel: `${rs.segment.amount} ${rs.segment.unit ?? ""}`.trim(),
          probability: q.noul,
          confidence: null,
          gate: quantityOutcome,
        });
      }
      resolved.push({ product, segmentIndex: i, amount: rs.segment.amount, unit: rs.segment.unit, price: rs.segment.price, quantityOutcome, productOutcome: g.outcome });
    }
    return resolved;
  }

  private query(intent: "consultar" | "pedir_sugerencias"): Plan {
    const g = this.gate("herramienta", "Consulta", this.thresholds.herramienta);
    let tool: Herramienta = g?.choice as Herramienta;
    if (intent === "pedir_sugerencias" && (!g || tool === "ninguna" || g.outcome !== "actuar")) {
      tool = "query_reorder";
    } else if (!g || tool === "ninguna" || g.outcome !== "actuar") {
      return this.clarify("herramienta", "¿Qué quieres consultar?", g?.ranked ?? [], ["ninguna"]);
    }
    const loc = this.readLocation(this.thresholds.local_consulta);
    const area = this.readArea(this.thresholds.local_consulta);
    const products = this.resolveProducts(this.thresholds.producto_consulta, false);
    if ("type" in products) return products;
    const periodo = (this.choice("periodo")?.choice ?? NO_INDICADO) as Periodo;
    if (periodo !== NO_INDICADO) {
      const p = this.choice("periodo")!;
      this.decisions.push({ id: "periodo", label: "Periodo", value: periodo, valueLabel: label(periodo), probability: (p.probabilities as Record<string, number>)[periodo] ?? 0, confidence: p.confidence, gate: "actuar" });
    }
    const areaId = area.outcome === "actuar" ? area.id : null;
    const areaLocation = areaId ? this.ctx.areas.find((a) => a.id === areaId)?.locationId : undefined;
    return {
      type: "consultar",
      tool: tool as ToolName,
      locationIds: areaLocation ? [areaLocation] : loc.ids,
      locationsDefaulted: areaLocation ? false : loc.defaulted,
      areaId,
      products,
      periodo,
    };
  }

  /**
   * Acciones de catálogo. El alta no busca un producto existente (lo busca después el constructor
   * para detectar duplicados); precio, mínimo y archivar necesitan un producto claro. Solo el mínimo
   * necesita local. El resto de datos (precio, proveedor, cantidad) los extrae el código del mensaje.
   */
  private catalogAction(accion: CatalogAccion): Plan {
    const t = this.thresholds;
    const locGate = this.gate("local", "Local", t.local_borrador);
    let locationId = locGate ? this.meta.locationKeys.get(locGate.choice) ?? null : null;
    let locationOutcome: GateOutcome = locationId ? locGate!.outcome : "preguntar";

    if (accion === "nuevo_producto") {
      return { type: "catalogo", accion, locationId: locationOutcome === "actuar" ? locationId : null, locationOutcome, products: [] };
    }

    const products = this.resolveProducts(t.producto_borrador, true);
    if ("type" in products) return products;
    if (products.length === 0) {
      const question = accion === "cambiar_precio" ? "¿De qué producto quieres cambiar el precio?" : accion === "archivar_producto" ? "¿Qué producto quieres archivar?" : "¿De qué producto?";
      return { type: "clarify", field: "producto", question, options: [] };
    }

    if (accion === "cambiar_minimo") {
      if (!locationId && this.pageLocationId) {
        locationId = this.pageLocationId;
        locationOutcome = "confirmar";
      }
      if (!locationId || locationOutcome === "preguntar") {
        return this.clarify("local", "¿En qué local?", locGate?.ranked ?? [], [TODOS, NO_INDICADO], (key) => key);
      }
    }
    return { type: "catalogo", accion, locationId, locationOutcome, products };
  }

  private action(): Plan {
    const accionAnswer = this.choice("tipo_accion");
    const spec = accionAnswer?.choice === "cierre_inventario" ? this.thresholds.cierre_inventario : this.thresholds.tipo_accion;
    const g = this.gate("tipo_accion", "Operación", spec);
    if (!g || g.choice === "ninguna" || g.outcome !== "actuar") {
      return this.clarify("tipo_accion", "¿Qué operación quieres registrar?", g?.ranked ?? [], ["ninguna"]);
    }
    if ((CATALOG_ACCIONES as readonly string[]).includes(g.choice)) return this.catalogAction(g.choice as CatalogAccion);
    const accion = g.choice as Exclude<Accion, "ninguna" | CatalogAccion>;
    const t = this.thresholds;

    const area = this.readArea(t.local_borrador);
    const areaId = area.outcome === "actuar" ? area.id : null;
    const areaLocation = areaId ? this.ctx.areas.find((a) => a.id === areaId)?.locationId ?? null : null;
    const locationName = (key: string) => key;

    // Local de origen: donde se mueve el stock. Por debajo de ask → se pregunta.
    const locGate = this.gate("local", "Local", t.local_borrador);
    let resolvedLocation = locGate ? this.meta.locationKeys.get(locGate.choice) ?? null : null;
    let locationOutcome: GateOutcome = resolvedLocation ? locGate!.outcome : "preguntar";
    if (!resolvedLocation && areaLocation) {
      resolvedLocation = areaLocation;
      locationOutcome = "actuar";
    } else if (!resolvedLocation && this.pageLocationId) {
      resolvedLocation = this.pageLocationId;
      locationOutcome = "confirmar";
    }
    if (!resolvedLocation || locationOutcome === "preguntar") {
      const question = accion === "traspaso" ? "¿Desde qué local sale la mercancía?" : "¿En qué local?";
      return this.clarify("local", question, locGate?.ranked ?? [], [TODOS, NO_INDICADO], locationName);
    }

    let toLocationId: string | null = null;
    let toLocationOutcome: GateOutcome = "actuar";
    if (accion === "traspaso") {
      const toGate = this.gate("local_destino", "Local destino", t.local_borrador);
      toLocationId = toGate && toGate.choice !== NO_APLICA ? this.meta.locationKeys.get(toGate.choice) ?? null : null;
      toLocationOutcome = toLocationId && toLocationId !== resolvedLocation ? toGate!.outcome : "preguntar";
      if (toLocationOutcome === "preguntar") {
        const ranked = (toGate?.ranked ?? []).filter((r) => this.meta.locationKeys.get(r.option) !== resolvedLocation);
        return this.clarify("local_destino", "¿A qué local va la mercancía?", ranked, [NO_APLICA], locationName);
      }
    }

    const products = this.resolveProducts(t.producto_borrador, true);
    if ("type" in products) return products;
    if (products.length === 0 && accion !== "cierre_inventario") {
      return { type: "clarify", field: "producto", question: "¿Qué producto y qué cantidad?", options: [] };
    }
    for (const p of products) {
      if (accion !== "cierre_inventario" && (p.amount === null || p.quantityOutcome === "preguntar")) {
        const options = p.amount !== null ? [{ id: "si", label: `Sí, ${p.amount} ${p.unit ?? ""}`.trim(), probability: null }] : [];
        return { type: "clarify", field: "cantidad", question: `¿Qué cantidad de ${p.product.name}?`, options, segmentIndex: p.segmentIndex };
      }
    }

    // Mucha ambigüedad percibida aunque cada entidad haya pasado su umbral: se pregunta antes de escribir.
    const ambiguo = asNoul(this.answers.ambiguo);
    if (ambiguo && accion !== "cierre_inventario" && Object.keys(this.overrides).length === 0 && gateNoulNo(ambiguo, t.ambiguo) === "preguntar") {
      return {
        type: "clarify",
        field: "tipo_accion",
        question: "No tengo claro qué quieres registrar. ¿Puedes indicarme la operación, el producto, la cantidad y el local?",
        options: [],
      };
    }

    const motivo = (this.choice("motivo_merma")?.choice ?? NO_INDICADO) as MotivoMerma;
    const ambiguous = asNoul(this.answers.ambiguo)?.noul ?? 0;
    return {
      type: "accion",
      accion,
      locationId: resolvedLocation,
      locationOutcome,
      toLocationId,
      toLocationOutcome,
      areaId: areaId && areaLocation === resolvedLocation ? areaId : null,
      products,
      motivo,
      ambiguous,
    };
  }
}

export function locationLabel(ctx: SessionContext, id: string): string {
  return ctx.locations.find((l) => l.id === id)?.name ?? id;
}
