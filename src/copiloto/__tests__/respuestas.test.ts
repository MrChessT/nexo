import { describe, expect, it } from "vitest";
import { smallTalk } from "../agent/loop";
import { chat, FakeJev, find, makeAgent, run } from "./helpers";

describe("respuestas del asistente", () => {
  it("saludos, gracias y despedidas cortas se reconocen; lo demás no", () => {
    expect(smallTalk("gracias!")).toBe("gracias");
    expect(smallTalk("Muchas gracias")).toBe("gracias");
    expect(smallTalk("perfecto, gracias")).toBe("gracias");
    expect(smallTalk("buenas tardes")).toBe("hola");
    expect(smallTalk("hasta luego")).toBe("adios");
    expect(smallTalk("¿qué puedes hacer?")).toBeUndefined();
    expect(smallTalk("gracias, y ahora pásame 3 cocas al vivero por favor")).toBeUndefined();
  });

  it("«gracias» recibe una respuesta corta, no la ayuda entera", async () => {
    const { agent } = makeAgent(new FakeJev([{ intent: "conversar", intent_alt: "ninguno" }]));
    expect(find(await run(agent, chat("gracias!")), "done")!.text).toBe("¡De nada!");
  });

  it("el aviso de continuación va antes de los datos, y muchos productos se resumen", async () => {
    const stock = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Parador", producto_0: "varios" };
    const jev = new FakeJev([stock, { intent: "consultar", intent_alt: "leer", local: "Vivero", seguimiento: 0.85 }]);
    const { agent } = makeAgent(jev);
    await run(agent, chat("¿cuánto ron queda en Parador?"));
    const text = find(await run(agent, chat("¿y en el Vivero?")), "done")!.text;
    expect(text.startsWith("Sigo con los mismos productos.")).toBe(true);
    expect(text).toContain("No hay stock registrado de Ron Barceló Añejo 70 cl, Ron Brugal Añejo 70 cl en Vivero.");
  });

  it("al preguntar el local se ofrecen todos los locales", async () => {
    const waste = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: "Ron Barceló Añejo 70 cl", cantidad_ok_0: 0.97 };
    const clarify = find(await run(makeAgent(new FakeJev([waste])).agent, chat("se han roto 2 botellas de Barceló")), "clarify")!;
    expect(clarify.options.map((o) => o.id).sort()).toEqual(["La Oliva", "Parador", "Pickels", "Vivero"]);
  });
});

describe("botones para seguir desde una respuesta", () => {
  it("tras «¿cuántas cocas hay?»: precios, consumo, ficha… y al pulsar responde sin volver a Jev", async () => {
    const stock = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Vivero", producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 } };
    const jev = new FakeJev([stock]);
    const { agent } = makeAgent(jev);
    const first = await run(agent, chat("¿cuántas cajas de coca quedan en el Vivero?"));
    const actions = find(first, "actions")!.actions;
    expect(actions.map((a) => a.label)).toEqual(["Precios", "Consumo del mes", "Ficha", "Qué reponer"]);
    expect(jev.calls).toHaveLength(1);

    // «Consumo del mes»: movimientos de la Coca-Cola en el Vivero, sin llamada a Jev.
    const consumo = await run(agent, chat("Consumo del mes", { followUpId: actions[1]!.id }));
    expect(jev.calls).toHaveLength(1);
    expect(find(consumo, "done")!.text).toContain("Movimientos de Coca-Cola 20 cl en Vivero");
    // Arriba, el dinero por tipo; no «N registros».
    expect(find(consumo, "done")!.text).toMatch(/^Movimientos de Coca-Cola 20 cl en Vivero \(los últimos 30 días\): Consumo [\d.,]+ €/);
    expect(find(consumo, "decision")!.shortcut).toBe(true);

    // «Ficha»: formatos, compra y stock.
    const ficha = find(await run(agent, chat("Ficha", { followUpId: actions[2]!.id })), "done")!.text;
    expect(ficha.startsWith("Coca-Cola 20 cl · Refrescos")).toBe(true);
    expect(jev.calls).toHaveLength(1);
  });

  it("«Qué reponer» en un local ofrece «Preparar pedido», que prepara el borrador del pedido", async () => {
    const reorder = { intent: "pedir_sugerencias", intent_alt: "leer", herramienta: "query_reorder", local: "Vivero" };
    const jev = new FakeJev([reorder, {}, { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const actions = find(await run(agent, chat("¿qué me falta en el Vivero?")), "actions")!.actions;
    expect(actions.map((a) => a.label)).toEqual(["Preparar pedido"]);
    const draft = find(await run(agent, chat("Preparar pedido", { followUpId: actions[0]!.id })), "draft")!;
    expect(draft).toMatchObject({ kind: "pedido" });
  });

  it("un botón que ya no existe se trata como un mensaje normal", async () => {
    const jev = new FakeJev([{ intent: "conversar", intent_alt: "ninguno" }]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("Precios", { followUpId: "inventado" }));
    expect(jev.calls).toHaveLength(1);
    expect(find(events, "done")).toBeDefined();
  });
});
