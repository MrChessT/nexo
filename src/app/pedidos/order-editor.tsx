"use client";

import { useMemo, useState } from "react";
import Decimal from "decimal.js";
import { Check, Copy, Mail, MessageCircle, PackageCheck, Plus, Search, Send, Trash2, X, XCircle } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { decimalText as num, euros, inputText, normalizeText, parseDecimal as parse } from "@/lib/format";
import { canManage, orderText, orderTotal, saveDraft, STATUS_LABEL, type Order, type OrderLine, type Reference } from "./orders-data";

// Ficha de un pedido. Borrador: se edita y se envía (encargado). Enviado o parcial: se recibe
// (cualquiera con acceso al local) o se cancela (encargado). Recibido o cancelado: solo lectura.

type Mode = "edit" | "view" | "receive";

function rpcMessage(message: string | undefined, fallback: string) {
  if (!message) return fallback;
  if (message.includes("forbidden")) return "No tienes permisos para esta acción (hace falta un encargado).";
  if (message.includes("invalid_status")) return "El pedido ya cambió de estado. Recarga la lista.";
  if (message.includes("empty_order")) return "Añade al menos una línea antes de enviarlo.";
  if (message.includes("invalid_quantity")) return "Revisa las cantidades y los precios recibidos.";
  return fallback;
}

