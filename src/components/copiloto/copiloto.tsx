"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { AlertTriangle, ArrowRight, Check, CircleAlert, CircleCheck, Loader2, Send, ShieldAlert, Sparkles, X } from "lucide-react";
import { ChartCard } from "@/components/charts/charts";
import type { AppRoute, ChartSpec, ClarifyEvent, ConfirmResponse, Decision, DecisionEvent, DoneEvent, Draft, DraftCheck, ErrorEvent, NavigateEvent, Suggestion } from "./types";
import "./copiloto.css";

type Item =
  | { id: string; role: "user"; text: string }
  | {
      id: string;
      role: "assistant";
      text: string;
      pending: boolean;
      decision?: DecisionEvent;
      navigate?: NavigateEvent;
      clarify?: ClarifyEvent;
      draft?: Draft;
      charts?: ChartSpec[];
      error?: string;
    };

type AssistantItem = Extract<Item, { role: "assistant" }>;

const ROUTE_LABELS: Record<AppRoute, string> = {
  "/": "Resumen",
  "/productos": "Productos",
  "/stock": "Stock",
  "/recepciones": "Recepciones",
  "/traspasos": "Traspasos",
  "/inventarios": "Inventarios",
  "/mermas": "Mermas",
  "/informes": "Informes",
};

const EXAMPLES = [
  "¿Qué me falta para el finde?",
  "¿Cuánto ron queda en Parador?",
  "El Barceló ahora cuesta 15 €",
  "Añade Ginebra Nordés 70 cl a 18 €",
];

const DECIMAL = /^\d+([.,]\d+)?$/;
/** Ediciones numéricas: se normalizan a "12.5". El resto (nombre, medida) va tal cual. */
const NUMERIC_PATH = /^(qtyBase|newPrice|price|packQtyBase|newValue|lines\.\d+\.(packPrice|qtyBase|packsQty))$/;

