"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import Decimal from "decimal.js";
import { createClient } from "@/lib/supabase/client";
import "./dashboard-charts.css";
import {
  ArrowUpRight,
  Boxes,
  ChevronDown,
  ChevronRight,
  CircleHelp,
  ClipboardList,
  LayoutDashboard,
  LogOut,
  Menu,
  Package,
  Search,
  ShoppingCart,
  SlidersHorizontal,
  Sparkles,
  Truck,
  Warehouse,
  X,
  XCircle,
} from "lucide-react";

// Resumen de inicio: todo lo que se ve sale de la base de datos (con RLS) y se puede filtrar por local.

type Location = { id: string; name: string };
type Identity = { name: string; initials: string; role: string; org: string; locations: Location[] };

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

type BrowserClient = NonNullable<ReturnType<typeof createClient>>;

const ROLE_LABEL: Record<string, string> = { owner: "Propietario", admin: "Administrador", manager: "Encargado", staff: "Equipo" };
const LOCATION_KEY = "nexo.local";

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

/** Fecha local YYYY-MM-DD (no UTC: a las 00:30 en España sigue siendo hoy). */
function localDay(date: Date) {
  return date.toLocaleDateString("sv-SE");
}

function euros(value: Decimal.Value) {
  return `${new Decimal(value).toFixed(2).replace(".", ",")} €`;
}

function greeting(hour: number) {
  return hour < 6 ? "Buenas noches" : hour < 14 ? "Buenos días" : hour < 21 ? "Buenas tardes" : "Buenas noches";
}

