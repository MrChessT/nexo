"use client";

import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { Sparkles, X } from "lucide-react";
import { euros, inputText, parseDecimal as parse, quantity } from "@/lib/format";
import { saveDraft, type Reference } from "./orders-data";

// Sugerir pedido: mismo cálculo que el asistente («¿qué me falta?»), en formatos de compra y
// agrupado por proveedor. Descuenta lo que ya está pedido o en camino. Cada grupo se convierte en
// un borrador que luego se revisa y se envía.

type ReorderLine = {
  productId: string;
  productName: string;
  baseUnit: string;
  stock: string;
  min: string;
  pendingIn: string;
  coverageDays: string | null;
  pack: { id: string; name: string; qtyBase: string } | null;
  packs: string | null;
  supplier: { id: string; name: string } | null;
  price: string | null;
};

type Choice = { include: boolean; qty: string; price: string; supplierId: string };

export function SuggestModal({
  reference,
  defaultLocationId,
  onClose,
  onCreated,
}: {
  reference: Reference;
  defaultLocationId: string;
  onClose: () => void;
  onCreated: (message: string) => void;
}) {
  const [locationId, setLocationId] = useState(defaultLocationId || reference.locations[0]?.id || "");
  const [days, setDays] = useState(7);
  const [lines, setLines] = useState<ReorderLine[] | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!locationId) return;
    let cancelled = false;
    async function run() {
      await Promise.resolve();
      setLoading(true);
      setError("");
      try {
        const res = await fetch(`/api/copiloto/reorder?locationId=${locationId}&dias=${days}`);
        const body = (await res.json()) as { lines?: ReorderLine[]; message?: string };
        if (!res.ok) throw new Error(body.message ?? "No se pudo calcular la sugerencia.");
        if (cancelled) return;
        const list = body.lines ?? [];
        setLines(list);
        setChoices(
          Object.fromEntries(
            list.map((l) => [
              l.productId,
              { include: !!l.pack, qty: l.packs ?? "", price: l.price ? inputText(l.price) : "", supplierId: l.supplier?.id ?? "" },
            ]),
          ),
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : "No se pudo calcular la sugerencia.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void run();
    return () => {
      cancelled = true;
    };
  }, [locationId, days]);

  const groups = useMemo(() => {
    const map = new Map<string, ReorderLine[]>();
    for (const l of lines ?? []) {
      const key = choices[l.productId]?.supplierId || "";
      map.set(key, [...(map.get(key) ?? []), l]);
    }
    return [...map.entries()].sort(([a], [b]) => (a === "" ? 1 : b === "" ? -1 : 0));
  }, [lines, choices]);

  const selected = (lines ?? []).filter((l) => l.pack && choices[l.productId]?.include && (parse(choices[l.productId]!.qty) ?? new Decimal(0)).gt(0));
  const bySupplier = new Map<string, ReorderLine[]>();
  for (const l of selected) {
    const s = choices[l.productId]!.supplierId;
    bySupplier.set(s, [...(bySupplier.get(s) ?? []), l]);
  }
  const missingSupplier = bySupplier.has("");

  function patch(productId: string, p: Partial<Choice>) {
    setChoices((c) => ({ ...c, [productId]: { ...c[productId]!, ...p } }));
  }

  async function create() {
    if (missingSupplier) return setError("Elige proveedor para los productos marcados en «Sin proveedor».");
    if (selected.length === 0) return setError("Marca al menos un producto.");
    setSaving(true);
    setError("");
    try {
      for (const [supplierId, group] of bySupplier) {
        await saveDraft(reference, {
          locationId,
          supplierId,
          note: "",
          expectedDate: "",
          lines: group.map((l) => ({ packId: l.pack!.id, packsQty: choices[l.productId]!.qty, packPrice: choices[l.productId]!.price, receivedPacks: "0" })),
        });
      }
      onCreated(`${bySupplier.size === 1 ? "1 pedido creado" : `${bySupplier.size} pedidos creados`} en borrador. Revísalos y envíalos.`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron crear los pedidos.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="modal-layer editor-layer" onClick={() => !saving && onClose()}>
      <section className="product-editor order-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Sugerir pedido">
        <header className="editor-header">
          <div>
            <p className="eyebrow">Según consumo real, mínimos y lo que ya está en camino</p>
            <h2>Sugerir pedido</h2>
          </div>
          <button className="modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </header>
        <div className="editor-body">
          <div className="editor-grid">
            <label>
              Local
              <select value={locationId} onChange={(event) => setLocationId(event.target.value)}>
                {reference.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
              </select>
            </label>
            <label>
              Que alcance para
              <select value={days} onChange={(event) => setDays(Number(event.target.value))}>
                <option value={3}>3 días</option>
                <option value={7}>1 semana</option>
                <option value={14}>2 semanas</option>
              </select>
            </label>
          </div>

          {loading && <div className="catalog-empty"><strong>Calculando…</strong></div>}
          {!loading && lines && lines.length === 0 && (
            <div className="catalog-empty">
              <strong>No hace falta pedir nada</strong>
              <span>Con el stock, los mínimos y lo que ya está en camino llegas a {days} días. Si falta algo, revisa los mínimos del producto.</span>
            </div>
          )}

          {!loading &&
            groups.map(([supplierId, group]) => {
              const name = reference.suppliers.find((s) => s.id === supplierId)?.name ?? "Sin proveedor";
              const total = group.reduce((acc, l) => {
                const c = choices[l.productId];
                return c?.include ? acc.plus(new Decimal(parse(c.qty) ?? 0).mul(parse(c.price) ?? 0)) : acc;
              }, new Decimal(0));
              return (
                <div className="editor-section suggest-group" key={supplierId || "none"}>
                  <p className="facet-title">{name} · {euros(total)}</p>
                  <div className="editor-table">
                    {group.map((l) => {
                      const c = choices[l.productId]!;
                      return (
                        <div className={`editor-row suggest-row ${c.include ? "" : "disabled"}`} key={l.productId}>
                          <input type="checkbox" checked={c.include} disabled={!l.pack} onChange={(event) => patch(l.productId, { include: event.target.checked })} aria-label={`Incluir ${l.productName}`} />
                          <span>
                            <b>{l.productName}</b>
                            <small>
                              {l.pack ? `${l.pack.name} · ` : "Sin formato de compra · "}
                              quedan {quantity(l.stock, l.baseUnit, 1)}
                              {new Decimal(l.pendingIn).gt(0) ? ` · en camino ${quantity(l.pendingIn, l.baseUnit, 1)}` : ""}
                              {l.coverageDays ? ` · para ${l.coverageDays.replace(".", ",")} días` : ""}
                            </small>
                          </span>
                          <input inputMode="decimal" value={c.qty} disabled={!l.pack} onChange={(event) => patch(l.productId, { qty: event.target.value })} aria-label={`Cantidad de ${l.productName}`} />
                          <div className="money-input">
                            <input inputMode="decimal" value={c.price} disabled={!l.pack} placeholder="—" onChange={(event) => patch(l.productId, { price: event.target.value })} aria-label={`Precio de ${l.productName}`} />
                            <span>€</span>
                          </div>
                          <select value={c.supplierId} disabled={!l.pack} onChange={(event) => patch(l.productId, { supplierId: event.target.value })} aria-label={`Proveedor de ${l.productName}`}>
                            <option value="">Sin proveedor</option>
                            {reference.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                          </select>
                        </div>
                      );
                    })}
                  </div>
                </div>
              );
            })}
        </div>
        {error && <p className="editor-message error">{error}</p>}
        <footer className="editor-footer">
          <span className="section-hint">{selected.length} productos · {bySupplier.size} {bySupplier.size === 1 ? "proveedor" : "proveedores"}</span>
          <button className="catalog-primary" disabled={saving || loading || selected.length === 0} onClick={() => void create()}>
            <Sparkles size={15} /> {saving ? "Creando..." : `Crear ${bySupplier.size || ""} ${bySupplier.size === 1 ? "borrador" : "borradores"}`}
          </button>
        </footer>
      </section>
    </div>
  );
}
