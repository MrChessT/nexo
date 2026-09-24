import { describe, expect, it } from "vitest";
import { SUPPLIERS, LOCATIONS, PRODUCTS } from "../dev/fixture";
import {
  asksHardDelete,
  containerFromText,
  extractNewProductName,
  lastQuantity,
  mentionedPack,
  mentionedSupplier,
  minimumField,
  parseMoney,
  sizeFromText,
  unitWordFromText,
} from "../entities/catalog-parser";

const BARCELO = PRODUCTS[0]!;

describe("extracción para acciones de catálogo", () => {
  it.each([
    ["cambia el precio del Barceló a 15 €", "15"],
    ["el ron ahora cuesta 14,50€", "14.5"],
    ["pasa la caja de coca cola de 13,20 a 14 euros", "14"],
    ["sube el precio a €9", "9"],
    ["baja 2 botellas de ron", null],
  ])("precio: %s → %s", (message, expected) => {
    expect(parseMoney(message)).toBe(expected);
  });

  it.each([
    ["Añade Ginebra Nordés 70 cl a 18 €", "Ginebra Nordés 70 cl"],
    ["da de alta el producto Tónica Fever Tree 20 cl, caja de 24 a 21,60 € de Makro", "Tónica Fever Tree 20 cl"],
    ["crea un producto nuevo llamado Sirope de fresa Monin 1 l", "Sirope de fresa Monin 1 l"],
    ["añade «Hierbabuena fresca» en la categoría Fruta", "Hierbabuena fresca"],
    ["mete limas al catálogo", "Limas"],
    ["nuevo producto: servilletas de papel, pack de 100", "Servilletas de papel"],
    ["añade vermut Yzaguirre rojo de Makro", "Vermut Yzaguirre rojo"],
    ["cuánto ron queda", null],
  ])("nombre: %s → %s", (message, expected) => {
    expect(extractNewProductName(message, SUPPLIERS, LOCATIONS)).toBe(expected);
  });

  it("tamaño, contenedor y envase", () => {
    expect(sizeFromText("Ginebra Nordés 70 cl")).toMatchObject({ dimension: "volume", label: "70 cl" });
    expect(sizeFromText("Ginebra Nordés 70 cl")!.qtyBase.toString()).toBe("700");
    expect(sizeFromText("Café en grano 1 kg")!.qtyBase.toString()).toBe("1000");
    expect(sizeFromText("Limas")).toBeNull();
    expect(containerFromText("caja de 24 a 21 €")).toMatchObject({ word: "Caja" });
    expect(containerFromText("caja de 24")!.units.toString()).toBe("24");
    expect(unitWordFromText("cerveza en lata 33 cl")).toBe("Lata");
  });

  it("proveedor, formato, mínimo/objetivo y borrado", () => {
    expect(mentionedSupplier("el Barceló de Makro a 15 €", SUPPLIERS)?.name).toBe("Makro");
    expect(mentionedSupplier("en Distribuciones Canarias", SUPPLIERS)?.name).toBe("Distribuciones Canarias");
    expect(mentionedSupplier("el de canarias", SUPPLIERS)?.name).toBe("Distribuciones Canarias");
    expect(mentionedSupplier("el ron a 15 €", SUPPLIERS)).toBeNull();
    expect(mentionedPack("la caja de Barceló a 90 €", BARCELO)?.name).toBe("Caja 6 botellas");
    expect(mentionedPack("la botella a 15 €", BARCELO)?.name).toBe("Botella 70 cl");
    expect(mentionedPack("el Barceló a 15 €", BARCELO)).toBeNull();
    expect(minimumField("pon el mínimo del ron en 4 botellas")).toBe("min_qty");
    expect(minimumField("el objetivo de coca cola en 120")).toBe("par_qty");
    expect(lastQuantity("pon el mínimo de Barceló 70 cl en Parador a 6 botellas")).toEqual({ amount: "6", unit: "botella" });
    expect(asksHardDelete("elimina el ron brugal")).toBe(true);
    expect(asksHardDelete("archiva el ron brugal")).toBe(false);
  });
});

describe("comparación literal de nombres", () => {
  it("ignora mayúsculas, tildes, signos, espacios y la forma de escribir el tamaño", async () => {
    const { comparableName } = await import("../drafts/catalog-builder");
    expect(comparableName("Coca-Cola 20 cl")).toBe(comparableName("coca cola 0,2 l"));
    expect(comparableName("Coca-Cola 20 cl")).toBe(comparableName("COCACOLA 200ml"));
    expect(comparableName("Ginebra Bombay Sapphire 70 cl")).toBe(comparableName("ginebra bombay sapphire 70cl"));
    expect(comparableName("Café 1 kg")).toBe(comparableName("cafe 1000 g"));
    expect(comparableName("Coca-Cola 20 cl")).not.toBe(comparableName("Coca-Cola 33 cl"));
  });
});
