import { describe, expect, it } from "vitest";
import type { CountCloseDraft, Draft, ReceiptDraft, TransferDraft, WasteDraft } from "../contract/index";
import { FixtureWriter } from "../dev/fixture-writer";
import { fixtureContext, LOCATIONS, ORG_ID, PRODUCTS } from "../dev/fixture";
import { FixtureDataSource } from "../dev/fixture";
import { DraftBuilder } from "../drafts/builder";
import { ConfirmService } from "../drafts/confirm";
import { MemoryAuditSink } from "../audit/audit";
import type { ActionPlan } from "../agent/interpret";
import type { Product } from "../domain";
import { chat, FakeJev, find, makeAgent, NOW, run } from "./helpers";

const [PARADOR, , VIVERO] = LOCATIONS;
const BARCELO = "Ron Barceló Añejo 70 cl";

const WASTE_SCRIPT = {
  intent: "proponer_accion",
  intent_alt: "cambiar",
  tipo_accion: "merma",
  local: "Parador",
  espacio: "Parador · Barra 1",
  producto_0: BARCELO,
  cantidad_ok_0: 0.97,
  motivo_merma: "rotura",
};

describe("borradores desde el chat", () => {
  it("merma: cantidad en unidad base con decimal.js, espacio, motivo y coherencia de Jev", async () => {
    const jev = new FakeJev([WASTE_SCRIPT, { coherencia: 0.96 }]);
    const { agent, drafts, audit } = makeAgent(jev);
    const events = await run(agent, chat("baja 2 botellas de ron rotas en barra 1"));

    expect(events.map((e) => e.event)).toEqual(["decision", "draft", "text", "done"]);
    expect(jev.calls).toHaveLength(2);
    expect(jev.calls[1]!.state).toEqual({
      request: "baja 2 botellas de ron rotas en barra 1",
      draft: { operation: "write off (merma)", product: BARCELO, quantity: "2 × Botella 70 cl", venue: "Parador · Barra 1", reason: "rotura" },
    });
    const draft = find(events, "draft") as WasteDraft;
    expect(draft).toMatchObject({
      kind: "merma",
      locationId: PARADOR!.id,
      areaName: "Barra 1",
      productName: BARCELO,
      qtyBase: "1400",
      baseUnit: "ml",
      input: { amount: "2", unit: "Botella 70 cl" },
      reason: "rotura",
      requiredRole: "staff",
      canConfirm: true,
      coherence: 0.96,
      warnings: [],
    });
    expect(draft.title).toBe(`Merma: 2 × Botella 70 cl de ${BARCELO} en Parador · Barra 1`);
    expect((await drafts.get(draft.draftId, fixtureContext().userId, ORG_ID))?.status).toBe("pendiente");
    // El título ya va en la tarjeta: el texto es solo la indicación.
    expect(find(events, "done")!.text).toBe("Revísalo y confírmalo si está bien.");
    expect(audit.events.map((e) => e.type)).toEqual(["borrador", "mensaje"]);
  });

  it("coherencia baja → no hay borrador, se pide repetir", async () => {
    const jev = new FakeJev([WASTE_SCRIPT, { coherencia: 0.3 }]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("baja 2 botellas de ron rotas en barra 1"));
    expect(find(events, "draft")).toBeUndefined();
    expect(find(events, "clarify")!.question).toContain("No estoy seguro");
  });

  it("coherencia media → borrador con aviso", async () => {
    const { agent } = makeAgent(new FakeJev([WASTE_SCRIPT, { coherencia: 0.7 }]));
    const draft = find(await run(agent, chat("baja 2 botellas de ron rotas en barra 1")), "draft")!;
    expect(draft.warnings[0]).toContain("Revisa los datos");
  });

  it("cantidad dudosa → pregunta; al confirmarla se crea el borrador sin volver a enrutar", async () => {
    const jev = new FakeJev([{ ...WASTE_SCRIPT, cantidad_ok_0: 0.3 }, { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const clarify = find(await run(agent, chat("baja 2 botellas de ron rotas en barra 1")), "clarify")!;
    expect(clarify).toMatchObject({ field: "cantidad", options: [{ id: "si", label: "Sí, 2 botella" }] });
    const events = await run(agent, chat("Sí", { clarification: { clarifyId: clarify.clarifyId, optionId: "si" } }));
    expect((find(events, "draft") as WasteDraft).qtyBase).toBe("1400");
    expect(jev.calls.filter((c) => "intent" in c.questions)).toHaveLength(1);
  });

  it("local sin decidir → pregunta por el local antes de preparar nada", async () => {
    const { agent } = makeAgent(new FakeJev([{ ...WASTE_SCRIPT, local: { dist: { Parador: 0.5, Vivero: 0.4 } }, espacio: "no_indicado" }]));
    const clarify = find(await run(agent, chat("baja 2 botellas de ron")), "clarify")!;
    expect(clarify.field).toBe("local");
    expect(clarify.options.map((o) => o.id).slice(0, 2)).toEqual(["Parador", "Vivero"]);
  });

  it("traspaso de varios productos: staff lo deja en borrador, encargado lo envía", async () => {
    const script = {
      intent: "proponer_accion",
      intent_alt: "cambiar",
      tipo_accion: "traspaso",
      local: "Parador",
      local_destino: "Vivero",
      producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 },
      producto_1: { winner: "Ginebra Tanqueray 70 cl", p: 0.99 },
      cantidad_ok_0: 0.95,
      cantidad_ok_1: 0.95,
    };
    const message = "pasa 6 unidades de coca y 2 botellas de ginebra de Parador al Vivero";
    const staff = find(await run(makeAgent(new FakeJev([script, { coherencia: 0.9 }])).agent, chat(message), "staff"), "draft") as TransferDraft;
    expect(staff).toMatchObject({ kind: "traspaso", fromLocationId: PARADOR!.id, toLocationId: VIVERO!.id, send: false });
    expect(staff.lines.map((l) => [l.productName, l.qtyBase, l.baseUnit])).toEqual([
      ["Coca-Cola 20 cl", "6", "ud"],
      ["Ginebra Tanqueray 70 cl", "1400", "ml"],
    ]);
    expect(staff.warnings).toContain("Se guardará como borrador: enviarlo requiere rol de encargado.");
    const manager = find(await run(makeAgent(new FakeJev([script, { coherencia: 0.9 }])).agent, chat(message), "manager"), "draft") as TransferDraft;
    expect(manager.send).toBe(true);
  });

  it("Jev comprueba la cantidad tal como se pidió («30 unidades», no solo «1 caja + 6 ud»)", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "traspaso", local: "Parador", local_destino: "Vivero", producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 }, cantidad_ok_0: 0.95 };
    const jev = new FakeJev([script, { coherencia: 0.9 }]);
    const draft = find(await run(makeAgent(jev).agent, chat("pasa 30 unidades de coca de Parador al Vivero")), "draft") as TransferDraft;
    expect(draft.title).toContain("1 caja + 6 ud de Coca-Cola 20 cl");
    expect((jev.calls[1]!.state as { draft: { lines: string } }).draft.lines).toBe("30 ud (= 1 caja + 6 ud) de Coca-Cola 20 cl");
  });

  it("cantidad sin unidad («6 cocas») → pregunta el formato en vez de suponerlo", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "traspaso", local: "Parador", local_destino: "Vivero", producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 }, cantidad_ok_0: 0.95 };
    const { agent } = makeAgent(new FakeJev([script, { coherencia: 0.9 }]));
    const clarify = find(await run(agent, chat("pasa 6 cocas de Parador al Vivero")), "clarify")!;
    expect(clarify).toMatchObject({ field: "cantidad", question: "¿En qué formato son las 6 de Coca-Cola 20 cl?" });
    expect(clarify.options.map((o) => o.label)).toEqual(["Unidades sueltas", "Caja 24 ud"]);
    const events = await run(agent, chat("Unidades sueltas", { clarification: { clarifyId: clarify.clarifyId, optionId: "pack:base" } }));
    expect((find(events, "draft") as TransferDraft).lines[0]).toMatchObject({ qtyBase: "6", baseUnit: "ud" });
  });

  it("origen y destino iguales → pregunta el destino", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "traspaso", local: "Parador", local_destino: "Parador", producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 }, cantidad_ok_0: 0.95 };
    const clarify = find(await run(makeAgent(new FakeJev([script])).agent, chat("pasa 6 cocas a Parador")), "clarify")!;
    expect(clarify.field).toBe("local_destino");
    expect(clarify.options.map((o) => o.id)).not.toContain("Parador");
  });

  it("recepción: precio del mensaje o, si falta, el último del proveedor", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "recepcion", local: "Parador", producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 }, cantidad_ok_0: 0.95 };
    const withPrice = find(await run(makeAgent(new FakeJev([script, { coherencia: 0.9 }])).agent, chat("han llegado 3 cajas de coca a 13,50 € en Parador")), "draft") as ReceiptDraft;
    expect(withPrice.lines).toEqual([
      expect.objectContaining({ packName: "Caja 24 ud", packsQty: "3", packPrice: "13.5", priceSource: "usuario" }),
    ]);
    const lastPrice = find(await run(makeAgent(new FakeJev([script, { coherencia: 0.9 }])).agent, chat("han llegado 3 cajas de coca en Parador")), "draft") as ReceiptDraft;
    expect(lastPrice.lines[0]).toMatchObject({ packPrice: "13.2", priceSource: "ultimo_precio" });
    expect(lastPrice.supplierName).toBe("Bebidas del Sur");
    expect(lastPrice.warnings.join(" ")).toContain("último albarán");
  });

  it("cierre de inventario: vista previa de ajustes; exige 0,95 y rol de encargado", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { winner: "cierre_inventario", p: 0.99 }, local: "Vivero" };
    const staffEvents = await run(makeAgent(new FakeJev([script, { coherencia: 0.9 }])).agent, chat("cierra el inventario del vivero"), "staff");
    const draft = find(staffEvents, "draft") as CountCloseDraft;
    expect(draft).toMatchObject({ kind: "cierre_inventario", requiredRole: "manager", canConfirm: false, zeroUncounted: false });
    // Coca contada 40 frente a 48 teóricas a 0,55 € → −8 ud, −4,40 €
    expect(draft.preview).toEqual({
      countedProducts: 2,
      adjustments: [expect.objectContaining({ productName: "Coca-Cola 20 cl", expected: "48", counted: "40", diff: "-8", diffValue: "-4.4" })],
      totalDiffValue: "-4.4",
    });

    const unsure = { ...script, tipo_accion: { winner: "cierre_inventario", p: 0.95 } };
    expect(find(await run(makeAgent(new FakeJev([unsure])).agent, chat("cierra el inventario del vivero")), "clarify")!.field).toBe("tipo_accion");

    const noCount = { ...script, local: "Parador" };
    const text = find(await run(makeAgent(new FakeJev([noCount])).agent, chat("cierra el inventario de parador")), "done")!.text;
    expect(text).toBe("No hay ningún inventario abierto en Parador.");
  });
});

