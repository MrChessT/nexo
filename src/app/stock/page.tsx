"use client";

import { useEffect, useRef, useState } from "react";
import Decimal from "decimal.js";
import { ArrowLeft, ChevronDown, ChevronRight, Download, Filter, Search, Warehouse } from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import { daysAgo, euros, normalizeText, quantity } from "@/lib/format";
import { readLocation, saveLocation } from "@/lib/location-preference";
import { formatStock, type CountingPacks, type UnitDimension } from "@/lib/units";
import "../productos/productos.css";
import "./stock.css";

// Existencias por local: filtro por local, estado y texto; exportación CSV; último inventario cerrado.

type Status = "ok" | "low" | "critical";
type StockRow = {
  id: string;
  locationId: string;
  locationName: string;
  name: string;
  category: string;
  quantity: string;
  value: string;
  valueNumber: string;
  minimum: string;
  status: Status;
};
type Location = { id: string; name: string };

type ValuationRow = {
  location_id: string;
  location_name: string | null;
  product_id: string;
  product_name: string;
  category_name: string | null;
  base_unit: string;
  qty: number;
  stock_value: number | null;
  min_qty: number | null;
  below_min: boolean;
  family_name?: string | null;
  dimension?: UnitDimension | null;
  count_pack_name?: string | null;
  count_pack_qty?: number | null;
  purchase_pack_name?: string | null;
  purchase_pack_qty?: number | null;
};

function countingPacks(row: ValuationRow): CountingPacks {
  return {
    dimension: row.dimension ?? "count",
    countPack: row.count_pack_name && row.count_pack_qty ? { name: row.count_pack_name, qtyBase: String(row.count_pack_qty) } : null,
    purchasePack: row.purchase_pack_name && row.purchase_pack_qty ? { name: row.purchase_pack_name, qtyBase: String(row.purchase_pack_qty) } : null,
  };
}

const STATUS_LABEL: Record<Status, string> = { ok: "Correcto", low: "Bajo mínimo", critical: "Urgente" };

