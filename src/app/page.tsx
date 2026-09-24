"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { createClient } from "@/lib/supabase/client";
import "./dashboard-charts.css";
import {
  ArrowUpRight,
  Bell,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  LayoutDashboard,
  Menu,
  Package,
  Plus,
  Search,
  Settings,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Truck,
  Users,
  Warehouse,
  X,
} from "lucide-react";

type NavItem = { label: string; icon: typeof LayoutDashboard; badge?: string };

const navigation: NavItem[] = [
  { label: "Resumen", icon: LayoutDashboard },
  { label: "Stock", icon: Boxes, badge: "3" },
  { label: "Recepciones", icon: Package },
  { label: "Traspasos", icon: Truck, badge: "2" },
  { label: "Inventarios", icon: ClipboardList },
  { label: "Pedidos", icon: ShoppingCart },
];

type DashboardStockRow = {
  name: string;
  category: string;
  amount: string;
  value: string;
  status: "ok" | "low" | "critical";
  color: "green" | "orange" | "red";
};

type DashboardActivity = {
  id: number;
  icon: typeof Truck;
  title: string;
  detail: string;
  time: string;
  tone: "blue" | "orange" | "purple";
};

type MovementType = "opening" | "purchase" | "consumption" | "waste" | "transfer_out" | "transfer_in" | "count_adjustment" | "manual_adjustment";

const movementIcon: Record<MovementType, typeof Truck> = {
  purchase: ShoppingCart,
  transfer_in: Truck,
  transfer_out: Truck,
  waste: X,
  count_adjustment: ClipboardList,
  manual_adjustment: Package,
  opening: Package,
  consumption: ShoppingCart,
};

const movementTone: Record<MovementType, "blue" | "orange" | "purple"> = {
  purchase: "blue",
  transfer_in: "orange",
  transfer_out: "orange",
  waste: "purple",
  count_adjustment: "purple",
  manual_adjustment: "purple",
  opening: "blue",
  consumption: "blue",
};

const movementLabel: Record<MovementType, string> = {
  purchase: "Recepción registrada",
  transfer_in: "Traspaso recibido",
  transfer_out: "Traspaso enviado",
  waste: "Merma registrada",
  count_adjustment: "Ajuste de inventario",
  manual_adjustment: "Ajuste manual",
  opening: "Apertura de stock",
  consumption: "Consumo registrado",
};