export function OrderEditor({
  reference,
  order,
  defaultLocationId,
  onClose,
  onChanged,
}: {
  reference: Reference;
  order: Order | null;
  defaultLocationId: string;
  onClose: () => void;
  /** Mensaje para el usuario y, si procede, la pestaña donde queda el pedido. */
  onChanged: (message: string, tab?: "draft" | "open" | "received" | "cancelled") => void;
}) {
  const isNew = !order;
  const draft = isNew || order.status === "draft";
  const [mode, setMode] = useState<Mode>(draft ? "edit" : "view");
  const [locationId, setLocationId] = useState(order?.locationId ?? defaultLocationId ?? reference.locations[0]?.id ?? "");
  const [supplierId, setSupplierId] = useState(order?.supplierId ?? "");
  const [note, setNote] = useState(order?.note ?? "");
  const [expectedDate, setExpectedDate] = useState(order?.expectedDate ?? "");
  const [lines, setLines] = useState<OrderLine[]>(order?.lines ?? []);
  const [search, setSearch] = useState("");
  const [receive, setReceive] = useState<Record<string, { qty: string; price: string }>>({});
  const [docNumber, setDocNumber] = useState("");
  const [closeOrder, setCloseOrder] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const supplier = reference.suppliers.find((s) => s.id === supplierId);
  const manager = canManage(reference.role);
  const current: Order = {
    id: order?.id ?? "",
    status: order?.status ?? "draft",
    locationId,
    locationName: reference.locations.find((l) => l.id === locationId)?.name ?? order?.locationName ?? "",
    supplierId,
    supplierName: supplier?.name ?? order?.supplierName ?? "",
    note,
    expectedDate,
    createdAt: order?.createdAt ?? "",
    sentAt: order?.sentAt ?? null,
    lines,
  };
  const total = orderTotal(current);

  const results = useMemo(() => {
    if (search.trim().length < 2) return [];
    const used = new Set(lines.map((l) => l.packId));
    return [...reference.packs.values()]
      .filter((p) => !used.has(p.id) && normalizeText(`${p.productName} ${p.name}`).includes(normalizeText(search)))
      .slice(0, 8);
  }, [search, lines, reference.packs]);

  function addPack(packId: string) {
    const price = reference.lastPrices.get(`${supplierId}:${packId}`) ?? "";
    setLines((ls) => [...ls, { packId, packsQty: "1", packPrice: price ? inputText(price) : "", receivedPacks: "0" }]);
    setSearch("");
  }

  function patchLine(packId: string, patch: Partial<OrderLine>) {
    setLines((ls) => ls.map((l) => (l.packId === packId ? { ...l, ...patch } : l)));
  }

  function validate(): string | null {
    if (!locationId) return "Elige el local.";
    if (!supplierId) return "Elige el proveedor.";
    if (lines.length === 0) return "Añade al menos un producto.";
    for (const l of lines) {
      const name = reference.packs.get(l.packId)?.productName ?? "un producto";
      if (!(parse(l.packsQty) ?? new Decimal(0)).gt(0)) return `Revisa la cantidad de ${name}.`;
      if (l.packPrice.trim() && parse(l.packPrice) === null) return `Revisa el precio de ${name}.`;
    }
    return null;
  }

  async function save(): Promise<string | null> {
    const invalid = validate();
    if (invalid) {
      setError(invalid);
      return null;
    }
    setSaving(true);
    setError("");
    try {
      const id = await saveDraft(reference, { id: order?.id, locationId, supplierId, note, expectedDate, lines });
      setSaving(false);
      return id;
    } catch (err) {
      setSaving(false);
      setError(err instanceof Error ? err.message : "No se pudo guardar.");
      return null;
    }
  }

  async function saveAndClose() {
    if (await save()) onChanged(isNew ? "Pedido guardado como borrador." : "Borrador actualizado.", "draft");
  }

  async function send() {
    const id = await save();
    if (!id) return;
    setSaving(true);
    const { error: err } = (await createClient()?.rpc("send_order", { p_order: id })) ?? { error: null };
    setSaving(false);
    if (err) return setError(rpcMessage(err.message, "No se pudo enviar el pedido."));
    // Se abre el correo con el pedido ya escrito (si el proveedor tiene email).
    if (supplier?.email) {
      const subject = `Pedido ${reference.orgName} · ${current.locationName}`;
      window.location.assign(`mailto:${supplier.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(orderText(reference, current))}`);
    }
    onChanged(supplier?.email ? "Pedido enviado: revisa el correo que se ha abierto y envíalo." : "Pedido marcado como enviado. Copia el texto y mándaselo al proveedor.", "open");
  }

  async function copyText() {
    try {
      await navigator.clipboard.writeText(orderText(reference, current));
      setCopied(true);
    } catch {
      setError("No se pudo copiar el texto.");
    }
  }

  function startReceive() {
    const initial: Record<string, { qty: string; price: string }> = {};
    for (const l of lines) {
      const remaining = Decimal.max(0, new Decimal(l.packsQty).minus(l.receivedPacks));
      initial[l.packId] = { qty: remaining.gt(0) ? inputText(remaining) : "", price: inputText(l.packPrice || (reference.lastPrices.get(`${supplierId}:${l.packId}`) ?? "0")) };
    }
    setReceive(initial);
    setMode("receive");
  }

  async function confirmReceive() {
    const received = Object.entries(receive)
      .map(([packId, r]) => ({ packId, qty: parse(r.qty), price: parse(r.price) }))
      .filter((r) => r.qty && r.qty.gt(0));
    if (received.length === 0) return setError("Indica al menos una cantidad recibida.");
    if (received.some((r) => r.price === null)) return setError("Revisa los precios: usa números como 12,50.");
    setSaving(true);
    setError("");
    const { error: err } = (await createClient()?.rpc("receive_order", {
      p_order: order!.id,
      p_lines: received.map((r) => ({ pack_id: r.packId, packs_qty: r.qty!.toString(), pack_price: r.price!.toString() })),
      p_doc_number: docNumber.trim() || null,
      p_close: closeOrder,
    })) ?? { error: null };
    setSaving(false);
    if (err) return setError(rpcMessage(err.message, "No se pudo registrar la recepción."));
    onChanged("Mercancía recibida: stock y precios actualizados.");
  }

  async function cancel() {
    if (!window.confirm("¿Cancelar este pedido? Lo ya recibido se mantiene.")) return;
    setSaving(true);
    const { error: err } = (await createClient()?.rpc("cancel_order", { p_order: order!.id })) ?? { error: null };
    setSaving(false);
    if (err) return setError(rpcMessage(err.message, "No se pudo cancelar."));
    onChanged("Pedido cancelado.", "cancelled");
  }

  async function removeDraft() {
    if (!order || !window.confirm("¿Eliminar este borrador?")) return;
    setSaving(true);
    const { data, error: err } = (await createClient()?.from("purchase_orders").delete().eq("id", order.id).select("id")) ?? { data: null, error: null };
    setSaving(false);
    if (err || !data?.length) return setError("No se pudo eliminar el borrador.");
    onChanged("Borrador eliminado.");
  }

  const whatsapp = supplier?.phone ? `https://wa.me/${supplier.phone.replace(/\D/g, "")}?text=${encodeURIComponent(orderText(reference, current))}` : null;

  return (
    <div className="modal-layer editor-layer" onClick={() => !saving && onClose()}>
      <section className="product-editor order-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Pedido">
        <header className="editor-header">
          <div>
            <p className="eyebrow">{isNew ? "Nuevo pedido" : `Pedido · ${STATUS_LABEL[current.status]}`}</p>
            <h2>{current.supplierName || "Elige proveedor"}</h2>
            {!isNew && <span className={`order-status ${current.status}`}>{STATUS_LABEL[current.status]}</span>}
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </header>

        <div className="editor-body">
          <div className="editor-grid">
            <label>
              Local
              <select value={locationId} disabled={!isNew} onChange={(event) => setLocationId(event.target.value)}>
                {reference.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label>
              Proveedor
              <select value={supplierId} disabled={mode !== "edit"} onChange={(event) => setSupplierId(event.target.value)}>
                <option value="">Elige proveedor</option>
                {reference.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>
              Entrega prevista
              <input type="date" value={expectedDate} disabled={mode !== "edit"} onChange={(event) => setExpectedDate(event.target.value)} />
            </label>
            <label>
              Nota para el proveedor
              <input value={note} disabled={mode !== "edit"} maxLength={500} onChange={(event) => setNote(event.target.value)} placeholder="Opcional: horario de entrega, referencia…" />
            </label>
          </div>

          <div className="editor-section order-lines">
            <div className="editor-table">
              <div className={`editor-head ${mode === "receive" ? "receive-row" : "order-row"}`}>
                <span>Producto</span>
                {mode === "receive" ? (
                  <><span>Pedido</span><span>Ya recibido</span><span>Recibo ahora</span><span>Precio</span></>
                ) : (
                  <><span>Cantidad</span><span>Precio / formato</span><span>Importe</span><span /></>
                )}
              </div>
              {lines.map((l) => {
                const pack = reference.packs.get(l.packId);
                const amount = new Decimal(parse(l.packsQty) ?? 0).mul(parse(l.packPrice) ?? 0);
                if (mode === "receive") {
                  const r = receive[l.packId] ?? { qty: "", price: "" };
                  return (
                    <div className="editor-row receive-row" key={l.packId}>
                      <span><b>{pack?.productName ?? "Producto"}</b><small>{pack?.name}</small></span>
                      <span>{num(l.packsQty)}</span>
                      <span>{num(l.receivedPacks)}</span>
                      <input inputMode="decimal" value={r.qty} onChange={(event) => setReceive({ ...receive, [l.packId]: { ...r, qty: event.target.value } })} aria-label={`Recibido de ${pack?.productName}`} />
                      <div className="money-input">
                        <input inputMode="decimal" value={r.price} onChange={(event) => setReceive({ ...receive, [l.packId]: { ...r, price: event.target.value } })} aria-label={`Precio de ${pack?.productName}`} />
                        <span>€</span>
                      </div>
                    </div>
                  );
                }
                return (
                  <div className="editor-row order-row" key={l.packId}>
                    <span><b>{pack?.productName ?? "Producto"}</b><small>{pack?.name}{new Decimal(l.receivedPacks).gt(0) ? ` · recibido ${num(l.receivedPacks)}` : ""}</small></span>
                    <input inputMode="decimal" value={mode === "edit" ? l.packsQty : num(l.packsQty)} disabled={mode !== "edit"} onChange={(event) => patchLine(l.packId, { packsQty: event.target.value })} aria-label={`Cantidad de ${pack?.productName}`} />
                    <div className="money-input">
                      <input inputMode="decimal" value={mode === "edit" ? l.packPrice : l.packPrice ? num(l.packPrice) : ""} placeholder="—" disabled={mode !== "edit"} onChange={(event) => patchLine(l.packId, { packPrice: event.target.value })} aria-label={`Precio de ${pack?.productName}`} />
                      <span>€</span>
                    </div>
                    <span className="muted">{amount.gt(0) ? euros(amount) : "—"}</span>
                    {mode === "edit" ? (
                      <button type="button" className="icon-danger" aria-label={`Quitar ${pack?.productName}`} onClick={() => setLines((ls) => ls.filter((x) => x.packId !== l.packId))}><Trash2 size={15} /></button>
                    ) : <span />}
                  </div>
                );
              })}
              {lines.length === 0 && <p className="editor-empty">Añade productos buscándolos abajo, o usa «Sugerir pedido» en la lista.</p>}
            </div>

            {mode === "edit" && (
              <div className="order-search">
                <Search size={15} />
                <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Añadir producto: escribe su nombre" />
                {results.length > 0 && (
                  <ul className="order-results">
                    {results.map((p) => (
                      <li key={p.id}>
                        <button type="button" onClick={() => addPack(p.id)}>
                          <Plus size={13} /> <b>{p.productName}</b> <small>{p.name}</small>
                          {reference.lastPrices.get(`${supplierId}:${p.id}`) && <em>{euros(reference.lastPrices.get(`${supplierId}:${p.id}`)!)}</em>}
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}

            {mode === "receive" && (
              <div className="editor-grid receive-extra">
                <label>Nº de albarán<input value={docNumber} onChange={(event) => setDocNumber(event.target.value)} placeholder="Opcional" /></label>
                <label className="check-option">
                  <input type="checkbox" checked={closeOrder} onChange={(event) => setCloseOrder(event.target.checked)} /> Cerrar el pedido aunque falte algo
                </label>
              </div>
            )}

            {mode !== "receive" && <p className="order-total">Total estimado: <b>{euros(total)}</b></p>}
          </div>
        </div>

        {error && <p className="editor-message error">{error}</p>}

        <footer className="editor-footer">
          <div className="footer-left">
            {!isNew && current.status === "draft" && <button className="ghost-button danger" disabled={saving} onClick={() => void removeDraft()}><Trash2 size={14} /> Eliminar</button>}
            {(current.status === "sent" || current.status === "partial") && manager && mode === "view" && (
              <button className="ghost-button danger" disabled={saving} onClick={() => void cancel()}><XCircle size={14} /> Cancelar pedido</button>
            )}
            {!isNew && current.status !== "cancelled" && (
              <>
                <button className="ghost-button" onClick={() => void copyText()}>{copied ? <><Check size={14} /> Copiado</> : <><Copy size={14} /> Copiar texto</>}</button>
                {whatsapp && <a className="ghost-button" href={whatsapp} target="_blank" rel="noreferrer"><MessageCircle size={14} /> WhatsApp</a>}
              </>
            )}
          </div>
          <div className="footer-right">
            {mode === "edit" && (
              <>
                <button className="ghost-button" disabled={saving} onClick={() => void saveAndClose()}>Guardar borrador</button>
                <button className="catalog-primary" disabled={saving || !manager} title={manager ? undefined : "Solo un encargado puede enviar pedidos"} onClick={() => void send()}>
                  {supplier?.email ? <Mail size={15} /> : <Send size={15} />} {saving ? "..." : "Enviar pedido"}
                </button>
              </>
            )}
            {mode === "view" && (current.status === "sent" || current.status === "partial") && (
              <button className="catalog-primary" onClick={startReceive}><PackageCheck size={15} /> Recibir mercancía</button>
            )}
            {mode === "receive" && (
              <>
                <button className="ghost-button" disabled={saving} onClick={() => setMode("view")}>Volver</button>
                <button className="catalog-primary" disabled={saving} onClick={() => void confirmReceive()}>{saving ? "Registrando..." : "Registrar recepción"}</button>
              </>
            )}
          </div>
        </footer>
      </section>
    </div>
  );
}
