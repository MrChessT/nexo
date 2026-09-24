import { describe, expect, it } from "vitest";
import { memoizeSource } from "../supabase/memo-source";
import type { InventoryDataSource } from "../tools/types";

function countingSource() {
  const calls: string[] = [];
  let fail = false;
  const source = {
    balances: async (filter: { locationIds: string[] }) => {
      calls.push(`balances:${filter.locationIds.join(",")}`);
      if (fail) throw new Error("caída");
      return [{ locationId: filter.locationIds[0]!, productId: "p1", qty: "1", avgCost: "2" }];
    },
  } as unknown as InventoryDataSource;
  return { source, calls, setFail: (v: boolean) => (fail = v) };
}

describe("memoizeSource (caché de lecturas dentro de una petición)", () => {
  it("una lectura idéntica, también simultánea, se hace una sola vez", async () => {
    const { source, calls } = countingSource();
    const memo = memoizeSource(source);
    const [a, b] = await Promise.all([memo.balances({ locationIds: ["L1"] }), memo.balances({ locationIds: ["L1"] })]);
    await memo.balances({ locationIds: ["L1"], productIds: undefined });
    expect(a).toBe(b);
    expect(calls).toEqual(["balances:L1"]);
  });

  it("argumentos distintos consultan por separado", async () => {
    const { source, calls } = countingSource();
    const memo = memoizeSource(source);
    await memo.balances({ locationIds: ["L1"] });
    await memo.balances({ locationIds: ["L2"] });
    expect(calls).toEqual(["balances:L1", "balances:L2"]);
  });

  it("un error no se queda en caché", async () => {
    const { source, calls, setFail } = countingSource();
    const memo = memoizeSource(source);
    setFail(true);
    await expect(memo.balances({ locationIds: ["L1"] })).rejects.toThrow("caída");
    setFail(false);
    await expect(memo.balances({ locationIds: ["L1"] })).resolves.toHaveLength(1);
    expect(calls).toHaveLength(2);
  });
});
