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

describe("ficha de producto", () => {
  const sheet = (extra: Script = {}): Script => ({ intent: "consultar", intent_alt: "leer", herramienta: "query_product", ...extra });

  it("«¿a cuánto compramos el Barceló?»: formatos, compra y stock por local", async () => {
    const { agent } = makeAgent(new FakeJev([sheet({ producto_0: "Ron Barceló Añejo 70 cl" })]));
    const events = await run(agent, chat("¿a cuánto compramos el Barceló?"));
    const text = find(events, "done")!.text;
    expect(text).toContain("Ron Barceló Añejo 70 cl (Destilados). Formatos: Botella 70 cl · Caja 6 botellas. Compra: Caja 6 botellas a 92,40 € (Distribuciones Canarias).");
    expect(find(events, "table")!.rows).toEqual(expect.arrayContaining([expect.objectContaining({ local: "Parador", cantidad: "3 botellas", minimo: "4 botellas" })]));
    expect(find(events, "navigate")).toMatchObject({ route: "/productos" });
  });

  it("con un tipo genérico («ron») pregunta de cuál", async () => {
    const { agent } = makeAgent(new FakeJev([sheet({ producto_0: "varios" })]));
    const clarify = find(await run(agent, chat("ficha del ron")), "clarify")!;
    expect(clarify).toMatchObject({ field: "producto", question: "¿De cuál de estos productos?" });
    expect(clarify.options.map((o) => o.label)).toEqual(expect.arrayContaining(["Ron Barceló Añejo 70 cl", "Ron Brugal Añejo 70 cl"]));
  });
});

describe("inventarios desde el chat", () => {
  const act = (accion: string, extra: Script = {}): Script => ({ intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { winner: accion, p: 0.97 }, ...extra });

  it("«empieza el inventario del Parador»: lo abre al confirmar", async () => {
    const jev = new FakeJev([act("abrir_inventario", { local: "Parador" }), { coherencia: 0.95 }, { borrador: "confirmar" }]);
    const { agent, writer } = makeAgent(jev);
    const draft = find(await run(agent, chat("empieza el inventario del Parador")), "draft")!;
    expect(draft).toMatchObject({ kind: "conteo", operation: "abrir", title: "Abrir inventario en Parador" });
    const done = await run(agent, chat("sí, adelante"));
    expect(find(done, "resolved")!.message).toContain("Inventario abierto en Parador");
    expect(writer.calls.map((c) => c.method)).toEqual(["openCount"]);
  });

  it("si ya hay uno abierto, lo dice y explica cómo apuntar", async () => {
    const { agent } = makeAgent(new FakeJev([act("abrir_inventario", { local: "Vivero" })]));
    const text = find(await run(agent, chat("abre inventario en el vivero")), "done")!.text;
    expect(text).toMatch(/^Ya hay un inventario abierto en Vivero \(\d+ productos? contados?\)\./);
  });

  it("«en la cámara del Vivero hay 3 botellas de Tanqueray»: se apunta en el inventario abierto", async () => {
    const script = act("anotar_conteo", { local: "Vivero", espacio: "Vivero · Cámara", producto_0: { winner: "Ginebra Tanqueray 70 cl", p: 0.97 }, cantidad_ok_0: 0.97 });
    const jev = new FakeJev([script, { coherencia: 0.95 }, { borrador: "confirmar" }]);
    const { agent, writer } = makeAgent(jev);
    const draft = find(await run(agent, chat("en la cámara del Vivero hay 3 botellas de Tanqueray")), "draft")!;
    expect(draft).toMatchObject({ kind: "conteo", operation: "anotar", areaName: "Cámara", title: "Contado en Vivero · Cámara: 3 × Botella 70 cl de Ginebra Tanqueray 70 cl" });
    await run(agent, chat("vale, confírmalo"));
    expect(writer.calls).toEqual([
      { method: "addCountLines", args: expect.objectContaining({ areaId: expect.any(String), lines: [expect.objectContaining({ qtyBase: "2100" })] }) },
    ]);
  });

  it("sin inventario abierto no apunta: dice cómo abrirlo", async () => {
    const script = act("anotar_conteo", { local: "Parador", producto_0: { winner: "Ginebra Tanqueray 70 cl", p: 0.97 }, cantidad_ok_0: 0.97 });
    const text = find(await run(makeAgent(new FakeJev([script])).agent, chat("en el Parador hay 3 botellas de Tanqueray")), "done")!.text;
    expect(text).toBe("No hay ningún inventario abierto en Parador. Dime «empieza el inventario de Parador» para abrirlo.");
  });
});
