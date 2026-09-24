"use client";

import { useEffect, useMemo, useState } from "react";
import { Archive, ArchiveRestore, Plus, Star, Trash2, X } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import { Decimal } from "@/lib/decimal";
import { formatQuantity, type UnitDimension } from "@/lib/units";
import "./product-editor.css";

// Ficha de producto: datos generales, formatos, precios por proveedor y mínimos por local.
// Se edita todo en borrador y "Guardar cambios" aplica solo lo que ha cambiado. Los permisos los
// decide RLS (gerente o superior); si una escritura no afecta a ninguna fila se avisa como falta de permiso.

type Tab = "general" | "formatos" | "precios" | "locales";

type Option = { id: string; name: string };
type Unit = { id: string; label: string; factor: number };

type PackDraft = {
  key: string;
  id: string | null;
  name: string;
  amount: string;
  unit: string;
  barcode: string;
  purchaseDefault: boolean;
  countDefault: boolean;
  active: boolean;
};

type PriceDraft = { key: string; supplierId: string; packKey: string; price: string; lastAt: string | null };

type LocationDraft = { locationId: string; enabled: boolean; min: string; par: string };

type Draft = {
  name: string;
  sku: string;
  categoryId: string;
  dimension: UnitDimension;
  active: boolean;
  packs: PackDraft[];
  prices: PriceDraft[];
  locations: LocationDraft[];
  qtyUnit: string; // unidad en la que se muestran mínimos y par
};

type Loaded = {
  orgId: string;
  hasMovements: boolean;
  categories: Array<Option & { parentId: string | null }>;
  suppliers: Option[];
  allLocations: Option[];
  stock: Map<string, number>;
  existingLocations: Map<string, { active: boolean }>;
  draft: Draft;
};

const BASE_UNITS: Record<UnitDimension, Unit[]> = {
  volume: [
    { id: "ml", label: "ml", factor: 1 },
    { id: "cl", label: "cl", factor: 10 },
    { id: "l", label: "l", factor: 1000 },
  ],
  mass: [
    { id: "g", label: "g", factor: 1 },
    { id: "kg", label: "kg", factor: 1000 },
  ],
  count: [{ id: "ud", label: "ud", factor: 1 }],
};

const baseUnit = (d: UnitDimension) => BASE_UNITS[d][0]!.id;

function bestUnit(qtyBase: number, d: UnitDimension): Unit {
  const units = BASE_UNITS[d];
  return [...units].reverse().find((u) => qtyBase >= u.factor && new Decimal(qtyBase).mod(u.factor).isZero()) ?? units[0]!;
}

/** Acepta "1,5" y "1.5". Devuelve null si no es un número. */
function parseNum(text: string): Decimal | null {
  const clean = text.trim().replace(",", ".");
  if (!clean || !/^-?\d*\.?\d+$/.test(clean)) return null;
  return new Decimal(clean);
}

const show = (value: Decimal.Value) => new Decimal(value).toDecimalPlaces(4).toString().replace(".", ",");

const newKey = () => crypto.randomUUID();

function money(value: Decimal.Value) {
  return `${new Decimal(value).toFixed(2).replace(".", ",")} €`;
}

function friendlyError(error: { code?: string; message?: string } | null, fallback: string) {
  if (!error) return fallback;
  if (error.code === "23505") return "Ya existe otro registro con ese nombre o código.";
  if (error.code === "42501") return "No tienes permisos para hacer este cambio.";
  return fallback;
}

