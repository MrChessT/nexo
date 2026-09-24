// Proveedores de LLM para redactar. Intercambiables por .env: Ollama (desarrollo) u OpenAI-compatible
// (producción: OpenAI, Mistral, Groq, OpenRouter, vLLM…). Sin herramientas: solo texto de entrada y salida.

export interface ChatMessages {
  system: string;
  user: string;
}

export interface WriterProvider {
  readonly name: string;
  readonly model: string;
  stream(messages: ChatMessages, signal: AbortSignal): AsyncIterable<string>;
  ping(): Promise<boolean>;
}

export interface ProviderOptions {
  url: string;
  model: string;
  apiKey?: string;
  maxTokens: number;
  temperature: number;
  numCtx: number;
  keepAlive: string;
}

async function* lines(body: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of body as unknown as AsyncIterable<Uint8Array>) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline = buffer.indexOf("\n");
    while (newline >= 0) {
      yield buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
    }
  }
  if (buffer.trim()) yield buffer.trim();
}

export class OllamaProvider implements WriterProvider {
  readonly name = "ollama";

  constructor(private readonly options: ProviderOptions) {}

  get model(): string {
    return this.options.model;
  }

  async *stream(messages: ChatMessages, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(`${this.options.url}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal,
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        keep_alive: this.options.keepAlive,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
        options: { temperature: this.options.temperature, num_ctx: this.options.numCtx, num_predict: this.options.maxTokens },
      }),
    });
    if (!response.ok || !response.body) throw new Error(`Ollama respondió ${response.status}`);
    for await (const line of lines(response.body)) {
      if (!line) continue;
      const data = JSON.parse(line) as { message?: { content?: string }; done?: boolean; error?: string };
      if (data.error) throw new Error(`Ollama: ${data.error}`);
      if (data.message?.content) yield data.message.content;
      if (data.done) return;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.url}/api/tags`, { signal: AbortSignal.timeout(2000) });
      if (!response.ok) return false;
      const data = (await response.json()) as { models?: Array<{ name: string }> };
      return (data.models ?? []).some((m) => m.name === this.options.model || m.name === `${this.options.model}:latest`);
    } catch {
      return false;
    }
  }

  /** Carga el modelo en memoria para que la primera respuesta no pague el arranque. */
  async preload(): Promise<void> {
    await fetch(`${this.options.url}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: this.options.model, keep_alive: this.options.keepAlive }),
      signal: AbortSignal.timeout(60_000),
    }).catch(() => undefined);
  }
}

export class OpenAICompatibleProvider implements WriterProvider {
  readonly name = "openai";

  constructor(private readonly options: ProviderOptions) {}

  get model(): string {
    return this.options.model;
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      ...(this.options.apiKey ? { Authorization: `Bearer ${this.options.apiKey}` } : {}),
    };
  }

  async *stream(messages: ChatMessages, signal: AbortSignal): AsyncIterable<string> {
    const response = await fetch(`${this.options.url}/v1/chat/completions`, {
      method: "POST",
      headers: this.headers(),
      signal,
      body: JSON.stringify({
        model: this.options.model,
        stream: true,
        temperature: this.options.temperature,
        max_tokens: this.options.maxTokens,
        messages: [
          { role: "system", content: messages.system },
          { role: "user", content: messages.user },
        ],
      }),
    });
    if (!response.ok || !response.body) throw new Error(`LLM respondió ${response.status}`);
    for await (const line of lines(response.body)) {
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (payload === "[DONE]") return;
      const data = JSON.parse(payload) as { choices?: Array<{ delta?: { content?: string } }> };
      const content = data.choices?.[0]?.delta?.content;
      if (content) yield content;
    }
  }

  async ping(): Promise<boolean> {
    try {
      const response = await fetch(`${this.options.url}/v1/models`, { headers: this.headers(), signal: AbortSignal.timeout(3000) });
      return response.ok;
    } catch {
      return false;
    }
  }
}
