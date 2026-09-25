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
  type Dato,
  type Destino,
  type Herramienta,
  type Intent,
  type MotivoMerma,
  type Periodo,
} from "../jev/catalog";
import type { JevAnswer } from "../jev/client";
import type { ToolName } from "../tools/tools";
import { mentionsWaste, venueRoles, type RoutingMeta } from "./routing";
import type { Focus } from "./session";
import { preferredLocation, type Habits } from "./habits";
import { VIEW_FOR_TOOL } from "../analytics/analytics";
import { need, relevant, slotSpec, type ContextKey } from "../gates/policy";
import { namesAll, namesProduct } from "../entities/mentions";
import { formatDecimal } from "../entities/units";

export interface ClarifyPlan {
  type: "clarify";
  field: ClarifyField;
  question: string;
  options: Array<{ id: string; label: string; probability: number | null }>;
  segmentIndex?: number;
  /** La pregunta pide repetir la orden entera: lo que se escriba es un mensaje nuevo, no un añadido. */
  restart?: boolean;
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
  /** Lo heredado del mensaje anterior, para decírselo al usuario ("Barceló", "Parador"…). */
  inherited?: string[];
  /** Qué quiere saber (cantidad, precio, valor…): la respuesta enseña solo eso. Sin él, todo. */
  dato?: Dato;
}

export interface NavigatePlan {
  type: "navegar";
  route: AppRoute;
  filters: NavigateFilters;
  auto: boolean;
}

export interface ActionPlan {
  type: "accion";
  accion: Exclude<Accion, "ninguna" | CatalogAccion | DocumentAccion>;
  locationId: string;
  locationOutcome: GateOutcome;
  toLocationId: string | null;
  toLocationOutcome: GateOutcome;
  areaId: string | null;
  products: ResolvedProduct[];
  motivo: MotivoMerma;
  ambiguous: number;
  /** Jev veía que faltaba algo aunque cada dato estaba claro: el borrador lo avisa. */
  reviewAll?: boolean;
}

/** Operaciones sobre el catálogo (no mueven stock). */
export const CATALOG_ACCIONES = ["cambiar_precio", "nuevo_producto", "cambiar_minimo", "archivar_producto", "preparar_pedido"] as const;
export type CatalogAccion = (typeof CATALOG_ACCIONES)[number];

export interface CatalogPlan {
  type: "catalogo";
  accion: CatalogAccion;
  /** Local: obligatorio para el mínimo; opcional en el alta (se activa el producto en él). */
  locationId: string | null;
  locationOutcome: GateOutcome;
  /** Producto existente al que se refiere (precio, mínimo, archivar). Vacío en el alta. */
  products: ResolvedProduct[];
  /** Periodo que debe cubrir un pedido ("para el finde", "de la semana"). */
  periodo?: Periodo;
}

/** Operaciones sobre traspasos y pedidos que ya existen. */
export const DOCUMENT_ACCIONES = ["recibir_traspaso", "cancelar_traspaso", "enviar_pedido", "recibir_pedido", "cancelar_pedido"] as const;
export type DocumentAccion = (typeof DOCUMENT_ACCIONES)[number];

export interface DocumentPlan {
  type: "documento";
  accion: DocumentAccion;
  /** Locales donde buscar el documento (el nombrado o, si no, todos los del usuario). */
  locationIds: string[];
}

/** Respuesta a un borrador pendiente desde el chat («sí, adelante», «cancélalo»). */
export interface DraftAnswerPlan {
  type: "borrador";
  action: "confirmar" | "cancelar";
  draftId: string;
}