async function load(productId: string): Promise<Loaded> {
  const supabase = createClient();
  if (!supabase) throw new Error("Configura las variables de Supabase.");
  const [product, categories, suppliers, locations, packs, prices, locationProducts, balances, movements] = await Promise.all([
    supabase.from("products").select("id, org_id, name, sku, category_id, dimension, active").eq("id", productId).single(),
    supabase.from("categories").select("id, name, parent_id").order("name"),
    supabase.from("suppliers").select("id, name").eq("active", true).order("name"),
    supabase.from("locations").select("id, name").eq("active", true).order("name"),
    supabase.from("product_packs").select("*").eq("product_id", productId).order("qty_base"),
    supabase
      .from("supplier_prices")
      .select("supplier_id, pack_id, last_price, last_price_at, pack:product_packs!inner(product_id)")
      .eq("pack.product_id", productId),
    supabase.from("location_products").select("*").eq("product_id", productId),
    supabase.from("stock_balances").select("location_id, qty").eq("product_id", productId),
    supabase.from("stock_movements").select("id", { count: "exact", head: true }).eq("product_id", productId),
  ]);
  if (product.error || !product.data) throw new Error("No se pudo cargar el producto.");
  const p = product.data;
  const dimension = p.dimension as UnitDimension;

  const packRows = packs.data ?? [];
  const packDrafts: PackDraft[] = packRows.map((k) => {
    const unit = bestUnit(Number(k.qty_base), dimension);
    return {
      key: k.id,
      id: k.id,
      name: k.name,
      amount: show(new Decimal(k.qty_base).div(unit.factor)),
      unit: unit.id,
      barcode: k.barcode ?? "",
      purchaseDefault: k.is_purchase_default,
      countDefault: k.is_count_default,
      active: k.active,
    };
  });
  const priceDrafts: PriceDraft[] = ((prices.data ?? []) as unknown as Array<{ supplier_id: string; pack_id: string; last_price: number | null; last_price_at: string | null }>).map((r) => ({
    key: `${r.supplier_id}|${r.pack_id}`,
    supplierId: r.supplier_id,
    packKey: r.pack_id,
    price: r.last_price === null ? "" : show(r.last_price),
    lastAt: r.last_price_at,
  }));

  const allLocations = (locations.data ?? []) as Option[];
  const lpRows = locationProducts.data ?? [];
  const existingLocations = new Map(lpRows.map((lp) => [lp.location_id, { active: lp.active }]));
  const lpByLocation = new Map(lpRows.map((lp) => [lp.location_id, lp]));
  const qtyUnit = baseUnit(dimension); // mínimos y objetivo se guardan en la unidad base
  const locationDrafts: LocationDraft[] = allLocations.map((l) => {
    const lp = lpByLocation.get(l.id);
    return {
      locationId: l.id,
      enabled: lp?.active ?? false,
      min: lp && Number(lp.min_qty) !== 0 ? show(lp.min_qty) : "",
      par: lp && Number(lp.par_qty) !== 0 ? show(lp.par_qty) : "",
    };
  });

  return {
    orgId: p.org_id,
    hasMovements: (movements.count ?? 0) > 0,
    categories: (categories.data ?? []).map((c) => ({ id: c.id, name: c.name, parentId: c.parent_id })),
    suppliers: (suppliers.data ?? []) as Option[],
    allLocations,
    stock: new Map((balances.data ?? []).map((b) => [b.location_id, Number(b.qty)])),
    existingLocations,
    draft: {
      name: p.name,
      sku: p.sku ?? "",
      categoryId: p.category_id ?? "",
      dimension,
      active: p.active,
      packs: packDrafts,
      prices: priceDrafts,
      locations: locationDrafts,
      qtyUnit,
    },
  };
}

