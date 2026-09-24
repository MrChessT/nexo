import { describe, expect, it } from "vitest";
import { LruCache } from "../cache/lru";
import { cachedSource, invalidateBusinessCache } from "../supabase/business-cache";
import type { InventoryDataSource } from "../tools/types";

function counting() {
  const calls: string[] = [];
  const source = new Proxy({} as InventoryDataSource, {
    get: (_t, name: string) => async () => {
      calls.push(name);
      return [];
    },
  });
  return { source, calls };
}

describe("caché del negocio entre mensajes", () => {
  it("los históricos se reutilizan entre peticiones; el stock siempre se lee al momento", async () => {
    const { source, calls } = counting();
    const cache = new LruCache<Promise<unknown>>(100, 60_000);
    const scope = { orgId: "org-cache-1", userId: "u1" };
    for (let i = 0; i < 3; i += 1) {
      const s = cachedSource(source, scope, cache); // una por petición, como en producción
      await s.movements({ locationIds: ["l1"], since: "2026-09-01" });
      await s.balances({ locationIds: ["l1"] });
    }
    expect(calls.filter((c) => c === "movements")).toHaveLength(1);
    expect(calls.filter((c) => c === "balances")).toHaveLength(3);
  });

  it("cada usuario tiene lo suyo (RLS) y una escritura confirmada invalida la organización", async () => {
    const { source, calls } = counting();
    const cache = new LruCache<Promise<unknown>>(100, 60_000);
    const args = { locationIds: ["l1"], since: "2026-09-01" };
    await cachedSource(source, { orgId: "org-cache-2", userId: "u1" }, cache).movements(args);
    await cachedSource(source, { orgId: "org-cache-2", userId: "u2" }, cache).movements(args);
    expect(calls).toHaveLength(2);
    invalidateBusinessCache("org-cache-2");
    await cachedSource(source, { orgId: "org-cache-2", userId: "u1" }, cache).movements(args);
    expect(calls).toHaveLength(3);
  });
});
