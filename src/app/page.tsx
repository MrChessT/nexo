"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import Decimal from "decimal.js";
import { createClient } from "@/lib/supabase/client";
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
  icon: typeof Truck;
  title: string;
  detail: string;
  time: string;
  tone: "blue" | "orange" | "purple";
};

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

  useEffect(() => {
    async function loadDashboard() {
      const supabase = createClient();
      if (!supabase) {
        setDashboardLoading(false);
        return;
      }
      const { data, error } = await supabase
        .from("v_stock_valuation")
        .select("product_name, category_name, base_unit, qty, stock_value, below_min")
        .order("below_min", { ascending: false })
        .order("product_name")
        .limit(8);
      if (error) {
        setDashboardLoading(false);
        return;
      }
      const rows = data ?? [];
      const totalValue = rows.reduce((total, row) => total.plus(String(row.stock_value ?? 0)), new Decimal(0));
      const attention = rows.filter((row) => row.below_min);
      setStockValue(`${totalValue.toFixed(2).replace(".", ",")} €`);
      setAttentionCount(String(attention.length));
      setCriticalCount(String(attention.filter((row) => row.qty <= 0).length));
      setStockRows(rows.slice(0, 4).map((row) => ({
        name: row.product_name,
        category: row.category_name ?? "Sin categoría",
        amount: `${new Decimal(String(row.qty ?? 0)).toFixed(2)} ${row.base_unit}`,
        value: `${new Decimal(String(row.stock_value ?? 0)).toFixed(2).replace(".", ",")} €`,
        status: row.below_min ? row.qty <= 0 ? "critical" : "low" : "ok",
        color: row.below_min ? row.qty <= 0 ? "red" : "orange" : "green",
      })));
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
          <Link className="nav-item" href="/stock"><SlidersHorizontal size={18} /><span>Informes</span></Link>
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
              <div className="sparkline" aria-hidden="true"><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /><i /></div>
            </article>
            <article className="metric-card"><div className="metric-top"><span>Consumo del periodo</span><span className="metric-menu">···</span></div><strong className="metric-value">Sin datos</strong><div className="metric-footer"><span>Requiere movimientos</span><span>sin comparativa</span></div><div className="mini-bars" /></article>
            <article className="metric-card"><div className="metric-top"><span>Rotación</span><span className="metric-menu">···</span></div><strong className="metric-value">Sin datos</strong><div className="metric-footer"><span>Requiere consumo</span><span>sin periodo comparable</span></div><div className="ring-chart"><div><strong>—</strong><small>pendiente</small></div></div></article>
            <article className="metric-card alert-card"><div className="metric-top"><span>Requieren atención</span><span className="alert-dot" /></div><strong className="metric-value">{dashboardLoading ? "..." : attentionCount} <em>productos</em></strong><div className="metric-footer"><span className="negative">{dashboardLoading ? "..." : criticalCount} críticos</span><span>por debajo del mínimo</span></div><div className="alert-line"><span /><span /><span /><span /><span /><span /><span /></div></article>
          </div>

          <div className="section-grid">
            <section className="panel stock-panel"><div className="panel-header"><div><h2>Stock que requiere atención</h2><p>Valoración actual por producto</p></div><Link href="/stock" className="text-button">Ver todo <ChevronRight size={15} /></Link></div><div className="stock-table"><div className="table-head"><span>Producto</span><span>Existencias</span><span>Valor</span><span>Estado</span></div>{stockRows.length === 0 ? <div className="empty-state">{dashboardLoading ? "Cargando valoración..." : "No hay stock valorado todavía."}</div> : stockRows.map((row) => <div className="stock-row" key={row.name}><div className="product-name"><span className={`product-dot ${row.color}`} /><span><b>{row.name}</b><small>{row.category}</small></span></div><strong>{row.amount}</strong><span>{row.value}</span><span className={`status ${row.status}`}>{row.status === "ok" ? "En nivel" : row.status === "low" ? "Bajo mínimo" : "Urgente"}</span></div>)}</div></section>
            <section className="panel activity-panel"><div className="panel-header"><div><h2>Actividad reciente</h2><p>Movimientos del equipo</p></div><button className="icon-button"><SlidersHorizontal size={17} /></button></div><div className="activity-list">{activity.length === 0 ? <div className="empty-state">Todavía no hay actividad conectada.</div> : activity.map((item) => { const Icon = item.icon; return <div className="activity-item" key={item.title}><span className={`activity-icon ${item.tone}`}><Icon size={17} /></span><span className="activity-copy"><b>{item.title}</b><small>{item.detail}</small><time>{item.time}</time></span></div>; })}</div><button className="activity-link">Ver toda la actividad <ChevronRight size={15} /></button></section>
          </div>

          <section className="order-banner"><div className="banner-icon"><ShoppingCart size={21} /></div><div><strong>Tu próximo pedido está listo</strong><p>Hay 6 productos bajo mínimo que podrías incluir en la próxima compra.</p></div><button className="secondary-button">Revisar sugerencia <ArrowUpRight size={16} /></button></section>
        </div>
      </section>
      {searchOpen && <div className="search-overlay" onClick={() => setSearchOpen(false)}><div className="search-dialog" onClick={(event) => event.stopPropagation()}><Search size={19} /><input autoFocus placeholder="Buscar productos, documentos o personas" /><kbd>ESC</kbd><div className="search-hint">Escribe para buscar en todo Parador Eventos</div></div></div>}
      {menuOpen && <button className="mobile-backdrop" onClick={() => setMenuOpen(false)} aria-label="Cerrar menu" />}
    </main>
  );
}
