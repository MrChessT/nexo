"use client";

import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  CirclePlus,
  Package,
  Search,
  SlidersHorizontal,
  X,
} from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { normalizeText } from "@/lib/format";
import { formatQuantity, type UnitDimension } from "@/lib/units";
import { ProductEditor } from "./product-editor";
import "./productos.css";

// El filtrado, orden y paginado se hacen en Postgres (catalog_search, migración 0007):
// la página solo descarga los productos visibles y los contadores de cada filtro.

const PAGE_SIZE = 50;

type Status = "active" | "archived" | "all";
type StockFilter = "" | "con" | "sin" | "bajo";
type Sort = "name" | "name_desc" | "recent" | "category";

type Filters = {
  q: string;
  cat: string; // id de categoría o "sin" para productos sin categoría
  prov: string;
  local: string;
  medida: "" | UnitDimension;
  estado: Status;
  stock: StockFilter;
  orden: Sort;
  pag: number;
};

type Item = {
  id: string;
  name: string;
  sku: string | null;
  dimension: UnitDimension;
  active: boolean;
  category: string | null;
  packs: number;
  main_pack: string | null;
  suppliers: string[];
  locations: number;
  stock_qty: string;
  low_stock: boolean;
};

type Option = { id: string; name: string; count: number };

type SearchResult = {
  total: number;
  items: Item[];
  facets: {
    status: Record<Status, number>;
    stock: Record<"con" | "sin" | "bajo", number>;
    dimensions: Partial<Record<UnitDimension, number>>;
    categories: Option[];
    uncategorized: number;
    suppliers: Option[];
    locations: Option[];
  };
};

const EMPTY: Filters = { q: "", cat: "", prov: "", local: "", medida: "", estado: "active", stock: "", orden: "name", pag: 1 };

const dimensionLabels: Record<UnitDimension, string> = { mass: "Peso", volume: "Volumen", count: "Unidades" };
const stockLabels: Record<Exclude<StockFilter, "">, string> = { con: "Con stock", sin: "Sin stock", bajo: "Bajo mínimo" };
const sortLabels: Record<Sort, string> = { name: "Nombre A-Z", name_desc: "Nombre Z-A", category: "Categoría", recent: "Más recientes" };

function readFilters(): Filters {
  const p = new URLSearchParams(window.location.search);
  const pick = <T extends string>(key: string, allowed: readonly T[], fallback: T): T => {
    const v = p.get(key) as T | null;
    return v && allowed.includes(v) ? v : fallback;
  };
  return {
    q: p.get("q") ?? "",
    cat: p.get("cat") ?? "",
    prov: p.get("prov") ?? "",
    local: p.get("local") ?? "",
    medida: pick("medida", ["", "mass", "volume", "count"] as const, ""),
    estado: pick("estado", ["active", "archived", "all"] as const, "active"),
    stock: pick("stock", ["", "con", "sin", "bajo"] as const, ""),
    orden: pick("orden", ["name", "name_desc", "recent", "category"] as const, "name"),
    pag: Math.max(1, Number(p.get("pag")) || 1),
  };
}

function writeUrl(f: Filters) {
  const p = new URLSearchParams();
  for (const [key, value] of Object.entries(f)) {
    if (value !== EMPTY[key as keyof Filters] && value !== "") p.set(key, String(value));
  }
  const query = p.toString();
  window.history.replaceState(null, "", query ? `/productos?${query}` : "/productos");
}

// Caché corta en memoria: volver a un filtro ya visto es instantáneo.
const cache = new Map<string, { at: number; data: SearchResult }>();
const CACHE_MS = 60_000;

