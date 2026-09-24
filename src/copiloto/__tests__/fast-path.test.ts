import { describe, expect, it } from "vitest";
import { fastStockPlan } from "../agent/fast-path";
import { fixtureContext, LOCATIONS, PRODUCTS } from "../dev/fixture";
import { LexicalRetriever } from "../entities/retriever";
import { chat, FakeJev, find, makeAgent, run } from "./helpers";

const [, , VIVERO] = LOCATIONS;
const ctx = fixtureContext();
const retriever = new LexicalRetriever();
const plan = (m: string) => fastStockPlan(m, ctx, retriever);

describe("vía rápida sin Jev para preguntas de stock puras", () => {
  it("resuelve «¿cuántas cocas quedan en el Vivero?» y «stock de ron» (la familia)", async () => {
    expect(await plan("¿cuántas cocas quedan en el Vivero?")).toMatchObject({ tool: "query_stock", locationIds: [VIVERO!.id], locationsDefaulted: false, products: [expect.objectContaining({ product: PRODUCTS[3] })] });
    const rum = await plan("stock de ron");
    expect(rum?.products.map((p) => p.product.name).sort()).toEqual(["Ron Barceló Añejo 70 cl", "Ron Brugal Añejo 70 cl"]);
    expect(rum?.locationsDefaulted).toBe(true);
  });

  it("nunca decide si el mensaje dice algo más, trae cifras o nombra un espacio", async () => {
    for (const m of [
      "¿cuánto he gastado en cocas?", // gasto, no stock
      "¿a cuánto está la coca?", // precio
      "en el vivero hay 5 cocas", // recuento (cifra)
      "¿cuántas cocas quedan en la barra 1?", // espacio
      "se han roto las cocas del vivero", // merma
      "pasa las cocas al vivero", // traspaso
      "coca", // sin palabra de stock
      "¿cuánto queda?", // sin producto
    ]) {
      expect(await plan(m), m).toBeNull();
    }
  });

  it("en el agente: responde sin llamar a Jev, con tabla/texto y botones", async () => {
    const jev = new FakeJev([]);
    const { agent } = makeAgent(jev, null, { fastPath: true });
    const events = await run(agent, chat("¿cuántas cocas quedan en el Vivero?"));
    expect(jev.calls).toHaveLength(0);
    expect(find(events, "done")!.text).toContain("Stock de Coca-Cola 20 cl en Vivero: 2 cajas");
    expect(find(events, "actions")!.actions.map((a) => a.label)).toContain("Precios");
  });

  it("con un borrador esperando respuesta decide Jev (puede ser «sí» o «no»)", async () => {
    const waste = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", local: "Parador", producto_0: PRODUCTS[0]!.name, cantidad_ok_0: 0.97 };
    const jev = new FakeJev([waste, { coherencia: 0.95 }, { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", producto_0: "Coca-Cola 20 cl" }]);
    const { agent } = makeAgent(jev, null, { fastPath: true });
    await run(agent, chat("se han roto 2 botellas de barceló en el parador"));
    await run(agent, chat("¿cuántas cocas quedan?"));
    expect(jev.calls).toHaveLength(3);
  });
});
