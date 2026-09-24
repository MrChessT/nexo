import { describe, expect, it } from "vitest";
import { ORG_ID, PRODUCTS, fixtureContext } from "../dev/fixture";
import { FixtureWriter } from "../dev/fixture-writer";
import { chat, FakeJev, find, makeAgent, run, type Script } from "./helpers";

const BARCELO = PRODUCTS[0]!;
const WASTE: Script = {
  intent: "proponer_accion",
  intent_alt: "cambiar",
  tipo_accion: "merma",
  local: "Parador",
  espacio: "Parador · Barra 1",
  producto_0: BARCELO.name,
  cantidad_ok_0: 0.97,
  motivo_merma: "rotura",
};
const key = "00000009-0000-4000-8000-000000000000";

describe("confirmar o descartar un borrador desde el chat", () => {
  it("«sí, adelante» confirma el borrador pendiente con el mismo servicio que el botón", async () => {
    const jev = new FakeJev([WASTE, { coherencia: 0.96 }, { borrador: "confirmar" }]);
    const { agent, writer } = makeAgent(jev);
    const draft = find(await run(agent, chat("baja 2 botellas de ron rotas en barra 1")), "draft")!;
    const events = await run(agent, chat("sí, adelante"));

    // Solo con un borrador esperando se pregunta a Jev si el mensaje lo confirma.
    expect(Object.keys(jev.calls[0]!.questions)).not.toContain("borrador");
    expect(jev.calls[2]!.state).toMatchObject({ pending_draft: draft.title });
    expect(find(events, "resolved")).toEqual({ draftId: draft.draftId, status: "confirmado", message: "Merma registrada." });
    expect(find(events, "done")!.text).toBe("Merma registrada.");
    expect(writer.calls.map((c) => c.method)).toEqual(["registerWaste"]);

    // Ya no hay borrador pendiente: otro «sí» no vuelve a ejecutar nada.
    const again = await run(agent, chat("sí"));
    expect(Object.keys(jev.calls.at(-1)!.questions)).not.toContain("borrador");
    expect(find(again, "resolved")).toBeUndefined();
    expect(writer.calls).toHaveLength(1);
  });

  it("«cancélalo» lo descarta y bloquea: la tarjeta antigua ya no puede confirmarlo", async () => {
    const jev = new FakeJev([WASTE, { coherencia: 0.96 }, { borrador: "cancelar" }]);
    const { agent, writer, confirmService } = makeAgent(jev);
    const draft = find(await run(agent, chat("baja 2 botellas de ron rotas en barra 1")), "draft")!;
    const events = await run(agent, chat("no, cancélalo"));
    expect(find(events, "resolved")).toMatchObject({ status: "descartado" });
    expect(writer.calls).toHaveLength(0);

    const button = await confirmService.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key }, fixtureContext(), new FixtureWriter());
    expect(button.ok).toBe(false);
  });

  it("con avisos en «revisar» no se confirma por chat", async () => {
    const price: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "cambiar_precio", producto_0: BARCELO.name };
    const jev = new FakeJev([price, { coherencia: 0.9, precio_plausible: 0.08 }, { borrador: "confirmar" }]);
    const { agent, writer } = makeAgent(jev);
    await run(agent, chat("el Barceló ahora cuesta 924 €"));
    const events = await run(agent, chat("vale, confírmalo"));
    expect(find(events, "done")!.text).toContain("tiene avisos que revisar");
    expect(writer.calls).toHaveLength(0);
  });

  it("si Jev no está seguro, pregunta antes de confirmar", async () => {
    const jev = new FakeJev([WASTE, { coherencia: 0.96 }, { borrador: { winner: "confirmar", p: 0.75 } }]);
    const { agent, writer } = makeAgent(jev);
    await run(agent, chat("baja 2 botellas de ron rotas en barra 1"));
    const clarify = find(await run(agent, chat("bueno, venga")), "clarify")!;
    expect(clarify).toMatchObject({ field: "borrador", options: [{ id: "confirmar", label: "Sí, confírmalo" }] });
    expect(writer.calls).toHaveLength(0);

    const events = await run(agent, chat("Sí, confírmalo", { clarification: { clarifyId: clarify.clarifyId, optionId: "confirmar" } }));
    expect(find(events, "resolved")).toMatchObject({ status: "confirmado" });
    expect(writer.calls).toHaveLength(1);
  });
});
