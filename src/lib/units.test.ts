import { describe, expect, it } from "vitest";
import Decimal from "decimal.js";
import { baseToPacks, formatQuantity, openBottleFromWeight, packsToBase } from "./units";

describe("units", () => {
  const bottle = { name: "botellas", qtyBase: "700" };

  it("converts packs to base units without floating point loss", () => {
    expect(packsToBase("6", bottle).toString()).toBe("4200");
    expect(baseToPacks("4200", bottle).toString()).toBe("6");
  });

  it("formats full packs and remainder", () => {
    expect(formatQuantity("8750", "volume", bottle)).toBe("12 botellas + 350 ml");
  });

  it("clamps open bottle weight to the valid range", () => {
    expect(openBottleFromWeight("840", "1180", "500", "700").toString()).toBe("350");
    expect(openBottleFromWeight("400", "1180", "500", "700").toString()).toBe("0");
    expect(openBottleFromWeight("840", "1180", "500", "700").lessThanOrEqualTo(new Decimal("700"))).toBe(true);
  });
});
