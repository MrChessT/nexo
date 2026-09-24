import { describe, expect, it } from "vitest";
import { DataError, userClient, type SupabaseSettings } from "../supabase/client";
import { SupabaseContext } from "../supabase/context";
import { SupabaseDataSource } from "../supabase/data-source";

const ORG = "00000000-0000-4000-8000-000000000001";
const USER = "11111111-0000-4000-8000-000000000001";
const LOC = "aaaaaaaa-0000-4000-8000-000000000001";
const JWT = "jwt-del-usuario";

interface Call {
  url: URL;
  headers: Headers;
  method: string;
}

/** fetch falso con respuestas por tabla de PostgREST. */
function fakeFetch(routes: Record<string, (url: URL, call: number) => unknown>, status = 200) {
  const calls: Call[] = [];
  const counters = new Map<string, number>();
  const fn = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    calls.push({ url, headers, method: init?.method ?? "GET" });
    const key = url.pathname.split("/").pop()!;
    const n = counters.get(key) ?? 0;
    counters.set(key, n + 1);
    const route = routes[key];
    if (!route) return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
    let body = route(url, n);
    if (headers.get("accept")?.includes("vnd.pgrst.object") && Array.isArray(body)) body = body[0] ?? null;
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fn, calls };
}

const settings = (f: typeof fetch): SupabaseSettings => ({ url: "https://proyecto.supabase.co", anonKey: "anon-key", fetch: f });

describe("fuente de datos Supabase (solo lectura, con el JWT del usuario)", () => {
  it("pide las cifras como texto y filtra por los locales accesibles", async () => {
    const { fn, calls } = fakeFetch({
      stock_balances: () => [{ location_id: LOC, product_id: "p1", qty: "2100.0000", avg_cost: "0.021429" }],
    });
    const source = new SupabaseDataSource(userClient(settings(fn), JWT));
    const rows = await source.balances({ locationIds: [LOC], productIds: ["p1"] });

    expect(rows).toEqual([{ locationId: LOC, productId: "p1", qty: "2100.0000", avgCost: "0.021429" }]);
    const call = calls[0]!;
    expect(call.method).toBe("GET");
    expect(call.url.searchParams.get("select")).toBe("location_id,product_id,qty:qty::text,avg_cost:avg_cost::text");
    expect(call.url.searchParams.get("location_id")).toBe(`in.(${LOC})`);
    expect(call.headers.get("authorization")).toBe(`Bearer ${JWT}`);
    expect(call.headers.get("apikey")).toBe("anon-key");
  });

  it("pagina los movimientos de 1000 en 1000", async () => {
    const row = { location_id: LOC, product_id: "p1", area_id: null, type: "consumption", qty: "-1", unit_cost: "0.5", occurred_at: "2026-09-20T10:00:00Z" };
    const { fn, calls } = fakeFetch({ stock_movements: (_url, n) => Array.from({ length: n === 0 ? 1000 : 3 }, () => row) });
    const rows = await new SupabaseDataSource(userClient(settings(fn), JWT)).movements({ locationIds: [LOC], since: "2026-09-01T00:00:00Z" });
    expect(rows).toHaveLength(1003);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.headers.get("range") ?? calls[1]!.url.searchParams.get("offset")).toBeTruthy();
    expect(rows[0]).toEqual({ locationId: LOC, productId: "p1", areaId: null, type: "consumption", qty: "-1", unitCost: "0.5", occurredAt: "2026-09-20T10:00:00Z" });
  });

  it("traspasos: busca por origen o destino y lee las líneas", async () => {
    const { fn, calls } = fakeFetch({
      transfers: () => [
        { id: "t1", from_location_id: LOC, to_location_id: "otro", status: "in_transit", sent_at: "2026-09-20T10:00:00Z", lines: [{ product_id: "p1", qty_sent: "48.0000", unit_cost: null }] },
      ],
    });
    const rows = await new SupabaseDataSource(userClient(settings(fn), JWT)).transfers({ locationIds: [LOC], status: ["in_transit"] });
    expect(rows[0]!.lines).toEqual([{ productId: "p1", qtySent: "48.0000", unitCost: null }]);
    expect(calls[0]!.url.searchParams.get("or")).toBe(`(from_location_id.in.(${LOC}),to_location_id.in.(${LOC}))`);
  });

  it("un error de PostgREST se convierte en DataError", async () => {
    const { fn } = fakeFetch({ stock_balances: () => ({ message: "permission denied", code: "42501" }) }, 401);
    await expect(new SupabaseDataSource(userClient(settings(fn), JWT)).balances({ locationIds: [LOC] })).rejects.toBeInstanceOf(DataError);
  });
});

describe("contexto y autenticación con Supabase", () => {
  it("carga rol, locales, espacios y catálogo con formatos", async () => {
    const { fn } = fakeFetch({
      memberships: () => [{ role: "staff" }],
      locations: () => [{ id: LOC, name: "Parador", timezone: "Europe/Madrid", day_cutoff: "06:00:00" }],
      storage_areas: () => [{ id: "a1", location_id: LOC, name: "Barra 1" }],
      products: () => [
        {
          id: "p1",
          name: "Ron Barceló Añejo 70 cl",
          dimension: "volume",
          category: { name: "Destilados" },
          packs: [
            { id: "k1", name: "Botella 70 cl", qty_base: "700.0000", is_count_default: true, is_purchase_default: false, active: true },
            { id: "k2", name: "Formato retirado", qty_base: "1000.0000", is_count_default: false, is_purchase_default: false, active: false },
          ],
        },
      ],
    });
    const ctx = await new SupabaseContext(settings(fn)).load({ userId: USER, token: JWT }, ORG);
    expect(ctx.role).toBe("staff");
    expect(ctx.locations).toEqual([{ id: LOC, name: "Parador", timezone: "Europe/Madrid", dayCutoff: "06:00" }]);
    expect(ctx.areas).toEqual([{ id: "a1", locationId: LOC, name: "Barra 1" }]);
    expect(ctx.products[0]).toMatchObject({ baseUnit: "ml", category: "Destilados", packs: [{ id: "k1", qtyBase: "700.0000", isCountDefault: true }] });
    expect(ctx.catalogHash).toMatch(/^[0-9a-f]{16}$/);
  });

  it("sin pertenencia a la organización → forbidden", async () => {
    const { fn } = fakeFetch({ memberships: () => [] });
    await expect(new SupabaseContext(settings(fn)).load({ userId: USER, token: JWT }, ORG)).rejects.toMatchObject({ code: "forbidden" });
  });

});

describe("auditoría en copilot_audit", () => {
  it("convierte cada evento en una fila con el usuario y la organización", async () => {
    const { auditRow } = await import("../supabase/audit-sink");
    expect(
      auditRow({ type: "mensaje", at: "x", userId: USER, orgId: ORG, sessionId: "s", messageId: "m", message: "a".repeat(600), intent: "consultar", decisions: [], outcome: "consulta", jevModel: "typesafe-ai/jev", catalogVersion: "v", shortcut: false }),
    ).toMatchObject({ org_id: ORG, user_id: USER, kind: "mensaje", intent: "consultar", outcome: "consulta", detail: { message: "a".repeat(500), jev_model: "typesafe-ai/jev" } });
    expect(auditRow({ type: "confirmacion", at: "x", userId: USER, orgId: ORG, draftId: "d", kind: "merma", ok: false, code: "forbidden" })).toMatchObject({ kind: "confirmacion", draft_id: "d", outcome: "forbidden" });
  });
});
