import { describe, expect, it } from "vitest";
import type { WasteDraft } from "../contract/index";
import { emptyHabits, preferredLocation, recordUse } from "../agent/habits";
import { LOCATIONS, PRODUCTS } from "../dev/fixture";
import { chat, FakeJev, find, makeAgent, run, type Script } from "./helpers";

const [PARADOR, PICKELS] = LOCATIONS;
const BARCELO = PRODUCTS[0]!;
const BRUGAL = PRODUCTS[1]!;

describe("hábitos del usuario", () => {
  it("local habitual: solo con uso claro (≥ 5 usos y ≥ 70 %) y entre los locales visibles", () => {
    let h = emptyHabits();
    for (let i = 0; i < 4; i += 1) h = recordUse(h, { locationIds: [PARADOR!.id], productIds: [] });
    expect(preferredLocation(h, [PARADOR!.id])).toBeUndefined();
    h = recordUse(h, { locationIds: [PARADOR!.id], productIds: [] });
    expect(preferredLocation(h, [PARADOR!.id, PICKELS!.id])).toBe(PARADOR!.id);
    for (let i = 0; i < 3; i += 1) h = recordUse(h, { locationIds: [PICKELS!.id], productIds: [] });
    expect(preferredLocation(h, [PARADOR!.id, PICKELS!.id])).toBeUndefined(); // 5/8 < 70 %
    expect(preferredLocation(recordUse(emptyHabits(), { locationIds: ["otro"], productIds: [] }), [PARADOR!.id])).toBeUndefined();
  });

  it("una merma sin local va al local habitual, marcado para revisar", async () => {
    const stock: Script = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Parador", producto_0: BARCELO.name };
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: BARCELO.name, cantidad_ok_0: 0.97, motivo_merma: "rotura" };
    const jev = new FakeJev([stock, stock, stock, stock, stock, waste, { coherencia: 0.95 }]);
    const { agent } = makeAgent(jev);
    for (let i = 0; i < 5; i += 1) await run(agent, chat("¿cuánto Barceló queda en Parador?"));
    const draft = find(await run(agent, chat("se han roto 2 botellas de Barceló")), "draft") as WasteDraft;
    expect(draft.locationName).toBe("Parador");
    expect(draft.warnings).toContain("Revisa el local.");
  });

  it("sin hábitos, la misma merma pregunta el local", async () => {
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: BARCELO.name, cantidad_ok_0: 0.97 };
    const { agent } = makeAgent(new FakeJev([waste]));
    expect(find(await run(agent, chat("se han roto 2 botellas de Barceló")), "clarify")).toMatchObject({ field: "local" });
  });

  it("«¿qué ron?»: primero los que más usa", async () => {
    const stock: Script = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Parador", producto_0: BRUGAL.name };
    const waste: Script = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", local: "Parador", producto_0: "varios", cantidad_ok_0: 0.97 };
    const { agent } = makeAgent(new FakeJev([stock, waste]));
    await run(agent, chat("¿cuánto Brugal queda en Parador?"));
    const clarify = find(await run(agent, chat("baja 2 botellas de ron en Parador")), "clarify")!;
    expect(clarify.options[0]!.label).toBe(BRUGAL.name);
  });
});
