import { describe, expect, it } from "vitest";
import type { TransferDraft, WasteDraft } from "../contract/index";
import { LOCATIONS, PRODUCTS } from "../dev/fixture";
import { chat, FakeJev, find, makeAgent, run, type Script } from "./helpers";

const [PARADOR, , VIVERO] = LOCATIONS;
const BARCELO = PRODUCTS[0]!;
const BRUGAL = PRODUCTS[1]!;

const TRANSFER: Script = {
  intent: "proponer_accion",
  intent_alt: "cambiar",
  tipo_accion: "traspaso",
  local: "Parador",
  local_destino: "Vivero",
  producto_0: { winner: BARCELO.name, p: 0.99 },
};

describe("aclaraciones: no se repite la primera orden", () => {
  it("traspaso sin cantidad → pregunta; «5» escrito a mano la completa sin volver a Jev", async () => {
    const jev = new FakeJev([TRANSFER, { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("pasa Barceló del Parador al Vivero")), "clarify")!;
    expect(clarify).toMatchObject({ field: "cantidad", question: `¿Qué cantidad de ${BARCELO.name}?` });

    // Sin unidad: pregunta el formato (botellas o cajas) en lugar de suponerlo.
    const format = find(await run(agent, chat("5", { clarification: { clarifyId: clarify.clarifyId, optionId: "otra", freeText: "5" } })), "clarify")!;
    expect(format.field).toBe("cantidad");
    expect(format.options.map((o) => o.label)).toEqual(["Botella 70 cl", "Caja 6 botellas"]);

    const events = await run(agent, chat("cajas", { clarification: { clarifyId: format.clarifyId, optionId: "otra", freeText: "cajas" } }));
    const draft = find(events, "draft") as TransferDraft;
    expect(draft).toMatchObject({ fromLocationId: PARADOR!.id, toLocationId: VIVERO!.id });
    expect(draft.lines.map((l) => [l.productName, l.qtyBase, l.input.unit])).toEqual([[BARCELO.name, "21000", "Caja 6 botellas"]]);
    // Una sola llamada nº 1 (la del mensaje original) y la de coherencia.
    expect(jev.calls.filter((c) => "intent" in c.questions)).toHaveLength(1);
  });

  it("«5 botellas» escrito a mano: cantidad y formato de una vez", async () => {
    const { agent } = makeAgent(new FakeJev([TRANSFER, { coherencia: 0.95 }]));
    const clarify = find(await run(agent, chat("pasa Barceló del Parador al Vivero")), "clarify")!;
    const events = await run(agent, chat("5 botellas", { clarification: { clarifyId: clarify.clarifyId, optionId: "otra", freeText: "5 botellas" } }));
    expect((find(events, "draft") as TransferDraft).lines[0]).toMatchObject({ qtyBase: "3500", input: { amount: "5", unit: "Botella 70 cl" } });
  });

  it("producto elegido con botón + cantidad escrita: no vuelve a preguntar el producto", async () => {
    const script: Script = { ...TRANSFER, producto_0: "varios" };
    const jev = new FakeJev([script, { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const which = find(await run(agent, chat("pasa ron del Parador al Vivero")), "clarify")!;
    expect(which.field).toBe("producto");
    const qty = find(await run(agent, chat(BRUGAL.name, { clarification: { clarifyId: which.clarifyId, optionId: BRUGAL.name } })), "clarify")!;
    expect(qty.field).toBe("cantidad");
    const events = await run(agent, chat("3 botellas", { clarification: { clarifyId: qty.clarifyId, optionId: "otra", freeText: "3 botellas" } }));
    expect((find(events, "draft") as TransferDraft).lines[0]).toMatchObject({ productName: BRUGAL.name, qtyBase: "2100" });
  });

  it("una orden nueva mientras hay una pregunta con botones abierta no arrastra la anterior", async () => {
    const vague: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { dist: { merma: 0.5, traspaso: 0.4 } } };
    const stock: Script = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Vivero" };
    const jev = new FakeJev([vague, stock]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("quita unas cocas")), "clarify")!;
    expect(clarify.field).toBe("tipo_accion");
    const text = "¿qué stock hay en el Vivero?";
    await run(agent, chat(text, { clarification: { clarifyId: clarify.clarifyId, optionId: "otra", freeText: text } }));
    expect(jev.calls[1]!.state).toMatchObject({ message: text });
  });

  it("una pregunta nueva mientras se pregunta el local tampoco se pega a la orden anterior", async () => {
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: BARCELO.name, cantidad_ok_0: 0.97 };
    const stock: Script = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Parador" };
    const jev = new FakeJev([waste, stock]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("se han roto 2 botellas de Barceló")), "clarify")!;
    expect(clarify.field).toBe("local");
    const text = "¿cuánto ron queda en Parador?";
    await run(agent, chat(text, { clarification: { clarifyId: clarify.clarifyId, optionId: "otra", freeText: text } }));
    expect(jev.calls[1]!.state).toMatchObject({ message: text });
  });

  it("el historial guarda lo que dijo el usuario, no la orden original repetida", async () => {
    const jev = new FakeJev([{ ...TRANSFER, producto_0: "varios" }, { coherencia: 0.95 }, { intent: "conversar" }]);
    const { agent } = makeAgent(jev);
    const which = find(await run(agent, chat("pasa 3 botellas de ron del Parador al Vivero")), "clarify")!;
    await run(agent, chat(BRUGAL.name, { clarification: { clarifyId: which.clarifyId, optionId: BRUGAL.name } }));
    await run(agent, chat("gracias"));
    const turns = jev.calls.at(-1)!.state as { recent_turns: Array<{ role: string; text: string }> };
    const userTurns = turns.recent_turns.filter((t) => t.role === "user").map((t) => t.text);
    expect(userTurns).toEqual(["pasa 3 botellas de ron del Parador al Vivero", BRUGAL.name]);
  });

  it("un borrador ya confirmado con el botón deja de estar «pendiente» para el chat", async () => {
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", local: "Parador", producto_0: BARCELO.name, cantidad_ok_0: 0.97 };
    const jev = new FakeJev([waste, { coherencia: 0.95 }, waste, { coherencia: 0.95 }]);
    const { agent, drafts } = makeAgent(jev);
    const first = find(await run(agent, chat("se han roto 2 botellas de Barceló en Parador")), "draft") as WasteDraft;
    await drafts.claim(first.draftId);
    const second = await run(agent, chat("se han roto otras 3 botellas de Barceló en Parador"));
    expect(Object.keys(jev.calls[2]!.questions)).not.toContain("borrador");
    expect(find(second, "draft")).toBeDefined();
  });

  it("sin local y con local habitual: pregunta, con el habitual como primera opción", async () => {
    const stock: Script = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Vivero", producto_0: BARCELO.name };
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: BARCELO.name, cantidad_ok_0: 0.97 };
    const jev = new FakeJev([stock, stock, stock, stock, stock, waste]);
    const { agent } = makeAgent(jev);
    for (let i = 0; i < 5; i += 1) await run(agent, chat("¿cuánto Barceló queda en el Vivero?"));
    const clarify = find(await run(agent, chat("se han roto 2 botellas de Barceló")), "clarify")!;
    expect(clarify.field).toBe("local");
    expect(clarify.options[0]!.id).toBe("Vivero");
  });
});
