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
    expect(rum).toMatchObject({ cantidad: "3 botellas", valor: "45,00 €", minimo: "4 botellas", bajo_minimo: true });
    expect(r.rows[0]!.bajo_minimo).toBe(true);
  });

  it("stock por espacio usa stock_area_balances", async () => {
    const r = await tools.run("query_stock", { ...base, areaId: ctx.areas[0]!.id }, ctx);
    expect(r.rows.map((row) => [row.producto, row.espacio, row.cantidad])).toEqual([
      ["Ron Barceló Añejo 70 cl", "Barra 1", "2 botellas"],
      ["Coca-Cola 20 cl", "Barra 1", "1 caja + 6 ud"],
    ]);
  });

  it("varios locales: una fila por producto con el total y el reparto por local", async () => {
    const r = await tools.run("query_stock", { ...base, productIds: [PRODUCTS[0]!.id] }, ctx);
    expect(r.totals.desglose).toBe("local");
    expect(r.rows).toEqual([
      expect.objectContaining({ producto: "Ron Barceló Añejo 70 cl", cantidad: "4 botellas", desglose: "Parador 3 botellas ⚠ · Pickels 1 botella", bajo_minimo: true }),
    ]);
  });

  it("por secciones: el stock de cada espacio de los locales consultados", async () => {
    const r = await tools.run("query_stock", { ...base, locationIds: [LOCATIONS[0]!.id], byArea: true }, ctx);
    expect(r.totals.desglose).toBe("espacio");
    expect(new Set(r.rows.map((row) => row.espacio))).toContain("Barra 1");
    expect(r.rows.every((row) => row.local === "Parador")).toBe(true);
  });

  it("movimientos agrupados por tipo y producto dentro del periodo de negocio", async () => {
    const period = pastPeriod("semana", "2026-09-23", "", "semana");
    const r = await tools.run("query_movements", { ...base, period }, ctx);
    const waste = r.rows.find((row) => row.tipo === "merma" && row.producto === "Ron Barceló Añejo 70 cl");
    expect(waste).toMatchObject({ cantidad: "2 botellas", valor: "30,00 €" });
  });

  it("precios: subida porcentual calculada en código", async () => {
    const r = await tools.run("query_prices", base, ctx);
    expect(r.evalItems).toHaveLength(1);
    expect(r.evalItems[0]!.data).toMatchObject({ old_price: "84,00 €", new_price: "92,40 €", change_pct: "10 %" });
  });

  it("precios de un producto concreto: el último conocido aunque sea anterior al periodo", async () => {
    const tonic = PRODUCTS[4]!;
    const period = pastPeriod("hoy", "2026-09-23", "", "semana");
    const general = await tools.run("query_prices", { ...base, period }, ctx);
    expect(general.rows).toHaveLength(0);
    const r = await tools.run("query_prices", { ...base, period, productIds: [tonic.id] }, ctx);
    expect(r.rows).toEqual([expect.objectContaining({ producto: tonic.name, precio_actual: "11,52 €", proveedor: "Bebidas del Sur" })]);
    // Las subidas antiguas no se valoran como si fueran de hoy.
    const rum = await tools.run("query_prices", { ...base, period, productIds: [PRODUCTS[0]!.id] }, ctx);
    expect(rum.rows[0]).toMatchObject({ precio_actual: "92,40 €", precio_anterior: "84,00 €" });
    expect(rum.evalItems).toHaveLength(0);
  });

  it("desvíos de inventario ordenados por valor", async () => {
    const r = await tools.run("query_count_variance", base, ctx);
    expect(r.evalItems[0]!.data).toMatchObject({ product: "Ginebra Tanqueray 70 cl", diff: "-2 botellas", diff_pct: "-50 %", diff_value: "-34,00 €" });
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

describe("reposición con pedidos abiertos", () => {
  it("lo ya pedido y no recibido cuenta como en camino y reduce lo sugerido", async () => {
    const { computeReorder } = await import("../tools/tools");
    const vivero = LOCATIONS[2]!.id;
    const coca = PRODUCTS[3]!;
    const params = { ...base, locationIds: [vivero], horizonDays: 3 };

    const without = new FixtureDataSource(NOW);
    const before = (await computeReorder(without, params, ctx)).find((l) => l.product.id === coca.id)!;

    const withOrder = new FixtureDataSource(NOW);
    withOrder.openOrderLines = [{ locationId: vivero, productId: coca.id, qtyBase: "48" }];
    const after = (await computeReorder(withOrder, params, ctx)).find((l) => l.product.id === coca.id)!;

    // Ya había 48 en camino por un traspaso; el pedido suma otros 48.
    expect(after.pendingIn.minus(before.pendingIn).toString()).toBe("48");
    expect(before.suggested.minus(after.suggested).toString()).toBe("48");
  });
});