describe("constructor de borradores", () => {
  const twoBottles: Product = {
    id: "p-x",
    name: "Vermut Rojo",
    dimension: "volume",
    baseUnit: "ml",
    category: "Vermut",
    packs: [
      { id: "k-1l", name: "Botella 1 l", qtyBase: "1000", isCountDefault: false, isPurchaseDefault: false },
      { id: "k-75", name: "Botella 75 cl", qtyBase: "750", isCountDefault: false, isPurchaseDefault: false },
    ],
  };
  const ctx = { ...fixtureContext(), products: [...PRODUCTS, twoBottles] };
  const plan = (overrides: Partial<ActionPlan> = {}): ActionPlan => ({
    type: "accion",
    accion: "merma",
    locationId: PARADOR!.id,
    locationOutcome: "actuar",
    toLocationId: null,
    toLocationOutcome: "actuar",
    areaId: null,
    products: [{ product: twoBottles, segmentIndex: 0, amount: "1.5", unit: "botella", price: null, quantityOutcome: "actuar" }],
    motivo: "no_indicado",
    ambiguous: 0,
    ...overrides,
  });

  it("formato ambiguo → pregunta con los formatos; con la respuesta, calcula exacto", async () => {
    const builder = new DraftBuilder();
    const source = new FixtureDataSource(NOW);
    const first = await builder.build({ plan: plan(), ctx, source, overrides: {}, now: NOW });
    expect(first).toMatchObject({ kind: "clarify", plan: { field: "cantidad", options: [{ id: "pack:k-1l" }, { id: "pack:k-75" }] } });
    const second = await builder.build({ plan: plan(), ctx, source, overrides: { unidad_0: "k-75" }, now: NOW });
    expect(second.kind === "draft" && (second.draft as WasteDraft).qtyBase).toBe("1125");
    // Sin stock de este producto en Parador: aviso.
    expect(second.kind === "draft" && second.draft.warnings.join(" ")).toContain("Solo constan 0 ml");
  });
});

