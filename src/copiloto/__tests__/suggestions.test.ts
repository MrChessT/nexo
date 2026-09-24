import { describe, expect, it } from "vitest";
import { FixtureDataSource, fixtureContext } from "../dev/fixture";
import { DEFAULT_THRESHOLDS } from "../gates/thresholds";
import { Metrics } from "../metrics/metrics";
import { SuggestionEngine } from "../suggestions/engine";
import { InventoryTools } from "../tools/tools";
import { Writer } from "../writer/writer";
import { FakeJev, FakeProvider, NOW } from "./helpers";

function engine(jev: FakeJev, provider: FakeProvider | null = null) {
  const metrics = new Metrics("0.042");
  return new SuggestionEngine({ jev, writer: new Writer(provider, metrics), metrics, thresholds: DEFAULT_THRESHOLDS, now: () => NOW });
}
const tools = new InventoryTools(new FixtureDataSource(NOW));

describe("motor de sugerencias", () => {
  it("una sola llamada a Jev para todos los candidatos; filtra por relevancia y ordena por urgencia", async () => {
    // Orden de candidatos: reponer (5) → traspaso (1) → desvíos (2) → precios (1)
    const jev = new FakeJev([
      {
        reponer_0: 0.9, urgencia_0: 2,
        reponer_1: 0.2, urgencia_1: 1,
        reponer_2: 0.8, urgencia_2: 1,
        reponer_3: 0.1, urgencia_3: 0,
        reponer_4: 0.1, urgencia_4: 0,
        atasco_5: 0.95, urgencia_5: 3,
        desvio_6: 0.9, urgencia_6: 2.6,
        desvio_7: 0.1, urgencia_7: 0,
        subida_8: 0.7, urgencia_8: 1,
      },
    ]);
    const result = await engine(jev).suggest(fixtureContext(), tools, { limit: 8 });
    expect(jev.calls).toHaveLength(1);
    expect(Object.keys(jev.calls[0]!.questions)).toHaveLength(18);
    expect(result.items.map((s) => [s.kind, s.urgency])).toEqual([
      ["traspaso_pendiente", "critica"],
      ["desvio_inventario", "critica"],
      ["stock_bajo", "alta"],
      ["stock_bajo", "media"],
      ["subida_precio", "media"],
    ]);
    const transfer = result.items[0]!;
    expect(transfer.text).toBe("Traspaso Parador → Vivero sin recibir desde hace 3 días (56,40 €).");
    expect(transfer.action).toEqual({ route: "/traspasos", filters: { locationId: expect.any(String) }, auto: false });
    expect(result.items.find((s) => s.kind === "subida_precio")!.text).toBe(
      "Ron Barceló Añejo 70 cl (Caja 6 botellas) ha subido de 84,00 € a 92,40 € (10 %) con Distribuciones Canarias.",
    );
  });

  it("respeta el límite y cachea la respuesta", async () => {
    const jev = new FakeJev([{ atasco_5: 0.9, urgencia_5: 3, desvio_6: 0.9, urgencia_6: 2 }]);
    const e = engine(jev);
    const first = await e.suggest(fixtureContext(), tools, { limit: 1 });
    expect(first.items).toHaveLength(1);
    await e.suggest(fixtureContext(), tools, { limit: 1 });
    expect(jev.calls).toHaveLength(1);
  });

  it("la LLM redacta la línea solo si sus cifras están en los datos", async () => {
    const jev = new FakeJev([{ atasco_5: 0.95, urgencia_5: 3 }]);
    const good = await engine(jev, new FakeProvider([["El traspaso de Parador a Vivero lleva 3 días sin recibirse: revísalo."]])).suggest(fixtureContext(), tools, { limit: 1 });
    expect(good.items[0]!.text).toBe("El traspaso de Parador a Vivero lleva 3 días sin recibirse: revísalo.");
    const bad = await engine(new FakeJev([{ atasco_5: 0.95, urgencia_5: 3 }]), new FakeProvider([["Lleva 5 días sin recibirse."]])).suggest(fixtureContext(), tools, { limit: 1 });
    expect(bad.items[0]!.text).toContain("3 días");
  });
});
