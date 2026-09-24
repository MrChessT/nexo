import { describe, expect, it } from "vitest";
import { runConversations } from "../eval/conversaciones";

describe("conversaciones de prueba con el catálogo real (Jev simulado)", () => {
  it("cada turno acaba como se espera (pregunta, borrador, consulta…)", async () => {
    const { report, turns, failed } = await runConversations(false);
    expect(turns).toBeGreaterThan(15);
    expect(failed, report).toBe(0);
  });
});
