"use client";

import { useEffect, useMemo, useState } from "react";
import Decimal from "decimal.js";
import { ArrowLeft, Search, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { euros, normalizeText, parseDecimal as parse, quantity as show } from "@/lib/format";

// Conteo de inventario en dos pasos:
//   1) contar en el formato habitual (botellas, cajas…) y guardar las líneas (se pueden ir sumando);
//   2) revisar las diferencias con su valor y cerrar. Lo que falta puede registrarse como CONSUMO:
//      en un bar sin TPV es el consumo real del periodo y alimenta informes y reposición.

type Product = { id: string; name: string; base_unit: string };
type Pack = { id: string; productId: string; name: string; qtyBase: string; isCountDefault: boolean };
type Entry = { qty: string; unit: string }; // unit: "base" o id de formato
type PreviewRow = { productId: string; name: string; unit: string; expected: Decimal; counted: Decimal; diff: Decimal; value: Decimal };

export function CountModal({
  count,
  products,
  onClose,
  onChanged,
}: {
  count: { id: string; locationId: string };
  products: Product[];
  onClose: () => void;
  onChanged: () => void;
}) {
  const [packs, setPacks] = useState<Map<string, Pack[]>>(new Map());
  const [counted, setCounted] = useState<Map<string, Decimal>>(new Map());
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [search, setSearch] = useState("");
  const [step, setStep] = useState<"count" | "review">("count");
  const [preview, setPreview] = useState<PreviewRow[] | null>(null);
  const [zeroUncounted, setZeroUncounted] = useState(false);
  const [asConsumption, setAsConsumption] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  async function loadCounted() {
    const supabase = createClient();
    if (!supabase) return;
    const { data } = await supabase.from("count_lines").select("product_id, qty").eq("count_id", count.id);
    const sums = new Map<string, Decimal>();
    for (const line of data ?? []) sums.set(line.product_id, (sums.get(line.product_id) ?? new Decimal(0)).plus(String(line.qty)));
    setCounted(sums);
  }

  useEffect(() => {
    async function start() {
      await Promise.resolve();
      const supabase = createClient();
      if (!supabase) return;
      const [{ data: packRows }] = await Promise.all([
        supabase.from("product_packs").select("id, product_id, name, qty_base, is_count_default").eq("active", true).order("qty_base"),
        loadCounted(),
      ]);
      const byProduct = new Map<string, Pack[]>();
      for (const p of packRows ?? []) {
        const list = byProduct.get(p.product_id) ?? [];
        list.push({ id: p.id, productId: p.product_id, name: p.name, qtyBase: String(p.qty_base), isCountDefault: p.is_count_default });
        byProduct.set(p.product_id, list);
      }
      setPacks(byProduct);
    }
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se carga una vez por inventario
  }, [count.id]);

  const defaultUnit = (productId: string) => packs.get(productId)?.find((p) => p.isCountDefault)?.id ?? "base";
  const entryOf = (productId: string): Entry => entries[productId] ?? { qty: "", unit: defaultUnit(productId) };
  const factor = (productId: string, unit: string) => (unit === "base" ? new Decimal(1) : new Decimal(packs.get(productId)?.find((p) => p.id === unit)?.qtyBase ?? 1));

  const visible = useMemo(() => {
    const list = products.filter((p) => !search || normalizeText(p.name).includes(normalizeText(search)));
    // Primero lo ya contado o en curso, luego el resto por nombre.
    return list.sort((a, b) => Number(!!entries[b.id]?.qty || counted.has(b.id)) - Number(!!entries[a.id]?.qty || counted.has(a.id)) || a.name.localeCompare(b.name));
  }, [products, search, entries, counted]);

  const pending = Object.entries(entries).filter(([, e]) => e.qty.trim() !== "");

  /** Guarda lo tecleado como líneas de conteo (en unidad base). Devuelve false si hay algo mal. */
  async function saveLines(): Promise<boolean> {
    if (pending.length === 0) return true;
    const invalid = pending.find(([, e]) => parse(e.qty) === null);
    if (invalid) {
      setError(`Revisa la cantidad de ${products.find((p) => p.id === invalid[0])?.name ?? "un producto"}: usa números como 2 o 1,5.`);
      return false;
    }
    const supabase = createClient();
    if (!supabase) return false;
    const rows = pending.map(([productId, e]) => {
      const pack = packs.get(productId)?.find((p) => p.id === e.unit);
      const product = products.find((p) => p.id === productId);
      return {
        count_id: count.id,
        product_id: productId,
        qty: parse(e.qty)!.mul(factor(productId, e.unit)).toNumber(),
        input: { amount: e.qty.trim().replace(",", "."), unit: pack?.name ?? product?.base_unit ?? "" },
        client_ref: crypto.randomUUID(),
      };
    });
    const { error: err } = await supabase.from("count_lines").insert(rows);
    if (err) {
      setError("No se pudieron guardar las líneas contadas. ¿Sigue abierto el inventario?");
      return false;
    }
    setEntries({});
    await loadCounted();
    return true;
  }

  async function save() {
    setSaving(true);
    setError("");
    setNotice("");
    if (pending.length === 0) setError("Introduce al menos una cantidad.");
    else if (await saveLines()) {
      setNotice(`${pending.length} ${pending.length === 1 ? "línea guardada" : "líneas guardadas"}. Puedes seguir contando o revisar y cerrar.`);
      onChanged();
    }
    setSaving(false);
  }

  async function loadPreview(zero: boolean) {
    const supabase = createClient();
    if (!supabase) return;
    const { data, error: err } = await supabase.rpc("count_preview", { p_count: count.id, p_zero_uncounted: zero });
    if (err) {
      setError(err.code === "PGRST202" ? "Falta aplicar la migración 0011_consumo_por_inventario.sql en Supabase." : "No se pudo calcular la revisión.");
      setPreview(null);
      return;
    }
    setPreview(
      (data ?? []).map((r) => ({
        productId: r.product_id,
        name: r.product_name,
        unit: r.base_unit,
        expected: new Decimal(String(r.expected)),
        counted: new Decimal(String(r.counted)),
        diff: new Decimal(String(r.diff)),
        value: new Decimal(String(r.diff_value)),
      })),
    );
  }

  async function review() {
    setSaving(true);
    setError("");
    setNotice("");
    if (await saveLines()) {
      await loadPreview(zeroUncounted);
      setStep("review");
    }
    setSaving(false);
  }

  async function close() {
    const supabase = createClient();
    if (!supabase) return;
    setSaving(true);
    setError("");
    const { error: err } = await supabase.rpc("close_count", { p_count: count.id, p_zero_uncounted: zeroUncounted, p_as_consumption: asConsumption });
    setSaving(false);
    if (err) {
      setError(err.message?.includes("forbidden") ? "Solo un encargado puede cerrar el inventario. Guarda el conteo y avísale." : err.message?.includes("invalid_status") ? "Este inventario ya está cerrado." : "No se pudo cerrar el inventario.");
      return;
    }
    onChanged();
    onClose();
  }

  const missing = (preview ?? []).filter((r) => r.diff.lt(0)).reduce((acc, r) => acc.plus(r.value.abs()), new Decimal(0));
  const extra = (preview ?? []).filter((r) => r.diff.gt(0)).reduce((acc, r) => acc.plus(r.value), new Decimal(0));
  const changes = (preview ?? []).filter((r) => !r.diff.isZero());

  return (
    <div className="op-modal-layer" onClick={() => !saving && onClose()}>
      <section className="op-modal count-modal" onClick={(event) => event.stopPropagation()}>
        <div className="op-modal-heading">
          <div>
            <p className="operation-eyebrow">Inventario · {step === "count" ? "paso 1 de 2" : "paso 2 de 2"}</p>
            <h2>{step === "count" ? "Contar productos" : "Revisar y cerrar"}</h2>
          </div>
          <button className="op-modal-close" onClick={onClose} aria-label="Cerrar"><X size={18} /></button>
        </div>

        {step === "count" && (
          <>
            <div className="count-search">
              <Search size={15} />
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Buscar producto" autoFocus />
            </div>
            <div className="op-modal-count-list">
              {visible.map((product) => {
                const entry = entryOf(product.id);
                const productPacks = packs.get(product.id) ?? [];
                const already = counted.get(product.id);
                const typed = parse(entry.qty);
                return (
                  <div className="op-modal-count-row count-row" key={product.id}>
                    <span>
                      {product.name}
                      <small>
                        {already ? `Ya contado: ${show(already, product.base_unit)}` : "Sin contar"}
                        {typed && entry.unit !== "base" ? ` · ${show(typed.mul(factor(product.id, entry.unit)), product.base_unit)}` : ""}
                      </small>
                    </span>
                    <input
                      inputMode="decimal"
                      placeholder="0"
                      value={entry.qty}
                      onChange={(event) => setEntries({ ...entries, [product.id]: { ...entry, qty: event.target.value } })}
                      aria-label={`Cantidad de ${product.name}`}
                    />
                    <select
                      value={entry.unit}
                      onChange={(event) => setEntries({ ...entries, [product.id]: { ...entry, unit: event.target.value } })}
                      aria-label={`Unidad de ${product.name}`}
                    >
                      {productPacks.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      <option value="base">{product.base_unit}</option>
                    </select>
                  </div>
                );
              })}
              {visible.length === 0 && <p className="count-empty">Ningún producto coincide con la búsqueda.</p>}
            </div>
            <p className="count-hint">Lo que guardes se suma a lo ya contado: podéis contar por zonas o entre varias personas.</p>
            {notice && <p className="count-notice">{notice}</p>}
            {error && <p className="op-modal-error">{error}</p>}
            <div className="op-modal-actions">
              <button className="op-modal-submit op-modal-secondary" onClick={() => void save()} disabled={saving || pending.length === 0}>{saving ? "Guardando..." : "Guardar conteo"}</button>
              <button className="op-modal-submit" onClick={() => void review()} disabled={saving || (pending.length === 0 && counted.size === 0)}>{saving ? "..." : "Revisar y cerrar"}</button>
            </div>
          </>
        )}

        {step === "review" && (
          <>
            <div className="count-totals">
              <div><span>Falta</span><strong className="negative">{euros(missing)}</strong></div>
              <div><span>Sobra</span><strong>{euros(extra)}</strong></div>
              <div><span>Productos con diferencia</span><strong>{changes.length}</strong></div>
            </div>
            <div className="op-modal-count-list count-review">
              {changes.length === 0 && <p className="count-empty">Todo cuadra: no hay diferencias con el stock esperado.</p>}
              {changes.map((r) => (
                <div className="count-review-row" key={r.productId}>
                  <span><b>{r.name}</b><small>esperado {show(r.expected, r.unit)} · contado {show(r.counted, r.unit)}</small></span>
                  <span className={r.diff.lt(0) ? "negative" : "positive"}>{r.diff.gt(0) ? "+" : ""}{show(r.diff, r.unit)}</span>
                  <span className={r.value.lt(0) ? "negative" : "positive"}>{euros(r.value)}</span>
                </div>
              ))}
            </div>
            <label className="count-option">
              <input type="checkbox" checked={asConsumption} onChange={(event) => setAsConsumption(event.target.checked)} />
              <span><b>Lo que falta es consumo</b><small>Recomendado si no registráis cada venta: cuenta como consumo real en informes y en la reposición. Desmárcalo si la diferencia es un error o una pérdida.</small></span>
            </label>
            <label className="count-option">
              <input
                type="checkbox"
                checked={zeroUncounted}
                onChange={(event) => {
                  setZeroUncounted(event.target.checked);
                  void loadPreview(event.target.checked);
                }}
              />
              <span><b>Poner a cero lo no contado</b><small>Los productos activos del local que no se han contado pasan a 0. Úsalo solo en un inventario completo.</small></span>
            </label>
            {error && <p className="op-modal-error">{error}</p>}
            <div className="op-modal-actions">
              <button className="op-modal-submit op-modal-secondary" onClick={() => setStep("count")} disabled={saving}><ArrowLeft size={14} /> Seguir contando</button>
              <button className="op-modal-submit" onClick={() => void close()} disabled={saving || preview === null}>{saving ? "Cerrando..." : "Cerrar inventario"}</button>
            </div>
          </>
        )}
      </section>
    </div>
  );
}
