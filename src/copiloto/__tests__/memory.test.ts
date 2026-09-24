import { describe, expect, it } from "vitest";
import { LOCATIONS, PRODUCTS } from "../dev/fixture";
import { chat, FakeJev, find, makeAgent, run, type Script } from "./helpers";

const BARCELO = PRODUCTS[0]!;
const [PARADOR, , VIVERO] = LOCATIONS;
const stock = (extra: Script = {}): Script => ({ intent: "consultar", intent_alt: "leer", herramienta: "query_stock", ...extra });

describe("memoria de la conversación", () => {
  it("«¿y en el Vivero?» sigue con el mismo producto y lo dice", async () => {
    const jev = new FakeJev([stock({ local: "Parador", producto_0: BARCELO.name }), stock({ local: "Vivero", seguimiento: 0.82 })]);
    const { agent } = makeAgent(jev);
    await run(agent, chat("¿cuánto ron Barceló queda en Parador?"));
    const events = await run(agent, chat("¿y en el Vivero?"));

    expect(find(events, "decision")!.decisions).toEqual(expect.arrayContaining([expect.objectContaining({ id: "seguimiento", valueLabel: "Continúa lo anterior" })]));
    expect(find(events, "navigate")).toMatchObject({ route: "/stock", filters: { locationId: VIVERO!.id, productId: BARCELO.id } });
    expect(find(events, "done")!.text).toContain(`Sigo con ${BARCELO.name}, de lo que hablábamos.`);
    // Jev recibe la conversación para resolver la referencia.
    expect((jev.calls[1]!.state as { recent_turns: unknown[] }).recent_turns).toHaveLength(2);
  });

  it("«¿y el Brugal?» cambia de producto pero se queda en el mismo local", async () => {
    const BRUGAL = PRODUCTS[1]!;
    const jev = new FakeJev([stock({ local: "Parador", producto_0: BARCELO.name }), stock({ producto_0: BRUGAL.name, seguimiento: 0.91 })]);
    const { agent } = makeAgent(jev);
    await run(agent, chat("¿cuánto ron Barceló queda en Parador?"));
    const events = await run(agent, chat("¿y el Brugal?"));
    expect(find(events, "navigate")).toMatchObject({ filters: { locationId: PARADOR!.id, productId: BRUGAL.id } });
    expect(find(events, "done")!.text).toContain("Sigo con Parador");
  });

  it("una pregunta nueva no hereda nada aunque venga justo después", async () => {
    const jev = new FakeJev([stock({ local: "Parador", producto_0: BARCELO.name }), stock({ seguimiento: 0.5 })]);
    const { agent } = makeAgent(jev);
    await run(agent, chat("¿cuánto ron Barceló queda en Parador?"));
    const events = await run(agent, chat("¿cuánto stock hay?"));
    expect(find(events, "decision")!.decisions.map((d) => d.id)).not.toContain("seguimiento");
    expect(find(events, "done")!.text).not.toContain("Sigo con");
    expect(find(events, "navigate")!.filters.productId).toBeUndefined();
  });
});