describe("confirmación", () => {
  async function setup(role: "staff" | "manager" = "manager") {
    const jev = new FakeJev([WASTE_SCRIPT, { coherencia: 0.95 }]);
    const { agent, drafts, audit } = makeAgent(jev);
    const draft = find(await run(agent, chat("baja 2 botellas de ron rotas en barra 1")), "draft") as Draft;
    const writer = new FixtureWriter();
    const service = new ConfirmService(drafts, audit, () => NOW);
    const ctx = fixtureContext(role);
    return { draft, writer, service, ctx, drafts, audit };
  }
  const key = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

  it("merma: llama a register_movement con la cantidad exacta y es idempotente", async () => {
    const { draft, writer, service, ctx, audit } = await setup();
    const req = { orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1) };
    const first = await service.confirm(req, ctx, writer);
    expect(first).toMatchObject({ ok: true, kind: "merma", message: "Merma registrada.", navigate: { route: "/mermas" } });
    expect(writer.calls).toEqual([
      { method: "registerWaste", args: { locationId: PARADOR!.id, productId: PRODUCTS[0]!.id, qtyBase: "1400", reason: "rotura", areaId: expect.any(String), clientRef: key(1) } },
    ]);
    expect(await service.confirm(req, ctx, writer)).toEqual(first);
    expect(writer.calls).toHaveLength(1);
    expect(await service.confirm({ ...req, idempotencyKey: key(2) }, ctx, writer)).toMatchObject({ ok: false, code: "draft_not_found" });
    expect(audit.events.at(-1)).toMatchObject({ type: "confirmacion", ok: true, kind: "merma" });
  });

  it("solo acepta ediciones de la lista blanca y las valida", async () => {
    const { draft, writer, service, ctx } = await setup();
    const base = { orgId: ORG_ID, draftId: draft.draftId };
    expect(await service.confirm({ ...base, idempotencyKey: key(1), edits: { productId: "otro" } }, ctx, writer)).toMatchObject({ ok: false, code: "invalid_edit" });
    expect(await service.confirm({ ...base, idempotencyKey: key(2), edits: { qtyBase: "-3" } }, ctx, writer)).toMatchObject({ ok: false, code: "invalid_edit" });
    expect(await service.confirm({ ...base, idempotencyKey: key(3), edits: { areaId: "bbbbbbbb-0000-4000-8000-000000000004" } }, ctx, writer)).toMatchObject({
      ok: false,
      code: "invalid_edit",
      message: "El espacio no pertenece al local",
    });
    const ok = await service.confirm({ ...base, idempotencyKey: key(4), edits: { qtyBase: "700.5" } }, ctx, writer);
    expect(ok.ok).toBe(true);
    expect((writer.calls[0]!.args as { qtyBase: string }).qtyBase).toBe("700.5");
  });

  it("otro usuario no puede usar el borrador; caducado → draft_expired", async () => {
    const { draft, writer, service, ctx, drafts } = await setup();
    const other = { ...ctx, userId: "22222222-0000-4000-8000-000000000001" };
    expect(await service.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1) }, other, writer)).toMatchObject({ code: "draft_not_found" });
    const late = new ConfirmService(drafts, new MemoryAuditSink(), () => new Date(NOW.getTime() + 16 * 60 * 1000));
    expect(await late.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(2) }, ctx, writer)).toMatchObject({ code: "draft_expired" });
    expect(writer.calls).toHaveLength(0);
  });

  it("si la RPC falla, devuelve su mensaje y el borrador sigue disponible", async () => {
    const { draft, writer, service, ctx } = await setup();
    writer.failOn = { method: "registerWaste", code: "forbidden" };
    const failed = await service.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1) }, ctx, writer);
    expect(failed).toEqual({ ok: false, code: "forbidden", message: "No tienes permisos para realizar esta acción." });
    writer.failOn = null;
    expect((await service.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(2) }, ctx, writer)).ok).toBe(true);
  });

  it("traspaso: si send_transfer falla, borra el borrador creado", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "traspaso", local: "Parador", local_destino: "Vivero", producto_0: { winner: "Coca-Cola 20 cl", p: 0.99 }, cantidad_ok_0: 0.95 };
    const { agent, drafts, audit } = makeAgent(new FakeJev([script, { coherencia: 0.9 }]));
    const draft = find(await run(agent, chat("pasa 6 unidades de coca al Vivero")), "draft") as TransferDraft;
    const writer = new FixtureWriter();
    writer.failOn = { method: "sendTransfer", code: "forbidden" };
    const result = await new ConfirmService(drafts, audit, () => NOW).confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1) }, fixtureContext("manager"), writer);
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(writer.calls.map((c) => c.method)).toEqual(["createTransfer", "sendTransfer", "deleteDraftTransfer"]);
  });

  it("recepción sin precio no se confirma hasta que se edita", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "recepcion", local: "Parador", producto_0: { winner: "Tónica Schweppes 20 cl", p: 0.99 }, cantidad_ok_0: 0.95 };
    const { agent, drafts, audit } = makeAgent(new FakeJev([script, { coherencia: 0.9 }]));
    const draft = find(await run(agent, chat("han llegado 2 cajas de tónica")), "draft") as ReceiptDraft;
    expect(draft.lines[0]!.packPrice).toBeNull();
    const service = new ConfirmService(drafts, audit, () => NOW);
    const writer = new FixtureWriter();
    const req = { orgId: ORG_ID, draftId: draft.draftId };
    expect(await service.confirm({ ...req, idempotencyKey: key(1) }, fixtureContext(), writer)).toMatchObject({ ok: false, code: "invalid_edit" });
    const ok = await service.confirm({ ...req, idempotencyKey: key(2), edits: { "lines.0.packPrice": "11.52" } }, fixtureContext(), writer);
    expect(ok.ok).toBe(true);
    expect(writer.calls.map((c) => c.method)).toEqual(["createReceipt", "postReceipt"]);
    expect((writer.calls[0]!.args as { lines: unknown[] }).lines).toEqual([{ packId: expect.any(String), packsQty: "2", packPrice: "11.52" }]);
  });

  it("staff no puede confirmar un cierre de inventario", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { winner: "cierre_inventario", p: 0.99 }, local: "Vivero" };
    const { agent, drafts, audit } = makeAgent(new FakeJev([script, { coherencia: 0.9 }]));
    const draft = find(await run(agent, chat("cierra el inventario del vivero"), "staff"), "draft")!;
    const writer = new FixtureWriter();
    const result = await new ConfirmService(drafts, audit, () => NOW).confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1) }, fixtureContext("staff"), writer);
    expect(result).toMatchObject({ ok: false, code: "forbidden" });
    expect(writer.calls).toHaveLength(0);
  });

  it("un encargado cierra el inventario registrando lo que falta como consumo (o como ajuste si lo desmarca)", async () => {
    const script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { winner: "cierre_inventario", p: 0.99 }, local: "Vivero" };
    const { agent, drafts, audit } = makeAgent(new FakeJev([script, { coherencia: 0.9 }, script, { coherencia: 0.9 }]));
    const service = new ConfirmService(drafts, audit, () => NOW);

    const draft = find(await run(agent, chat("cierra el inventario del vivero")), "draft")!;
    expect(draft).toMatchObject({ asConsumption: true, editable: expect.arrayContaining(["asConsumption"]) });
    const writer = new FixtureWriter();
    expect(await service.confirm({ orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1) }, fixtureContext(), writer)).toMatchObject({ ok: true });
    expect(writer.calls[0]).toMatchObject({ method: "closeCount", args: { zeroUncounted: false, asConsumption: true } });

    const other = find(await run(agent, chat("cierra el inventario del vivero")), "draft")!;
    const adjust = new FixtureWriter();
    await service.confirm({ orgId: ORG_ID, draftId: other.draftId, idempotencyKey: key(2), edits: { asConsumption: false } }, fixtureContext(), adjust);
    expect(adjust.calls[0]).toMatchObject({ args: { asConsumption: false } });
  });
});
