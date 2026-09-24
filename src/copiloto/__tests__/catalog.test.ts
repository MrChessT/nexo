import { describe, expect, it } from "vitest";
import type { ArchiveDraft, Draft, MinimumDraft, NewProductDraft, PriceDraft } from "../contract/index";
import { FixtureWriter } from "../dev/fixture-writer";
import { fixtureContext, LOCATIONS, ORG_ID, PRODUCTS, SUPPLIERS, CATEGORIES } from "../dev/fixture";
import { ConfirmService } from "../drafts/confirm";
import { chat, FakeJev, find, makeAgent, NOW, run, type Script } from "./helpers";

const [PARADOR] = LOCATIONS;
const BARCELO = PRODUCTS[0]!;
const BRUGAL = PRODUCTS[1]!;
const MAKRO = SUPPLIERS[2]!;
const key = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

const route = (tipo: string, extra: Script = {}): Script => ({ intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: tipo, ...extra });

async function confirmDraft(draft: Draft, drafts: ReturnType<typeof makeAgent>["drafts"], edits?: Record<string, string | boolean | null>, n = 1) {
  const writer = new FixtureWriter();
  const service = new ConfirmService(drafts, makeAgent(new FakeJev()).audit, () => NOW);
  const result = await service.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(n), ...(edits ? { edits } : {}) }, fixtureContext(), writer);
  return { result, writer };
}

