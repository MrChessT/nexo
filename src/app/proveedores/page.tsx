"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Archive, ArchiveRestore, ArrowLeft, CirclePlus, Search, Trash2, Truck, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { euros, normalizeText } from "@/lib/format";
import "../productos/productos.css";
import "../productos/product-editor.css";
import "./proveedores.css";

// Proveedores: alta, edición, archivar y eliminar, con los últimos precios que tiene cada uno.
// Los permisos los decide RLS (encargado o superior para escribir).

type Price = { price: number | null; at: string | null; pack: string; product: string; productId: string };
type Supplier = {
  id: string;
  name: string;
  taxId: string;
  email: string;
  phone: string;
  notes: string;
  active: boolean;
  prices: Price[];
};
type Form = Omit<Supplier, "id" | "active" | "prices">;

const EMPTY_FORM: Form = { name: "", taxId: "", email: "", phone: "", notes: "" };

function friendly(error: { code?: string } | null, fallback: string) {
  if (error?.code === "23505") return "Ya existe un proveedor con ese nombre.";
  if (error?.code === "42501") return "No tienes permisos para hacer este cambio.";
  return fallback;
}

async function loadSuppliers(): Promise<Supplier[]> {
  const supabase = createClient();
  if (!supabase) throw new Error("Configura las variables de Supabase.");
  const { data, error } = await supabase
    .from("suppliers")
    .select("id, name, tax_id, email, phone, notes, active, prices:supplier_prices(last_price, last_price_at, pack:product_packs(name, product:products(id, name)))")
    .order("name");
  if (error) throw new Error("No se pudieron cargar los proveedores.");
  type Row = {
    id: string; name: string; tax_id: string | null; email: string | null; phone: string | null; notes: string | null; active: boolean;
    prices: Array<{ last_price: number | null; last_price_at: string | null; pack: { name: string; product: { id: string; name: string } | null } | null }>;
  };
  return ((data ?? []) as unknown as Row[]).map((r) => ({
    id: r.id,
    name: r.name,
    taxId: r.tax_id ?? "",
    email: r.email ?? "",
    phone: r.phone ?? "",
    notes: r.notes ?? "",
    active: r.active,
    prices: r.prices
      .map((p) => ({ price: p.last_price, at: p.last_price_at, pack: p.pack?.name ?? "Formato", product: p.pack?.product?.name ?? "Producto", productId: p.pack?.product?.id ?? "" }))
      .sort((a, b) => a.product.localeCompare(b.product)),
  }));
}

