"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ArrowDownRight, ArrowLeft, ArrowRight, ArrowUpRight, Building2, Sparkles } from "lucide-react";
import { ChartCard } from "@/components/charts/charts";
import type { AnalyticsResponse, AnalyticsView } from "@/components/copiloto/types";
import "../productos/productos.css";
import "./informes.css";

const VIEWS: Array<{ id: AnalyticsView; label: string; question: string }> = [
  { id: "resumen", label: "Resumen", question: "¿Qué debería revisar hoy?" },
  { id: "consumo", label: "Consumo", question: "¿Cómo va el consumo esta semana?" },
  { id: "mermas", label: "Mermas", question: "¿Qué productos tienen más merma?" },
  { id: "stock", label: "Stock", question: "¿Qué productos tienen más valor en stock?" },
  { id: "precios", label: "Precios", question: "¿Ha subido algún proveedor los precios?" },
  { id: "reposicion", label: "Reposición", question: "¿Qué me falta para el finde?" },
  { id: "desvios", label: "Desvíos", question: "¿Qué desvíos hubo en el último inventario?" },
];
const PERIODS = [7, 30, 90] as const;

function readFilters(): { view: AnalyticsView; location: string; days: number } {
  const params = new URLSearchParams(window.location.search);
  const view = VIEWS.find((v) => v.id === params.get("vista"))?.id ?? "resumen";
  const days = Number(params.get("dias"));
  return { view, location: params.get("local") ?? "", days: PERIODS.includes(days as 7) ? days : 30 };
}

function askAssistant(message: string) {
  window.dispatchEvent(new CustomEvent("copiloto:ask", { detail: { message } }));
}

export default function InformesPage() {
  const [view, setView] = useState<AnalyticsView>("resumen");
  const [location, setLocation] = useState("");
  const [days, setDays] = useState(30);
  const [data, setData] = useState<AnalyticsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  async function load(next: { view: AnalyticsView; location: string; days: number }) {
    setLoading(true);
    setError("");
    const params = new URLSearchParams({ vista: next.view, dias: String(next.days) });
    if (next.location) params.set("locationId", next.location);
    const url = new URLSearchParams({ vista: next.view, dias: String(next.days), ...(next.location ? { local: next.location } : {}) });
    window.history.replaceState(null, "", `/informes?${url.toString()}`);
    try {
      const res = await fetch(`/api/copiloto/analytics?${params.toString()}`);
      const body = (await res.json()) as AnalyticsResponse & { message?: string };
      if (!res.ok) throw new Error(body.message ?? "No se pudieron cargar los informes.");
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "No se pudieron cargar los informes.");
    } finally {
      setLoading(false);
    }
  }

  function change(patch: Partial<{ view: AnalyticsView; location: string; days: number }>) {
    const next = { view, location, days, ...patch };
    setView(next.view);
    setLocation(next.location);
    setDays(next.days);
    void load(next);
  }

  useEffect(() => {
    // Carga inicial con los filtros de la URL (el asistente enlaza aquí con ?vista=&local=&dias=).
    async function bootstrap() {
      await Promise.resolve();
      const initial = readFilters();
      setView(initial.view);
      setLocation(initial.location);
      setDays(initial.days);
      await load(initial);
    }
    void bootstrap();
  }, []);

  const current = VIEWS.find((v) => v.id === view)!;
  const [lead, ...rest] = data?.charts ?? [];

  return (
    <main className="informes-page">
      <header className="catalog-topbar">
        <Link href="/" className="back-link">
          <ArrowLeft size={16} /> Resumen
        </Link>
        <span className="catalog-title">Informes</span>
        <div className="catalog-user">MC</div>
      </header>

      <div className="informes-content">
        <div className="informes-heading">
          <div>
            <p className="eyebrow">Análisis · {data?.locationName ?? "Todos los locales"} · últimos {days} días</p>
            <h1>{current.label}</h1>
          </div>
          <button type="button" className="secondary-button" onClick={() => askAssistant(current.question)}>
            <Sparkles size={15} /> Preguntar al asistente
          </button>
        </div>

        <div className="informes-filters" role="toolbar" aria-label="Filtros">
          <div className="informes-tabs" role="tablist">
            {VIEWS.map((v) => (
              <button key={v.id} type="button" role="tab" aria-selected={v.id === view} className={v.id === view ? "active" : ""} onClick={() => change({ view: v.id })}>
                {v.label}
              </button>
            ))}
          </div>
          <div className="informes-selects">
            <label className="location-select">
              <Building2 size={15} />
              <select value={location} onChange={(event) => change({ location: event.target.value })} aria-label="Local">
                <option value="">Todos los locales</option>
                {data?.locations.map((l) => (
                  <option key={l.id} value={l.id}>{l.name}</option>
                ))}
              </select>
            </label>
            <div className="informes-periods" role="group" aria-label="Periodo">
              {PERIODS.map((p) => (
                <button key={p} type="button" className={p === days ? "active" : ""} onClick={() => change({ days: p })}>
                  {p} días
                </button>
              ))}
            </div>
          </div>
        </div>

        {error && <p className="informes-error">{error}</p>}

        <div className={`informes-body${loading ? " loading" : ""}`}>
          {data && data.kpis.length > 0 && (
            <div className="informes-kpis">
              {data.kpis.map((kpi) => (
                <div key={kpi.id} className="informes-kpi">
                  <span>{kpi.label}</span>
                  <strong>{kpi.value}</strong>
                  {kpi.delta ? (
                    <small className={kpi.delta.direction === "flat" ? "flat" : kpi.delta.good ? "good" : "bad"}>
                      {kpi.delta.direction === "up" ? <ArrowUpRight size={13} /> : kpi.delta.direction === "down" ? <ArrowDownRight size={13} /> : <ArrowRight size={13} />}
                      {kpi.delta.display}
                    </small>
                  ) : (
                    kpi.hint && <small>{kpi.hint}</small>
                  )}
                </div>
              ))}
            </div>
          )}

          {!data && loading && <p className="informes-muted">Calculando…</p>}

          {data && (
            <div className="informes-grid">
              {lead && (
                <div className={lead.kind === "line" ? "wide" : ""}>
                  <ChartCard spec={lead} />
                </div>
              )}
              {rest.map((chart) => (
                <div key={chart.id}>
                  <ChartCard spec={chart} />
                </div>
              ))}
            </div>
          )}
          {data && <p className="informes-muted">Cifras calculadas a coste medio. Actualizado {new Date(data.generatedAt).toLocaleString("es-ES")}.</p>}
        </div>
      </div>
    </main>
  );
}
