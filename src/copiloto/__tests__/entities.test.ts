import { describe, expect, it } from "vitest";
import { PRODUCTS } from "../dev/fixture";
import { parseNumber, parseQuantities } from "../entities/quantity-parser";
import { LexicalRetriever } from "../entities/retriever";
import { formatBase, formatDecimal, toBase } from "../entities/units";

const byName = (fragment: string) => PRODUCTS.find((p) => p.name.includes(fragment))!;

describe("parser de cantidades", () => {
  it("separa cantidad, unidad y producto sin confundir el número de barra", () => {
    expect(parseQuantities("baja 2 botellas de ron rotas en barra 1")).toEqual([
      { text: "2 botellas de ron", amount: "2", unit: "botella", productText: "ron", price: null },
    ]);
  });

  it("detecta varios productos en un traspaso", () => {
    const segments = parseQuantities("pasa 6 cocas y 2 botellas de ginebra al Vivero");
    expect(segments.map((s) => [s.amount, s.unit, s.productText])).toEqual([
      ["6", null, "cocas"],
      ["2", "botella", "ginebra"],
    ]);
  });

  it("usa coma decimal y convierte palabras-número", () => {
    expect(parseQuantities("1,5 kg de limones")[0]).toMatchObject({ amount: "1.5", unit: "kg", productText: "limones" });
    expect(parseQuantities("dos cajas y media de tónica")[0]).toMatchObject({ amount: "2.5", unit: "caja", productText: "tónica" });
    expect(parseQuantities("una docena de limones")[0]).toMatchObject({ amount: "12", unit: "ud" });
    expect(parseQuantities("un par de cocas")[0]).toMatchObject({ amount: "2", productText: "cocas" });
  });

  it("interpreta el punto de miles y las fracciones", () => {
    expect(parseQuantities("1.500 g de hielo")[0]).toMatchObject({ amount: "1500", unit: "g" });
    expect(parseNumber("1/2")?.toString()).toBe("0.5");
    expect(parseNumber("0,1")?.plus("0.2").toString()).toBe("0.3");
  });

  it("mantiene el tamaño dentro del nombre del producto", () => {
    expect(parseQuantities("6 coca cola 20 cl")).toEqual([
      { text: "6 coca cola 20 cl", amount: "6", unit: null, productText: "coca cola 20 cl", price: null },
    ]);
  });

  it("no toma artículos ni números de identificación como cantidades", () => {
    expect(parseQuantities("¿cuánto ron queda en barra 1?")).toEqual([]);
    expect(parseQuantities("haz un traspaso de 6 cocas")).toHaveLength(1);
    expect(parseQuantities("tengo una pregunta")).toEqual([]);
  });

  it("extrae el precio de una recepción", () => {
    expect(parseQuantities("han llegado 3 cajas de coca a 12,50 €")[0]).toMatchObject({ amount: "3", unit: "caja", price: "12.5" });
  });
});

describe("conversión a unidad base", () => {
  it("convierte formatos con decimal.js", () => {
    const rum = byName("Barceló");
    const r = toBase("2", "botella", rum);
    expect(r.ok && r.qtyBase.toString()).toBe("1400");
    expect(r.ok && r.pack?.name).toBe("Botella 70 cl");
    const box = toBase("1.5", "caja", rum);
    expect(box.ok && box.qtyBase.toString()).toBe("6300");
  });

  it("convierte unidades métricas y rechaza dimensiones incompatibles", () => {
    expect(toBase("1.5", "kg", byName("Limones"))).toMatchObject({ ok: true });
    const lemons = toBase("1.5", "kg", byName("Limones"));
    expect(lemons.ok && lemons.qtyBase.toString()).toBe("1500");
    const cl = toBase("3", "cl", byName("Barceló"));
    expect(cl.ok && cl.qtyBase.toString()).toBe("30");
    expect(toBase("2", "kg", byName("Barceló"))).toEqual({ ok: false, reason: "incompatible" });
    expect(toBase("0", "ud", byName("Coca-Cola"))).toEqual({ ok: false, reason: "invalid_amount" });
  });

  it("marca como supuesto el formato por defecto", () => {
    const r = toBase("2", null, byName("Barceló"));
    expect(r).toMatchObject({ ok: true, assumed: true });
    expect(r.ok && r.qtyBase.toString()).toBe("1400");
    const cocas = toBase("24", null, byName("Coca-Cola"));
    expect(cocas.ok && cocas.qtyBase.toString()).toBe("24");
  });

  it("formatea en es-ES sin pasar por number", () => {
    expect(formatDecimal("1234567.891")).toBe("1.234.567,89");
    expect(formatBase("1400", "ml")).toBe("1,4 l");
    expect(formatBase("-2000", "g")).toBe("-2 kg");
    expect(formatBase("48", "ud")).toBe("48 ud");
  });
});

describe("recuperación léxica", () => {
  it("encuentra productos con plurales, abreviaturas y sin acentos", async () => {
    const r = new LexicalRetriever();
    expect((await r.retrieve(PRODUCTS, "cocas", 3))[0]?.product.name).toBe("Coca-Cola 20 cl");
    expect((await r.retrieve(PRODUCTS, "tonica", 3))[0]?.product.name).toBe("Tónica Schweppes 20 cl");
    const rums = await r.retrieve(PRODUCTS, "ron", 5);
    expect(rums.map((c) => c.product.name).slice(0, 2).sort()).toEqual(["Ron Barceló Añejo 70 cl", "Ron Brugal Añejo 70 cl"]);
    expect(await r.retrieve(PRODUCTS, "cuánto stock hay", 5)).toEqual([]);
  });
});

describe("texto con tildes descompuestas (NFD)", () => {
  it("no corta las palabras", () => {
    const nfd = "baja 2 botellas de barceló rotas".normalize("NFD");
    expect(parseQuantities(nfd)[0]).toMatchObject({ text: "2 botellas de barceló", productText: "barceló" });
  });
});