export function ProductEditor({ productId, onClose, onChanged }: { productId: string; onClose: () => void; onChanged: () => void }) {
  const [data, setData] = useState<Loaded | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [tab, setTab] = useState<Tab>("general");
  const [loadError, setLoadError] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [newCategory, setNewCategory] = useState<string | null>(null);
  const [newSupplier, setNewSupplier] = useState<string | null>(null);

  async function reload() {
    try {
      const loaded = await load(productId);
      setData(loaded);
      setDraft(loaded.draft);
      setLoadError("");
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "No se pudo cargar el producto.");
    }
  }

  useEffect(() => {
    async function start() {
      await Promise.resolve();
      await reload();
    }
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- se carga al abrir cada producto
  }, [productId]);

  const dirty = useMemo(() => !!data && !!draft && JSON.stringify(data.draft) !== JSON.stringify(draft), [data, draft]);

  function close() {
    if (saving) return;
    if (dirty && !window.confirm("Hay cambios sin guardar. ¿Cerrar igualmente?")) return;
    onClose();
  }

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  function patch(p: Partial<Draft>) {
    setDraft((d) => (d ? { ...d, ...p } : d));
  }
  function patchPack(key: string, p: Partial<PackDraft>) {
    setDraft((d) => {
      if (!d) return d;
      return {
        ...d,
        packs: d.packs.map((k) => {
          if (k.key === key) return { ...k, ...p };
          // Solo puede haber un formato de compra y uno de conteo por defecto.
          return {
            ...k,
            ...(p.purchaseDefault ? { purchaseDefault: false } : {}),
            ...(p.countDefault ? { countDefault: false } : {}),
          };
        }),
      };
    });
  }
  function patchPrice(key: string, p: Partial<PriceDraft>) {
    setDraft((d) => (d ? { ...d, prices: d.prices.map((r) => (r.key === key ? { ...r, ...p } : r)) } : d));
  }
  function patchLocation(id: string, p: Partial<LocationDraft>) {
    setDraft((d) => (d ? { ...d, locations: d.locations.map((l) => (l.locationId === id ? { ...l, ...p } : l)) } : d));
  }

  async function createCategory() {
    const name = newCategory?.trim();
    const supabase = createClient();
    if (!name || !supabase || !data) return;
    const { data: row, error: err } = await supabase.from("categories").insert({ org_id: data.orgId, name }).select("id, name, parent_id").single();
    if (err || !row) return setError(friendlyError(err, "No se pudo crear la categoría."));
    setData({ ...data, categories: [...data.categories, { id: row.id, name: row.name, parentId: row.parent_id }].sort((a, b) => a.name.localeCompare(b.name)) });
    patch({ categoryId: row.id });
    setNewCategory(null);
  }

  async function createSupplier() {
    const name = newSupplier?.trim();
    const supabase = createClient();
    if (!name || !supabase || !data) return;
    const { data: row, error: err } = await supabase.from("suppliers").insert({ org_id: data.orgId, name }).select("id, name").single();
    if (err || !row) return setError(friendlyError(err, "No se pudo crear el proveedor."));
    setData({ ...data, suppliers: [...data.suppliers, row].sort((a, b) => a.name.localeCompare(b.name)) });
    setNewSupplier(null);
  }

  function validate(d: Draft): string | null {
    if (!d.name.trim()) return "El producto necesita un nombre.";
    for (const k of d.packs) {
      if (!k.name.trim()) return "Todos los formatos necesitan un nombre.";
      const amount = parseNum(k.amount);
      if (!amount || amount.lte(0)) return `Indica una cantidad mayor que 0 en el formato «${k.name}».`;
    }
    const packNames = d.packs.map((k) => k.name.trim().toLowerCase());
    if (new Set(packNames).size !== packNames.length) return "Hay dos formatos con el mismo nombre.";
    const seen = new Set<string>();
    for (const r of d.prices) {
      if (!r.supplierId || !r.packKey) return "Completa proveedor y formato en todos los precios.";
      const price = parseNum(r.price);
      if (!price || price.lt(0)) return "Revisa los precios: deben ser números de 0 o más.";
      const key = `${r.supplierId}|${r.packKey}`;
      if (seen.has(key)) return "Hay un proveedor con dos precios para el mismo formato.";
      seen.add(key);
    }
    for (const l of d.locations) {
      if (l.min && !parseNum(l.min)) return "Revisa los mínimos: deben ser números.";
      if (l.par && !parseNum(l.par)) return "Revisa las cantidades objetivo: deben ser números.";
    }
    return null;
  }

  async function save() {
    if (!data || !draft || saving) return;
    const invalid = validate(draft);
    if (invalid) return setError(invalid);
    const supabase = createClient();
    if (!supabase) return setError("Configura las variables de Supabase.");
    setSaving(true);
    setError("");
    setNotice("");
    const warnings: string[] = [];
    const before = data.draft;
    const fail = (message: string) => {
      setError(message);
      setSaving(false);
    };

    // 1) Datos generales
    if (before.name !== draft.name || before.sku !== draft.sku || before.categoryId !== draft.categoryId || before.dimension !== draft.dimension || before.active !== draft.active) {
      const { data: rows, error: err } = await supabase
        .from("products")
        .update({ name: draft.name.trim(), sku: draft.sku.trim() || null, category_id: draft.categoryId || null, dimension: draft.dimension, active: draft.active })
        .eq("id", productId)
        .select("id");
      if (err) return fail(friendlyError(err, "No se pudieron guardar los datos generales."));
      if (!rows?.length) return fail("No tienes permisos para editar productos.");
    }

    // 2) Formatos
    const units = BASE_UNITS[draft.dimension];
    const qtyBase = (k: PackDraft) => parseNum(k.amount)!.mul(units.find((u) => u.id === k.unit)?.factor ?? 1).toNumber();
    const packIds = new Map<string, string>(); // clave del borrador → id real
    const beforePacks = new Map(before.packs.map((k) => [k.id!, k]));
    const keptIds = new Set(draft.packs.filter((k) => k.id).map((k) => k.id!));

    for (const old of before.packs) {
      if (keptIds.has(old.id!)) continue;
      const { error: err } = await supabase.from("product_packs").delete().eq("id", old.id!);
      if (err?.code === "23503") {
        // Ya aparece en albaranes: se conserva el historial y se desactiva.
        await supabase.from("product_packs").update({ active: false, is_purchase_default: false, is_count_default: false }).eq("id", old.id!);
        warnings.push(`El formato «${old.name}» aparece en albaranes: se ha desactivado en lugar de borrarse.`);
      } else if (err) {
        return fail(friendlyError(err, `No se pudo eliminar el formato «${old.name}».`));
      }
    }
    // Primero se quitan los "por defecto" que desaparecen (índice único por producto).
    for (const k of draft.packs) {
      const old = k.id ? beforePacks.get(k.id) : undefined;
      if (!old) continue;
      const clear: { is_purchase_default?: boolean; is_count_default?: boolean } = {};
      if (old.purchaseDefault && !k.purchaseDefault) clear.is_purchase_default = false;
      if (old.countDefault && !k.countDefault) clear.is_count_default = false;
      if (Object.keys(clear).length > 0) {
        const { error: err } = await supabase.from("product_packs").update(clear).eq("id", k.id!);
        if (err) return fail(friendlyError(err, "No se pudieron actualizar los formatos."));
      }
    }
    for (const k of draft.packs) {
      const values = {
        name: k.name.trim(),
        qty_base: qtyBase(k),
        barcode: k.barcode.trim() || null,
        is_purchase_default: k.purchaseDefault,
        is_count_default: k.countDefault,
        active: k.active,
      };
      if (k.id) {
        packIds.set(k.key, k.id);
        if (JSON.stringify(beforePacks.get(k.id)) === JSON.stringify(k)) continue;
        const { data: rows, error: err } = await supabase.from("product_packs").update(values).eq("id", k.id).select("id");
        if (err) return fail(friendlyError(err, `No se pudo guardar el formato «${k.name}».`));
        if (!rows?.length) return fail("No tienes permisos para editar formatos.");
      } else {
        const { data: row, error: err } = await supabase.from("product_packs").insert({ product_id: productId, ...values }).select("id").single();
        if (err || !row) return fail(friendlyError(err, `No se pudo crear el formato «${k.name}».`));
        packIds.set(k.key, row.id);
      }
    }

    // 3) Precios por proveedor y formato
    const beforePrices = new Map(before.prices.map((r) => [r.key, r]));
    const nextPrices = draft.prices
      .filter((r) => packIds.has(r.packKey))
      .map((r) => ({ ...r, packId: packIds.get(r.packKey)!, id: `${r.supplierId}|${packIds.get(r.packKey)!}` }));
    const nextIds = new Set(nextPrices.map((r) => r.id));
    for (const old of before.prices) {
      if (nextIds.has(old.key) || !keptIds.has(old.packKey)) continue;
      const { error: err } = await supabase.from("supplier_prices").delete().eq("supplier_id", old.supplierId).eq("pack_id", old.packKey);
      if (err) return fail(friendlyError(err, "No se pudo quitar un precio."));
    }
    const changedPrices = nextPrices.filter((r) => {
      const old = beforePrices.get(r.id);
      return !old || !parseNum(old.price)?.eq(parseNum(r.price)!);
    });
    if (changedPrices.length > 0) {
      const now = new Date().toISOString();
      const { data: rows, error: err } = await supabase
        .from("supplier_prices")
        .upsert(
          changedPrices.map((r) => ({ supplier_id: r.supplierId, pack_id: r.packId, last_price: parseNum(r.price)!.toNumber(), last_price_at: now })),
          { onConflict: "supplier_id,pack_id" },
        )
        .select("pack_id");
      if (err) return fail(friendlyError(err, "No se pudieron guardar los precios."));
      if (!rows?.length) return fail("No tienes permisos para editar precios.");
    }

    // 4) Locales: alta, mínimos y cantidad objetivo
    const factor = qtyUnitFactor(draft);
    const toBase = (text: string) => (parseNum(text) ?? new Decimal(0)).mul(factor).toNumber();
    const beforeLocations = new Map(before.locations.map((l) => [l.locationId, l]));
    const upserts = [];
    for (const l of draft.locations) {
      const old = beforeLocations.get(l.locationId);
      const same = old && old.enabled === l.enabled && old.min === l.min && old.par === l.par && before.qtyUnit === draft.qtyUnit;
      if (same) continue;
      // Desactivar solo tiene sentido si la fila existe; se envían siempre todas las columnas
      // (en un upsert múltiple, una columna ausente se escribiría como null).
      if (!l.enabled && !data.existingLocations.has(l.locationId)) continue;
      upserts.push({ location_id: l.locationId, product_id: productId, min_qty: toBase(l.min), par_qty: toBase(l.par), active: l.enabled });
    }
    if (upserts.length > 0) {
      const { data: rows, error: err } = await supabase.from("location_products").upsert(upserts, { onConflict: "location_id,product_id" }).select("location_id");
      if (err) return fail(friendlyError(err, "No se pudieron guardar los locales."));
      if (!rows?.length) return fail("No tienes permisos para editar los locales de este producto.");
    }

    setSaving(false);
    setNotice(warnings.length > 0 ? warnings.join(" ") : "Cambios guardados.");
    onChanged();
    await reload();
  }

  async function remove() {
    const supabase = createClient();
    if (!supabase || !draft) return;
    setSaving(true);
    setError("");
    const { data: rows, error: err } = await supabase.from("products").delete().eq("id", productId).select("id");
    setSaving(false);
    setConfirmDelete(false);
    if (err?.code === "23503") {
      return setError("Este producto tiene movimientos, albaranes o inventarios y no se puede borrar sin perder el historial. Archívalo: dejará de aparecer en la operativa pero conservará sus datos.");
    }
    if (err) return setError(friendlyError(err, "No se pudo eliminar el producto."));
    if (!rows?.length) return setError("No tienes permisos para eliminar productos.");
    onChanged();
    onClose();
  }

  async function toggleArchive() {
    if (!draft) return;
    const supabase = createClient();
    if (!supabase) return;
    setSaving(true);
    const { data: rows, error: err } = await supabase.from("products").update({ active: !draft.active }).eq("id", productId).select("id");
    setSaving(false);
    if (err) return setError(friendlyError(err, "No se pudo cambiar el estado."));
    if (!rows?.length) return setError("No tienes permisos para archivar productos.");
    setNotice(draft.active ? "Producto archivado." : "Producto restaurado.");
    onChanged();
    await reload();
  }

  const d = draft;
  const packUnits = d ? BASE_UNITS[d.dimension] : [];
  const qtyUnits = d ? qtyUnitOptions(d) : [];
  const mainPack = d?.packs.find((k) => k.purchaseDefault && k.active);
  const categoryLabel = (c: { name: string; parentId: string | null }) => {
    const parent = c.parentId ? data?.categories.find((x) => x.id === c.parentId) : undefined;
    return parent ? `${parent.name} › ${c.name}` : c.name;
  };

  return (
    <div className="modal-layer editor-layer" onClick={close}>
      <section className="product-editor" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true" aria-label="Ficha de producto">
        <header className="editor-header">
          <div>
            <p className="eyebrow">Ficha de producto</p>
            <h2>{d?.name || "Producto"}</h2>
            {d && !d.active && <span className="editor-badge">Archivado</span>}
          </div>
          <button className="modal-close" onClick={close} aria-label="Cerrar">
            <X size={18} />
          </button>
        </header>

        <nav className="editor-tabs" role="tablist">
          {(
            [
              ["general", "General"],
              ["formatos", `Formatos${d ? ` (${d.packs.length})` : ""}`],
              ["precios", `Precios${d ? ` (${d.prices.length})` : ""}`],
              ["locales", "Locales y stock"],
            ] as Array<[Tab, string]>
          ).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? "active" : ""} onClick={() => setTab(id)}>
              {label}
            </button>
          ))}
        </nav>

        <div className="editor-body">
          {loadError && (
            <div className="catalog-empty">
              <strong>{loadError}</strong>
              <button className="filter-button" onClick={() => void reload()}>Reintentar</button>
            </div>
          )}
          {!d && !loadError && <div className="catalog-empty"><strong>Cargando ficha...</strong></div>}

          {d && data && tab === "general" && (
            <div className="editor-grid">
              <label className="span-2">
                Nombre
                <input value={d.name} onChange={(e) => patch({ name: e.target.value })} />
              </label>
              <label>
                SKU / referencia interna
                <input value={d.sku} onChange={(e) => patch({ sku: e.target.value })} placeholder="Opcional" />
              </label>
              <label>
                Categoría
                {newCategory === null ? (
                  <div className="inline-field">
                    <select value={d.categoryId} onChange={(e) => patch({ categoryId: e.target.value })}>
                      <option value="">Sin categoría</option>
                      {data.categories.map((c) => (
                        <option key={c.id} value={c.id}>{categoryLabel(c)}</option>
                      ))}
                    </select>
                    <button type="button" className="ghost-button" onClick={() => setNewCategory("")}><Plus size={14} /> Nueva</button>
                  </div>
                ) : (
                  <div className="inline-field">
                    <input autoFocus value={newCategory} onChange={(e) => setNewCategory(e.target.value)} placeholder="Nombre de la categoría" onKeyDown={(e) => e.key === "Enter" && void createCategory()} />
                    <button type="button" className="ghost-button" onClick={() => void createCategory()}>Crear</button>
                    <button type="button" className="ghost-button" onClick={() => setNewCategory(null)}><X size={14} /></button>
                  </div>
                )}
              </label>
              <label>
                Cómo se mide
                <select
                  value={d.dimension}
                  disabled={data.hasMovements}
                  onChange={(e) => {
                    const dimension = e.target.value as UnitDimension;
                    patch({ dimension, qtyUnit: baseUnit(dimension), packs: d.packs.map((k) => ({ ...k, unit: baseUnit(dimension) })) });
                  }}
                >
                  <option value="volume">Volumen (ml)</option>
                  <option value="mass">Peso (g)</option>
                  <option value="count">Unidades (ud)</option>
                </select>
                {data.hasMovements && <small className="field-hint">No se puede cambiar: ya tiene movimientos de stock.</small>}
              </label>
              <label>
                Estado
                <select value={d.active ? "1" : "0"} onChange={(e) => patch({ active: e.target.value === "1" })}>
                  <option value="1">Activo</option>
                  <option value="0">Archivado</option>
                </select>
              </label>
              <div className="span-2 editor-summary">
                <div><span>Formato de compra</span><strong>{mainPack ? `${mainPack.name}` : "Sin definir"}</strong></div>
                <div><span>Proveedores</span><strong>{new Set(d.prices.map((r) => r.supplierId)).size}</strong></div>
                <div><span>Stock total</span><strong>{formatQuantity([...data.stock.values()].reduce((a, b) => a + b, 0), d.dimension)}</strong></div>
              </div>
            </div>
          )}

          {d && tab === "formatos" && (
            <div className="editor-section">
              <p className="section-hint">Cómo se compra y se cuenta el producto. Ej.: «Botella 70 cl», «Caja 6 × 70 cl» = 4,2 l.</p>
              <div className="editor-table packs-table">
                <div className="editor-head"><span>Nombre</span><span>Contenido</span><span>Código de barras</span><span title="Formato de compra por defecto">Compra</span><span title="Formato de conteo por defecto">Conteo</span><span>Activo</span><span /></div>
                {d.packs.map((k) => (
                  <div className="editor-row" key={k.key}>
                    <input value={k.name} onChange={(e) => patchPack(k.key, { name: e.target.value })} placeholder="Botella 70 cl" />
                    <div className="qty-input">
                      <input inputMode="decimal" value={k.amount} onChange={(e) => patchPack(k.key, { amount: e.target.value })} placeholder="70" />
                      <select value={k.unit} onChange={(e) => patchPack(k.key, { unit: e.target.value })}>
                        {packUnits.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                      </select>
                    </div>
                    <input value={k.barcode} onChange={(e) => patchPack(k.key, { barcode: e.target.value })} placeholder="Opcional" />
                    <button type="button" className={`star ${k.purchaseDefault ? "on" : ""}`} onClick={() => patchPack(k.key, { purchaseDefault: !k.purchaseDefault })} aria-label="Formato de compra por defecto"><Star size={15} /></button>
                    <button type="button" className={`star ${k.countDefault ? "on" : ""}`} onClick={() => patchPack(k.key, { countDefault: !k.countDefault })} aria-label="Formato de conteo por defecto"><Star size={15} /></button>
                    <input type="checkbox" checked={k.active} onChange={(e) => patchPack(k.key, { active: e.target.checked })} aria-label="Activo" />
                    <button
                      type="button"
                      className="icon-danger"
                      aria-label={`Eliminar ${k.name}`}
                      onClick={() => setDraft({ ...d, packs: d.packs.filter((x) => x.key !== k.key), prices: d.prices.filter((r) => r.packKey !== k.key) })}
                    >
                      <Trash2 size={15} />
                    </button>
                  </div>
                ))}
                {d.packs.length === 0 && <p className="editor-empty">Sin formatos. Añade al menos el formato en que lo compras.</p>}
              </div>
              <button
                type="button"
                className="ghost-button add-row"
                onClick={() =>
                  patch({
                    packs: [
                      ...d.packs,
                      { key: newKey(), id: null, name: "", amount: "", unit: packUnits[packUnits.length > 1 ? 1 : 0]!.id, barcode: "", purchaseDefault: d.packs.length === 0, countDefault: d.packs.length === 0, active: true },
                    ],
                  })
                }
              >
                <Plus size={14} /> Añadir formato
              </button>
            </div>
          )}

          {d && data && tab === "precios" && (
            <div className="editor-section">
              <p className="section-hint">Último precio de compra por proveedor y formato. Las recepciones de mercancía lo actualizan solas.</p>
              <div className="editor-table prices-table">
                <div className="editor-head"><span>Proveedor</span><span>Formato</span><span>Precio</span><span>Coste unitario</span><span /></div>
                {d.prices.map((r) => {
                  const pack = d.packs.find((k) => k.key === r.packKey);
                  const price = parseNum(r.price);
                  const amount = pack ? parseNum(pack.amount) : null;
                  const unit = pack ? packUnits.find((u) => u.id === pack.unit) : undefined;
                  const perUnit = price && amount && amount.gt(0) && unit ? price.div(amount) : null;
                  return (
                    <div className="editor-row" key={r.key}>
                      <select value={r.supplierId} onChange={(e) => patchPrice(r.key, { supplierId: e.target.value })}>
                        <option value="">Elige proveedor</option>
                        {data.suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                      </select>
                      <select value={r.packKey} onChange={(e) => patchPrice(r.key, { packKey: e.target.value })}>
                        <option value="">Elige formato</option>
                        {d.packs.map((k) => <option key={k.key} value={k.key}>{k.name || "(sin nombre)"}</option>)}
                      </select>
                      <div className="money-input">
                        <input inputMode="decimal" value={r.price} onChange={(e) => patchPrice(r.key, { price: e.target.value })} placeholder="0,00" />
                        <span>€</span>
                      </div>
                      <span className="muted">
                        {perUnit && unit ? `${money(perUnit)}/${unit.label}` : "—"}
                        {r.lastAt && <small>act. {new Date(r.lastAt).toLocaleDateString("es-ES")}</small>}
                      </span>
                      <button type="button" className="icon-danger" aria-label="Quitar precio" onClick={() => patch({ prices: d.prices.filter((x) => x.key !== r.key) })}>
                        <Trash2 size={15} />
                      </button>
                    </div>
                  );
                })}
                {d.prices.length === 0 && <p className="editor-empty">Sin precios. Añade el proveedor al que se lo compras.</p>}
              </div>
              <div className="row-actions">
                <button
                  type="button"
                  className="ghost-button add-row"
                  disabled={d.packs.length === 0}
                  title={d.packs.length === 0 ? "Crea primero un formato" : undefined}
                  onClick={() => patch({ prices: [...d.prices, { key: newKey(), supplierId: "", packKey: (mainPack ?? d.packs[0])?.key ?? "", price: "", lastAt: null }] })}
                >
                  <Plus size={14} /> Añadir precio
                </button>
                {newSupplier === null ? (
                  <button type="button" className="ghost-button" onClick={() => setNewSupplier("")}><Plus size={14} /> Nuevo proveedor</button>
                ) : (
                  <div className="inline-field">
                    <input autoFocus value={newSupplier} onChange={(e) => setNewSupplier(e.target.value)} placeholder="Nombre del proveedor" onKeyDown={(e) => e.key === "Enter" && void createSupplier()} />
                    <button type="button" className="ghost-button" onClick={() => void createSupplier()}>Crear</button>
                    <button type="button" className="ghost-button" onClick={() => setNewSupplier(null)}><X size={14} /></button>
                  </div>
                )}
              </div>
            </div>
          )}

          {d && data && tab === "locales" && (
            <div className="editor-section">
              <div className="section-toolbar">
                <p className="section-hint">Activa el producto en cada local y define el mínimo (alerta) y la cantidad objetivo (para sugerir pedidos).</p>
                <label className="unit-picker">
                  Cantidades en
                  <select value={d.qtyUnit} onChange={(e) => convertQtyUnit(e.target.value)}>
                    {qtyUnits.map((u) => <option key={u.id} value={u.id}>{u.label}</option>)}
                  </select>
                </label>
              </div>
              <div className="editor-table locations-table">
                <div className="editor-head"><span>Local</span><span>Activo</span><span>Stock actual</span><span>Mínimo</span><span>Objetivo</span></div>
                {data.allLocations.map((loc) => {
                  const l = d.locations.find((x) => x.locationId === loc.id)!;
                  const qty = data.stock.get(loc.id) ?? 0;
                  const minBase = l.min ? (parseNum(l.min) ?? new Decimal(0)).mul(qtyUnitFactor(d)) : null;
                  const low = l.enabled && minBase && minBase.gt(0) && new Decimal(qty).lt(minBase);
                  return (
                    <div className={`editor-row ${l.enabled ? "" : "disabled"}`} key={loc.id}>
                      <strong>{loc.name}</strong>
                      <input type="checkbox" checked={l.enabled} onChange={(e) => patchLocation(loc.id, { enabled: e.target.checked })} aria-label={`Activo en ${loc.name}`} />
                      <span className={low ? "stock-low" : undefined}>
                        {formatQuantity(qty, d.dimension, mainPack && packQtyBase(mainPack, d) > 0 ? { name: mainPack.name, qtyBase: String(packQtyBase(mainPack, d)) } : undefined)}
                      </span>
                      <input inputMode="decimal" disabled={!l.enabled} value={l.min} onChange={(e) => patchLocation(loc.id, { min: e.target.value })} placeholder="0" />
                      <input inputMode="decimal" disabled={!l.enabled} value={l.par} onChange={(e) => patchLocation(loc.id, { par: e.target.value })} placeholder="0" />
                    </div>
                  );
                })}
                {data.allLocations.length === 0 && <p className="editor-empty">No hay locales activos.</p>}
              </div>
              <p className="section-hint">El stock cambia con recepciones, traspasos, mermas e inventarios; no se edita aquí para no perder la trazabilidad.</p>
            </div>
          )}
        </div>

        {(error || notice) && <p className={error ? "editor-message error" : "editor-message"}>{error || notice}</p>}

        <footer className="editor-footer">
          {confirmDelete ? (
            <div className="delete-confirm">
              <span>¿Eliminar «{d?.name}» definitivamente?</span>
              <button className="danger-button" disabled={saving} onClick={() => void remove()}>Sí, eliminar</button>
              <button className="ghost-button" onClick={() => setConfirmDelete(false)}>Cancelar</button>
            </div>
          ) : (
            <div className="footer-left">
              <button className="ghost-button danger" disabled={!d || saving} onClick={() => setConfirmDelete(true)}><Trash2 size={14} /> Eliminar</button>
              <button className="ghost-button" disabled={!d || saving || dirty} title={dirty ? "Guarda o descarta los cambios primero" : undefined} onClick={() => void toggleArchive()}>
                {d?.active === false ? <><ArchiveRestore size={14} /> Restaurar</> : <><Archive size={14} /> Archivar</>}
              </button>
            </div>
          )}
          <div className="footer-right">
            {dirty && <button className="ghost-button" disabled={saving} onClick={() => data && setDraft(data.draft)}>Descartar</button>}
            <button className="catalog-primary" disabled={!dirty || saving} onClick={() => void save()}>
              {saving ? "Guardando..." : "Guardar cambios"}
            </button>
          </div>
        </footer>
      </section>
    </div>
  );

  function convertQtyUnit(next: string) {
    if (!d) return;
    const from = qtyUnitFactor(d);
    const to = qtyUnitFactor({ ...d, qtyUnit: next });
    const convert = (text: string) => {
      const n = parseNum(text);
      return n ? show(n.mul(from).div(to)) : text;
    };
    patch({ qtyUnit: next, locations: d.locations.map((l) => ({ ...l, min: convert(l.min), par: convert(l.par) })) });
  }
}

function packQtyBase(pack: PackDraft, d: Draft): number {
  const amount = parseNum(pack.amount);
  const unit = BASE_UNITS[d.dimension].find((u) => u.id === pack.unit);
  return amount && unit ? amount.mul(unit.factor).toNumber() : 0;
}

/** Unidades para mínimos/objetivo: las de medida más los formatos activos (ej. "Botella 70 cl"). */
function qtyUnitOptions(d: Draft): Unit[] {
  return [
    ...BASE_UNITS[d.dimension],
    ...d.packs.filter((k) => k.id && k.active && packQtyBase(k, d) > 0).map((k) => ({ id: `pack:${k.key}`, label: k.name, factor: packQtyBase(k, d) })),
  ];
}

function qtyUnitFactor(d: Draft): number {
  return qtyUnitOptions(d).find((u) => u.id === d.qtyUnit)?.factor ?? 1;
}