export default function SuppliersPage() {
  const [suppliers, setSuppliers] = useState<Supplier[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"active" | "archived">("active");
  const [editing, setEditing] = useState<Supplier | "new" | null>(null);

  async function reload() {
    try {
      setSuppliers(await loadSuppliers());
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudieron cargar los proveedores.");
    }
  }

  useEffect(() => {
    async function start() {
      await Promise.resolve();
      await reload();
    }
    void start();
  }, []);

  const counts = useMemo(
    () => ({ active: suppliers?.filter((s) => s.active).length ?? 0, archived: suppliers?.filter((s) => !s.active).length ?? 0 }),
    [suppliers],
  );
  const visible = (suppliers ?? []).filter(
    (s) => (status === "active" ? s.active : !s.active) && (!query || normalizeText(`${s.name} ${s.taxId} ${s.email}`).includes(normalizeText(query))),
  );

  return (
    <main className="catalog-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link"><ArrowLeft size={16} /> Resumen</Link>
        <span className="catalog-title">Proveedores</span>
        <span />
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Gestión · Compras</p>
            <h1>Proveedores</h1>
            <p className="catalog-subtitle">A quién compras y a qué precio. Los precios se actualizan solos con cada recepción.</p>
          </div>
          <button className="catalog-primary" onClick={() => setEditing("new")}><CirclePlus size={17} /> Nuevo proveedor</button>
        </div>
        <div className="catalog-tabs">
          <button className={status === "active" ? "active" : undefined} onClick={() => setStatus("active")}>Activos <b>{counts.active}</b></button>
          <button className={status === "archived" ? "active" : undefined} onClick={() => setStatus("archived")}>Archivados <b>{counts.archived}</b></button>
        </div>
        <section className="catalog-panel">
          <div className="catalog-toolbar">
            <div className="catalog-search">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por nombre, CIF o email" />
            </div>
          </div>
          <div className="suppliers-table">
            <div className="suppliers-head"><span>Proveedor</span><span>Contacto</span><span>Productos con precio</span><span>Último precio</span></div>
            {!suppliers && !loadError && <div className="catalog-empty"><strong>Cargando proveedores...</strong></div>}
            {loadError && (
              <div className="catalog-empty">
                <strong>{loadError}</strong>
                <button className="filter-button" onClick={() => void reload()}>Reintentar</button>
              </div>
            )}
            {visible.map((s) => {
              const last = s.prices.map((p) => p.at).filter(Boolean).sort().at(-1);
              return (
                <div
                  key={s.id}
                  className="suppliers-row"
                  role="button"
                  tabIndex={0}
                  onClick={() => setEditing(s)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      setEditing(s);
                    }
                  }}
                >
                  <span className="catalog-product">
                    <span className="catalog-product-icon"><Truck size={16} /></span>
                    <span><strong>{s.name}</strong><small>{s.taxId || "Sin CIF"}</small></span>
                  </span>
                  <span className="cell-ellipsis">{[s.email, s.phone].filter(Boolean).join(" · ") || <em className="muted">Sin contacto</em>}</span>
                  <span>{new Set(s.prices.map((p) => p.productId)).size}</span>
                  <span>{last ? new Date(last).toLocaleDateString("es-ES") : <em className="muted">—</em>}</span>
                </div>
              );
            })}
            {suppliers && visible.length === 0 && (
              <div className="catalog-empty">
                <strong>{query ? "No hay resultados" : status === "active" ? "Todavía no hay proveedores" : "No hay proveedores archivados"}</strong>
                {status === "active" && !query && <span>Crea el primero con «Nuevo proveedor».</span>}
              </div>
            )}
          </div>
        </section>
      </div>
      {editing && (
        <SupplierEditor
          supplier={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onChanged={() => void reload()}
        />
      )}
    </main>
  );
}

