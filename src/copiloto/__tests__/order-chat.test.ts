import { describe, expect, it } from "vitest";
import type { OrderDraft } from "../contract/index";
import { FixtureWriter } from "../dev/fixture-writer";
import { fixtureContext, LOCATIONS, ORG_ID, PRODUCTS, SUPPLIERS } from "../dev/fixture";
import { ConfirmService } from "../drafts/confirm";
import { chat, FakeJev, find, makeAgent, NOW, run, type Script } from "./helpers";

const [PARADOR] = LOCATIONS;
const COCA = PRODUCTS[3]!;
const BARCELO = PRODUCTS[0]!;
const [CANARIAS, SUR, MAKRO] = SUPPLIERS as [(typeof SUPPLIERS)[number], (typeof SUPPLIERS)[number], (typeof SUPPLIERS)[number]];
const key = (n: number) => `0000000${n}-0000-4000-8000-000000000000`;

const route = (extra: Script = {}): Script => ({ intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "preparar_pedido", ...extra });

describe("pedidos desde el chat", () => {
  it("«prepara el pedido de la semana»: lo que falta con consumo real, en cajas y agrupado por proveedor", async () => {
    const jev = new FakeJev([route({ local: "Parador", periodo: "semana" }), { coherencia: 0.95 }]);
    const { agent, drafts, audit } = makeAgent(jev);
    const draft = find(await run(agent, chat("prepara el pedido de la semana para Parador")), "draft") as OrderDraft;

    expect(draft).toMatchObject({ kind: "pedido", locationName: "Parador", horizonLabel: "la próxima semana", requiredRole: "staff", canConfirm: true });
    expect(draft.title).toBe("Pedido para Parador (la próxima semana): 2 productos a Bebidas del Sur, Distribuciones Canarias · 184,80 €");
    // Coca: 20 ud/día × 7 + mínimo 48 − 30 en stock = 158 ud → 7 cajas de 24. Barceló: hasta el objetivo, 1 caja de 6.
    expect(draft.orders.map((o) => [o.supplierName, o.lines.map((l) => [l.productName, l.packName, l.packsQty, l.packPrice])])).toEqual([
      [SUR.name, [[COCA.name, "Caja 24 ud", "7", "13.2"]]],
      [CANARIAS.name, [[BARCELO.name, "Caja 6 botellas", "1", "92.4"]]],
    ]);
    expect(draft.orders[0]!.lines[0]!.note).toBe("quedan 1 caja + 6 ud · para 1,5 días");

    // Al confirmar se crea un pedido en borrador por proveedor; la línea a 0 se quita.
    const writer = new FixtureWriter();
    const result = await new ConfirmService(drafts, audit, () => NOW).confirm(
      { orgId: ORG_ID, draftId: draft.draftId, idempotencyKey: key(1), edits: { "orders.1.lines.0.packsQty": "0" } },
      fixtureContext("staff"),
      writer,
    );
    expect(result).toMatchObject({ ok: true, kind: "pedido", message: "Pedido creado en borrador. Revísalo y envíalo desde Pedidos.", navigate: { route: "/pedidos", filters: { status: "draft" } } });
    expect(writer.calls).toEqual([
      {
        method: "createOrder",
        args: { orgId: ORG_ID, locationId: PARADOR!.id, supplierId: SUR.id, lines: [{ packId: COCA.packs[0]!.id, packsQty: "7", packPrice: "13.2" }] },
      },
    ]);
  });

  it("con cantidades y proveedor: pide exactamente eso a ese proveedor y avisa si no hay precio", async () => {
    const jev = new FakeJev([route({ local: "Parador", producto_0: COCA.name, cantidad_ok_0: 0.97 }), { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const draft = find(await run(agent, chat("pide 3 cajas de coca cola a Makro para Parador")), "draft") as OrderDraft;
    expect(draft.orders).toEqual([
      {
        supplierId: MAKRO.id,
        supplierName: "Makro",
        lines: [{ productId: COCA.id, productName: COCA.name, packId: COCA.packs[0]!.id, packName: "Caja 24 ud", packsQty: "3", packPrice: null, note: "cantidad indicada por ti" }],
      },
    ]);
    expect(draft.checks!.map((c) => [c.id, c.status])).toEqual([
      ["origen", "ok"],
      ["precio", "aviso"],
    ]);
  });

  it("si no falta nada, lo dice y no propone ningún borrador", async () => {
    const jev = new FakeJev([route({ local: "Pickels" })]);
    const { agent } = makeAgent(jev);
    const events = await run(agent, chat("haz el pedido para Pickels"));
    expect(find(events, "draft")).toBeUndefined();
    expect(find(events, "done")!.text).toBe("No hace falta pedir nada en Pickels para la próxima semana: con el stock, los mínimos y lo que ya está en camino es suficiente.");
  });

  it("sin local claro, pregunta para qué local es", async () => {
    const jev = new FakeJev([route({ local: { dist: { Parador: 0.4, Vivero: 0.35 } } })]);
    const { agent } = makeAgent(jev);
    expect(find(await run(agent, chat("prepara el pedido")), "clarify")).toMatchObject({ field: "local", question: "¿Para qué local es el pedido?" });
  });
});

describe("pedidos desde el chat: local", () => {
  it("si la pregunta de local duda pero la de destino está segura, usa el destino", async () => {
    const jev = new FakeJev([route({ local: { dist: { Parador: 0.68, no_indicado: 0.23 } }, local_destino: "Parador", producto_0: COCA.name, cantidad_ok_0: 0.97 }), { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const draft = find(await run(agent, chat("pide 3 cajas de coca cola a Makro para Parador")), "draft") as OrderDraft;
    expect(draft.locationName).toBe("Parador");
    expect(draft.warnings).not.toContain("Revisa el local.");
  });
});
