import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";

describe("configuración", () => {
  it("usa Jev directo con TYPESAFE_API_KEY y el gateway con AI_GATEWAY_API_KEY", () => {
    expect(loadConfig({ TYPESAFE_API_KEY: "ts" }).jev).toEqual({ apiKey: "ts", baseURL: "https://api.typesafe.ai", model: "jev-latest", via: "typesafe", oidc: false });
    expect(loadConfig({ AI_GATEWAY_API_KEY: "vck" }).jev).toEqual({ apiKey: "vck", baseURL: "https://ai-gateway.vercel.sh/typesafe", model: "typesafe-ai/jev", via: "ai-gateway", oidc: false });
    // En Vercel sin claves: gateway con el token OIDC del despliegue.
    expect(loadConfig({ VERCEL: "1" }).jev).toMatchObject({ via: "ai-gateway", oidc: true, model: "typesafe-ai/jev" });
  });

  it("las variables vacías cuentan como no definidas y el gateway comparte clave con la redacción", () => {
    const cfg = loadConfig({ TYPESAFE_API_KEY: "", AI_GATEWAY_API_KEY: "vck", WRITER_PROVIDER: "openai", WRITER_URL: "https://ai-gateway.vercel.sh" });
    expect(cfg.jev.via).toBe("ai-gateway");
    expect(cfg.WRITER_API_KEY).toBe("vck");
    expect(cfg.writerUrl).toBe("https://ai-gateway.vercel.sh");
  });

  it("en producción exige Jev y Supabase", () => {
    expect(() => loadConfig({ NODE_ENV: "production" })).toThrow(/Faltan variables/);
  });
});