describe("cambiar precio desde el chat", () => {
  it("formato nombrado, proveedor único, variación y plausibilidad en la misma llamada nº 2", async () => {
    const jev = new FakeJev([route("cambiar_precio", { producto_0: BARCELO.name }), { coherencia: 0.95, precio_plausible: 0.9 }]);
    const { agent, drafts } = makeAgent(jev);
    const events = await run(agent, chat("cambia el precio de la caja de Barceló a 96 €"));

    const draft = find(events, "draft") as PriceDraft;
    expect(draft).toMatchObject({
      kind: "precio",
      productName: BARCELO.name,
      packName: "Caja 6 botellas",
      supplierName: "Distribuciones Canarias",
      oldPrice: "92.4",
      newPrice: "96",
      unitCost: "0,0229 €/ml",
      requiredRole: "manager",
      canConfirm: true,
    });
    expect(draft.checks!.map((c) => [c.id, c.status])).toEqual([
      ["variacion", "ok"],
      ["plausible", "ok"],
    ]);
    expect(draft.checks![0]!.detail).toContain("+3,9 %");
    // Una sola llamada de revisión: coherencia + plausibilidad, con el cambio en el state.
    expect(jev.calls).toHaveLength(2);
    expect(Object.keys(jev.calls[1]!.questions).sort()).toEqual(["coherencia", "precio_plausible"]);
    expect(jev.calls[1]!.state).toMatchObject({ change: { old_price: "92,40 €", new_price: "96,00 €", change_pct: "+3,9 %" } });

    const { result, writer } = await confirmDraft(draft, drafts);
    expect(result).toMatchObject({ ok: true, kind: "precio", navigate: { route: "/productos", filters: { productId: BARCELO.id } } });
    expect(writer.calls).toEqual([{ method: "setSupplierPrice", args: { supplierId: SUPPLIERS[0]!.id, packId: BARCELO.packs[1]!.id, price: "96" } }]);
  });

  it("una cifra de más: el código y Jev lo marcan y hay que marcar «revisado» para confirmar", async () => {
    const jev = new FakeJev([route("cambiar_precio", { producto_0: BARCELO.name }), { coherencia: 0.9, precio_plausible: 0.08 }]);
    const { agent, drafts } = makeAgent(jev);
    const draft = find(await run(agent, chat("el Barceló ahora cuesta 924 €")), "draft") as PriceDraft;
    expect(draft.checks!.filter((c) => c.status === "revisar").map((c) => c.id)).toEqual(["variacion", "plausible"]);
    expect(draft.checks![0]!.detail).toContain("¿Falta o sobra una cifra?");

    const blocked = await confirmDraft(draft, drafts);
    expect(blocked.result).toMatchObject({ ok: false, code: "invalid_edit" });
    expect(blocked.writer.calls).toHaveLength(0);
    // Corregido en la tarjeta (y marcado como revisado): se guarda el precio corregido.
    const fixed = await confirmDraft(draft, drafts, { newPrice: "92.4", acknowledged: true }, 2);
    expect(fixed.result).toMatchObject({ ok: false, code: "invalid_edit", message: "El precio nuevo es igual al actual" });
    const ok = await confirmDraft(draft, drafts, { newPrice: "94.5", acknowledged: true }, 3);
    expect(ok.result).toMatchObject({ ok: true });
    expect(ok.writer.calls[0]).toMatchObject({ args: { price: "94.5" } });
  });

  it("sin precio anterior ni proveedor claro: pregunta el proveedor y lo reutiliza", async () => {
    const tanqueray = PRODUCTS[2]!;
    const jev = new FakeJev([route("cambiar_precio", { producto_0: tanqueray.name }), { coherencia: 0.9, precio_plausible: 0.8 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("la tanqueray a 16,50 €")), "clarify")!;
    expect(clarify.field).toBe("proveedor");
    expect(clarify.options.map((o) => o.label)).toEqual(SUPPLIERS.map((s) => s.name));

    const events = await run(agent, chat("Makro", { clarification: { clarifyId: clarify.clarifyId, optionId: MAKRO.id } }));
    const draft = find(events, "draft") as PriceDraft;
    expect(draft).toMatchObject({ supplierName: "Makro", oldPrice: null, newPrice: "16.5", packName: "Caja 6 botellas" });
    expect(draft.checks![0]).toMatchObject({ status: "aviso", detail: "Primer precio registrado para Caja 6 botellas." });
  });

  it("precio igual al actual: no propone nada", async () => {
    const jev = new FakeJev([route("cambiar_precio", { producto_0: BARCELO.name })]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("pon el Barceló a 92,40 €"));
    expect(find(events, "draft")).toBeUndefined();
    expect(find(events, "done")!.text).toContain("ya cuesta 92,40 €");
  });
});

describe("dar de alta un producto desde el chat", () => {
  const NEW_OK: Script = { coherencia: 0.95, tiene_sentido: 0.97, categoria: "Destilados", medida: "volume", precio_plausible: 0.9 };

  it("extrae nombre, tamaño, formato, precio y proveedor; Jev pone categoría y descarta duplicados", async () => {
    const jev = new FakeJev([route("nuevo_producto", { local: "Parador" }), NEW_OK]);
    const { agent, drafts } = makeAgent(jev);
    const events = await run(agent, chat("añade Ginebra Nordés 70 cl a 18 € de Makro en Parador"));

    const draft = find(events, "draft") as NewProductDraft;
    expect(draft).toMatchObject({
      kind: "producto_nuevo",
      name: "Ginebra Nordés 70 cl",
      dimension: "volume",
      baseUnit: "ml",
      categoryName: "Destilados",
      packName: "Botella 70 cl",
      packQtyBase: "700",
      supplierName: "Makro",
      price: "18",
      locationNames: ["Parador"],
      title: "Nuevo producto: Ginebra Nordés 70 cl · Botella 70 cl · 18,00 €",
    });
    expect(Object.fromEntries(draft.checks!.map((c) => [c.id, c.status]))).toEqual({
      duplicado: "ok",
      sentido: "ok",
      medida: "ok",
      plausible: "ok",
      categoria: "ok",
    });
    // Parecidos enviados a Jev: incluye el archivado Bombay Sapphire.
    const state = jev.calls[1]!.state as { similar: Array<{ name: string; archived: boolean }> };
    expect(state.similar.map((s) => s.name)).toContain("Ginebra Bombay Sapphire 70 cl");
    expect(Object.keys(jev.calls[1]!.questions)).toEqual(expect.arrayContaining(["duplicado_0", "tiene_sentido", "categoria", "medida", "precio_plausible"]));

    const { result, writer } = await confirmDraft(draft, drafts);
    expect(result).toMatchObject({ ok: true, kind: "producto_nuevo", message: "«Ginebra Nordés 70 cl» creado en el catálogo." });
    expect(writer.calls[0]).toEqual({
      method: "createProduct",
      args: {
        orgId: ORG_ID,
        name: "Ginebra Nordés 70 cl",
        dimension: "volume",
        categoryId: CATEGORIES[0]!.id,
        pack: { name: "Botella 70 cl", qtyBase: "700" },
        supplierId: MAKRO.id,
        price: "18",
        locationIds: [PARADOR!.id],
      },
    });
  });

  it("duplicado escrito de otra forma: pregunta; «es ese» no crea nada y lleva a su ficha", async () => {
    const jev = new FakeJev([route("nuevo_producto"), { ...NEW_OK, duplicado_0: 0.94 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("añade ron barcelo añejo")), "clarify")!;
    expect(clarify).toMatchObject({ field: "duplicado", question: expect.stringContaining(`Ya tienes «${BARCELO.name}»`) });
    expect(clarify.options.map((o) => o.id)).toEqual([`dup:${BARCELO.id}`, "crear"]);

    const events = await run(agent, chat("Sí", { clarification: { clarifyId: clarify.clarifyId, optionId: `dup:${BARCELO.id}` } }));
    expect(find(events, "draft")).toBeUndefined();
    expect(find(events, "navigate")).toMatchObject({ route: "/productos", filters: { productId: BARCELO.id } });
    expect(find(events, "done")!.text).toContain("no creo nada");
  });

  it("duplicado: «no, es otro» sigue con el alta y lo deja anotado", async () => {
    const jev = new FakeJev([route("nuevo_producto"), { ...NEW_OK, duplicado_0: 0.94 }, { ...NEW_OK, duplicado_0: 0.94 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("añade ron barcelo añejo")), "clarify")!;
    const events = await run(agent, chat("No", { clarification: { clarifyId: clarify.clarifyId, optionId: "crear" } }));
    const draft = find(events, "draft") as NewProductDraft;
    expect(draft.name).toBe("Ron barcelo añejo");
    expect(draft.checks!.find((c) => c.id === "duplicado")).toMatchObject({ status: "aviso" });
  });

  it("parecido dudoso: no bloquea, pero exige marcar «revisado»", async () => {
    const jev = new FakeJev([route("nuevo_producto"), { ...NEW_OK, duplicado_0: 0.6 }]);
    const { agent } = makeAgent(jev);
    const draft = find(await run(agent, chat("añade ron barcelo gran añejo")), "draft") as NewProductDraft;
    expect(draft.checks!.find((c) => c.id === "duplicado")).toMatchObject({ status: "revisar", detail: expect.stringContaining(BARCELO.name) });
  });

  it("duplicado literal (activo o archivado): lo para el código sin llamada nº 2", async () => {
    const jev = new FakeJev([route("nuevo_producto"), route("nuevo_producto")]);
    const { agent } = makeAgent(jev);
    const same = await run(agent, chat("añade coca cola 20 cl"));
    expect(find(same, "done")!.text).toBe("Ya existe «Coca-Cola 20 cl» en el catálogo. No lo creo otra vez.");
    const archived = await run(agent, chat("da de alta ginebra bombay sapphire 70cl"));
    expect(find(archived, "done")!.text).toContain("está archivado");
    expect(jev.calls).toHaveLength(2);
  });

  it("nombre sin sentido: pregunta antes de proponerlo", async () => {
    const jev = new FakeJev([route("nuevo_producto"), { ...NEW_OK, tiene_sentido: 0.05 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("añade asdf qwerty")), "clarify")!;
    expect(clarify).toMatchObject({ field: "sentido", options: [{ id: "crear_igual" }] });
    expect(clarify.question).toContain("no parece un producto");
  });

  it("precio sin proveedor: pregunta a quién se le compra", async () => {
    const jev = new FakeJev([route("nuevo_producto")]);
    const { agent } = makeAgent(jev);
    expect(find(await run(agent, chat("añade limas a 3 €")), "clarify")).toMatchObject({ field: "proveedor" });
  });

  it("un encargado puede confirmarlo; un camarero no", async () => {
    const jev = new FakeJev([route("nuevo_producto"), NEW_OK]);
    const { agent } = makeAgent(jev);
    const draft = find(await run(agent, chat("añade hierbabuena fresca"), "staff"), "draft")!;
    expect(draft).toMatchObject({ requiredRole: "manager", canConfirm: false });
  });
});

describe("mínimos y archivar desde el chat", () => {
  it("mínimo en botellas → unidad base, con el objetivo y el stock actual como referencia", async () => {
    const jev = new FakeJev([route("cambiar_minimo", { local: "Parador", producto_0: BARCELO.name }), { coherencia: 0.95, valor_plausible: 0.9 }]);
    const { agent, drafts } = makeAgent(jev);
    const draft = find(await run(agent, chat("pon el mínimo del Barceló en Parador a 6 botellas")), "draft") as MinimumDraft;
    expect(draft).toMatchObject({ kind: "minimo", field: "min_qty", oldValue: "2800", newValue: "4200", baseUnit: "ml", locationName: "Parador" });
    expect(draft.title).toBe(`Mínimo de ${BARCELO.name} en Parador: 2,8 l → 6 × Botella 70 cl (4,2 l)`);
    expect(draft.checks!.find((c) => c.id === "stock")).toMatchObject({ status: "aviso" });

    const { result, writer } = await confirmDraft(draft, drafts);
    expect(result).toMatchObject({ ok: true, kind: "minimo" });
    expect(writer.calls).toEqual([{ method: "setLocationLevel", args: { locationId: PARADOR!.id, productId: BARCELO.id, field: "min_qty", value: "4200" } }]);
  });

  it("mínimo por encima del objetivo → revisar", async () => {
    const jev = new FakeJev([route("cambiar_minimo", { local: "Parador", producto_0: BARCELO.name }), { coherencia: 0.95, valor_plausible: 0.9 }]);
    const { agent } = makeAgent(jev);
    const draft = find(await run(agent, chat("sube el mínimo del Barceló en Parador a 10 botellas")), "draft") as MinimumDraft;
    expect(draft.checks!.find((c) => c.id === "orden")).toMatchObject({ status: "revisar" });
  });

  it("«elimina» archiva (no borra), avisa del stock que queda y exige revisarlo", async () => {
    const jev = new FakeJev([route("archivar_producto", { producto_0: BRUGAL.name }), { coherencia: 0.95 }]);
    const { agent, drafts } = makeAgent(jev);
    const draft = find(await run(agent, chat("elimina el ron brugal")), "draft") as ArchiveDraft;
    expect(draft).toMatchObject({ kind: "archivar", productName: BRUGAL.name, stockQty: "4900" });
    expect(draft.warnings[0]).toContain("no borro productos");
    expect(draft.checks![0]).toMatchObject({ id: "stock", status: "revisar", detail: expect.stringContaining("4,9 l en Parador") });

    expect((await confirmDraft(draft, drafts)).result).toMatchObject({ ok: false, code: "invalid_edit" });
    const { result, writer } = await confirmDraft(draft, drafts, { acknowledged: true }, 2);
    expect(result).toMatchObject({ ok: true, kind: "archivar" });
    expect(writer.calls).toEqual([{ method: "archiveProduct", args: { productId: BRUGAL.id } }]);
  });
});