function formatRelativeTime(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.round(diffMs / 60000);
  if (minutes < 1) return "Ahora mismo";
  if (minutes < 60) return `Hace ${minutes} min`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Hoy, ${new Date(iso).toLocaleTimeString("es-ES", { hour: "2-digit", minute: "2-digit" })}`;
  return new Date(iso).toLocaleDateString("es-ES", { day: "2-digit", month: "short" });
}

type BrowserClient = NonNullable<ReturnType<typeof createClient>>;

// Consumo y merma por día de negocio. La función SQL (migración 0008) filtra por fecha antes de
// agrupar; si aún no está aplicada se usa la vista, que devuelve las mismas filas.
async function loadConsumption(supabase: BrowserClient, since: string): Promise<Array<{ business_day: string; value: number | null }>> {
  const { data, error } = await supabase.rpc("consumption_by_business_day", { p_since: since, p_types: ["consumption", "waste"] });
  if (!error) return data ?? [];
  const { data: fallback } = await supabase
    .from("v_movements_by_business_day")
    .select("business_day, value")
    .in("type", ["consumption", "waste"])
    .gte("business_day", since);
  return (fallback ?? []) as Array<{ business_day: string; value: number | null }>;
}

type StockSummary = { totalValue: Decimal; attention: number; critical: number };

// Totales sobre TODO el stock visible (no solo las filas que se listan). La función SQL (migración
// 0008) devuelve una sola fila; si aún no está aplicada se suman las filas en el navegador.
async function loadStockSummary(supabase: BrowserClient): Promise<StockSummary | null> {
  const { data, error } = await supabase.rpc("stock_summary");
  const row = data?.[0];
  if (!error && row) {
    return { totalValue: new Decimal(String(row.total_value ?? 0)), attention: Number(row.below_min_count), critical: Number(row.critical_count) };
  }
  const { data: rows, error: rowsError } = await supabase.from("v_stock_valuation").select("qty, stock_value, below_min");
  if (rowsError) return null;
  const all = rows ?? [];
  const attention = all.filter((r) => r.below_min);
  return {
    totalValue: all.reduce((total, r) => total.plus(String(r.stock_value ?? 0)), new Decimal(0)),
    attention: attention.length,
    critical: attention.filter((r) => r.qty <= 0).length,
  };
}

export default function Dashboard() {
  const [active, setActive] = useState("Resumen");
  const [location, setLocation] = useState("Parador");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [stockRows, setStockRows] = useState<DashboardStockRow[]>([]);
  const [activity, setActivity] = useState<DashboardActivity[]>([]);
  const [stockValue, setStockValue] = useState("Sin datos");
  const [attentionCount, setAttentionCount] = useState("Sin datos");
  const [criticalCount, setCriticalCount] = useState("Sin datos");
  const [dashboardLoading, setDashboardLoading] = useState(true);
  const [consumptionValue, setConsumptionValue] = useState("Sin datos");
  const [consumptionTrend, setConsumptionTrend] = useState("");
  const [consumptionBars, setConsumptionBars] = useState<Array<{ label: string; value: number }>>([]);
  const [rotationValue, setRotationValue] = useState("Sin datos");

  useEffect(() => {
    async function loadDashboard() {
      const supabase = createClient();
      if (!supabase) {
        setDashboardLoading(false);
        return;
      }
      const fromDate = new Date();
      fromDate.setDate(fromDate.getDate() - 13);
      // Las tres consultas son independientes: se lanzan a la vez en lugar de una tras otra.
      const [stockResult, summary, consumptionRows, movementResult] = await Promise.all([
        supabase
          .from("v_stock_valuation")
          .select("product_name, category_name, base_unit, qty, stock_value, below_min")
          .order("below_min", { ascending: false })
          .order("product_name")
          .limit(4),
        loadStockSummary(supabase),
        loadConsumption(supabase, fromDate.toISOString().slice(0, 10)),
        supabase
          .from("stock_movements")
          .select("id, type, occurred_at, products(name), locations(name)")
          .order("occurred_at", { ascending: false })
          .limit(6),
      ]);
      const { data, error } = stockResult;
      if (error || !summary) {
        setDashboardLoading(false);
        return;
      }
      const rows = data ?? [];
      const totalValue = summary.totalValue;
      setStockValue(`${totalValue.toFixed(2).replace(".", ",")} €`);
      setAttentionCount(String(summary.attention));
      setCriticalCount(String(summary.critical));
      setStockRows(rows.map((row) => ({
        name: row.product_name,
        category: row.category_name ?? "Sin categoría",
        amount: `${new Decimal(String(row.qty ?? 0)).toFixed(2)} ${row.base_unit}`,
        value: `${new Decimal(String(row.stock_value ?? 0)).toFixed(2).replace(".", ",")} €`,
        status: row.qty < 0 || (row.below_min && row.qty <= 0) ? "critical" : row.below_min ? "low" : "ok",
        color: row.qty < 0 || (row.below_min && row.qty <= 0) ? "red" : row.below_min ? "orange" : "green",
      })));

      const byDay = new Map<string, number>();
      for (const row of consumptionRows) {
        byDay.set(row.business_day, (byDay.get(row.business_day) ?? 0) + Math.abs(row.value ?? 0));
      }
      const days: string[] = [];
      for (let i = 13; i >= 0; i -= 1) {
        const d = new Date();
        d.setDate(d.getDate() - i);
        days.push(d.toISOString().slice(0, 10));
      }
      const lastWeek = days.slice(7, 14);
      const previousWeek = days.slice(0, 7);
      const lastWeekTotal = lastWeek.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);
      const previousWeekTotal = previousWeek.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);
      const hasConsumption = lastWeekTotal > 0 || previousWeekTotal > 0;
      if (hasConsumption) {
        setConsumptionValue(`${lastWeekTotal.toFixed(2).replace(".", ",")} €`);
        if (previousWeekTotal > 0) {
          const change = ((lastWeekTotal - previousWeekTotal) / previousWeekTotal) * 100;
          setConsumptionTrend(`${change >= 0 ? "+" : ""}${change.toFixed(0)}% vs semana anterior`);
        } else {
          setConsumptionTrend("sin semana anterior");
        }
        setConsumptionBars(
          lastWeek.map((day) => ({
            label: new Date(day).toLocaleDateString("es-ES", { weekday: "short" }),
            value: byDay.get(day) ?? 0,
          })),
        );
        const stockValueNumber = totalValue.toNumber();
        setRotationValue(stockValueNumber > 0 ? `${(lastWeekTotal / stockValueNumber).toFixed(2)}x` : "Sin datos");
      }
      const movements = (movementResult.data ?? []) as unknown as Array<{
        id: number; type: MovementType; occurred_at: string;
        products: { name: string } | null; locations: { name: string } | null;
      }>;
      setActivity(
        movements.map((movement) => ({
          id: movement.id,
          icon: movementIcon[movement.type],
          title: movementLabel[movement.type],
          detail: `${movement.products?.name ?? "Producto"} · ${movement.locations?.name ?? "Local"}`,
          time: formatRelativeTime(movement.occurred_at),
          tone: movementTone[movement.type],
        })),
      );
      setDashboardLoading(false);
    }
    void loadDashboard();
  }, []);

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.5} /></div>
          <span className="brand-name">nexo<span>.</span></span>
          <button className="icon-button sidebar-close" aria-label="Cerrar menu"><X size={18} /></button>
        </div>

        <div className="workspace-switcher">
          <div className="venue-avatar">P</div>
          <div className="workspace-copy"><strong>Parador Eventos</strong><span>4 locales activos</span></div>
          <ChevronDown size={16} className="muted-icon" />
        </div>

        <div className="nav-heading">Operativa</div>
        <nav className="main-nav" aria-label="Navegacion principal">
          {navigation.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.label} href={item.label === "Stock" ? "/stock" : item.label === "Recepciones" ? "/recepciones" : item.label === "Traspasos" ? "/traspasos" : item.label === "Inventarios" ? "/inventarios" : "/"} className={`nav-item ${active === item.label ? "active" : ""}`} onClick={() => setActive(item.label)}>
                <Icon size={18} strokeWidth={active === item.label ? 2.4 : 1.8} />
                <span>{item.label}</span>
                {item.badge && <span className="nav-badge">{item.badge}</span>}
              </Link>
            );
          })}
        </nav>

        <div className="nav-heading secondary-heading">Gestion</div>
        <nav className="main-nav">
          <Link className="nav-item" href="/productos"><Package size={18} /><span>Productos</span></Link>
          <button className="nav-item" onClick={() => setActive("Proveedores")}><Users size={18} /><span>Proveedores</span></button>
          <Link className="nav-item" href="/informes"><SlidersHorizontal size={18} /><span>Informes</span></Link>
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item"><Settings size={18} /><span>Ajustes</span></button>
          <button className="nav-item"><CircleHelp size={18} /><span>Ayuda</span></button>
          <div className="user-card">
            <div className="user-avatar">MC</div>
            <div className="workspace-copy"><strong>Marina Costa</strong><span>Administradora</span></div>
            <ChevronRight size={16} className="muted-icon" />
          </div>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Abrir menu"><Menu size={20} /></button>
          <div className="breadcrumb"><span>Parador Eventos</span><ChevronRight size={14} /><strong>Resumen</strong></div>
          <div className="top-actions">
            <button className="search-trigger" onClick={() => setSearchOpen(!searchOpen)}><Search size={17} /><span>Buscar</span><kbd>⌘ K</kbd></button>
            <button className="icon-button notification-button" aria-label="Notificaciones"><Bell size={19} /><i /></button>
            <div className="top-avatar">MC</div>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">Martes, 22 de septiembre de 2026</p>
              <h1>Buenos días, Marina <span>↗</span></h1>
              <p className="subtitle">Esto es lo que está pasando con tu inventario.</p>
            </div>
            <div className="heading-actions">
              <div className="location-select">
                <Warehouse size={17} /><select value={location} onChange={(event) => setLocation(event.target.value)} aria-label="Seleccionar local"><option>Parador</option><option>Pickels</option><option>Vivero</option><option>La Oliva</option><option>Todos los locales</option></select><ChevronDown size={15} /></div>
              <button className="primary-button"><Plus size={17} /> Nueva accion</button>
            </div>
          </div>

          <div className="quick-actions">
            <Link href="/recepciones"><span className="quick-icon lime"><Package size={17} /></span><span><b>Recibir mercancía</b><small>Registrar albarán</small></span><ChevronRight size={16} /></Link>
            <Link href="/traspasos"><span className="quick-icon coral"><Truck size={17} /></span><span><b>Nuevo traspaso</b><small>Mover entre locales</small></span><ChevronRight size={16} /></Link>
            <Link href="/inventarios"><span className="quick-icon violet"><ClipboardList size={17} /></span><span><b>Contar inventario</b><small>Empezar un conteo</small></span><ChevronRight size={16} /></Link>
          </div>

          <div className="metric-grid">
            <article className="metric-card featured-card">
              <div className="metric-top"><span>Valor del stock</span><span className="metric-menu">···</span></div>
              <strong className="metric-value">{dashboardLoading ? "..." : stockValue}</strong>
              <div className="metric-footer"><span className="positive">Valoración actual</span><span>sin comparativa</span></div>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Consumo del periodo</span><span className="metric-menu">···</span></div>
              <strong className="metric-value">{dashboardLoading ? "..." : consumptionValue}</strong>
              <div className="metric-footer">
                <span>Últimos 7 días</span>
                <span>{consumptionTrend || "sin comparativa"}</span>
              </div>
              {consumptionBars.length > 0 && (
                <div className="real-bars" aria-hidden="true">
                  {consumptionBars.map((bar, index) => {
                    const max = Math.max(...consumptionBars.map((b) => b.value), 0.01);
                    return <i key={`${bar.label}-${index}`} style={{ height: `${Math.max((bar.value / max) * 100, 4)}%` }} title={`${bar.label}: ${bar.value.toFixed(2)} €`} />;
                  })}
                </div>
              )}
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Rotación</span><span className="metric-menu">···</span></div>
              <strong className="metric-value">{dashboardLoading ? "..." : rotationValue}</strong>
              <div className="metric-footer"><span>Consumo / valor de stock</span><span>últimos 7 días</span></div>
            </article>
            <article className="metric-card alert-card"><div className="metric-top"><span>Requieren atención</span><span className="alert-dot" /></div><strong className="metric-value">{dashboardLoading ? "..." : attentionCount} <em>productos</em></strong><div className="metric-footer"><span className="negative">{dashboardLoading ? "..." : criticalCount} críticos</span><span>por debajo del mínimo</span></div></article>
          </div>

          <div className="section-grid">
            <section className="panel stock-panel"><div className="panel-header"><div><h2>Stock que requiere atención</h2><p>Valoración actual por producto</p></div><Link href="/stock" className="text-button">Ver todo <ChevronRight size={15} /></Link></div><div className="stock-table"><div className="table-head"><span>Producto</span><span>Existencias</span><span>Valor</span><span>Estado</span></div>{stockRows.length === 0 ? <div className="empty-state">{dashboardLoading ? "Cargando valoración..." : "No hay stock valorado todavía."}</div> : stockRows.map((row, index) => <div className="stock-row" key={`${row.name}-${index}`}><div className="product-name"><span className={`product-dot ${row.color}`} /><span><b>{row.name}</b><small>{row.category}</small></span></div><strong>{row.amount}</strong><span>{row.value}</span><span className={`status ${row.status}`}>{row.status === "ok" ? "En nivel" : row.status === "low" ? "Bajo mínimo" : "Urgente"}</span></div>)}</div></section>
            <section className="panel activity-panel"><div className="panel-header"><div><h2>Actividad reciente</h2><p>Movimientos del equipo</p></div><button className="icon-button"><SlidersHorizontal size={17} /></button></div><div className="activity-list">{activity.length === 0 ? <div className="empty-state">Todavía no hay actividad conectada.</div> : activity.map((item) => { const Icon = item.icon; return <div className="activity-item" key={item.id}><span className={`activity-icon ${item.tone}`}><Icon size={17} /></span><span className="activity-copy"><b>{item.title}</b><small>{item.detail}</small><time>{item.time}</time></span></div>; })}</div><button className="activity-link">Ver toda la actividad <ChevronRight size={15} /></button></section>
          </div>

          <section className="order-banner"><div className="banner-icon"><ShoppingCart size={21} /></div><div><strong>Tu próximo pedido está listo</strong><p>Hay 6 productos bajo mínimo que podrías incluir en la próxima compra.</p></div><button className="secondary-button">Revisar sugerencia <ArrowUpRight size={16} /></button></section>
        </div>
      </section>
      {searchOpen && <div className="search-overlay" onClick={() => setSearchOpen(false)}><div className="search-dialog" onClick={(event) => event.stopPropagation()}><Search size={19} /><input autoFocus placeholder="Buscar productos, documentos o personas" /><kbd>ESC</kbd><div className="search-hint">Escribe para buscar en todo Parador Eventos</div></div></div>}
      {menuOpen && <button className="mobile-backdrop" onClick={() => setMenuOpen(false)} aria-label="Cerrar menu" />}
    </main>
  );
}
