import { describe, expect, it } from "vitest";
import { daysAgo, decimalText, euros, normalizeText, parseDecimal, quantity } from "./format";

describe("formato es-ES con decimal.js", () => {
  it("euros con miles y dos decimales", () => {
    expect(euros(1234.5)).toBe("1.234,50 €");
    expect(euros("92.4")).toBe("92,40 €");
    expect(euros(null)).toBe("0,00 €");
    expect(euros(-28)).toBe("-28,00 €");
  });

  it("cantidades legibles en l y kg", () => {
    expect(quantity(2100, "ml")).toBe("2,1 l");
    expect(quantity("350", "g")).toBe("350 g");
    expect(quantity(1500, "g")).toBe("1,5 kg");
    expect(quantity(24, "ud")).toBe("24 ud");
    expect(quantity(-1400, "ml")).toBe("-1,4 l");
  });

  it("decimales sin ceros sobrantes, o fijos", () => {
    expect(decimalText("1.50")).toBe("1,5");
    expect(decimalText("1.5", 2, true)).toBe("1,50");
    expect(decimalText("1234567")).toBe("1.234.567");
  });

  it("lee lo que escribe el usuario con coma o punto", () => {
    expect(parseDecimal("1,5")?.toString()).toBe("1.5");
    expect(parseDecimal(" 12.50 ")?.toString()).toBe("12.5");
    expect(parseDecimal("-3")).toBeNull();
    expect(parseDecimal("abc")).toBeNull();
    expect(parseDecimal("")).toBeNull();
  });

  it("texto comparable y días transcurridos", () => {
    expect(normalizeText("Limón ÁCIDO")).toBe("limon acido");
    const now = new Date("2026-09-24T12:00:00Z");
    expect(daysAgo("2026-09-24T08:00:00Z", now)).toBe("hoy");
    expect(daysAgo("2026-09-23T08:00:00Z", now)).toBe("ayer");
    expect(daysAgo("2026-09-19T12:00:00Z", now)).toBe("hace 5 días");
  });
});

describe("valores para campos editables", () => {
  it("sin separador de miles, para poder volver a leerlos", async () => {
    const { inputText, parseDecimal } = await import("./format");
    expect(inputText("1234.5")).toBe("1234,5");
    expect(parseDecimal(inputText("1234.5"))?.toString()).toBe("1234.5");
    expect(inputText("92.40")).toBe("92,4");
  });
});
