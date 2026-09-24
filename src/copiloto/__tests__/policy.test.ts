import { describe, expect, it } from "vitest";
import type { Decision, TransferDraft, WasteDraft } from "../contract/index";
import { fixtureContext, LOCATIONS, PRODUCTS } from "../dev/fixture";
import { POLICIES, slotSpec } from "../gates/policy";
import { DEFAULT_THRESHOLDS } from "../gates/thresholds";
import { chat, FakeJev, find, makeAgent, run, type Script } from "./helpers";

const [PARADOR, , VIVERO] = LOCATIONS;
const BARCELO = PRODUCTS[0]!;

const decisionIds = (events: Awaited<ReturnType<typeof run>>): string[] => {
  const d = find(events, "decision")!;
  return [d.intent, ...d.decisions].map((x: Decision) => x.id);
};

describe("política de confianza por contexto", () => {
  it("el mismo dato exige más seguridad cuanto más arriesgada es la operación", () => {
    expect(slotSpec(DEFAULT_THRESHOLDS, "consulta:query_stock", "local").act).toBe(0.75);
    expect(slotSpec(DEFAULT_THRESHOLDS, "accion:merma", "local").act).toBe(0.9);
    expect(slotSpec(DEFAULT_THRESHOLDS, "accion:cierre_inventario", "local").act).toBe(0.95);
    // Nombrado tal cual en el mensaje: basta menos, salvo en operaciones críticas.
    expect(slotSpec(DEFAULT_THRESHOLDS, "accion:merma", "local", true).act).toBe(0.75);
    expect(slotSpec(DEFAULT_THRESHOLDS, "accion:cierre_inventario", "local", true).act).toBe(0.95);
  });

  it("cada operación declara lo que necesita", () => {
    expect(POLICIES["accion:traspaso"].slots).toMatchObject({ local: "requerido", local_destino: "requerido", espacio: "irrelevante", motivo: "irrelevante" });
    expect(POLICIES["accion:cambiar_precio"].slots.local).toBe("irrelevante");
    expect(POLICIES["consulta:query_stock"].slots.periodo).toBe("irrelevante");
  });

  const TRANSFER: Script = {
    intent: "proponer_accion",
    intent_alt: "cambiar",
    tipo_accion: "traspaso",
    local: { winner: "Parador", p: 0.8 },
    local_destino: { winner: "Vivero", p: 0.8 },
    producto_0: { winner: BARCELO.name, p: 0.85 },
    cantidad_ok_0: 0.95,
  };

  it("locales y producto nombrados tal cual: basta la seguridad de una lectura clara", async () => {
    const { agent } = makeAgent(new FakeJev([TRANSFER, { coherencia: 0.95 }]));
    const draft = find(await run(agent, chat("pasa 3 botellas de barceló del Parador al Vivero")), "draft") as TransferDraft;
    expect(draft).toMatchObject({ fromLocationId: PARADOR!.id, toLocationId: VIVERO!.id });
    expect(draft.warnings.filter((w) => w.startsWith("Revisa"))).toEqual([]);
  });

  it("la misma seguridad sin nombrarlos: el borrador pide revisarlos", async () => {
    const { agent } = makeAgent(new FakeJev([TRANSFER, { coherencia: 0.95 }]));
    const draft = find(await run(agent, chat("pasa 3 botellas de ese ron de aquí al otro")), "draft") as TransferDraft;
    expect(draft.warnings).toEqual(expect.arrayContaining(["Revisa el local de origen.", "Revisa el local de destino.", `Revisa el producto: ${BARCELO.name}.`]));
  });

  it("lo irrelevante no se evalúa ni se enseña (espacio en un traspaso, motivo fuera de las mermas)", async () => {
    const script: Script = { ...TRANSFER, local: "Parador", local_destino: "Vivero", espacio: "Parador · Barra 1", motivo_merma: "rotura" };
    const { agent } = makeAgent(new FakeJev([script, { coherencia: 0.95 }]));
    const events = await run(agent, chat("pasa 3 botellas rotas de barceló de la barra 1 del Parador al Vivero"));
    expect(decisionIds(events)).not.toContain("espacio");
    expect(find(events, "draft")).toBeDefined();
  });

  it("un cambio de precio no pregunta ni enseña el local", async () => {
    const price: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "cambiar_precio", local: { dist: { Parador: 0.4, Vivero: 0.35 } }, producto_0: BARCELO.name };
    const { agent } = makeAgent(new FakeJev([price, { coherencia: 0.95, precio_plausible: 0.9 }]));
    const events = await run(agent, chat("el Barceló ahora cuesta 15,40 €"));
    expect(decisionIds(events)).not.toContain("local");
    expect(find(events, "clarify")).toBeUndefined();
  });

  it("el stock de ahora no depende del periodo", async () => {
    const stock: Script = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Parador", producto_0: BARCELO.name, periodo: "semana" };
    const { agent } = makeAgent(new FakeJev([stock]));
    expect(decisionIds(await run(agent, chat("¿cuánto Barceló queda en Parador esta semana?")))).not.toContain("periodo");
  });

  it("cerrar un inventario exige 0,95 aunque el local esté escrito", async () => {
    const close: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: { winner: "cierre_inventario", p: 0.99 }, local: { winner: "Vivero", p: 0.95 } };
    const { agent } = makeAgent(new FakeJev([close, { coherencia: 0.95 }]));
    const draft = find(await run(agent, chat("cierra el inventario del Vivero")), "draft")!;
    expect(draft.warnings).toContain("Revisa el local.");
  });

  it("con un solo local no se pregunta cuál", async () => {
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: BARCELO.name, cantidad_ok_0: 0.97 };
    const jev = new FakeJev([waste, { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    const events: Awaited<ReturnType<typeof run>> = [];
    await agent.handle(chat("se han roto 2 botellas de barceló"), { ...fixtureContext(), locations: [PARADOR!], areas: [] }, (e) => {
      events.push(e);
    });
    expect(Object.keys(jev.calls[0]!.questions)).not.toContain("local");
    expect((find(events, "draft") as WasteDraft).locationId).toBe(PARADOR!.id);
  });
});
