import { describe, expect, it } from "vitest";
import { runBattery } from "../eval/bateria";

describe("batería de frases con el catálogo real (sin Jev)", () => {
  it("productos, cantidades y respuestas escritas se entienden", async () => {
    const { total, fails } = await runBattery();
    expect(total).toBeGreaterThan(70);
    expect(fails).toEqual([]);
  });
});
