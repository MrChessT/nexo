import { describe, expect, it } from "vitest";
import { Analytics } from "../analytics/analytics";
import { FixtureDataSource, fixtureContext, LOCATIONS } from "../dev/fixture";
import { chat, FakeJev, find, makeAgent, NOW, run } from "./helpers";

const ctx = fixtureContext();
const all = LOCATIONS.map((l) => l.id);
const [PARADOR, , VIVERO] = LOCATIONS;
const analytics = new Analytics(new FixtureDataSource(NOW));
const q = (over: Partial<Parameters<Analytics["view"]>[1]> = {}) => ({ ctx, locationIds: all, productIds: [], days: 7, now: NOW, ...over });

describe("analítica (decimal.js, cifras exactas)", () => {
  it("resumen: KPIs y tres gráficas", async () => {
    const r = await analytics.view("resumen", q());
    expect(r.kpis.map((k) => k.id)).toEqual(["valor_stock", "consumo", "mermas", "bajo_minimo"]);
    expect(r.kpis.find((k) => k.id === "bajo_minimo")!.value).toBe("4"); // el hielo del Vivero está justo en el mínimo
    expect(r.charts.map((c) => c.id)).toEqual(["consumo-diario", "stock-local", "mermas-producto"]);
  });

  it("consumo diario: una línea por local, un punto por día con su valor exacto", async () => {
    const chart = await analytics.dailyUsage(q({ locationIds: [PARADOR!.id, VIVERO!.id] }));
    expect(chart.kind).toBe("line");
    expect(chart.series.map((s) => s.name)).toEqual(["Parador", "Vivero"]);
    expect(chart.series[0]!.points).toHaveLength(7);
    // Vivero: 40 cocas/día a 0,55 € = 22,00 €
    const vivero = chart.series[1]!.points.find((p) => p.display === "22,00 €");
    expect(vivero?.value).toBe("22");
    expect(chart.series[0]!.points[0]!.label).toMatch(/^\d+ sep$/);
  });

  it("mermas por producto y desvíos (divergente)", async () => {
    const waste = await analytics.topProducts(q(), true);
    expect(waste.series[0]!.points[0]).toMatchObject({ label: "Ron Barceló Añejo 70 cl", display: "30,00 €" });
    const variance = await analytics.variance(q({ days: 30 }));
    expect(variance.kind).toBe("diverging");
    expect(variance.series[0]!.points[0]).toMatchObject({ label: "Ginebra Tanqueray 70 cl", value: "-34", display: "-34,00 €" });
  });

  it("cobertura con horizonte de referencia y variación de precios", async () => {
    const coverage = await analytics.coverage(q(), 5);
    expect(coverage.reference).toEqual({ value: "5", label: "Horizonte: 5 días" });
    expect(coverage.series[0]!.points.find((p) => p.label.startsWith("Coca-Cola 20 cl · Vivero"))?.display).toBe("1,2 días");
    const prices = await analytics.priceChanges(q({ days: 30 }));
    expect(prices.series[0]!.points[0]).toMatchObject({ value: "10", display: "10 %" });
  });

  it("no devuelve una gráfica de una sola barra al chat", async () => {
    const one = await analytics.chartForTool("query_stock", q({ locationIds: [PARADOR!.id], productIds: [ctx.products[0]!.id] }), 3);
    expect(one).toBeNull();
  });
});

describe("gráficas en el chat", () => {
  it("una consulta de reposición adjunta su gráfica y ofrece /informes con la vista", async () => {
    const jev = new FakeJev([{ intent: "pedir_sugerencias", intent_alt: "leer", herramienta: "query_reorder", periodo: "fin_de_semana" }, {}]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("¿qué me falta para el finde?"));
    expect(events.map((e) => e.event)).toEqual(["decision", "chart", "navigate", "text", "done"]);
    expect(find(events, "chart")).toMatchObject({ id: "cobertura", kind: "bar", reference: { value: "5" } });
    expect(find(events, "navigate")).toMatchObject({ route: "/informes", filters: { view: "reposicion" } });
  });

  it("«llévame a las gráficas de mermas» navega a /informes con la vista de mermas", async () => {
    const jev = new FakeJev([{ intent: "navegar", intent_alt: "leer", destino: "/informes", herramienta: "query_movements", periodo: "semana" }]);
    const { agent } = makeAgent(jev);
    const nav = find(await run(agent, chat("llévame a las gráficas de consumo de esta semana")), "navigate")!;
    expect(nav).toEqual({ route: "/informes", filters: { view: "consumo", days: 7 }, auto: true });
  });
});