function initialsOf(name: string) {
  const parts = name.split(/[\s@._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

/** Abre el asistente (y, si se indica, le envía un mensaje). */
function askAssistant(message?: string) {
  window.dispatchEvent(new CustomEvent("copiloto:ask", { detail: message ? { message } : {} }));
}

function readStoredLocation(): string {
  try {
    return window.localStorage.getItem(LOCATION_KEY) ?? "";
  } catch {
    return "";
  }
}

function storeLocation(id: string) {
  try {
    if (id) window.localStorage.setItem(LOCATION_KEY, id);
    else window.localStorage.removeItem(LOCATION_KEY);
  } catch {
    // Sin almacenamiento (modo privado): solo se pierde la preferencia.
  }
}

async function loadIdentity(supabase: BrowserClient): Promise<Identity | null> {
  const { data: session } = await supabase.auth.getSession();
  const user = session.session?.user;
  const [profile, membership, locations] = await Promise.all([
    user ? supabase.from("profiles").select("full_name").eq("user_id", user.id).maybeSingle() : Promise.resolve({ data: null }),
    user ? supabase.from("memberships").select("role, organizations(name)").eq("user_id", user.id).limit(1).maybeSingle() : Promise.resolve({ data: null }),
    supabase.from("locations").select("id, name").eq("active", true).order("name"),
  ]);
  const name = profile.data?.full_name?.trim() || user?.email?.split("@")[0] || "Usuario";
  const member = membership.data as { role: string; organizations: { name: string } | null } | null;
  if (user && !member) return null;
  return {
    name,
    initials: initialsOf(name),
    role: ROLE_LABEL[member?.role ?? ""] ?? "",
    org: member?.organizations?.name ?? "Tu organización",
    locations: (locations.data ?? []) as Location[],
  };
}

/** Consumo por día de negocio (misma definición que Informes). Si falta la migración 0009, usa la vista. */
async function loadUsage(supabase: BrowserClient, since: string, locationId: string): Promise<Array<{ business_day: string; value: number | null }>> {
  const { data, error } = await supabase.rpc("usage_by_business_day", { p_since: since, p_location: locationId || null });
  if (!error) return data ?? [];
  let query = supabase.from("v_movements_by_business_day").select("business_day, value").in("type", ["consumption", "waste"]).gte("business_day", since);
  if (locationId) query = query.eq("location_id", locationId);
  const { data: fallback } = await query;
  return (fallback ?? []) as Array<{ business_day: string; value: number | null }>;
}

/** Totales sobre TODO el stock del local (o de todos). Si falta la migración 0009, suma en el navegador. */
async function loadSummary(supabase: BrowserClient, locationId: string) {
  const { data, error } = await supabase.rpc("stock_summary", { p_location: locationId || null });
  const row = data?.[0];
  if (!error && row) return { total: new Decimal(String(row.total_value ?? 0)), attention: Number(row.below_min_count), critical: Number(row.critical_count) };
  let query = supabase.from("v_stock_valuation").select("qty, stock_value, below_min");
  if (locationId) query = query.eq("location_id", locationId);
  const { data: rows, error: rowsError } = await query;
  if (rowsError) return null;
  const attention = (rows ?? []).filter((r) => r.below_min);
  return {
    total: (rows ?? []).reduce((acc, r) => acc.plus(String(r.stock_value ?? 0)), new Decimal(0)),
    attention: attention.length,
    critical: attention.filter((r) => r.qty <= 0).length,
  };
}

type DashboardData = {
  stockValue: string;
  attention: number;
  critical: number;
  pendingTransfers: number;
  stockRows: DashboardStockRow[];
  activity: DashboardActivity[];
  consumptionValue: string;
  consumptionTrend: string;
  consumptionBars: Array<{ label: string; value: number }>;
  rotationValue: string;
};

async function loadDashboard(supabase: BrowserClient, locationId: string): Promise<DashboardData | null> {
  const days: string[] = [];
  for (let i = 13; i >= 0; i -= 1) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    days.push(localDay(d));
  }
  let stockQuery = supabase
    .from("v_stock_valuation")
    .select("product_name, category_name, base_unit, qty, stock_value, below_min")
    .order("below_min", { ascending: false })
    .order("product_name")
    .limit(4);
  let movementQuery = supabase.from("stock_movements").select("id, type, occurred_at, products(name), locations(name)").order("occurred_at", { ascending: false }).limit(6);
  let transferQuery = supabase.from("transfers").select("id", { count: "exact", head: true }).in("status", ["draft", "in_transit"]);
  if (locationId) {
    stockQuery = stockQuery.eq("location_id", locationId);
    movementQuery = movementQuery.eq("location_id", locationId);
    transferQuery = transferQuery.or(`from_location_id.eq.${locationId},to_location_id.eq.${locationId}`);
  }

  // Todo en una sola ronda de peticiones.
  const [stock, summary, usage, movements, transfers] = await Promise.all([stockQuery, loadSummary(supabase, locationId), loadUsage(supabase, days[0]!, locationId), movementQuery, transferQuery]);
  if (stock.error || !summary) return null;

  const byDay = new Map<string, number>();
  for (const row of usage) byDay.set(row.business_day, (byDay.get(row.business_day) ?? 0) + Math.abs(row.value ?? 0));
  const lastWeek = days.slice(7);
  const previousWeek = days.slice(0, 7);
  const lastWeekTotal = lastWeek.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);
  const previousWeekTotal = previousWeek.reduce((sum, day) => sum + (byDay.get(day) ?? 0), 0);
  const hasConsumption = lastWeekTotal > 0 || previousWeekTotal > 0;
  const change = previousWeekTotal > 0 ? ((lastWeekTotal - previousWeekTotal) / previousWeekTotal) * 100 : null;
  const totalNumber = summary.total.toNumber();

  const movementRows = (movements.data ?? []) as unknown as Array<{
    id: number; type: MovementType; occurred_at: string;
    products: { name: string } | null; locations: { name: string } | null;
  }>;

  return {
    stockValue: euros(summary.total),
    attention: summary.attention,
    critical: summary.critical,
    pendingTransfers: transfers.count ?? 0,
    stockRows: (stock.data ?? []).map((row) => {
      const critical = row.qty < 0 || (row.below_min && row.qty <= 0);
      return {
        name: row.product_name,
        category: row.category_name ?? "Sin categoría",
        amount: `${new Decimal(String(row.qty ?? 0)).toFixed(2)} ${row.base_unit}`,
        value: euros(String(row.stock_value ?? 0)),
        status: critical ? "critical" : row.below_min ? "low" : "ok",
        color: critical ? "red" : row.below_min ? "orange" : "green",
      };
    }),
    activity: movementRows.map((m) => ({
      id: m.id,
      icon: movementIcon[m.type],
      title: movementLabel[m.type],
      detail: `${m.products?.name ?? "Producto"} · ${m.locations?.name ?? "Local"}`,
      time: formatRelativeTime(m.occurred_at),
      tone: movementTone[m.type],
    })),
    consumptionValue: hasConsumption ? euros(lastWeekTotal.toFixed(2)) : "Sin datos",
    consumptionTrend: !hasConsumption ? "" : change === null ? "sin semana anterior" : `${change >= 0 ? "+" : ""}${change.toFixed(0)}% vs semana anterior`,
    consumptionBars: hasConsumption
      ? lastWeek.map((day) => ({ label: new Date(`${day}T12:00:00`).toLocaleDateString("es-ES", { weekday: "short" }), value: byDay.get(day) ?? 0 }))
      : [],
    rotationValue: hasConsumption && totalNumber > 0 ? `${(lastWeekTotal / totalNumber).toFixed(2)}x` : "Sin datos",
  };
}

export default function Dashboard() {
  const [identity, setIdentity] = useState<Identity | null>(null);
  const [location, setLocation] = useState("");
  const [data, setData] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [menuOpen, setMenuOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [now, setNow] = useState<Date | null>(null);
  const requestId = useRef(0);
  const router = useRouter();

  // Identidad y locales una sola vez; el local elegido se recuerda en este navegador.
  useEffect(() => {
    async function start() {
      await Promise.resolve();
      setNow(new Date());
      const supabase = createClient();
      if (!supabase) {
        setError("Configura las variables de Supabase para cargar el resumen.");
        setLoading(false);
        return;
      }
      const loaded = await loadIdentity(supabase);
      if (!loaded) {
        setError("Tu usuario aún no tiene acceso a ninguna organización. Pide a un administrador que te dé acceso.");
        setLoading(false);
        return;
      }
      setIdentity(loaded);
      const stored = readStoredLocation();
      setLocation(loaded.locations.some((l) => l.id === stored) ? stored : "");
    }
    void start();
  }, []);

  useEffect(() => {
    if (!identity) return;
    const id = ++requestId.current;
    async function run() {
      await Promise.resolve();
      setLoading(true);
      const supabase = createClient();
      const result = supabase ? await loadDashboard(supabase, location) : null;
      if (id !== requestId.current) return;
      setData(result);
      setError(result ? "" : "No se pudo cargar el resumen. Revisa la conexión e inténtalo de nuevo.");
      setLoading(false);
    }
    void run();
  }, [identity, location]);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setSearchOpen(false);
        setMenuOpen(false);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  function changeLocation(id: string) {
    storeLocation(id);
    setLocation(id);
  }

  function search(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const q = new FormData(event.currentTarget).get("q")?.toString().trim();
    router.push(q ? `/productos?q=${encodeURIComponent(q)}&estado=all` : "/productos");
  }

  async function signOut() {
    await createClient()?.auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const locationName = identity?.locations.find((l) => l.id === location)?.name;
  const localQuery = location ? `local=${location}` : "";
  const withLocal = (path: string) => (localQuery ? `${path}${path.includes("?") ? "&" : "?"}${localQuery}` : path);
  const value = (text: string | undefined) => (loading && !data ? "..." : text ?? "Sin datos");
  const firstName = identity?.name.split(" ")[0] ?? "";
  const today = now ? now.toLocaleDateString("es-ES", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) : "";

  const navigation: Array<{ label: string; href: string; icon: typeof LayoutDashboard; badge?: number }> = [
    { label: "Resumen", href: "/", icon: LayoutDashboard },
    { label: "Stock", href: withLocal("/stock"), icon: Boxes, badge: data?.attention },
    { label: "Pedidos", href: "/pedidos", icon: ShoppingCart },
    { label: "Recepciones", href: "/recepciones", icon: Package },
    { label: "Traspasos", href: "/traspasos", icon: Truck, badge: data?.pendingTransfers },
    { label: "Inventarios", href: "/inventarios", icon: ClipboardList },
    { label: "Mermas", href: "/mermas", icon: XCircle },
  ];

  return (
    <main className="app-shell">
      <aside className={`sidebar ${menuOpen ? "open" : ""}`}>
        <div className="brand-row">
          <div className="brand-mark"><Sparkles size={18} strokeWidth={2.5} /></div>
          <span className="brand-name">nexo<span>.</span></span>
          <button className="icon-button sidebar-close" aria-label="Cerrar menú" onClick={() => setMenuOpen(false)}><X size={18} /></button>
        </div>

        <div className="workspace-switcher">
          <div className="venue-avatar">{identity?.org[0]?.toUpperCase() ?? "·"}</div>
          <div className="workspace-copy">
            <strong>{identity?.org ?? "…"}</strong>
            <span>{identity ? `${identity.locations.length} ${identity.locations.length === 1 ? "local activo" : "locales activos"}` : ""}</span>
          </div>
        </div>

        <div className="nav-heading">Operativa</div>
        <nav className="main-nav" aria-label="Navegación principal">
          {navigation.map((item) => {
            const Icon = item.icon;
            const active = item.href === "/";
            return (
              <Link key={item.label} href={item.href} className={`nav-item ${active ? "active" : ""}`} onClick={() => setMenuOpen(false)}>
                <Icon size={18} strokeWidth={active ? 2.4 : 1.8} />
                <span>{item.label}</span>
                {item.badge ? <span className="nav-badge">{item.badge}</span> : null}
              </Link>
            );
          })}
        </nav>

        <div className="nav-heading secondary-heading">Gestión</div>
        <nav className="main-nav">
          <Link className="nav-item" href="/productos"><Package size={18} /><span>Productos</span></Link>
          <Link className="nav-item" href="/proveedores"><Truck size={18} /><span>Proveedores</span></Link>
          <Link className="nav-item" href={withLocal("/informes")}><SlidersHorizontal size={18} /><span>Informes</span></Link>
        </nav>

        <div className="sidebar-bottom">
          <button className="nav-item" onClick={() => { setMenuOpen(false); askAssistant("¿Qué puedes hacer?"); }}><CircleHelp size={18} /><span>Ayuda</span></button>
          <div className="user-card">
            <div className="user-avatar">{identity?.initials ?? "·"}</div>
            <Link className="workspace-copy user-link" href="/cuenta" title="Tu cuenta"><strong>{identity?.name ?? "…"}</strong><span>{identity?.role}</span></Link>
            <button className="icon-button" aria-label="Cerrar sesión" title="Cerrar sesión" onClick={() => void signOut()}><LogOut size={16} /></button>
          </div>
        </div>
      </aside>

      <section className="main-area">
        <header className="topbar">
          <button className="icon-button mobile-menu" aria-label="Abrir menú" onClick={() => setMenuOpen(true)}><Menu size={20} /></button>
          <div className="breadcrumb"><span>{identity?.org ?? ""}</span><ChevronRight size={14} /><strong>Resumen</strong></div>
          <div className="top-actions">
            <button className="search-trigger" onClick={() => setSearchOpen(true)}><Search size={17} /><span>Buscar producto</span></button>
            <div className="top-avatar" title={identity?.name}>{identity?.initials ?? "·"}</div>
          </div>
        </header>

        <div className="content">
          <div className="page-heading">
            <div>
              <p className="eyebrow">{today.charAt(0).toUpperCase() + today.slice(1)}</p>
              <h1>{now && firstName ? `${greeting(now.getHours())}, ${firstName}` : "Hola"} <span>↗</span></h1>
              <p className="subtitle">Esto es lo que está pasando con tu inventario{locationName ? ` en ${locationName}` : ""}.</p>
            </div>
            <div className="heading-actions">
              <div className="location-select">
                <Warehouse size={17} />
                <select value={location} onChange={(event) => changeLocation(event.target.value)} aria-label="Seleccionar local">
                  <option value="">Todos los locales</option>
                  {identity?.locations.map((l) => <option key={l.id} value={l.id}>{l.name}</option>)}
                </select>
                <ChevronDown size={15} />
              </div>
              <button className="primary-button" onClick={() => askAssistant()}><Sparkles size={17} /> Pedir al asistente</button>
            </div>
          </div>

          <div className="quick-actions">
            <Link href="/recepciones"><span className="quick-icon lime"><Package size={17} /></span><span><b>Recibir mercancía</b><small>Registrar albarán</small></span><ChevronRight size={16} /></Link>
            <Link href="/traspasos"><span className="quick-icon coral"><Truck size={17} /></span><span><b>Nuevo traspaso</b><small>Mover entre locales</small></span><ChevronRight size={16} /></Link>
            <Link href="/inventarios"><span className="quick-icon violet"><ClipboardList size={17} /></span><span><b>Contar inventario</b><small>Empezar un conteo</small></span><ChevronRight size={16} /></Link>
          </div>

          {error && <p className="dashboard-error">{error}</p>}

          <div className="metric-grid">
            <article className="metric-card featured-card">
              <div className="metric-top"><span>Valor del stock</span></div>
              <strong className="metric-value">{value(data?.stockValue)}</strong>
              <div className="metric-footer"><span className="positive">Valoración actual</span><span>a coste medio</span></div>
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Consumo del periodo</span></div>
              <strong className="metric-value">{value(data?.consumptionValue)}</strong>
              <div className="metric-footer">
                <span>Últimos 7 días</span>
                <span>{data?.consumptionTrend || "sin comparativa"}</span>
              </div>
              {data && data.consumptionBars.length > 0 && (
                <div className="real-bars" aria-hidden="true">
                  {data.consumptionBars.map((bar, index) => {
                    const max = Math.max(...data.consumptionBars.map((b) => b.value), 0.01);
                    return <i key={`${bar.label}-${index}`} style={{ height: `${Math.max((bar.value / max) * 100, 4)}%` }} title={`${bar.label}: ${bar.value.toFixed(2)} €`} />;
                  })}
                </div>
              )}
            </article>
            <article className="metric-card">
              <div className="metric-top"><span>Rotación</span></div>
              <strong className="metric-value">{value(data?.rotationValue)}</strong>
              <div className="metric-footer"><span>Consumo / valor de stock</span><span>últimos 7 días</span></div>
            </article>
            <article className="metric-card alert-card">
              <div className="metric-top"><span>Requieren atención</span>{data && data.attention > 0 && <span className="alert-dot" />}</div>
              <strong className="metric-value">{value(data ? String(data.attention) : undefined)} <em>productos</em></strong>
              <div className="metric-footer"><span className={data && data.critical > 0 ? "negative" : undefined}>{value(data ? String(data.critical) : undefined)} sin stock</span><span>por debajo del mínimo</span></div>
            </article>
          </div>

          <div className="section-grid">
            <section className="panel stock-panel">
              <div className="panel-header">
                <div><h2>Stock que requiere atención</h2><p>Primero lo que está bajo mínimo</p></div>
                <Link href={withLocal("/stock")} className="text-button">Ver todo <ChevronRight size={15} /></Link>
              </div>
              <div className="stock-table">
                <div className="table-head"><span>Producto</span><span>Existencias</span><span>Valor</span><span>Estado</span></div>
                {!data || data.stockRows.length === 0 ? (
                  <div className="empty-state">{loading ? "Cargando valoración..." : "No hay stock valorado todavía."}</div>
                ) : (
                  data.stockRows.map((row, index) => (
                    <div className="stock-row" key={`${row.name}-${index}`}>
                      <div className="product-name"><span className={`product-dot ${row.color}`} /><span><b>{row.name}</b><small>{row.category}</small></span></div>
                      <strong>{row.amount}</strong>
                      <span>{row.value}</span>
                      <span className={`status ${row.status}`}>{row.status === "ok" ? "En nivel" : row.status === "low" ? "Bajo mínimo" : "Urgente"}</span>
                    </div>
                  ))
                )}
              </div>
            </section>
            <section className="panel activity-panel">
              <div className="panel-header"><div><h2>Actividad reciente</h2><p>Últimos movimientos de stock</p></div></div>
              <div className="activity-list">
                {!data || data.activity.length === 0 ? (
                  <div className="empty-state">{loading ? "Cargando actividad..." : "Todavía no hay movimientos."}</div>
                ) : (
                  data.activity.map((item) => {
                    const Icon = item.icon;
                    return (
                      <div className="activity-item" key={item.id}>
                        <span className={`activity-icon ${item.tone}`}><Icon size={17} /></span>
                        <span className="activity-copy"><b>{item.title}</b><small>{item.detail}</small><time>{item.time}</time></span>
                      </div>
                    );
                  })
                )}
              </div>
              <Link className="activity-link" href={withLocal("/informes?vista=consumo")}>Ver consumo y mermas <ChevronRight size={15} /></Link>
            </section>
          </div>

          {data && data.attention > 0 && (
            <section className="order-banner">
              <div className="banner-icon"><ShoppingCart size={21} /></div>
              <div>
                <strong>Toca reponer</strong>
                <p>
                  {data.attention === 1 ? "Hay 1 producto" : `Hay ${data.attention} productos`} por debajo del mínimo{locationName ? ` en ${locationName}` : ""}.
                </p>
              </div>
              <Link className="secondary-button" href={withLocal("/pedidos?sugerir=1")}>Preparar pedido <ArrowUpRight size={16} /></Link>
            </section>
          )}
        </div>
      </section>

      {searchOpen && (
        <div className="search-overlay" onClick={() => setSearchOpen(false)}>
          <form className="search-dialog" onClick={(event) => event.stopPropagation()} onSubmit={search}>
            <Search size={19} />
            <input name="q" autoFocus placeholder="Buscar productos por nombre, categoría, SKU o código de barras" />
            <kbd>ESC</kbd>
            <div className="search-hint">Pulsa Intro para buscar en el catálogo</div>
          </form>
        </div>
      )}
      {menuOpen && <button className="mobile-backdrop" onClick={() => setMenuOpen(false)} aria-label="Cerrar menú" />}
    </main>
  );
}