export type Plan =
  | ClarifyPlan
  | DraftAnswerPlan
  | CatalogPlan
  | DocumentPlan
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
  // Conversar tampoco escribe nada: «¿cómo hago un traspaso?» suena a «cambiar» (0,63) y es ayuda (1,00).
  conversar: ["ninguno", "leer", "cambiar"],
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
    /** Foco vigente de la conversación (si lo hay). */
    private readonly focus?: Focus,
    /** Hábitos del usuario (locales y productos más usados). */
    private readonly habits?: Habits,
  ) {}

  /** Local habitual del usuario, si lo tiene claro (solo ordena las opciones al preguntar). */
  private habitualLocation(): string | undefined {
    return preferredLocation(this.habits, this.ctx.locations.map((l) => l.id));
  }

  /** ¿El mensaje continúa el anterior? Solo si hay foco y Jev lo ve con seguridad suficiente. */
  private followsUp(): boolean {
    if (!this.focus) return false;
    const answer = asNoul(this.answers.seguimiento);
    if (!answer || answer.noul < this.thresholds.seguimiento.act) return false;
    if (!this.decisions.some((d) => d.id === "seguimiento")) {
      this.decisions.push({ id: "seguimiento", label: "Conversación", value: "continua", valueLabel: "Continúa lo anterior", probability: answer.noul, confidence: null, gate: "actuar" });
    }
    return true;
  }

  private choice(id: string): ChoiceResponse | undefined {
    const answer = asChoice(this.answers[id]);
    const override = this.overrides[id];
    // Una respuesta anterior solo cuenta si sigue siendo una de las opciones (el mensaje pudo cambiar).
    if (override !== undefined && answer && override in answer.probabilities) return forced(override, Object.keys(answer.probabilities));
    return answer;
  }

  /** Opciones de local con el habitual del usuario primero (propuesto, nunca decidido). */
  private locationOptions(ranked: RankedOption[]): RankedOption[] {
    const habitual = this.habitualLocation();
    const name = habitual ? this.ctx.locations.find((l) => l.id === habitual)?.name : undefined;
    if (!name) return ranked;
    const rest = ranked.filter((r) => r.option !== name);
    return [{ option: name, probability: ranked.find((r) => r.option === name)?.probability ?? 0 }, ...rest];
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

  /**
   * Un dato según la política del contexto: si es irrelevante no se evalúa ni se enseña (null); si
   * el mensaje lo nombra tal cual, basta menos seguridad (salvo en operaciones críticas).
   */
  private gateSlot(context: ContextKey, slot: "local" | "local_destino" | "espacio", id: string, decisionLabel: string): ChoiceGate | null {
    if (!relevant(context, slot)) return null;
    const answer = this.choice(id);
    if (!answer) return null;
    return this.gate(id, decisionLabel, slotSpec(this.thresholds, context, slot, this.literal(slot, answer.choice)));
  }

  /** ¿El mensaje nombra tal cual esta opción? */
  private literal(slot: "local" | "local_destino" | "espacio", option: string): boolean {
    const message = this.meta.message;
    if (!message) return false;
    if (slot === "espacio") {
      const areaId = this.meta.areaKeys.get(option);
      const area = areaId ? this.ctx.areas.find((a) => a.id === areaId) : undefined;
      return !!area && namesAll(message, area.name);
    }
    return this.meta.locationKeys.has(option) && namesAll(message, option);
  }

  /** Con un solo local no hay nada que preguntar: es ese. */
  private onlyLocation(): string | null {
    return this.ctx.locations.length === 1 ? this.ctx.locations[0]!.id : null;
  }

  private clarify(field: ClarifyField, question: string, ranked: RankedOption[], exclude: string[] = [], labeler: (v: string) => string = label, segmentIndex?: number): ClarifyPlan {
    // Los locales son pocos: se ofrecen todos (hasta 6); del resto, las 3 opciones más probables.
    const max = field === "local" || field === "local_destino" ? 6 : 3;
    const options = ranked
      .filter((r) => !exclude.includes(r.option))
      .slice(0, max)
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

    // Hay un borrador esperando respuesta: «sí, adelante» o «cancélalo» se resuelven antes que nada.
    const draftAnswer = this.draftAnswer();
    if (draftAnswer) return this.done("proponer_accion", draftAnswer);

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

    // «Ha llegado el traspaso del Parador»: proponer_accion 0,66 (dudoso) pero recibir_traspaso 0,99.
    // Si Jev tiene clarísima la operación concreta, la intención queda corroborada: preguntar «¿Qué
    // quieres hacer?» sobraría, y el resultado es un borrador que nunca se ejecuta sin confirmar.
    if (intentValue === "proponer_accion" && intentOutcome === "confirmar" && this.overrides.intent === undefined && this.actionCorroborates()) {
      intentOutcome = "actuar";
    }
    // Lo mismo en una lectura: «ficha del Barceló» (consultar 0,59, navegar 0,40) con query_product 1,00
    // y «leer» 1,00. Solo lectura: nada se escribe.
    if (intentValue === "consultar" && intentOutcome !== "actuar" && this.overrides.intent === undefined && this.queryCorroborates()) {
      intentOutcome = "actuar";
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

  /** Qué dato pide la consulta. Sin seguridad suficiente, «general» (se enseña todo, como antes). */
  private readDato(): Dato {
    const g = this.gate("dato", "Dato", this.thresholds.dato);
    return g && g.outcome === "actuar" ? (g.choice as Dato) : "general";
  }

  /**
   * Merma o traspaso («tírame 1 bolsa de hielo del parador»: merma 0,71, traspaso 0,29): un traspaso
   * necesita un local de destino distinto del de origen. Si Jev está seguro de que no se nombra ninguno
   * y ya se inclina por la merma, es merma; si nombra otro local y se inclina por el traspaso, traspaso.
   * Si no, null (se pregunta como siempre).
   */
  private wasteOrTransfer(ranked: RankedOption[]): "merma" | "traspaso" | null {
    const [first, second] = ranked;
    if (!first || !second) return null;
    const pair = new Set([first.option, second.option]);
    if (!pair.has("merma") || !pair.has("traspaso") || first.probability + second.probability < 0.85) return null;
    const dest = this.choice("local_destino");
    if (!dest) return null;
    const p = (dest.probabilities as Record<string, number>)[dest.choice] ?? 0;
    const origin = this.choice("local")?.choice;
    const sure = p >= this.thresholds.local_borrador.act;
    // «caducaron 3 packs de agua en la oliva»: un «destino» igual al origen es que no hay destino.
    const otherVenue = sure && this.meta.locationKeys.has(dest.choice) && dest.choice !== origin;
    const noDestination = (sure && dest.choice === NO_APLICA) || dest.choice === origin;
    const waste = !!this.meta.message && mentionsWaste(this.meta.message);
    // Solo confirma hacia donde Jev ya se inclina: «quita 6 cocas del vivero» (merma 0,55, traspaso
    // 0,40, sin palabras de merma) sigue siendo dudoso aunque no diga destino, y se pregunta.
    if (first.option === "merma" && !otherVenue && (waste || (noDestination && first.probability >= 0.65))) return "merma";
    return first.option === "traspaso" && otherVenue ? "traspaso" : null;
  }

  /** ¿Jev está seguro de una consulta concreta y de que se trata de leer? */
  private queryCorroborates(): boolean {
    const tool = this.choice("herramienta");
    if (!tool || tool.choice === "ninguna" || gateChoice(tool, this.thresholds.herramienta).outcome !== "actuar") return false;
    const alt = asChoice(this.answers.intent_alt);
    return !alt || ((alt.probabilities as Record<string, number>).leer ?? 0) >= 0.5;
  }

  /** La decisión ya registrada pasa a «actuar» (lo que se enseña en «Entendido» es lo que se decidió). */
  private markActed(id: string): void {
    const decision = [...this.decisions].reverse().find((d) => d.id === id);
    if (decision) decision.gate = "actuar";
  }

  /** ¿Jev está seguro de una operación concreta (no «ninguna»)? Nunca para cerrar inventario. */
  private actionCorroborates(): boolean {
    const answer = this.choice("tipo_accion");
    if (!answer || answer.choice === "ninguna" || answer.choice === "cierre_inventario") return false;
    return gateChoice(answer, this.thresholds.tipo_accion).outcome === "actuar";
  }

  /** Confirmar o descartar el borrador pendiente. Ejecutar exige mucha seguridad; si no, se pregunta. */
  private draftAnswer(): Plan | null {
    const draftId = this.focus?.draftId;
    const answer = this.choice("borrador");
    if (!draftId || !answer || answer.choice === NINGUNO) return null;
    const g = gateChoice(answer, this.thresholds.borrador_chat);
    const action = g.choice as "confirmar" | "cancelar";
    this.decisions.push({ id: "borrador", label: "Borrador pendiente", value: action, valueLabel: label(action), probability: g.probability, confidence: g.confidence, gate: g.outcome });
    if (g.outcome === "actuar") return { type: "borrador", action, draftId };
    if (g.outcome === "confirmar") {
      const title = this.focus?.draftTitle ?? "el borrador";
      return {
        type: "clarify",
        field: "borrador",
        question: action === "confirmar" ? `¿Confirmo «${title}»?` : `¿Descarto «${title}»?`,
        options: [{ id: action, label: action === "confirmar" ? "Sí, confírmalo" : "Sí, descártalo", probability: g.probability }],
      };
    }
    return null;
  }

  private done(intent: Intent, plan: Plan): Interpretation {
    return { intent, decisions: this.decisions, plan };
  }

  private navigate(): Plan {
    const g = this.gate("destino", "Pantalla", this.thresholds.destino);
    if (!g || g.choice === "ninguna" || g.outcome === "preguntar") {
      // Sin la pregunta (el mensaje no pedía pantalla) se ofrecen las pantallas más usadas.
      const ranked = g?.ranked ?? ["/stock", "/pedidos", "/informes"].map((option) => ({ option, probability: 0 }));
      return this.clarify("destino", "¿A qué pantalla quieres ir?", ranked, ["ninguna"]);
    }
    const filters: NavigateFilters = {};
    const loc = this.readLocation("navegar");
    if (loc.ids.length === 1 && !loc.defaulted) filters.locationId = loc.ids[0]!;
    const products = this.resolveProducts("navegar", false);
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
  private readLocation(context: ContextKey): { ids: string[]; defaulted: boolean } {
    const all = this.ctx.locations.map((l) => l.id);
    if (all.length === 1) return { ids: all, defaulted: false };
    const g = this.gateSlot(context, "local", "local", "Local");
    if (!g) return { ids: all, defaulted: relevant(context, "local") };
    const id = this.meta.locationKeys.get(g.choice);
    if (g.outcome === "actuar" && id) return { ids: [id], defaulted: false };
    if (g.outcome === "actuar" && g.choice === TODOS) return { ids: all, defaulted: false };
    if (g.choice === NO_INDICADO && this.pageLocationId && all.includes(this.pageLocationId)) {
      return { ids: [this.pageLocationId], defaulted: false };
    }
    return { ids: all, defaulted: true };
  }

  private readArea(context: ContextKey): { id: string | null; outcome: GateOutcome } {
    const g = this.gateSlot(context, "espacio", "espacio", "Espacio");
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

  private resolveProducts(context: ContextKey, forAction: boolean): ResolvedProduct[] | ClarifyPlan {
    const resolved: ResolvedProduct[] = [];
    if (!relevant(context, "producto")) return resolved;
    for (const [i, rs] of this.meta.segments.entries()) {
      const id = `producto_${i}`;
      const answer = this.choice(id);
      // Evidencia literal: el fragmento nombra el producto elegido («2 cajas de beefeater»).
      const chosen = answer ? rs.candidates.get(answer.choice) : undefined;
      const literal = !!chosen && namesProduct(rs.segment.productText || rs.segment.text, chosen);
      const g = this.gate(id, "Producto", slotSpec(this.thresholds, context, "producto", literal), (v) => (v === NINGUNO || v === VARIOS ? label(v) : v));
      if (!g) continue;
      // Un solo candidato, el mensaje lo nombra tal cual y Jev lo pone primero («4 tónicas» con una sola
      // tónica: 0,50 frente a «varios» 0,38): no hay otro producto al que pueda referirse.
      if (g.outcome !== "actuar" && literal && rs.candidates.size === 1 && chosen && g.ranked[0]?.option === answer!.choice && g.probability >= 0.45) {
        g.outcome = "actuar";
        this.markActed(id);
      }
      // En una consulta (solo lectura) basta con que el mensaje nombre el único candidato y Jev le dé
      // algo de peso: «¿cuál es el mínimo de tónica en pickels?» (ninguno 0,46, la tónica 0,43).
      const [onlyKey, only] = rs.candidates.size === 1 ? [...rs.candidates.entries()][0]! : [undefined, undefined];
      if (!forAction && only && onlyKey && g.outcome !== "actuar" && namesProduct(rs.segment.productText || rs.segment.text, only) && ((answer!.probabilities as Record<string, number>)[onlyKey] ?? 0) >= 0.3) {
        this.markActed(id);
        resolved.push({ product: only, segmentIndex: i, amount: null, unit: null, price: null, quantityOutcome: null, productOutcome: "actuar" });
        continue;
      }
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
          options: [...family]
            .sort((a, b) => (this.habits?.products[b.id] ?? 0) - (this.habits?.products[a.id] ?? 0))
            .slice(0, 4)
            .map((p) => ({ id: p.name, label: p.name, probability: null })),
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
      // Cantidad escrita por el usuario al responder «¿qué cantidad?»: manda sobre la del mensaje.
      const typedAmount = this.overrides[`cantidad_${i}`];
      if (typedAmount !== undefined) {
        const typedUnit = this.overrides[`unidad_texto_${i}`] ?? null;
        this.decisions.push({ id: `cantidad_ok_${i}`, label: "Cantidad", value: `${typedAmount} ${typedUnit ?? ""}`.trim(), valueLabel: amountLabel(typedAmount, typedUnit), probability: 1, confidence: null, gate: "actuar" });
        resolved.push({ product, segmentIndex: i, amount: typedAmount, unit: typedUnit, price: rs.segment.price, quantityOutcome: "actuar", productOutcome: g.outcome });
        continue;
      }
      let quantityOutcome: GateOutcome | null = null;
      const q = asNoul(this.answers[`cantidad_ok_${i}`]);
      if (q && rs.segment.amount !== null) {
        quantityOutcome = this.overrides[`cantidad_ok_${i}`] ? "actuar" : gateNoulYes(q, this.thresholds.cantidad);
        this.decisions.push({
          id: `cantidad_ok_${i}`,
          label: "Cantidad",
          value: `${rs.segment.amount} ${rs.segment.unit ?? ""}`.trim(),
          valueLabel: amountLabel(rs.segment.amount, rs.segment.unit),
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
    const inherited: string[] = [];
    const focusTool = this.focus?.kind === "consulta" ? (this.focus.tool as Herramienta | undefined) : undefined;
    if (intent === "pedir_sugerencias" && (!g || tool === "ninguna" || g.outcome !== "actuar")) {
      tool = "query_reorder";
    } else if (!g || tool === "ninguna" || g.outcome !== "actuar") {
      // «¿y en el Vivero?»: sin consulta clara, la misma que antes.
      if (!focusTool || !this.followsUp()) return this.clarify("herramienta", "¿Qué quieres consultar?", g?.ranked ?? [], ["ninguna"]);
      tool = focusTool;
    }
    const context: ContextKey = `consulta:${tool as ToolName}`;
    const loc = this.readLocation(context);
    const area = this.readArea(context);
    let products = this.resolveProducts(context, false);
    if ("type" in products) return products;
    // Consultas de un producto concreto (su ficha): sin producto, o con varios («ginebra»), se pregunta cuál.
    if (need(context, "producto") === "requerido" && products.length !== 1 && !(products.length === 0 && this.focus?.productIds.length === 1 && this.followsUp())) {
      if (products.length === 0) return { type: "clarify", field: "producto", question: "¿De qué producto?", options: [] };
      return {
        type: "clarify",
        field: "producto",
        question: "¿De cuál de estos productos?",
        options: products.slice(0, 4).map((p) => ({ id: p.product.name, label: p.product.name, probability: null })),
        segmentIndex: Math.max(0, products[0]!.segmentIndex),
      };
    }
    // El periodo solo cuenta donde importa (movimientos, gasto, precios…), no en el stock de ahora.
    let periodo = (relevant(context, "periodo") ? this.choice("periodo")?.choice ?? NO_INDICADO : NO_INDICADO) as Periodo;

    // Lo que este mensaje no dice se toma del anterior, si lo continúa.
    const focus = this.focus;
    if (focus && (products.length === 0 || loc.defaulted || periodo === NO_INDICADO) && this.followsUp()) {
      if (products.length === 0 && focus.productIds.length > 0 && relevant(context, "producto")) {
        products = focus.productIds
          .map((id) => this.ctx.products.find((p) => p.id === id))
          .filter((p): p is Product => !!p)
          .map((product) => ({ product, segmentIndex: -1, amount: null, unit: null, price: null, quantityOutcome: null }));
        if (products.length > 0) inherited.push(products.length === 1 ? products[0]!.product.name : "los mismos productos");
      }
      const focusLocations = focus.locationIds.filter((id) => this.ctx.locations.some((l) => l.id === id));
      if (loc.defaulted && focusLocations.length > 0 && relevant(context, "local")) {
        loc.ids = focusLocations;
        loc.defaulted = false;
        inherited.push(focusLocations.map((id) => locationLabel(this.ctx, id)).join(", "));
      }
      if (periodo === NO_INDICADO && focus.periodo && focus.periodo !== NO_INDICADO && relevant(context, "periodo")) {
        periodo = focus.periodo as Periodo;
        inherited.push(label(periodo).toLowerCase());
      }
    }
    if (periodo !== NO_INDICADO) {
      const p = this.choice("periodo")!;
      this.decisions.push({ id: "periodo", label: "Periodo", value: periodo, valueLabel: label(periodo), probability: (p.probabilities as Record<string, number>)[periodo] ?? 0, confidence: p.confidence, gate: "actuar" });
    }
    const areaId = area.outcome === "actuar" ? area.id : null;
    const areaLocation = areaId ? this.ctx.areas.find((a) => a.id === areaId)?.locationId : undefined;
    const dato = this.readDato();
    tool = toolForDato(tool, dato, products.length);
    return {
      type: "consultar",
      tool: tool as ToolName,
      ...(dato !== "general" ? { dato } : {}),
      locationIds: areaLocation ? [areaLocation] : loc.ids,
      locationsDefaulted: areaLocation ? false : loc.defaulted,
      areaId,
      products,
      periodo,
      ...(inherited.length > 0 ? { inherited } : {}),
    };
  }

  /**
   * Acciones de catálogo. El alta no busca un producto existente (lo busca después el constructor
   * para detectar duplicados); precio, mínimo y archivar necesitan un producto claro. Solo el mínimo
   * necesita local. El resto de datos (precio, proveedor, cantidad) los extrae el código del mensaje.
   */
  private catalogAction(accion: CatalogAccion): Plan {
    const context: ContextKey = `accion:${accion}`;
    const locGate = this.gateSlot(context, "local", "local", "Local");
    let locationId = locGate ? this.meta.locationKeys.get(locGate.choice) ?? null : this.onlyLocation();
    let locationOutcome: GateOutcome = locGate && locationId ? locGate.outcome : locationId ? "actuar" : "preguntar";

    if (accion === "nuevo_producto") {
      return { type: "catalogo", accion, locationId: locationOutcome === "actuar" ? locationId : null, locationOutcome, products: [] };
    }

    // Pedido: hace falta el local; los productos son opcionales (sin productos se pide lo que falta).
    if (accion === "preparar_pedido") {
      // En un pedido la mercancía llega AL local desde el proveedor: la pregunta de destino a veces
      // está segura cuando la de local duda (medido con Jev real). Se usa la que esté segura; si
      // ninguna lo está pero coinciden, se sigue marcando el local para revisar.
      if (locationOutcome !== "actuar") {
        const dest = this.gateSlot(context, "local_destino", "local_destino", "Local destino");
        const destId = dest && dest.choice !== NO_APLICA ? this.meta.locationKeys.get(dest.choice) ?? null : null;
        if (destId && dest!.outcome === "actuar") {
          locationId = destId;
          locationOutcome = "actuar";
        } else if (destId && destId === locationId && dest!.outcome === "confirmar") {
          locationOutcome = "confirmar";
        }
      }
      if (!locationId && this.pageLocationId) {
        locationId = this.pageLocationId;
        locationOutcome = "confirmar";
      }
      if (!locationId || locationOutcome === "preguntar") {
        return this.clarify("local", "¿Para qué local es el pedido?", this.locationOptions(locGate?.ranked ?? []), [TODOS, NO_INDICADO], (key) => key);
      }
      const products = this.resolveProducts(context, true);
      if ("type" in products) return products;
      const periodo = (this.choice("periodo")?.choice ?? NO_INDICADO) as Periodo;
      return { type: "catalogo", accion, locationId, locationOutcome, products, periodo };
    }

    const products = this.resolveProducts(context, true);
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
        return this.clarify("local", "¿En qué local?", this.locationOptions(locGate?.ranked ?? []), [TODOS, NO_INDICADO], (key) => key);
      }
    }
    return { type: "catalogo", accion, locationId, locationOutcome, products };
  }

  /** Recibir, enviar o cancelar un traspaso o un pedido: el local, si se dice, acota cuál. */
  private documentAction(accion: DocumentAccion): Plan {
    const context: ContextKey = `accion:${accion}`;
    const all = this.ctx.locations.map((l) => l.id);
    const g = this.gateSlot(context, "local", "local", "Local");
    let id = g && g.outcome === "actuar" ? this.meta.locationKeys.get(g.choice) : undefined;
    // «ya ha llegado lo que mandó el Vivero»: si Jev no lo recoge pero el mensaje nombra un solo local,
    // ese local acota el documento (solo filtra cuál; el borrador se confirma igual).
    if (!id && this.meta.message) {
      const named = [...this.meta.locationKeys.entries()].filter(([name]) => namesAll(this.meta.message!, name));
      if (named.length === 1) id = named[0]![1];
    }
    return { type: "documento", accion, locationIds: id ? [id] : all };
  }

  private action(): Plan {
    const accionAnswer = this.choice("tipo_accion");
    const spec = accionAnswer?.choice === "cierre_inventario" ? this.thresholds.cierre_inventario : this.thresholds.tipo_accion;
    const g = this.gate("tipo_accion", "Operación", spec);
    let chosen = g && g.outcome === "actuar" && g.choice !== "ninguna" ? g.choice : null;
    if (g && !chosen) {
      chosen = this.wasteOrTransfer(g.ranked);
      // Lo que se enseña en «Entendido» debe ser lo que se decidió.
      const decision = chosen ? this.decisions.find((d) => d.id === "tipo_accion") : undefined;
      if (decision && chosen) Object.assign(decision, { value: chosen, valueLabel: label(chosen), gate: "actuar" });
    }
    if (!chosen) {
      return this.clarify("tipo_accion", "¿Qué operación quieres registrar?", g?.ranked ?? [], ["ninguna"]);
    }
    if ((CATALOG_ACCIONES as readonly string[]).includes(chosen)) return this.catalogAction(chosen as CatalogAccion);
    if ((DOCUMENT_ACCIONES as readonly string[]).includes(chosen)) return this.documentAction(chosen as DocumentAccion);
    const accion = chosen as Exclude<Accion, "ninguna" | CatalogAccion | DocumentAccion>;
    const t = this.thresholds;
    const context: ContextKey = `accion:${accion}`;

    const area = this.readArea(context);
    const areaId = area.outcome === "actuar" ? area.id : null;
    const areaLocation = areaId ? this.ctx.areas.find((a) => a.id === areaId)?.locationId ?? null : null;
    const locationName = (key: string) => key;

    // Local de origen: donde se mueve el stock. Por debajo de ask → se pregunta.
    const locGate = this.gateSlot(context, "local", "local", "Local");
    let resolvedLocation = locGate ? this.meta.locationKeys.get(locGate.choice) ?? null : null;
    let locationOutcome: GateOutcome = resolvedLocation ? locGate!.outcome : "preguntar";
    // «pásame 4 tónicas del Pickels al Parador»: Jev duda entre los dos locales nombrados (0,65 / 0,35),
    // pero la preposición dice cuál es el origen. Si Jev ya lo pone primero, se confirma.
    const roles = accion === "traspaso" && this.meta.message ? venueRoles(this.meta.message, [...this.meta.locationKeys.keys()]) : null;
    if (roles && locGate && resolvedLocation && locationOutcome !== "actuar" && roles.origin === locGate.choice) {
      locationOutcome = "actuar";
      this.markActed("local");
    }
    if (!resolvedLocation && this.onlyLocation()) {
      resolvedLocation = this.onlyLocation();
      locationOutcome = "actuar";
    } else if (!resolvedLocation && areaLocation) {
      resolvedLocation = areaLocation;
      locationOutcome = "actuar";
    } else if (!resolvedLocation && this.pageLocationId) {
      resolvedLocation = this.pageLocationId;
      locationOutcome = "confirmar";
    }
    // Sin local claro se pregunta; el habitual solo se ofrece como primera opción.
    if (!resolvedLocation || locationOutcome === "preguntar") {
      const question = accion === "traspaso" ? "¿Desde qué local sale la mercancía?" : "¿En qué local?";
      return this.clarify("local", question, this.locationOptions(locGate?.ranked ?? []), [TODOS, NO_INDICADO], locationName);
    }

    let toLocationId: string | null = null;
    let toLocationOutcome: GateOutcome = "actuar";
    if (accion === "traspaso") {
      const toGate = this.gateSlot(context, "local_destino", "local_destino", "Local destino");
      toLocationId = toGate && toGate.choice !== NO_APLICA ? this.meta.locationKeys.get(toGate.choice) ?? null : null;
      toLocationOutcome = toLocationId && toLocationId !== resolvedLocation ? toGate!.outcome : "preguntar";
      if (roles && toGate && toLocationOutcome === "confirmar" && roles.destination === toGate.choice) {
        toLocationOutcome = "actuar";
        this.markActed("local_destino");
      }
      if (toLocationOutcome === "preguntar") {
        const ranked = (toGate?.ranked ?? []).filter((r) => this.meta.locationKeys.get(r.option) !== resolvedLocation);
        return this.clarify("local_destino", "¿A qué local va la mercancía?", ranked, [NO_APLICA], locationName);
      }
    }

    const products = this.resolveProducts(context, true);
    if ("type" in products) return products;
    if (products.length === 0 && relevant(context, "producto")) {
      return { type: "clarify", field: "producto", question: "¿Qué producto y qué cantidad?", options: [] };
    }
    for (const p of products) {
      if (relevant(context, "cantidad") && (p.amount === null || p.quantityOutcome === "preguntar")) {
        const options = p.amount !== null ? [{ id: "si", label: `Sí, ${p.amount} ${p.unit ?? ""}`.trim(), probability: null }] : [];
        return { type: "clarify", field: "cantidad", question: `¿Qué cantidad de ${p.product.name}?`, options, segmentIndex: p.segmentIndex };
      }
    }

    // Mucha ambigüedad percibida. Si algún dato era dudoso, se pide repetir la orden. Si todos estaban
    // claros (operación, locales, productos y cantidades), una pregunta genérica no ayuda: se prepara
    // el borrador con un aviso (nada se ejecuta sin confirmarlo) y el formato, si falta, se pregunta aparte.
    const ambiguo = asNoul(this.answers.ambiguo);
    const allClear =
      locationOutcome === "actuar" &&
      toLocationOutcome === "actuar" &&
      products.every((p) => (p.productOutcome ?? "actuar") === "actuar" && (p.quantityOutcome ?? "actuar") === "actuar");
    const tooAmbiguous = !!ambiguo && accion !== "cierre_inventario" && Object.keys(this.overrides).length === 0 && gateNoulNo(ambiguo, t.ambiguo) === "preguntar";
    if (tooAmbiguous && !allClear) {
      return {
        type: "clarify",
        field: "tipo_accion",
        question: "No tengo claro qué quieres registrar. ¿Puedes indicarme la operación, el producto, la cantidad y el local?",
        options: [],
        restart: true,
      };
    }

    const motivo = (relevant(context, "motivo") ? this.choice("motivo_merma")?.choice ?? NO_INDICADO : NO_INDICADO) as MotivoMerma;
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
      ...(tooAmbiguous ? { reviewAll: true } : {}),
    };
  }
}

/**
 * La consulta que contesta ese dato de esos productos: «¿a cuánto nos sale el Beefeater?» es su
 * último precio (no la ficha entera), «¿cuántas botellas de Beefeater hay?» su stock, y el proveedor,
 * los formatos o el mínimo de un producto salen de su ficha. Sin productos, la consulta de Jev.
 */
export function toolForDato(tool: Herramienta, dato: Dato, productCount: number): Herramienta {
  if (productCount === 0) return tool;
  const lookup = tool === "query_stock" || tool === "query_product";
  if (dato === "precio" && (lookup || tool === "query_prices")) return "query_prices";
  if (!lookup) return tool;
  if (dato === "cantidad" || dato === "valor") return "query_stock";
  if ((dato === "proveedor" || dato === "formatos" || dato === "minimo") && productCount === 1) return "query_product";
  return tool;
}

/** «2 botellas», «1 caja», «6 ud»: la cantidad del mensaje para enseñarla. */
function amountLabel(amount: string, unit: string | null): string {
  const n = formatDecimal(amount, 4);
  if (!unit) return n;
  const plural = amount !== "1" && !/^(ud|kg|g|l|cl|ml)$/.test(unit) ? (/[aeiou]$/.test(unit) ? `${unit}s` : `${unit}es`) : unit;
  return `${n} ${plural}`;
}

export function locationLabel(ctx: SessionContext, id: string): string {
  return ctx.locations.find((l) => l.id === id)?.name ?? id;
}
