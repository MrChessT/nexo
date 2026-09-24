import { describe, expect, it } from "vitest";
import { smallTalk } from "../agent/loop";
import { chat, FakeJev, find, makeAgent, run } from "./helpers";

describe("respuestas del asistente", () => {
  it("saludos, gracias y despedidas cortas se reconocen; lo demás no", () => {
    expect(smallTalk("gracias!")).toBe("gracias");
    expect(smallTalk("Muchas gracias")).toBe("gracias");
    expect(smallTalk("perfecto, gracias")).toBe("gracias");
    expect(smallTalk("buenas tardes")).toBe("hola");
    expect(smallTalk("hasta luego")).toBe("adios");
    expect(smallTalk("¿qué puedes hacer?")).toBeUndefined();
    expect(smallTalk("gracias, y ahora pásame 3 cocas al vivero por favor")).toBeUndefined();
  });

  it("«gracias» recibe una respuesta corta, no la ayuda entera", async () => {
    const { agent } = makeAgent(new FakeJev([{ intent: "conversar", intent_alt: "ninguno" }]));
    expect(find(await run(agent, chat("gracias!")), "done")!.text).toBe("¡De nada! Aquí estoy si necesitas algo más.");
  });

  it("el aviso de continuación va antes de los datos, y muchos productos se resumen", async () => {
    const stock = { intent: "consultar", intent_alt: "leer", herramienta: "query_stock", local: "Parador", producto_0: "varios" };
    const jev = new FakeJev([stock, { intent: "consultar", intent_alt: "leer", local: "Vivero", seguimiento: 0.85 }]);
    const { agent } = makeAgent(jev);
    await run(agent, chat("¿cuánto ron queda en Parador?"));
    const text = find(await run(agent, chat("¿y en el Vivero?")), "done")!.text;
    expect(text.startsWith("Sigo con 2 productos, de lo que hablábamos.")).toBe(true);
    expect(text).toContain("No hay stock registrado de Ron Barceló Añejo 70 cl, Ron Brugal Añejo 70 cl en Vivero.");
  });

  it("al preguntar el local se ofrecen todos los locales", async () => {
    const waste = { intent: "proponer_accion", intent_alt: "cambiar", tipo_accion: "merma", producto_0: "Ron Barceló Añejo 70 cl", cantidad_ok_0: 0.97 };
    const clarify = find(await run(makeAgent(new FakeJev([waste])).agent, chat("se han roto 2 botellas de Barceló")), "clarify")!;
    expect(clarify.options.map((o) => o.id).sort()).toEqual(["La Oliva", "Parador", "Pickels", "Vivero"]);
  });
});