function SupplierEditor({ supplier, onClose, onChanged }: { supplier: Supplier | null; onClose: () => void; onChanged: () => void }) {
  const initial: Form = supplier ? { name: supplier.name, taxId: supplier.taxId, email: supplier.email, phone: supplier.phone, notes: supplier.notes } : EMPTY_FORM;
  const [form, setForm] = useState<Form>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = JSON.stringify(form) !== JSON.stringify(initial);

  function close() {
    if (saving) return;
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Cerrar igualmente?")) return;
    onClose();
  }

  const set = (key: keyof Form) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const values = () => ({
    name: form.name.trim(),
    tax_id: form.taxId.trim() || null,
    email: form.email.trim() || null,
    phone: form.phone.trim() || null,
    notes: form.notes.trim() || null,
  });

  async function save() {
    if (!form.name.trim()) return setError("El proveedor necesita un nombre.");
    if (form.email.trim() && !/^\S+@\S+\.\S+$/.test(form.email.trim())) return setError("Revisa el email.");
    const supabase = createClient();
    if (!supabase) return setError("Configura las variables de Supabase.");
    setSaving(true);
    setError("");
    if (supplier) {
      const { data, error: err } = await supabase.from("suppliers").update(values()).eq("id", supplier.id).select("id");
      setSaving(false);
      if (err) return setError(friendly(err, "No se pudo guardar."));
      if (!data?.length) return setError("No tienes permisos para editar proveedores.");
    } else {
      const { data: membership } = await supabase.from("memberships").select("org_id").limit(1).maybeSingle();
      if (!membership) {
        setSaving(false);
        return setError("No se encontró tu organización.");
      }
      const { error: err } = await supabase.from("suppliers").insert({ org_id: membership.org_id, ...values() });
      setSaving(false);
      if (err) return setError(friendly(err, "No se pudo crear el proveedor."));
    }
    onChanged();
    onClose();
  }

  async function toggleArchive() {
    if (!supplier) return;
    const supabase = createClient();
    if (!supabase) return;
    setSaving(true);
    const { data, error: err } = await supabase.from("suppliers").update({ active: !supplier.active }).eq("id", supplier.id).select("id");
    setSaving(false);
    if (err || !data?.length) return setError(friendly(err ?? { code: "42501" }, "No se pudo cambiar el estado."));
    onChanged();
    onClose();
  }

  async function remove() {
    if (!supplier) return;
    const supabase = createClient();
    if (!supabase) return;
    setSaving(true);
    const { data, error: err } = await supabase.from("suppliers").delete().eq("id", supplier.id).select("id");
    setSaving(false);
    setConfirmDelete(false);
    if (err?.code === "23503") return setError("Tiene recepciones registradas y no se puede borrar sin perder el historial. Archívalo.");
    if (err || !data?.length) return setError(friendly(err ?? { code: "42501" }, "No se pudo eliminar."));
    onChanged();
    onClose();
  }

  return (
    <div className="modal-layer editor-layer" onClick={close}>
      <section className="product-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Ficha de proveedor">
        <header className="editor-header">
          <div>
            <p className="eyebrow">{supplier ? "Ficha de proveedor" : "Nuevo proveedor"}</p>
            <h2>{form.name || "Proveedor"}</h2>
            {supplier && !supplier.active && <span className="editor-badge">Archivado</span>}
          </div>
          <button className="modal-close" onClick={close} aria-label="Cerrar"><X size={18} /></button>
        </header>
        <div className="editor-body">
          <div className="editor-grid">
            <label className="span-2">Nombre<input autoFocus={!supplier} value={form.name} onChange={set("name")} placeholder="Ej. Makro" /></label>
            <label>CIF / NIF<input value={form.taxId} onChange={set("taxId")} placeholder="Opcional" /></label>
            <label>Teléfono<input value={form.phone} onChange={set("phone")} placeholder="Opcional" inputMode="tel" /></label>
            <label className="span-2">Email de pedidos<input value={form.email} onChange={set("email")} placeholder="Opcional" inputMode="email" /></label>
            <label className="span-2">Notas<input value={form.notes} onChange={set("notes")} placeholder="Días de reparto, pedido mínimo, comercial…" /></label>
          </div>
          {supplier && (
            <div className="editor-section supplier-prices">
              <p className="facet-title">Precios de este proveedor ({supplier.prices.length})</p>
              {supplier.prices.length === 0 ? (
                <p className="section-hint">Todavía no hay precios. Se añaden desde la ficha de cada producto o al registrar una recepción.</p>
              ) : (
                <div className="editor-table">
                  <div className="editor-head supplier-price-row"><span>Producto</span><span>Formato</span><span>Precio</span><span>Fecha</span></div>
                  {supplier.prices.map((p, i) => (
                    <div className="editor-row supplier-price-row" key={`${p.productId}-${p.pack}-${i}`}>
                      <Link href={`/productos?producto=${p.productId}`}>{p.product}</Link>
                      <span>{p.pack}</span>
                      <strong>{p.price === null ? "—" : euros(p.price)}</strong>
                      <span className="muted">{p.at ? new Date(p.at).toLocaleDateString("es-ES") : "—"}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
        {error && <p className="editor-message error">{error}</p>}
        <footer className="editor-footer">
          {supplier ? (
            confirmDelete ? (
              <div className="delete-confirm">
                <span>¿Eliminar «{supplier.name}»{supplier.prices.length ? ` y sus ${supplier.prices.length} precios` : ""}?</span>
                <button className="danger-button" disabled={saving} onClick={() => void remove()}>Sí, eliminar</button>
                <button className="ghost-button" onClick={() => setConfirmDelete(false)}>Cancelar</button>
              </div>
            ) : (
              <div className="footer-left">
                <button className="ghost-button danger" disabled={saving} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Eliminar</button>
                <button className="ghost-button" disabled={saving || dirty} onClick={() => void toggleArchive()}>
                  {supplier.active ? <><Archive size={14} /> Archivar</> : <><ArchiveRestore size={14} /> Restaurar</>}
                </button>
              </div>
            )
          ) : (
            <span />
          )}
          <div className="footer-right">
            <button className="catalog-primary" disabled={saving || (!!supplier && !dirty)} onClick={() => void save()}>
              {saving ? "Guardando..." : supplier ? "Guardar cambios" : "Crear proveedor"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );
}