function exportCsv(rows: StockRow[], label: string) {
  const header = ["Producto", "Categoría", "Local", "Existencias", "Valor (€)", "Mínimo", "Estado"];
  const escape = (v: string) => (/[";\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = rows.map((r) => [r.name, r.category, r.locationName, r.quantity, r.valueNumber.replace(".", ","), r.minimum, STATUS_LABEL[r.status]].map(escape).join(";"));
  // BOM + ";" para que Excel en español lo abra con tildes y columnas correctas.
  const blob = new Blob([`﻿${[header.join(";"), ...lines].join("\r\n")}`], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `stock-${label.toLowerCase().replace(/\s+/g, "-")}-${new Date().toLocaleDateString("sv-SE")}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}

export default function StockPage() {
  const [location, setLocation] = useState<string | null>(null);
  const [locations, setLocations] = useState<Location[]>([]);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [lastCount, setLastCount] = useState<{ at: string; location: string } | null>(null);
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<"" | Status>("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [reloadKey, setReloadKey] = useState(0);
  const requestId = useRef(0);

  // Local inicial: ?local= (enlaces del resumen y del asistente) o el último elegido en el resumen.
  useEffect(() => {
    async function start() {
      await Promise.resolve();
      const fromUrl = new URLSearchParams(window.location.search).get("local");
      setLocation(fromUrl ?? readLocation());
      const supabase = createClient();
      const { data } = (await supabase?.from("locations").select("id, name").eq("active", true).order("name")) ?? { data: null };
      setLocations((data ?? []) as Location[]);
    }
    void start();
  }, []);

  useEffect(() => {
    if (location === null) return;
    const id = ++requestId.current;
    const selected = location;
    async function run() {
      await Promise.resolve();
      setLoading(true);
      setError("");
      const supabase = createClient();
      if (!supabase) {
        setError("Configura las variables de Supabase para cargar el stock.");
        setLoading(false);
        return;
      }
      const BASE = "location_id, location_name, product_id, product_name, category_name, base_unit, qty, stock_value, min_qty, below_min";
      // Con la migración 0016 la vista trae familia y formatos («12 botellas», «2 cajas + 5 ud»).
      const FULL = `${BASE}, family_name, dimension, count_pack_name, count_pack_qty, purchase_pack_name, purchase_pack_qty`;
      const stockQueryFor = (columns: string) => {
        const q = supabase.from("v_stock_valuation").select(columns).order("product_name");
        return selected ? q.eq("location_id", selected) : q;
      };
      let countQuery = supabase.from("inventory_counts").select("closed_at, locations(name)").eq("status", "closed").order("closed_at", { ascending: false }).limit(1);
      if (selected) countQuery = countQuery.eq("location_id", selected);
      const [full, count] = await Promise.all([stockQueryFor(FULL), countQuery]);
      const stock = full.error ? await stockQueryFor(BASE) : full; // migración 0016 aún sin aplicar
      if (id !== requestId.current) return;
      if (id !== requestId.current) return;
      if (stock.error) {
        setError("No se pudo cargar el stock del local seleccionado.");
        setLoading(false);
        return;
      }
      setRows(
        ((stock.data ?? []) as unknown as ValuationRow[]).map((row) => ({
          id: row.product_id,
          locationId: row.location_id,
          locationName: row.location_name ?? "",
          name: row.product_name,
          category: row.family_name && row.category_name ? `${row.family_name} · ${row.category_name}` : row.category_name ?? "Sin categoría",
          quantity: row.dimension ? formatStock(row.qty, countingPacks(row)) : quantity(row.qty, row.base_unit),
          value: euros(String(row.stock_value ?? 0)),
          valueNumber: new Decimal(String(row.stock_value ?? 0)).toFixed(2),
          minimum: row.min_qty ? (row.dimension ? formatStock(row.min_qty, countingPacks(row)) : quantity(row.min_qty, row.base_unit)) : "—",
          status: row.qty < 0 || (row.below_min && row.qty <= 0) ? "critical" : row.below_min ? "low" : "ok",
        })),
      );
      const last = (count.data ?? [])[0] as { closed_at: string | null; locations: { name: string } | null } | undefined;
      setLastCount(last?.closed_at ? { at: last.closed_at, location: last.locations?.name ?? "" } : null);
      setLoading(false);
    }
    void run();
  }, [location, reloadKey]);

  function changeLocation(id: string) {
    saveLocation(id);
    window.history.replaceState(null, "", id ? `/stock?local=${id}` : "/stock");
    setLocation(id);
  }

  const filtered = rows.filter((row) => (!status || row.status === status) && (!query || normalizeText(`${row.name} ${row.category}`).includes(normalizeText(query))));
  const totalValue = rows.reduce((acc, r) => acc.plus(r.valueNumber), new Decimal(0));
  const below = rows.filter((r) => r.status !== "ok").length;
  const locationLabel = locations.find((l) => l.id === location)?.name ?? "todos los locales";
  const allLocations = !location;

  return (
    <main className="stock-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Resumen
        </Link>
        <span className="catalog-title">Stock</span>
        <span />
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Existencias · {allLocations ? "Todos los locales" : locationLabel}</p>
            <h1>Stock</h1>
            <p className="catalog-subtitle">Lo que tienes, lo que vale y lo que está por debajo del mínimo.</p>
          </div>
          <div className="stock-heading-actions">
            <div className="stock-location">
              <Warehouse size={16} />
              <select value={location ?? ""} onChange={(event) => changeLocation(event.target.value)} aria-label="Local">
                <option value="">Todos los locales</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <button className="export-button" disabled={filtered.length === 0} onClick={() => exportCsv(filtered, allLocations ? "todos" : locationLabel)}>
              <Download size={15} /> Exportar
            </button>
          </div>
        </div>
        <div className="stock-summary">
          <div>
            <span>Valor total</span>
            <strong>{loading && rows.length === 0 ? "..." : euros(totalValue)}</strong>
            <small>a coste medio</small>
          </div>
          <div>
            <span>Productos con stock</span>
            <strong>{loading && rows.length === 0 ? "..." : rows.length}</strong>
            <small>en {locationLabel}</small>
          </div>
          <div>
            <span>Bajo mínimo</span>
            <strong className="red-text">{loading && rows.length === 0 ? "..." : below}</strong>
            <small>requieren revisión</small>
          </div>
          <div>
            <span>Último inventario</span>
            <strong>{lastCount ? new Date(lastCount.at).toLocaleDateString("es-ES", { day: "numeric", month: "short" }) : "Ninguno"}</strong>
            <small>{lastCount ? `${daysAgo(lastCount.at)}${allLocations && lastCount.location ? ` · ${lastCount.location}` : ""}` : <Link href="/inventarios">Empezar un conteo</Link>}</small>
          </div>
        </div>
        <section className="catalog-panel stock-table-panel">
          <div className="catalog-toolbar">
            <div className="catalog-search">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar producto o categoría" />
            </div>
            <label className="filter-button">
              <Filter size={14} />
              <select className="stock-status-filter" value={status} onChange={(event) => setStatus(event.target.value as "" | Status)} aria-label="Estado">
                <option value="">Todos los estados</option>
                <option value="low">Bajo mínimo</option>
                <option value="critical">Urgente (sin stock)</option>
                <option value="ok">Correcto</option>
              </select>
            </label>
            <span className="table-result-count">{filtered.length} productos</span>
          </div>
          <div className="stock-table">
            <div className="stock-head">
              <span>Producto</span>
              <span>Existencias</span>
              <span>Valor</span>
              <span>Mínimo</span>
              <span>Estado</span>
              <span />
            </div>
            {!loading && !error && filtered.map((row) => (
              <Link className="stock-data-row" key={`${row.id}-${row.locationId}`} href={`/productos?producto=${row.id}`} title="Abrir ficha del producto">
                <div className="stock-product">
                  <span className={`stock-thumb ${row.status}`} />
                  <span>
                    <strong>{row.name}</strong>
                    <small>{row.category}{allLocations && row.locationName ? ` · ${row.locationName}` : ""}</small>
                  </span>
                </div>
                <strong>{row.quantity}</strong>
                <span>{row.value}</span>
                <span>{row.minimum}</span>
                <span className={`stock-status ${row.status}`}>{STATUS_LABEL[row.status]}</span>
                <span className="stock-open" aria-hidden="true"><ChevronRight size={17} /></span>
              </Link>
            ))}
            {!loading && !error && filtered.length === 0 && (
              <div className="catalog-empty">
                <strong>No hay stock para mostrar</strong>
                <span>{rows.length > 0 ? "Prueba otro filtro o limpia la búsqueda." : "Registra una recepción o una apertura de stock para empezar."}</span>
              </div>
            )}
            {loading && <div className="catalog-empty"><strong>Cargando stock...</strong></div>}
            {!loading && error && (
              <div className="catalog-empty">
                <strong>{error}</strong>
                <button className="filter-button" onClick={() => setReloadKey((k) => k + 1)}>Reintentar</button>
              </div>
            )}
          </div>
        </section>
      </div>
    </main>
  );
}
