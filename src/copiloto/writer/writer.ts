import type { DecisionReport } from "../agent/report";
import { writerView } from "../agent/report";
import type { Emit } from "../contract/index";
import type { Metrics } from "../metrics/metrics";
import { LINE_PROMPT, SYSTEM_PROMPT, userPrompt } from "./prompt";
import type { WriterProvider } from "./provider";
import { renderTemplate } from "./templates";
import { allowedNumbers, verifyNumbers } from "./verifier";

export interface WriteResult {
  text: string;
  source: "llm" | "plantilla";
}

/** Resultados que siempre se dicen con plantilla: son fijos o de seguridad. */
const TEMPLATE_ONLY = new Set(["aclaracion", "fuera_de_ambito", "bloqueado", "error", "navegacion"]);

const MAX_CHARS = 900;
// Sin "$": un "1." al final de un fragmento puede ser el principio de "1.400".
const SENTENCE_END = /[.!?…:]\s+|\n/;

export interface WriterOptions {
  timeoutMs: number;
  /** Intentos con la LLM antes de pasar a plantilla (1 = sin regenerar). */
  attempts: number;
}

export class Writer {
  constructor(
    private readonly provider: WriterProvider | null,
    private readonly metrics: Metrics,
    private readonly options: WriterOptions = { timeoutMs: 15_000, attempts: 2 },
  ) {}

  async write(report: DecisionReport, emit: Emit): Promise<WriteResult> {
    const template = renderTemplate(report);
    if (!this.provider || TEMPLATE_ONLY.has(report.outcome.kind)) {
      await emit({ event: "text", data: { delta: template } });
      this.metrics.writer.plantilla += 1;
      return { text: template, source: "plantilla" };
    }

    const view = writerView(report);
    const allowed = allowedNumbers(view);
    let emittedAny = false;

    for (let attempt = 0; attempt < this.options.attempts; attempt += 1) {
      if (attempt > 0) this.metrics.writer.regenerado += 1;
      const result = await this.tryLlm(view, allowed, emit, emittedAny);
      emittedAny ||= result.emitted;
      if (result.ok) {
        this.metrics.writer.llm += 1;
        return { text: result.text, source: "llm" };
      }
    }

    await emit({ event: "text", data: { delta: template, ...(emittedAny ? { reset: true } : {}) } });
    this.metrics.writer.plantilla += 1;
    return { text: template, source: "plantilla" };
  }

  /** Una sola línea (sugerencias). Sin streaming: se verifica entera; si falla, plantilla. */
  async line(facts: Record<string, string>, template: string): Promise<string> {
    if (!this.provider) return template;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      let out = "";
      for await (const delta of this.provider.stream({ system: LINE_PROMPT, user: userPrompt(facts) }, controller.signal)) {
        out += delta;
        if (out.length > 240) break;
      }
      const line = out.split("\n")[0]!.trim();
      if (line.length > 0 && line.length <= 220 && verifyNumbers(line, allowedNumbers(facts)).ok) {
        this.metrics.writer.llm += 1;
        return line;
      }
    } catch {
      // se usa la plantilla
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
    this.metrics.writer.plantilla += 1;
    return template;
  }

  /**
   * Emite frase a frase: cada frase se verifica antes de salir hacia el cliente.
   * Si una frase trae una cifra que no está en el informe, se aborta el intento.
   */
  private async tryLlm(
    view: Record<string, unknown>,
    allowed: Set<string>,
    emit: Emit,
    resetFirst: boolean,
  ): Promise<{ ok: boolean; text: string; emitted: boolean }> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs);
    let pending = "";
    let text = "";
    let emitted = false;
    let needsReset = resetFirst;

    const flush = async (chunk: string): Promise<boolean> => {
      if (!chunk) return true;
      if (!verifyNumbers(chunk, allowed).ok) return false;
      await emit({ event: "text", data: { delta: chunk, ...(needsReset ? { reset: true } : {}) } });
      needsReset = false;
      emitted = true;
      text += chunk;
      return true;
    };

    try {
      for await (const delta of this.provider!.stream({ system: SYSTEM_PROMPT, user: userPrompt(view) }, controller.signal)) {
        pending += delta;
        let match = SENTENCE_END.exec(pending);
        while (match) {
          const cut = match.index + match[0].length;
          if (!(await flush(pending.slice(0, cut)))) {
            controller.abort();
            return { ok: false, text, emitted };
          }
          pending = pending.slice(cut);
          match = SENTENCE_END.exec(pending);
        }
        if (text.length + pending.length > MAX_CHARS) {
          controller.abort();
          break;
        }
      }
      if (!(await flush(pending.trim() ? pending : ""))) return { ok: false, text, emitted };
      const final = text.trim();
      return { ok: final.length > 0, text: final, emitted };
    } catch {
      return { ok: false, text, emitted };
    } finally {
      clearTimeout(timer);
    }
  }
}