async function search(f: Filters): Promise<SearchResult> {
  const key = JSON.stringify(f);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.data;
  const supabase = createClient();
  if (!supabase) throw new Error("Configura las variables de Supabase para cargar el catálogo.");
  const { data, error } = await supabase.rpc("catalog_search", {
    p_search: f.q.trim() || null,
    p_category: f.cat && f.cat !== "sin" ? f.cat : null,
    p_no_category: f.cat === "sin",
    p_supplier: f.prov || null,
    p_location: f.local || null,
    p_dimension: f.medida || null,
    p_status: f.estado,
    p_stock: f.stock || null,
    p_sort: f.orden,
    p_limit: PAGE_SIZE,
    p_offset: (f.pag - 1) * PAGE_SIZE,
  });
  if (error) {
    throw new Error(
      error.code === "PGRST202"
        ? "Falta aplicar la migración 0007_catalogo_filtros.sql en Supabase."
        : "No se pudo cargar el catálogo. Revisa la conexión e inténtalo de nuevo.",
    );
  }
  const result = data as unknown as SearchResult;
  cache.set(key, { at: Date.now(), data: result });
  return result;
}

function FacetList({
  title,
  options,
  value,
  onChange,
  searchable,
}: {
  title: string;
  options: Option[];
  value: string;
  onChange: (id: string) => void;
  searchable?: boolean;
}) {
  const [filter, setFilter] = useState("");
  const [expanded, setExpanded] = useState(false);
  const visible = options
    .filter((o) => o.count > 0 || o.id === value)
    .filter((o) => !filter || normalizeText(o.name).includes(normalizeText(filter)));
  const shown = expanded || filter ? visible : visible.slice(0, 8);
  if (options.length === 0) return null;
  return (
    <div className="facet">
      <p className="facet-title">{title}</p>
      {searchable && options.length > 8 && (
        <input className="facet-search" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={`Buscar ${title.toLowerCase()}`} />
      )}
      {shown.map((o) => (
        <button key={o.id} className={`facet-option ${value === o.id ? "active" : ""}`} onClick={() => onChange(value === o.id ? "" : o.id)}>
          <span>{o.name}</span>
          <b>{o.count}</b>
        </button>
      ))}
      {!filter && visible.length > 8 && (
        <button className="facet-more" onClick={() => setExpanded(!expanded)}>
          {expanded ? "Ver menos" : `Ver ${visible.length - 8} más`}
        </button>
      )}
      {visible.length === 0 && <p className="facet-none">Sin coincidencias</p>}
    </div>
  );
}

