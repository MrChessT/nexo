import { describe, expect, it } from "vitest";
import type { DocumentDraft } from "../contract/index";
import { LOCATIONS } from "../dev/fixture";
import { chat, FakeJev, find, makeAgent, run, type Script } from "./helpers";

const [PARADOR, PICKELS, VIVERO] = LOCATIONS;
const route = (accion: string, extra: Script = {}): Script => ({ intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { winner: accion, p: 0.97 }, ...extra });

describe("traspasos y pedidos desde el chat", () => {
  it("«ha llegado el traspaso del Parador»: borrador para recibirlo y, al confirmar, se recibe", async () => {
    const jev = new FakeJev([route("recibir_traspaso", { local: "Parador" }), { coherencia: 0.95 }, { borrador: "confirmar" }]);
    const { agent, writer } = makeAgent(jev);
    const draft = find(await run(agent, chat("ha llegado el traspaso del Parador")), "draft") as DocumentDraft;
    expect(draft).toMatchObject({ kind: "documento", operation: "recibir_traspaso", locationId: VIVERO!.id, requiredRole: "staff" });
    expect(draft.summary).toBe("Parador → Vivero · enviado hace 3 días");
    expect(draft.lines).toEqual([
      { label: "Coca-Cola 20 cl", qty: "2 cajas" },
      { label: "Ron Barceló Añejo 70 cl", qty: "2 botellas" },
    ]);
    const done = await run(agent, chat("sí, adelante"));
    expect(find(done, "resolved")).toMatchObject({ status: "confirmado", message: expect.stringContaining("Traspaso recibido") });
    expect(writer.calls.map((c) => c.method)).toEqual(["receiveTransfer"]);
  });

  it("sin traspasos pendientes en ese local lo dice (y no prepara nada)", async () => {
    const { agent } = makeAgent(new FakeJev([route("recibir_traspaso", { local: "Pickels" })]));
    const events = await run(agent, chat("¿ha llegado algo a Pickels? recíbelo"));
    expect(find(events, "draft")).toBeUndefined();
    expect(find(events, "done")!.text).toBe(`No hay traspasos pendientes de recibir en ${PICKELS!.name}.`);
  });

  it("«manda el pedido de Bebidas del Sur»: enviarlo exige encargado", async () => {
    const jev = new FakeJev([route("enviar_pedido"), { coherencia: 0.95 }]);
    const draft = find(await run(makeAgent(jev).agent, chat("manda el pedido de Bebidas del Sur"), "staff"), "draft") as DocumentDraft;
    expect(draft).toMatchObject({ operation: "enviar_pedido", requiredRole: "manager", canConfirm: false });
    expect(draft.summary).toBe("Bebidas del Sur · Vivero · sin enviar");
  });

  it("«ha llegado el pedido de Distribuciones Canarias»: se recibe lo pendiente al precio del pedido", async () => {
    const jev = new FakeJev([route("recibir_pedido"), { coherencia: 0.95 }, { borrador: "confirmar" }]);
    const { agent, writer } = makeAgent(jev);
    const draft = find(await run(agent, chat("ha llegado el pedido de Distribuciones Canarias")), "draft") as DocumentDraft;
    expect(draft).toMatchObject({ operation: "recibir_pedido", locationId: PARADOR!.id });
    expect(draft.lines).toEqual([{ label: "Ron Barceló Añejo 70 cl", qty: "2 × Caja 6 botellas" }]);
    expect(draft.receive).toEqual([{ packId: expect.any(String), packsQty: "2", packPrice: "92.40" }]);
    await run(agent, chat("sí, confírmalo"));
    expect(writer.calls).toEqual([{ method: "receiveOrder", args: { orderId: draft.documentId, lines: draft.receive } }]);
  });

  it("con varios candidatos pregunta cuál; la respuesta con botón lo elige", async () => {
    const jev = new FakeJev([route("cancelar_pedido"), { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("cancela el pedido")), "clarify")!;
    expect(clarify).toMatchObject({ field: "documento", question: "¿Qué pedido?" });
    expect(clarify.options.map((o) => o.label)).toEqual(["Distribuciones Canarias · Parador · entrega 21/09", "Bebidas del Sur · Vivero · sin enviar"]);
    const option = clarify.options[1]!;
    const draft = find(await run(agent, chat(option.label, { clarification: { clarifyId: clarify.clarifyId, optionId: option.id } })), "draft") as DocumentDraft;
    expect(draft).toMatchObject({ operation: "cancelar_pedido", documentId: option.id, requiredRole: "manager" });
  });
});
