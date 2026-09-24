import { describe, expect, it } from "vitest";
import { FixtureDataSource, fixtureContext, LOCATIONS, PRODUCTS } from "../dev/fixture";
import { horizon, pastPeriod } from "../tools/periods";
import { InventoryTools } from "../tools/tools";
import type { ToolParams } from "../tools/types";
import { NOW } from "./helpers";

const tools = new InventoryTools(new FixtureDataSource(NOW));
const ctx = fixtureContext();
const all = LOCATIONS.map((l) => l.id);
const base: ToolParams = { locationIds: all, areaId: null, productIds: [], period: null, horizonDays: 3, horizonLabel: "3 días", now: NOW };

describe("herramientas (solo lectura, decimal.js)", () => {
  it("stock: valor y bajo mínimo exactos", async () => {
    const r = await tools.run("query_stock", { ...base, locationIds: [LOCATIONS[0]!.id] }, ctx);
    const rum = r.rows.find((row) => row.producto === "Ron Barceló Añejo 70 cl")!;
    // 2100 ml × 0,021429 €/ml = 45,0009 €
    expect(rum).toMatchObject({ cantidad: "2,1 l", valor: "45,00 €", minimo: "2,8 l", bajo_minimo: true });
    expect(r.rows[0]!.bajo_minimo).toBe(true);
  });

  it("stock por espacio usa stock_area_balances", async () => {
    const r = await tools.run("query_stock", { ...base, areaId: ctx.areas[0]!.id }, ctx);
    expect(r.rows.map((row) => [row.producto, row.espacio, row.cantidad])).toEqual([
      ["Ron Barceló Añejo 70 cl", "Barra 1", "1,4 l"],
      ["Coca-Cola 20 cl", "Barra 1", "30 ud"],
    ]);
  });

  it("movimientos agrupados por tipo y producto dentro del periodo de negocio", async () => {
    const period = pastPeriod("semana", "2026-09-23", "", "semana");
    const r = await tools.run("query_movements", { ...base, period }, ctx);
    const waste = r.rows.find((row) => row.tipo === "merma" && row.producto === "Ron Barceló Añejo 70 cl");
    expect(waste).toMatchObject({ cantidad: "1,4 l", valor: "30,00 €" });
  });

  it("precios: subida porcentual calculada en código", async () => {
    const r = await tools.run("query_prices", base, ctx);
    expect(r.evalItems).toHaveLength(1);
    expect(r.evalItems[0]!.data).toMatchObject({ old_price: "84,00 €", new_price: "92,40 €", change_pct: "10 %" });
  });

  it("desvíos de inventario ordenados por valor", async () => {
    const r = await tools.run("query_count_variance", base, ctx);
    expect(r.evalItems[0]!.data).toMatchObject({ product: "Ginebra Tanqueray 70 cl", diff: "-1,4 l", diff_pct: "-50 %", diff_value: "-34,00 €" });
  });

  it("traspasos en tránsito con antigüedad y valor", async () => {
    const r = await tools.run("query_pending_transfers", base, ctx);
    expect(r.rows[0]).toMatchObject({ origen: "Parador", destino: "Vivero", enviado_hace: "3 días", valor: "56,40 €" });
  });

  it("horizonte del fin de semana desde un miércoles", () => {
    expect(horizon("fin_de_semana", "2026-09-23")).toEqual({ days: 5, label: "el fin de semana" });
    expect(pastPeriod("personalizado", "2026-09-23", "del 1 al 15", "semana")).toMatchObject({ from: "2026-09-01", to: "2026-09-15" });
    expect(PRODUCTS.length).toBeGreaterThan(0);
  });
});