const euros = (value: string | null) =>
  value === null ? "—" : `${Number(value).toLocaleString("es-ES", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;
const DIMENSION_LABEL = { volume: "Volumen (ml)", mass: "Peso (g)", count: "Unidades" } as const;

function currentRoute(pathname: string | null): AppRoute {
  const route = (Object.keys(ROUTE_LABELS) as AppRoute[]).find((r) => r !== "/" && pathname?.startsWith(r));
  return route ?? "/";
}

/** Ruta de la app con los filtros que entienden las páginas (?local=, ?producto=, ?estado=). */
function hrefFor(nav: NavigateEvent): string {
  const params = new URLSearchParams();
  if (nav.filters.locationId) params.set("local", nav.filters.locationId);
  if (nav.filters.productId) params.set("producto", nav.filters.productId);
  if (nav.filters.status) params.set("estado", nav.filters.status);
  if (nav.filters.view) params.set("vista", nav.filters.view);
  if (nav.filters.days) params.set("dias", String(nav.filters.days));
  const query = params.toString();
  return query ? `${nav.route}?${query}` : nav.route;
}

function confidence(d: Decision): string {
  return `${Math.round((d.confidence ?? d.probability) * 100)} %`;
}

function newId(): string {
  return crypto.randomUUID();
}

export function Copiloto() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[] | null>(null);
  const [pendingClarify, setPendingClarify] = useState<ClarifyEvent | null>(null);
  const sessionId = useRef<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const loadSuggestions = useCallback(async () => {
    try {
      const res = await fetch("/api/copiloto/suggestions?limit=5");
      if (!res.ok) return setSuggestions([]);
      const data = (await res.json()) as { items: Suggestion[] };
      setSuggestions(data.items);
    } catch {
      setSuggestions([]);
    }
  }, []);

  const toggle = useCallback(() => {
    setOpen((was) => {
      if (!was && suggestions === null) void loadSuggestions();
      return !was;
    });
  }, [loadSuggestions, suggestions]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        toggle();
      } else if (event.key === "Escape") {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggle]);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [items]);

  function update(id: string, patch: (item: AssistantItem) => Partial<AssistantItem>) {
    setItems((prev) => prev.map((item) => (item.id === id && item.role === "assistant" ? { ...item, ...patch(item) } : item)));
  }

  async function send(message: string, clarification?: { clarifyId: string; optionId: string; freeText?: string }) {
    if (busy || !message.trim()) return;
    sessionId.current ??= newId();
    const assistantId = newId();
    setBusy(true);
    setPendingClarify(null);
    setItems((prev) => [...prev, { id: newId(), role: "user", text: message }, { id: assistantId, role: "assistant", text: "", pending: true }]);

    let autoNavigate: NavigateEvent | null = null;
    try {
      const res = await fetch("/api/copiloto/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sessionId: sessionId.current, message, page: currentRoute(pathname), ...(clarification ? { clarification } : {}) }),
      });
      if (!res.ok || !res.body) {
        const error = (await res.json().catch(() => null)) as ErrorEvent | null;
        update(assistantId, () => ({ pending: false, error: error?.message ?? "El asistente no está disponible ahora." }));
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let cut = buffer.indexOf("\n\n");
        while (cut >= 0) {
          const block = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          cut = buffer.indexOf("\n\n");
          const event = /^event: (.*)$/m.exec(block)?.[1];
          const raw = /^data: (.*)$/m.exec(block)?.[1];
          if (!event || !raw) continue;
          const data: unknown = JSON.parse(raw);
          if (event === "decision") update(assistantId, () => ({ decision: data as DecisionEvent }));
          else if (event === "text") {
            const t = data as { delta: string; reset?: boolean };
            update(assistantId, (item) => ({ text: (t.reset ? "" : item.text) + t.delta }));
          } else if (event === "navigate") {
            const nav = data as NavigateEvent;
            if (nav.auto) autoNavigate = nav;
            update(assistantId, () => ({ navigate: nav }));
          } else if (event === "clarify") {
            setPendingClarify(data as ClarifyEvent);
            update(assistantId, () => ({ clarify: data as ClarifyEvent }));
          } else if (event === "draft") update(assistantId, () => ({ draft: data as Draft }));
          else if (event === "chart") update(assistantId, (item) => ({ charts: [...(item.charts ?? []), data as ChartSpec] }));
          else if (event === "error") update(assistantId, () => ({ error: (data as ErrorEvent).message }));
          else if (event === "done") update(assistantId, () => ({ text: (data as DoneEvent).text, pending: false }));
        }
      }
    } catch {
      update(assistantId, () => ({ error: "Se ha perdido la conexión con el asistente." }));
    } finally {
      update(assistantId, () => ({ pending: false }));
      setBusy(false);
    }
    if (autoNavigate) window.location.assign(hrefFor(autoNavigate));
  }

  function submit(event: React.FormEvent) {
    event.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput("");
    // Texto libre como respuesta a una aclaración abierta.
    if (pendingClarify) void send(text, { clarifyId: pendingClarify.clarifyId, optionId: "otra", freeText: text });
    else void send(text);
  }

  // Otras pantallas (p. ej. /informes) pueden abrir el asistente con una pregunta.
  const sendRef = useRef(send);
  useEffect(() => {
    sendRef.current = send;
  });
  useEffect(() => {
    function onAsk(event: Event) {
      const message = (event as CustomEvent<{ message?: string }>).detail?.message;
      setOpen(true);
      if (message) void sendRef.current(message);
    }
    window.addEventListener("copiloto:ask", onAsk);
    return () => window.removeEventListener("copiloto:ask", onAsk);
  }, []);

  if (pathname?.startsWith("/login")) return null;

  return (
    <>
      <button type="button" className="copiloto-launcher" onClick={toggle} aria-label="Abrir asistente (Ctrl+K)">
        <Sparkles size={18} />
        <span>Asistente</span>
        <kbd>Ctrl K</kbd>
      </button>

      {open && (
        <div className="copiloto-overlay" onClick={() => setOpen(false)}>
          <aside className="copiloto-panel" role="dialog" aria-label="Asistente de inventario" onClick={(event) => event.stopPropagation()}>
            <header className="copiloto-header">
              <div className="copiloto-title">
                <span className="copiloto-mark"><Sparkles size={15} /></span>
                <div>
                  <strong>Asistente</strong>
                  <small>Consulta, navega y prepara operaciones</small>
                </div>
              </div>
              <button type="button" className="icon-button" onClick={() => setOpen(false)} aria-label="Cerrar">
                <X size={17} />
              </button>
            </header>

            <div className="copiloto-list" ref={listRef}>
              {items.length === 0 && (
                <div className="copiloto-empty">
                  <p className="copiloto-section">Ahora mismo</p>
                  {suggestions === null && <p className="copiloto-muted"><Loader2 size={14} className="copiloto-spin" /> Buscando qué revisar…</p>}
                  {suggestions?.length === 0 && <p className="copiloto-muted">Nada urgente que revisar.</p>}
                  {suggestions?.map((s) => (
                    <button
                      type="button"
                      key={s.id}
                      className={`copiloto-suggestion ${s.urgency}`}
                      onClick={() => s.action && window.location.assign(hrefFor(s.action))}
                    >
                      <i />
                      <span>{s.text}</span>
                      {s.action && <ArrowRight size={14} />}
                    </button>
                  ))}
                  <p className="copiloto-section">Prueba con</p>
                  <div className="copiloto-examples">
                    {EXAMPLES.map((example) => (
                      <button type="button" key={example} onClick={() => void send(example)}>{example}</button>
                    ))}
                  </div>
                </div>
              )}

              {items.map((item) =>
                item.role === "user" ? (
                  <div key={item.id} className="copiloto-msg user"><p>{item.text}</p></div>
                ) : (
                  <div key={item.id} className="copiloto-msg assistant">
                    {item.decision && (
                      <div className="copiloto-chips">
                        {[item.decision.intent, ...item.decision.decisions].map((d) => (
                          <span key={d.id} className={`copiloto-chip ${d.gate}`} title={`${d.label}: ${d.valueLabel}`}>
                            {d.label}: <b>{d.valueLabel}</b> {item.decision?.shortcut ? "" : confidence(d)}
                          </span>
                        ))}
                      </div>
                    )}
                    {item.pending && !item.text && <p className="copiloto-muted"><Loader2 size={14} className="copiloto-spin" /> Pensando…</p>}
                    {item.text && <p className="copiloto-text">{item.text}</p>}
                    {item.error && <p className="copiloto-error"><AlertTriangle size={14} /> {item.error}</p>}
                    {item.clarify && item.clarify.options.length > 0 && (
                      <div className="copiloto-options">
                        {item.clarify.options.map((option) => (
                          <button
                            type="button"
                            key={option.id}
                            disabled={busy || pendingClarify?.clarifyId !== item.clarify?.clarifyId}
                            onClick={() => item.clarify && void send(option.label, { clarifyId: item.clarify.clarifyId, optionId: option.id })}
                          >
                            {option.label}
                          </button>
                        ))}
                      </div>
                    )}
                    {item.charts?.map((chart) => <ChartCard key={chart.id} spec={chart} compact />)}
                    {item.draft && <DraftCard draft={item.draft} />}
                    {item.navigate && !item.navigate.auto && (
                      <a className="copiloto-link" href={hrefFor(item.navigate)}>
                        Ver en {ROUTE_LABELS[item.navigate.route]} <ArrowRight size={13} />
                      </a>
                    )}
                  </div>
                ),
              )}
            </div>

            <form className="copiloto-input" onSubmit={submit}>
              <input
                ref={inputRef}
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder={pendingClarify ? "Responde o escribe otra cosa…" : "Pregunta o pide una operación…"}
                maxLength={1000}
              />
              <button type="submit" className="primary-button" disabled={busy || !input.trim()} aria-label="Enviar">
                {busy ? <Loader2 size={16} className="copiloto-spin" /> : <Send size={16} />}
              </button>
            </form>
          </aside>
        </div>
      )}
    </>
  );
}

function DraftCard({ draft }: { draft: Draft }) {
  const [edits, setEdits] = useState<Record<string, string | boolean>>({});
  const [key, setKey] = useState(() => newId());
  const [state, setState] = useState<"idle" | "sending" | "done">("idle");
  const [result, setResult] = useState<ConfirmResponse | null>(null);
  const [invalid, setInvalid] = useState("");

  function edit(path: string, value: string | boolean) {
    setEdits((prev) => ({ ...prev, [path]: value }));
  }

  async function confirm() {
    const normalized: Record<string, string | boolean> = {};
    for (const [path, value] of Object.entries(edits)) {
      if (typeof value === "string" && NUMERIC_PATH.test(path)) {
        const clean = value.trim().replace(",", ".");
        if (!DECIMAL.test(clean)) {
          setInvalid("Revisa las cifras: usa números como 12,50.");
          return;
        }
        normalized[path] = clean;
      } else normalized[path] = typeof value === "string" ? value.trim() : value;
    }
    setInvalid("");
    setState("sending");
    try {
      const res = await fetch("/api/copiloto/actions/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ draftId: draft.draftId, idempotencyKey: key, edits: normalized }),
      });
      const data = (await res.json()) as ConfirmResponse;
      setResult(data);
      setState(data.ok ? "done" : "idle");
      // Tras un fallo, un nuevo clic es un intento nuevo.
      if (!data.ok) setKey(newId());
    } catch {
      setResult({ ok: false, code: "internal", message: "No se ha podido confirmar. Inténtalo de nuevo." });
      setState("idle");
      setKey(newId());
    }
  }

  const locked = state !== "idle";
  const needsAck = draft.checks?.some((c) => c.status === "revisar") ?? false;
  const acknowledged = edits.acknowledged === true;

  return (
    <div className={`copiloto-draft${needsAck ? " needs-review" : ""}`}>
      <strong>{draft.title}</strong>
      {draft.checks && draft.checks.length > 0 && <Checks checks={draft.checks} />}
      {draft.warnings.map((warning) => (
        <p key={warning} className="copiloto-warning"><AlertTriangle size={13} /> {warning}</p>
      ))}

      {draft.kind === "precio" && (
        <>
          <p className="copiloto-detail">
            {draft.packName} · {draft.supplierName}
            <br />
            Antes: <b>{euros(draft.oldPrice)}</b> · coste unitario nuevo: {draft.unitCost}
          </p>
          <label className="copiloto-field">
            Precio nuevo por {draft.packName} (€)
            <input defaultValue={draft.newPrice.replace(".", ",")} disabled={locked} inputMode="decimal" onChange={(event) => edit("newPrice", event.target.value)} />
          </label>
        </>
      )}

      {draft.kind === "producto_nuevo" && (
        <>
          <label className="copiloto-field">
            Nombre
            <input defaultValue={draft.name} disabled={locked} maxLength={80} onChange={(event) => edit("name", event.target.value)} />
          </label>
          <div className="copiloto-row">
            <label className="copiloto-field">
              Cómo se mide
              <select defaultValue={draft.dimension} disabled={locked} onChange={(event) => edit("dimension", event.target.value)}>
                {(Object.keys(DIMENSION_LABEL) as Array<keyof typeof DIMENSION_LABEL>).map((d) => (
                  <option key={d} value={d}>{DIMENSION_LABEL[d]}</option>
                ))}
              </select>
            </label>
            {draft.price !== null && (
              <label className="copiloto-field">
                Precio (€)
                <input defaultValue={draft.price.replace(".", ",")} disabled={locked} inputMode="decimal" onChange={(event) => edit("price", event.target.value)} />
              </label>
            )}
          </div>
          <p className="copiloto-detail">
            Categoría: <b>{draft.categoryName ?? "sin categoría"}</b>
            {draft.packName && <> · Formato: <b>{draft.packName}</b></>}
            {draft.supplierName && <> · Proveedor: <b>{draft.supplierName}</b></>}
            {draft.locationNames.length > 0 && <> · Activo en: <b>{draft.locationNames.join(", ")}</b></>}
          </p>
        </>
      )}

      {draft.kind === "minimo" && (
        <label className="copiloto-field">
          {draft.field === "min_qty" ? "Mínimo" : "Objetivo"} en {draft.locationName} ({draft.baseUnit}) · antes: {draft.oldValue ?? "sin definir"}
          <input defaultValue={draft.newValue} disabled={locked} inputMode="decimal" onChange={(event) => edit("newValue", event.target.value)} />
        </label>
      )}

      {draft.kind === "archivar" && (
        <p className="copiloto-detail">Dejará de aparecer en recepciones, traspasos, mermas e inventarios. Conserva su historial y puedes restaurarlo desde su ficha.</p>
      )}

      {draft.kind === "merma" && draft.editable.includes("qtyBase") && (
        <label className="copiloto-field">
          Cantidad ({draft.baseUnit})
          <input defaultValue={draft.qtyBase} disabled={locked} inputMode="decimal" onChange={(event) => edit("qtyBase", event.target.value)} />
        </label>
      )}

      {draft.kind === "traspaso" && (
        <>
          <ul className="copiloto-lines">
            {draft.lines.map((line) => (
              <li key={line.productName}>{line.productName}: {line.qtyBase} {line.baseUnit}</li>
            ))}
          </ul>
          {draft.send && (
            <label className="copiloto-check">
              <input type="checkbox" defaultChecked disabled={locked} onChange={(event) => edit("send", event.target.checked)} /> Enviar ahora (si no, queda en borrador)
            </label>
          )}
        </>
      )}

      {draft.kind === "recepcion" &&
        draft.lines.map((line, index) => (
          <label key={`${line.packName}-${line.productName}`} className="copiloto-field">
            {line.packsQty} × {line.packName} · precio por formato (€)
            <input
              defaultValue={line.packPrice ?? ""}
              placeholder="Precio"
              disabled={locked}
              inputMode="decimal"
              onChange={(event) => edit(`lines.${index}.packPrice`, event.target.value)}
            />
          </label>
        ))}

      {draft.kind === "cierre_inventario" && (
        <>
          <ul className="copiloto-lines">
            {draft.preview.adjustments.map((a) => (
              <li key={a.productName}>{a.productName}: {a.expected} → {a.counted} {a.baseUnit} ({a.diffValue} €)</li>
            ))}
          </ul>
          <label className="copiloto-check">
            <input type="checkbox" disabled={locked} onChange={(event) => edit("zeroUncounted", event.target.checked)} /> Poner a cero lo no contado
          </label>
          <label className="copiloto-check">
            <input type="checkbox" defaultChecked={draft.asConsumption} disabled={locked} onChange={(event) => edit("asConsumption", event.target.checked)} /> Lo que falta es consumo (no un ajuste)
          </label>
        </>
      )}

      {needsAck && state !== "done" && (
        <label className="copiloto-check copiloto-ack">
          <input type="checkbox" checked={acknowledged} disabled={locked} onChange={(event) => edit("acknowledged", event.target.checked)} /> He revisado los avisos marcados
        </label>
      )}

      <div className="copiloto-draft-actions">
        <span className="copiloto-muted">Coherencia {Math.round(draft.coherence * 100)} %</span>
        {state === "done" ? (
          <span className="copiloto-ok"><Check size={14} /> Hecho</span>
        ) : (
          <button type="button" className="primary-button" disabled={!draft.canConfirm || locked || (needsAck && !acknowledged)} onClick={() => void confirm()}>
            {state === "sending" ? <Loader2 size={14} className="copiloto-spin" /> : <Check size={14} />}
            {draft.canConfirm ? "Confirmar" : "Requiere encargado"}
          </button>
        )}
      </div>
      {invalid && <p className="copiloto-error">{invalid}</p>}
      {result && (
        <p className={result.ok ? "copiloto-ok" : "copiloto-error"}>
          {result.message}{" "}
          {result.ok && result.navigate && <a href={hrefFor(result.navigate)}>Ver en {ROUTE_LABELS[result.navigate.route]}</a>}
        </p>
      )}
    </div>
  );
}

const CHECK_ICON = { ok: CircleCheck, aviso: CircleAlert, revisar: ShieldAlert } as const;

/** Comprobaciones del borrador: qué ha verificado el asistente y con qué resultado. */
function Checks({ checks }: { checks: DraftCheck[] }) {
  return (
    <ul className="copiloto-checks" aria-label="Comprobaciones">
      {checks.map((c) => {
        const Icon = CHECK_ICON[c.status];
        return (
          <li key={c.id} className={c.status}>
            <Icon size={14} />
            <span>
              <b>{c.label}:</b> {c.detail}
            </span>
            {c.probability !== null && <small title="Seguridad de Jev">{Math.round(c.probability * 100)} %</small>}
          </li>
        );
      })}
    </ul>
  );
}
