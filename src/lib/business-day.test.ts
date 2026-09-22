import { describe, expect, it } from "vitest";
import { businessDay } from "./business-day";

describe("businessDay", () => {
  it("assigns events before the cutoff to the previous business day", () => {
    expect(businessDay(new Date("2026-09-22T03:30:00Z"), "Europe/Madrid", "06:00")).toBe("2026-09-21");
    expect(businessDay(new Date("2026-09-22T05:30:00Z"), "Europe/Madrid", "06:00")).toBe("2026-09-22");
  });

  it("uses the location timezone across daylight saving time", () => {
    expect(businessDay(new Date("2026-03-29T03:30:00Z"), "Europe/Madrid", "06:00")).toBe("2026-03-28");
    expect(businessDay(new Date("2026-10-25T04:30:00Z"), "Europe/Madrid", "06:00")).toBe("2026-10-24");
  });
});