export default function ProductsPage() {
  const [filters, setFilters] = useState<Filters>(EMPTY);
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult | null>(null);
  const [ready, setReady] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);
  const [name, setName] = useState("");
  const [dimension, setDimension] = useState<UnitDimension>("count");
  const [saving, setSaving] = useState(false);
  const [modalError, setModalError] = useState("");
  const [editingId, setEditingId] = useState<string | null>(null);
  const requestId = useRef(0);
  const searchInput = useRef<HTMLInputElement>(null);

  // Filtros iniciales desde la URL (el asistente enlaza aquí con ?producto= o ?local=).
  useEffect(() => {
    async function bootstrap() {
      await Promise.resolve();
      const initial = readFilters();
      const productId = new URLSearchParams(window.location.search).get("producto");
      if (productId) {
        const { data } = (await createClient()?.from("products").select("name").eq("id", productId).maybeSingle()) ?? { data: null };
        if (data?.name) {
          initial.q = data.name;
          initial.estado = "all";
        }
      }
      setFilters(initial);
      setQuery(initial.q);
      setReady(true);
    }
    void bootstrap();
  }, []);

  // Búsqueda con retardo: no se consulta en cada tecla.
  useEffect(() => {
    if (!ready || query === filters.q) return;
    const timer = setTimeout(() => setFilters((f) => ({ ...f, q: query, pag: 1 })), 250);
    return () => clearTimeout(timer);
  }, [query, filters.q, ready]);

  useEffect(() => {
    if (!ready) return;
    writeUrl(filters);
    const id = ++requestId.current;
    async function run() {
      await Promise.resolve();
      setLoading(true);
      setError("");
      try {
        const data = await search(filters);
        if (id === requestId.current) setResult(data);
      } catch (err) {
        if (id === requestId.current) setError(err instanceof Error ? err.message : "No se pudo cargar el catálogo.");
      } finally {
        if (id === requestId.current) setLoading(false);
      }
    }
    void run();
  }, [filters, ready]);

  // Atajo: "/" enfoca la búsqueda.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement;
      if (document.querySelector(".product-editor")) return; // con la ficha abierta, "/" no salta al buscador
      if (event.key === "/" && !["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) {
        event.preventDefault();
        searchInput.current?.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function update(patch: Partial<Filters>) {
    setFilters((f) => ({ ...f, ...patch, pag: patch.pag ?? 1 }));
  }

  function clearAll() {
    setQuery("");
    setFilters({ ...EMPTY, estado: filters.estado, orden: filters.orden });
  }

  const facets = result?.facets;
  const nameOf = (list: Option[] | undefined, id: string) => list?.find((o) => o.id === id)?.name ?? "…";
  const chips: Array<{ label: string; clear: () => void }> = [];
  if (filters.q) chips.push({ label: `“${filters.q}”`, clear: () => { setQuery(""); update({ q: "" }); } });
  if (filters.cat) chips.push({ label: filters.cat === "sin" ? "Sin categoría" : nameOf(facets?.categories, filters.cat), clear: () => update({ cat: "" }) });
  if (filters.prov) chips.push({ label: nameOf(facets?.suppliers, filters.prov), clear: () => update({ prov: "" }) });
  if (filters.local) chips.push({ label: nameOf(facets?.locations, filters.local), clear: () => update({ local: "" }) });
  if (filters.medida) chips.push({ label: dimensionLabels[filters.medida], clear: () => update({ medida: "" }) });
  if (filters.stock) chips.push({ label: stockLabels[filters.stock], clear: () => update({ stock: "" }) });

  const total = result?.total ?? 0;
  const pages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const from = total === 0 ? 0 : (filters.pag - 1) * PAGE_SIZE + 1;
  const to = Math.min(total, filters.pag * PAGE_SIZE);

  const categoryOptions: Option[] = facets
    ? [...facets.categories, ...(facets.uncategorized > 0 || filters.cat === "sin" ? [{ id: "sin", name: "Sin categoría", count: facets.uncategorized }] : [])]
    : [];

  async function addProduct() {
    const productName = name.trim();
    if (!productName || saving) return;
    setSaving(true);
    setModalError("");
    const supabase = createClient();
    if (!supabase) {
      setModalError("Configura las variables de Supabase para crear productos.");
      setSaving(false);
      return;
    }
    const { data: membership, error: membershipError } = await supabase.from("memberships").select("org_id").limit(1).maybeSingle();
    if (membershipError || !membership) {
      setModalError("No se encontró una organización activa para crear el producto.");
      setSaving(false);
      return;
    }
    const { data: created, error: insertError } = await supabase
      .from("products")
      .insert({ org_id: membership.org_id, name: productName, dimension })
      .select("id")
      .single();
    if (insertError || !created) {
      setModalError(insertError?.code === "23505" ? "Ya existe un producto con ese nombre." : "No se pudo crear el producto.");
      setSaving(false);
      return;
    }
    setName("");
    setDimension("count");
    setModalOpen(false);
    setSaving(false);
    refresh();
    // Se abre la ficha para completar formatos, precios y locales.
    setEditingId(created.id);
  }

  function refresh() {
    cache.clear();
    setFilters((f) => ({ ...f }));
  }

  return (
    <main className="catalog-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Resumen
        </Link>
        <span className="catalog-title">Catálogo</span>
        <span />
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Parador Eventos · Catálogo común</p>
            <h1>Productos</h1>
            <p className="catalog-subtitle">Un solo catálogo para todos tus locales y proveedores.</p>
          </div>
          <button className="catalog-primary" onClick={() => setModalOpen(true)}>
            <CirclePlus size={17} /> Nuevo producto
          </button>
        </div>
        <div className="catalog-tabs">
          {(["active", "archived", "all"] as const).map((s) => (
            <button key={s} className={filters.estado === s ? "active" : undefined} onClick={() => update({ estado: s })}>
              {s === "active" ? "Activos" : s === "archived" ? "Archivados" : "Todos"} <b>{facets?.status[s] ?? "·"}</b>
            </button>
          ))}
        </div>
        <section className="catalog-panel">
          <div className="catalog-toolbar">
            <div className="catalog-search">
              <Search size={16} />
              <input
                ref={searchInput}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar por nombre, categoría, SKU o código de barras  ( / )"
              />
              {query && (
                <button className="search-clear" aria-label="Borrar búsqueda" onClick={() => setQuery("")}>
                  <X size={14} />
                </button>
              )}
            </div>
            <label className="sort-select">
              Ordenar
              <select value={filters.orden} onChange={(e) => update({ orden: e.target.value as Sort })}>
                {(Object.keys(sortLabels) as Sort[]).map((s) => (
                  <option key={s} value={s}>{sortLabels[s]}</option>
                ))}
              </select>
            </label>
            <button className="filter-button filters-toggle" onClick={() => setFiltersOpen(!filtersOpen)}>
              <SlidersHorizontal size={15} /> Filtros {chips.length > 0 && <b className="filters-count">{chips.length}</b>}
            </button>
          </div>
          {chips.length > 0 && (
            <div className="catalog-chips">
              {chips.map((chip) => (
                <button key={chip.label} className="chip" onClick={chip.clear}>
                  {chip.label} <X size={12} />
                </button>
              ))}
              <button className="chip-clear" onClick={clearAll}>Limpiar filtros</button>
            </div>
          )}
          <div className="catalog-body">
            <aside className={`catalog-facets ${filtersOpen ? "open" : ""}`}>
              {facets && (
                <>
                  <div className="facet">
                    <p className="facet-title">Stock</p>
                    {(["bajo", "con", "sin"] as const).map((s) => (
                      <button key={s} className={`facet-option ${filters.stock === s ? "active" : ""}`} onClick={() => update({ stock: filters.stock === s ? "" : s })}>
                        <span>{stockLabels[s]}</span>
                        <b>{facets.stock[s]}</b>
                      </button>
                    ))}
                  </div>
                  <FacetList title="Categoría" options={categoryOptions} value={filters.cat} onChange={(cat) => update({ cat })} searchable />
                  <FacetList title="Proveedor" options={facets.suppliers} value={filters.prov} onChange={(prov) => update({ prov })} searchable />
                  <FacetList title="Local" options={facets.locations} value={filters.local} onChange={(local) => update({ local })} />
                  <div className="facet">
                    <p className="facet-title">Cómo se mide</p>
                    {(["volume", "mass", "count"] as const).map((d) => (
                      <button key={d} className={`facet-option ${filters.medida === d ? "active" : ""}`} onClick={() => update({ medida: filters.medida === d ? "" : d })}>
                        <span>{dimensionLabels[d]}</span>
                        <b>{facets.dimensions[d] ?? 0}</b>
                      </button>
                    ))}
                  </div>
                </>
              )}
            </aside>
            <div className={`catalog-table ${loading && result ? "is-loading" : ""}`}>
              <div className="catalog-head">
                <span>Producto</span>
                <span>Formato</span>
                <span>Proveedor</span>
                <span>Stock{filters.local ? " en el local" : ""}</span>
                <span>Estado</span>
              </div>
              {loading && !result && (
                <div className="catalog-empty">
                  <strong>Cargando catálogo...</strong>
                </div>
              )}
              {error && (
                <div className="catalog-empty">
                  <strong>No se pudo cargar el catálogo</strong>
                  <span>{error}</span>
                  <button className="filter-button" onClick={() => { cache.clear(); setFilters((f) => ({ ...f })); }}>
                    Reintentar
                  </button>
                </div>
              )}
              {!error &&
                result?.items.map((product) => (
                  <div
                    className="catalog-row clickable"
                    key={product.id}
                    role="button"
                    tabIndex={0}
                    title="Abrir ficha"
                    onClick={() => setEditingId(product.id)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setEditingId(product.id);
                      }
                    }}
                  >
                    <div className="catalog-product">
                      <span className="catalog-product-icon">
                        <Package size={17} />
                      </span>
                      <span>
                        <strong>{product.name}</strong>
                        <small>
                          {product.category ?? "Sin categoría"}
                          {product.sku ? ` · ${product.sku}` : ""}
                        </small>
                      </span>
                    </div>
                    <span>
                      {product.main_pack ?? <em className="muted">Sin formato</em>}
                      {product.packs > 1 && <small className="muted"> +{product.packs - 1}</small>}
                    </span>
                    <span className="cell-ellipsis" title={product.suppliers.join(", ")}>
                      {product.suppliers.length ? product.suppliers.join(", ") : <em className="muted">—</em>}
                    </span>
                    <span className={product.low_stock ? "stock-low" : undefined}>
                      {product.locations === 0 ? <em className="muted">Sin local</em> : formatQuantity(product.stock_qty, product.dimension)}
                      {product.low_stock && <small> · bajo mínimo</small>}
                    </span>
                    <span className={`active-status ${product.active ? "" : "inactive-status"}`}>
                      <i /> {product.active ? "Activo" : "Archivado"}
                    </span>
                  </div>
                ))}
              {!error && result && result.items.length === 0 && (
                <div className="catalog-empty">
                  <Search size={20} />
                  <strong>No hay resultados</strong>
                  <span>Prueba con otra búsqueda o quita algún filtro.</span>
                  {chips.length > 0 && <button className="filter-button" onClick={clearAll}>Limpiar filtros</button>}
                </div>
              )}
              {!error && total > 0 && (
                <div className="catalog-pager">
                  <span>
                    {from}–{to} de {total}
                  </span>
                  <div>
                    <button disabled={filters.pag <= 1} onClick={() => update({ pag: filters.pag - 1 })} aria-label="Página anterior">
                      <ChevronLeft size={16} />
                    </button>
                    <span>
                      {filters.pag} / {pages}
                    </span>
                    <button disabled={filters.pag >= pages} onClick={() => update({ pag: filters.pag + 1 })} aria-label="Página siguiente">
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
      {editingId && <ProductEditor productId={editingId} onClose={() => setEditingId(null)} onChanged={refresh} />}
      {modalOpen && (
        <div className="modal-layer" onClick={() => setModalOpen(false)}>
          <section className="product-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-heading">
              <div>
                <p className="eyebrow">Alta rápida</p>
                <h2>Nuevo producto</h2>
              </div>
              <button className="modal-close" onClick={() => setModalOpen(false)} aria-label="Cerrar">
                <X size={18} />
              </button>
            </div>
            <label>
              Nombre del producto
              <input value={name} onChange={(event) => setName(event.target.value)} placeholder="Ej. Ginebra Nordés" autoFocus />
            </label>
            <label>
              Cómo se mide
              <select value={dimension} onChange={(event) => setDimension(event.target.value as UnitDimension)}>
                <option value="volume">Volumen (ml)</option>
                <option value="mass">Peso (g)</option>
                <option value="count">Unidades (ud)</option>
              </select>
            </label>
            <div className="modal-note">
              <Check size={15} /> Al crearlo se abre su ficha para añadir formatos, precios y locales
            </div>
            <button className="catalog-primary modal-submit" onClick={addProduct} disabled={saving || !name.trim()}>
              {saving ? "Guardando..." : "Crear producto"}
            </button>
            {modalError && <p className="modal-error">{modalError}</p>}
          </section>
        </div>
      )}
    </main>
  );
}
