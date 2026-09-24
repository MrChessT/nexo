"use client";

import { useState } from "react";
import { useEffect } from "react";
import Decimal from "decimal.js";
import {
  ArrowLeft,
  ChevronDown,
  ChevronRight,
  Download,
  Filter,
  Search,
  Warehouse,
} from "lucide-react";
import Link from "next/link";
import { createClient } from "@/lib/supabase/client";
import "../productos/productos.css";
import "./stock.css";

type StockRow = {
  id: string;
  locationId: string;
  name: string;
  category: string;
  quantity: string;
  value: string;
  minimum: string;
  status: "ok" | "low" | "critical";
};

type Location = { id: string; name: string };
type StockSummary = {
  value: string;
  products: string;
  belowMinimum: string;
};

function formatDecimal(value: number | null, decimals = 2) {
  return new Decimal(String(value ?? 0)).toFixed(decimals);
}

function formatCurrency(value: number | null) {
  return `${formatDecimal(value).replace(".", ",")} €`;
}

export default function StockPage() {
  const [location, setLocation] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [rows, setRows] = useState<StockRow[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [summary, setSummary] = useState<StockSummary>({
    value: "0,00 €",
    products: "0",
    belowMinimum: "0",
  });
  const filtered = rows.filter((row) =>
    row.name.toLowerCase().includes(query.toLowerCase()),
  );

  async function loadStock(locationId = location) {
    setLoading(true);
    setError("");
    const supabase = createClient();
      if (!supabase) {
        setError("Configura las variables de Supabase para cargar el stock.");
        setLoading(false);
        return;
      }
    const selectedLocation = locationId === "all" ? "" : locationId || location;
    let stockQuery = supabase
      .from("v_stock_valuation")
      .select("location_id, product_id, product_name, category_name, base_unit, qty, stock_value, min_qty, below_min");
    if (selectedLocation) stockQuery = stockQuery.eq("location_id", selectedLocation);

    // Los locales solo se piden la primera vez y en paralelo con el stock.
    const [locationResult, { data: stockData, error: stockError }] = await Promise.all([
      locations.length === 0
        ? supabase.from("locations").select("id, name").eq("active", true).order("name")
        : Promise.resolve(null),
      stockQuery.order("product_name"),
    ]);

    if (locationResult) {
      if (locationResult.error) {
        setError("No se pudieron cargar los locales.");
        setLoading(false);
        return;
      }
      setLocations(locationResult.data as Location[]);
    }

    if (stockError) {
      setError("No se pudo cargar el stock del local seleccionado.");
      setLoading(false);
      return;
    }

    const records = stockData ?? [];
    setRows(
      records.map((row) => ({
        id: row.product_id,
        locationId: row.location_id,
        name: row.product_name,
        category: row.category_name ?? "Sin categoría",
        quantity: `${formatDecimal(row.qty, 2)} ${row.base_unit}`,
        value: formatCurrency(row.stock_value),
        minimum: formatDecimal(row.min_qty, 2),
        status: row.qty < 0 || (row.below_min && row.qty <= 0) ? "critical" : row.below_min ? "low" : "ok",
      })),
    );
    const totalValue = records.reduce(
      (total, row) => total.plus(String(row.stock_value ?? 0)),
      new Decimal(0),
    );
    setSummary({
      value: `${totalValue.toFixed(2).replace(".", ",")} €`,
      products: String(records.length),
      belowMinimum: String(records.filter((row) => row.below_min).length),
    });
    if (!location && selectedLocation) setLocation(selectedLocation);
    setLoading(false);
  }

  useEffect(() => {
    // Carga inicial; admite el filtro que llega desde el asistente: /stock?local=<id>
    async function bootstrap() {
      await Promise.resolve();
      await loadStock(new URLSearchParams(window.location.search).get("local") ?? undefined);
    }
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- carga única al montar
  }, []);
  const locationLabel = location === "all"
    ? "todos los locales"
    : locations.find((availableLocation) => availableLocation.id === location)?.name ?? "todos los locales";
  return (
    <main className="stock-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Resumen
        </Link>
        <span className="catalog-title">Stock</span>
        <div className="catalog-user">MC</div>
      </header>
      <div className="catalog-content">
        <div className="catalog-heading">
          <div>
            <p className="eyebrow">Parador Eventos · Existencias</p>
            <h1>Stock</h1>
            <p className="catalog-subtitle">
              Un vistazo preciso a lo que tienes y lo que necesitas.
            </p>
          </div>
          <div className="stock-heading-actions">
            <div className="stock-location">
              <Warehouse size={16} />
              <select
                value={location}
                onChange={(event) => {
                  setLocation(event.target.value);
                  void loadStock(event.target.value);
                }}
                aria-label="Local"
              >
                <option value="all">Todos los locales</option>
                {locations.map((availableLocation) => (
                  <option key={availableLocation.id} value={availableLocation.id}>
                    {availableLocation.name}
                  </option>
                ))}
              </select>
              <ChevronDown size={14} />
            </div>
            <button className="export-button">
              <Download size={15} /> Exportar
            </button>
          </div>
        </div>
        <div className="stock-summary">
          <div>
            <span>Valor total</span>
            <strong>{summary.value}</strong>
            <small>valoración actual</small>
          </div>
          <div>
            <span>Productos activos</span>
            <strong>{summary.products}</strong>
            <small>en {locationLabel}</small>
          </div>
          <div>
            <span>Bajo mínimo</span>
            <strong className="red-text">{summary.belowMinimum}</strong>
            <small>requieren revisión</small>
          </div>
          <div>
            <span>Último inventario</span>
            <strong>Sin datos</strong>
            <small>pendiente de conteo</small>
          </div>
        </div>
        <section className="catalog-panel stock-table-panel">
          <div className="catalog-toolbar">
            <div className="catalog-search">
              <Search size={16} />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Buscar producto"
              />
            </div>
            <button className="filter-button">
              <Filter size={14} /> Filtros
            </button>
            <span className="table-result-count">
              {filtered.length} productos
            </span>
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
              <div className="stock-data-row" key={`${row.id}-${row.locationId}`}>
                <div className="stock-product">
                  <span className={`stock-thumb ${row.status}`} />
                  <span>
                    <strong>{row.name}</strong>
                    <small>{row.category}</small>
                  </span>
                </div>
                <strong>{row.quantity}</strong>
                <span>{row.value}</span>
                <span>{row.minimum}</span>
                <span className={`stock-status ${row.status}`}>
                  {row.status === "ok"
                    ? "Correcto"
                    : row.status === "low"
                      ? "Bajo mínimo"
                      : "Urgente"}
                </span>
                <button className="stock-open" aria-label={`Abrir ${row.name}`}>
                  <ChevronRight size={17} />
                </button>
              </div>
            ))}
            {!loading && !error && filtered.length === 0 && (
              <div className="catalog-empty">
                <strong>No hay stock para mostrar</strong>
                <span>Prueba otro local o limpia la búsqueda.</span>
              </div>
            )}
            {loading && <div className="catalog-empty"><strong>Cargando stock...</strong></div>}
            {!loading && error && <div className="catalog-empty"><strong>{error}</strong><button className="filter-button" onClick={() => void loadStock()}>Reintentar</button></div>}
          </div>
        </section>
      </div>
    </main>
  );
}
