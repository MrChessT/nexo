import { describe, expect, it } from "vitest";
import { buildQuery, QUERY_FUNCTIONS } from "../../components/copiloto/quick-actions";
import { chat, FakeJev, find, makeAgent, run } from "./helpers";

describe("menú de funciones del asistente", () => {
  it("el comando lleva producto y local, y el chat enseña un texto legible", () => {
    expect(buildQuery({ command: "existencias", label: "Stock" }, "Vivero", " barceló ")).toEqual({ message: "/existencias barceló Vivero", display: "Stock · Vivero · barceló" });
    expect(buildQuery({ command: "reponer", label: "Qué reponer" }, "", "")).toEqual({ message: "/reponer", display: "Qué reponer" });
  });

  it.each(QUERY_FUNCTIONS.map((fn) => [fn.label, fn] as const))("«%s» responde sin llamar a Jev", async (_label, fn) => {
    const jev = new FakeJev();
    const { agent } = makeAgent(jev);
    const { message } = buildQuery(fn, "Parador", fn.needsProduct ? "barceló" : "");
    const events = await run(agent, chat(message));
    // Sin la llamada de enrutado (la nº 1): solo puede haber la valoración de urgencia de algunas consultas.
    expect(jev.calls.filter((c) => "intent" in c.questions)).toHaveLength(0);
    expect(find(events, "error")).toBeUndefined();
    expect(find(events, "navigate")?.auto ?? false).toBe(false);
    expect(find(events, "done")!.text.length).toBeGreaterThan(0);
  });

  it("la ficha desde el menú enseña precio y stock del producto", async () => {
    const { agent } = makeAgent(new FakeJev());
    const text = find(await run(agent, chat("/ficha barceló")), "done")!.text;
    expect(text).toContain("Precio: 15,40 € / Botella 70 cl");
    expect(text).toContain("Stock: 4 botellas");
  });
});
