import { describe, expect, it } from "vitest";
import { chat, FakeJev, find, makeAgent, run } from "./helpers";

describe("consultas de pedidos y gasto", () => {
  it("pedidos abiertos: pendientes, retrasados y borradores sin enviar", async () => {
    const jev = new FakeJev([{ intent: "consultar", intent_alt: "leer", herramienta: "query_orders" }]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("¿qué pedidos tengo pendientes?"));
    const text = find(events, "done")!.text;
    expect(text).toContain("1 pedido pendiente de recibir (184,80 €), 1 con retraso y 1 borrador sin enviar.");
    // El detalle va en la tabla; el texto es el titular.
    const table = find(events, "table")!;
    expect(table.columns.map((c) => c.label)).toEqual(expect.arrayContaining(["Proveedor", "Local", "Estado", "Importe"]));
    expect(table.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ proveedor: "Distribuciones Canarias", local: "Parador", estado: "enviado" }),
      expect.objectContaining({ proveedor: "Bebidas del Sur", local: "Vivero", estado: "borrador sin enviar" }),
    ]));
    expect(table.flagged).toHaveLength(1);
    expect(text).not.toContain("•");
    expect(find(events, "navigate")).toMatchObject({ route: "/pedidos" });
  });

  it("gasto en compras por proveedor en el periodo, en tabla", async () => {
    const jev = new FakeJev([{ intent: "consultar", intent_alt: "leer", herramienta: "query_spend", periodo: "mes" }]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("¿cuánto he gastado en compras este mes?"));
    const text = find(events, "done")!.text;
    expect(text).toMatch(/Compras del .+: 382,80 € en 3 albaranes\./);
    expect(find(events, "table")!.rows).toEqual([
      { proveedor: "Bebidas del Sur", importe: "198,00 €", porcentaje: "51,7 %" },
      { proveedor: "Distribuciones Canarias", importe: "184,80 €", porcentaje: "48,3 %" },
    ]);
    // Con tabla, la gráfica de barras repetiría las mismas cifras: no se envía.
    expect(find(events, "chart")).toBeUndefined();
  });
});
