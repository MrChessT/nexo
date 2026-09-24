"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowLeft, CirclePlus, ShoppingCart, Sparkles } from "lucide-react";
import { euros } from "@/lib/format";
import { readLocation } from "@/lib/location-preference";
import { loadOrders, loadReference, orderTotal, STATUS_LABEL, type Order, type OrderStatus, type Reference } from "./orders-data";
import { OrderEditor } from "./order-editor";
import { SuggestModal } from "./suggest-modal";
import "../productos/productos.css";
import "../productos/product-editor.css";
import "../proveedores/proveedores.css";
import "./pedidos.css";

// Pedidos a proveedor: borradores, enviados (pendientes de recibir), recibidos y cancelados.

type Tab = "draft" | "open" | "received" | "cancelled";
const TAB_STATUSES: Record<Tab, OrderStatus[]> = { draft: ["draft"], open: ["sent", "partial"], received: ["received"], cancelled: ["cancelled"] };
const TAB_LABEL: Record<Tab, string> = { draft: "Borradores", open: "Pendientes de recibir", received: "Recibidos", cancelled: "Cancelados" };

export default function OrdersPage() {
  const [reference, setReference] = useState<Reference | null>(null);
  const [tab, setTab] = useState<Tab>("open");
  const [location, setLocation] = useState("");
  const [orders, setOrders] = useState<Order[] | null>(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [editing, setEditing] = useState<Order | "new" | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    async function start() {
      await Promise.resolve();
      const params = new URLSearchParams(window.location.search);
      try {
        const ref = await loadReference();
        setReference(ref);
        const wanted = params.get("local") ?? readLocation();
        setLocation(ref.locations.some((l) => l.id === wanted) ? wanted : "");
        // Desde el resumen («Ver qué reponer») se abre directamente la sugerencia.
        if (params.has("sugerir")) setSuggesting(true);
        // El asistente enlaza aquí tras crear borradores (?estado=draft).
        if (params.get("estado") === "draft") setTab("draft");
      } catch (err) {
        setError(err instanceof Error ? err.message : "No se pudieron cargar los datos.");
      }
    }
    void start();
  }, []);

  useEffect(() => {
    if (!reference) return;
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      try {
        const list = await loadOrders(TAB_STATUSES[tab], location);
        if (!cancelled) {
          setOrders(list);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudieron cargar los pedidos.");
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [reference, tab, location, reloadKey]);

  function done(message: string, goTo?: Tab) {
    setNotice(message);
    setEditing(null);
    setSuggesting(false);
    if (goTo) setTab(goTo);
    setReloadKey((k) => k + 1);
  }

  return (
    <main className="catalog-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link"><ArrowLeft size={16} /> Resumen</Link>
        <span className="catalog-title">Pedidos</span>
        <span />
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Operativa · Compras</p>
            <h1>Pedidos</h1>
            <p className="catalog-subtitle">Pide lo que falta, envíalo al proveedor y recíbelo contra el pedido.</p>
          </div>
          {reference && (
            <div className="orders-actions">
              <button className="ghost-button" onClick={() => setEditing("new")}><CirclePlus size={15} /> Nuevo pedido</button>
              <button className="catalog-primary" onClick={() => setSuggesting(true)}><Sparkles size={16} /> Sugerir pedido</button>
            </div>
          )}
        </div>

        {notice && <p className="page-notice">{notice}</p>}

        <div className="catalog-tabs">
          {(Object.keys(TAB_LABEL) as Tab[]).map((t) => (
            <button key={t} className={tab === t ? "active" : undefined} onClick={() => setTab(t)}>{TAB_LABEL[t]}</button>
          ))}
        </div>

        <section className="catalog-panel">
          <div className="catalog-toolbar">
            <label className="filter-button">
              Local
              <select className="orders-location" value={location} onChange={(event) => setLocation(event.target.value)} aria-label="Local">
                <option value="">Todos</option>
                {reference?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <span className="table-result-count">{orders ? `${orders.length} pedidos` : ""}</span>
          </div>
          <div className="orders-head"><span>Proveedor</span><span>Local</span><span>Líneas</span><span>Total</span><span>Estado</span></div>
          {error && <div className="catalog-empty"><strong>{error}</strong></div>}
          {!error && !orders && <div className="catalog-empty"><strong>Cargando pedidos...</strong></div>}
          {!error &&
            orders?.map((o) => (
              <div
                key={o.id}
                className="orders-row"
                role="button"
                tabIndex={0}
                onClick={() => setEditing(o)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    setEditing(o);
                  }
                }}
              >
                <span className="catalog-product">
                  <span className="catalog-product-icon"><ShoppingCart size={16} /></span>
                  <span>
                    <strong>{o.supplierName}</strong>
                    <small>
                      {new Date(o.sentAt ?? o.createdAt).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}
                      {o.expectedDate ? ` · entrega ${new Date(`${o.expectedDate}T12:00:00`).toLocaleDateString("es-ES", { day: "numeric", month: "short" })}` : ""}
                    </small>
                  </span>
                </span>
                <span>{o.locationName}</span>
                <span>{o.lines.length}</span>
                <span>{euros(orderTotal(o))}</span>
                <span className={`order-status ${o.status}`}>{STATUS_LABEL[o.status]}</span>
              </div>
            ))}
          {!error && orders?.length === 0 && (
            <div className="catalog-empty">
              <strong>{tab === "open" ? "No hay pedidos pendientes de recibir" : tab === "draft" ? "No hay borradores" : "Nada por aquí"}</strong>
              {(tab === "open" || tab === "draft") && <span>Usa «Sugerir pedido» para preparar los pedidos de la semana en un momento.</span>}
            </div>
          )}
        </section>
      </div>

      {reference && editing && (
        <OrderEditor
          reference={reference}
          order={editing === "new" ? null : editing}
          defaultLocationId={location}
          onClose={() => setEditing(null)}
          onChanged={(message, goTo) => done(message, goTo)}
        />
      )}
      {reference && suggesting && (
        <SuggestModal reference={reference} defaultLocationId={location} onClose={() => setSuggesting(false)} onCreated={(message) => done(message, "draft")} />
      )}
    </main>
  );
}
