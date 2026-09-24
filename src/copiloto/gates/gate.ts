import type { ChoiceResponse, NoulResponse, ScoreResponse } from "@typesafe-ai/sdk";
import type { GateOutcome } from "../contract/index";
import type { JevAnswer } from "../jev/client";
import type { GateSpec } from "./thresholds";

export interface RankedOption {
  option: string;
  probability: number;
}

export interface ChoiceGate {
  outcome: GateOutcome;
  choice: string;
  probability: number;
  confidence: number;
  margin: number;
  ranked: RankedOption[];
}

export function rank(probabilities: Record<string, number>): RankedOption[] {
  return Object.entries(probabilities)
    .map(([option, probability]) => ({ option, probability }))
    .sort((a, b) => b.probability - a.probability);
}

export function gateChoice(answer: ChoiceResponse, spec: GateSpec): ChoiceGate {
  const ranked = rank(answer.probabilities as Record<string, number>);
  const top = ranked[0]?.probability ?? 0;
  const margin = top - (ranked[1]?.probability ?? 0);
  let outcome: GateOutcome = answer.confidence >= spec.act ? "actuar" : answer.confidence >= spec.ask ? "confirmar" : "preguntar";
  if (outcome === "actuar" && spec.minMargin !== undefined && margin < spec.minMargin) outcome = "confirmar";
  return { outcome, choice: answer.choice, probability: top, confidence: answer.confidence, margin, ranked };
}

/** Noul donde "sí" es lo que queremos (cantidad correcta, borrador coherente). */
export function gateNoulYes(answer: NoulResponse, spec: GateSpec): GateOutcome {
  return answer.noul >= spec.act ? "actuar" : answer.noul >= spec.ask ? "confirmar" : "preguntar";
}

/** Noul donde "sí" es una señal de alarma (ambigüedad, inyección). */
export function gateNoulNo(answer: NoulResponse, spec: GateSpec): GateOutcome {
  return answer.noul <= spec.act ? "actuar" : answer.noul <= spec.ask ? "confirmar" : "preguntar";
}


/** Peor de varios resultados: preguntar > confirmar > actuar. */
export function worst(...outcomes: GateOutcome[]): GateOutcome {
  if (outcomes.includes("preguntar")) return "preguntar";
  if (outcomes.includes("confirmar")) return "confirmar";
  return "actuar";
}

export function asChoice(answer: JevAnswer | undefined): ChoiceResponse | undefined {
  return answer?.type === "choice" ? answer : undefined;
}

export function asNoul(answer: JevAnswer | undefined): NoulResponse | undefined {
  return answer?.type === "noul" ? answer : undefined;
}

export function asScore(answer: JevAnswer | undefined): ScoreResponse | undefined {
  return answer?.type === "score" ? answer : undefined;
}
