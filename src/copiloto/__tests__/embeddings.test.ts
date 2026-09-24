import { describe, expect, it } from "vitest";
import { PRODUCTS } from "../dev/fixture";
import { HybridRetriever, productDocument, type EmbeddingProvider } from "../entities/embeddings";
import { Metrics } from "../metrics/metrics";

/** Embeddings falsos por "conceptos": cada dimensión es un concepto con sus palabras clave. */
const CONCEPTS: string[][] = [
  ["ron", "cubata", "mojito"],
  ["coca", "cola", "refresco"],
  ["agua", "solan"],
  ["hielo", "cubitos"],
  ["cerveza", "caña", "mahou", "barril"],
  ["ginebra", "gin", "tanqueray"],
  ["limon", "limones", "fruta"],
  ["tonica", "schweppes"],
];

class FakeEmbeddings implements EmbeddingProvider {
  readonly name = "fake";
  readonly model = "fake-embed";
  calls = 0;
  fail = false;

  async embed(texts: string[]): Promise<number[][]> {
    this.calls += 1;
    if (this.fail) throw new Error("caído");
    return texts.map((t) => {
      const text = t.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
      return [...CONCEPTS.map((words): number => (words.some((w) => text.includes(w)) ? 1 : 0)), 0.05];
    });
  }

  async ping() {
    return !this.fail;
  }
}

describe("recuperación híbrida", () => {
  it("encuentra productos por significado aunque no compartan palabras", async () => {
    const embed = new FakeEmbeddings();
    const r = new HybridRetriever(embed, new Metrics("0.042"));
    const found = await r.retrieve(PRODUCTS, "algo para los cubatas", 5, "h1");
    expect(found.slice(0, 2).map((c) => c.product.name).sort()).toEqual(["Ron Barceló Añejo 70 cl", "Ron Brugal Añejo 70 cl"]);
    expect(found.map((c) => c.product.name)).not.toContain("Hielo en cubitos");
  });

  it("combina con la coincidencia léxica para desempatar marcas", async () => {
    const r = new HybridRetriever(new FakeEmbeddings(), new Metrics("0.042"));
    const found = await r.retrieve(PRODUCTS, "ron brugal", 5, "h1");
    expect(found[0]!.product.name).toBe("Ron Brugal Añejo 70 cl");
  });

  it("calcula los embeddings del catálogo una vez por huella y los recalcula si cambia", async () => {
    const embed = new FakeEmbeddings();
    const metrics = new Metrics("0.042");
    const r = new HybridRetriever(embed, metrics);
    await r.retrieve(PRODUCTS, "ron", 5, "h1");
    const afterFirst = embed.calls; // catálogo + consulta
    await r.retrieve(PRODUCTS, "ron", 5, "h1");
    expect(embed.calls).toBe(afterFirst);
    expect(metrics.embedCacheHits).toBe(2);
    await r.retrieve(PRODUCTS, "ron", 5, "h2");
    expect(embed.calls).toBe(afterFirst + 1);
  });

  it("si el proveedor cae, sigue con la búsqueda léxica", async () => {
    const embed = new FakeEmbeddings();
    embed.fail = true;
    const r = new HybridRetriever(embed, new Metrics("0.042"));
    const found = await r.retrieve(PRODUCTS, "cocas", 3, "h1");
    expect(found[0]!.product.name).toBe("Coca-Cola 20 cl");
    expect(r.lastError).toBe("caído");
    expect(await r.retrieve(PRODUCTS, "algo para los cubatas", 3, "h1")).toEqual([]);
  });

  it("describe cada producto con categoría y formatos", () => {
    expect(productDocument(PRODUCTS[0]!)).toBe("Ron Barceló Añejo 70 cl. Categoría: Destilados. Formatos: Botella 70 cl, Caja 6 botellas.");
  });
});
