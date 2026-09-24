import { describe, expect, it } from "vitest";
import { chat, FakeJev, find, makeAgent, run } from "./helpers";

describe("consultas de pedidos y gasto", () => {
  it("pedidos abiertos: pendientes, retrasados y borradores sin enviar", async () => {
    const jev = new FakeJev([{ intent: "consultar", intent_alt: "leer", herramienta: "query_orders" }]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("¿qué pedidos tengo pendientes?"));
    const text = find(events, "done")!.text;
    expect(text).toContain("1 pedido pendiente de recibir (184,80 €), 1 con retraso y 1 borrador sin enviar.");
    expect(text).toContain("Distribuciones Canarias → Parador: enviado ⚠ con retraso");
    expect(text).toContain("Bebidas del Sur → Vivero: borrador sin enviar");
    expect(find(events, "navigate")).toMatchObject({ route: "/pedidos" });
  });

  it("gasto en compras por proveedor en el periodo, con gráfica", async () => {
    const jev = new FakeJev([{ intent: "consultar", intent_alt: "leer", herramienta: "query_spend", periodo: "mes" }]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("¿cuánto he gastado en compras este mes?"));
    const text = find(events, "done")!.text;
    expect(text).toMatch(/Compras del .+: 382,80 € en 3 albaranes\./);
    expect(text).toContain("Bebidas del Sur: 198,00 € (51,7 %)");
    expect(text).toContain("Distribuciones Canarias: 184,80 € (48,3 %)");
    expect(find(events, "chart")).toMatchObject({ id: "compras-proveedor", kind: "bar" });
  });
});
