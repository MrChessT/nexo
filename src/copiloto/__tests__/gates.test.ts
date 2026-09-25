import { describe, expect, it } from "vitest";
import { gateChoice, gateNoulNo, gateNoulYes, worst } from "../gates/gate";
import { DEFAULT_THRESHOLDS, loadThresholds } from "../gates/thresholds";
import { choiceAnswer, choiceDist, noulAnswer } from "./helpers";

describe("compuertas de confianza", () => {
  it("actúa, confirma o pregunta según las bandas de cada decisión", () => {
    const options = ["a", "b", "c"];
    expect(gateChoice(choiceAnswer(options, "a", 0.97), DEFAULT_THRESHOLDS.intent_lectura).outcome).toBe("actuar");
    // p = 0,7 con 3 opciones → confianza 0,55: entre ask (0,45) y act (0,7).
    expect(gateChoice(choiceAnswer(options, "a", 0.7), DEFAULT_THRESHOLDS.intent_lectura).outcome).toBe("confirmar");
    expect(gateChoice(choiceAnswer(options, "a", 0.5), DEFAULT_THRESHOLDS.intent_lectura).outcome).toBe("preguntar");
  });

  it("el mismo reparto actúa en una lectura pero no en una escritura", () => {
    const answer = choiceAnswer(["a", "b", "c", "d"], "a", 0.78); // confianza 0,71
    expect(gateChoice(answer, DEFAULT_THRESHOLDS.intent_lectura).outcome).toBe("actuar");
    expect(gateChoice(answer, DEFAULT_THRESHOLDS.intent_accion).outcome).toBe("confirmar");
    expect(gateChoice(answer, DEFAULT_THRESHOLDS.cierre_inventario).outcome).toBe("confirmar");
  });

  it("exige margen entre los dos primeros productos", () => {
    const options = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const close = choiceDist(options, { p0: 0.6, p1: 0.38 });
    const g = gateChoice(close, DEFAULT_THRESHOLDS.producto_consulta);
    expect(g.confidence).toBeGreaterThan(0.5);
    expect(g.margin).toBeCloseTo(0.22);
    expect(g.outcome).not.toBe("actuar");
    expect(g.ranked.slice(0, 2).map((r) => r.option)).toEqual(["p0", "p1"]);
  });

  it("interpreta los noul en su sentido", () => {
    expect(gateNoulYes(noulAnswer(0.95), DEFAULT_THRESHOLDS.cantidad)).toBe("actuar");
    expect(gateNoulYes(noulAnswer(0.7), DEFAULT_THRESHOLDS.cantidad)).toBe("confirmar");
    expect(gateNoulYes(noulAnswer(0.2), DEFAULT_THRESHOLDS.cantidad)).toBe("preguntar");
    expect(gateNoulNo(noulAnswer(0.1), DEFAULT_THRESHOLDS.ambiguo)).toBe("actuar");
    expect(gateNoulNo(noulAnswer(0.9), DEFAULT_THRESHOLDS.inyeccion)).toBe("preguntar");
    expect(worst("actuar", "confirmar", "actuar")).toBe("confirmar");
  });

  it("permite ajustar umbrales por .env y valida el rango", () => {
    const t = loadThresholds({ GATE_PRODUCTO_BORRADOR_ACT: "0.97", GATE_PRODUCTO_BORRADOR_MARGIN: "0.5" });
    expect(t.producto_borrador).toEqual({ act: 0.97, ask: 0.6, minMargin: 0.5 });
    expect(() => loadThresholds({ GATE_DESTINO_ACT: "1.5" })).toThrow();
  });
});
