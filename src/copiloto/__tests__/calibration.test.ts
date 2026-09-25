import { describe, expect, it } from "vitest";
import { expectedCalibrationError, recommendThreshold, reliability, sweep, type Point } from "../eval/calibration";

const pts = (list: Array<[number, boolean]>): Point[] => list.map(([confidence, ok]) => ({ confidence, ok }));

describe("calibración de las decisiones de Jev", () => {
  it("tabla de fiabilidad por tramos de confianza", () => {
    const bins = reliability(pts([[0.99, true], [0.97, true], [0.96, false], [0.6, true], [0.2, false]]));
    expect(bins.map((b) => b.n)).toEqual([1, 1, 0, 0, 3]);
    expect(bins[4]!.accuracy).toBeCloseTo(2 / 3);
    expect(bins[2]!.accuracy).toBeNull();
  });

  it("ECE 0 si acierta tanto como dice; alto si está demasiado segura", () => {
    expect(expectedCalibrationError(pts([[0.99, true], [0.99, true]]))).toBeCloseTo(0.01);
    expect(expectedCalibrationError(pts([[0.99, false], [0.99, false]]))).toBeCloseTo(0.99);
  });

  it("barrido: cobertura, precisión y errores con cada umbral", () => {
    const [low, high] = sweep(pts([[0.95, true], [0.8, true], [0.6, false]]), [0.5, 0.7]);
    expect(low).toMatchObject({ coverage: 1, errors: 1 });
    expect(high).toMatchObject({ errors: 0, precision: 1 });
    expect(high!.coverage).toBeCloseTo(2 / 3);
  });

  it("recomienda el umbral más bajo sin errores, con margen y sin bajar del suelo", () => {
    // El error está en 0,62: sin errores desde 0,65 → con margen 0,7.
    expect(recommendThreshold(pts([[0.95, true], [0.8, true], [0.62, false], [0.4, true]]))).toBe(0.7);
    // Sin errores: el suelo.
    expect(recommendThreshold(pts([[0.95, true], [0.9, true]]))).toBe(0.5);
    // Un error con 0,99 de confianza: ningún umbral lo evita.
    expect(recommendThreshold(pts([[0.99, false], [0.9, true]]))).toBeNull();
  });
});
