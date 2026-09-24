"use client";

import Link from "next/link";
import {
  ArrowLeft,
  Bell,
  ChevronDown,
  CirclePlus,
  ClipboardList,
  Filter,
  Package,
  Plus,
  Search,
  Trash2,
  Truck,
  X,
  XCircle,
} from "lucide-react";
import { useEffect, useState } from "react";
import Decimal from "decimal.js";
import { createClient } from "@/lib/supabase/client";
import "./operations.css";
import "./operations-modal.css";

type OperationKind = "recepciones" | "traspasos" | "inventarios" | "mermas";
type StatusColor = "green" | "orange" | "purple" | "red";

type Location = { id: string; name: string };
type ProductOption = { id: string; name: string; base_unit: string };
type PackOption = { id: string; product_id: string; product_name: string; pack_name: string; base_unit: string };
type SupplierOption = { id: string; name: string };

type RowAction = { label: string; onClick: () => void; tone: "primary" | "secondary" | "danger" };

type DisplayRow = {
  id: string;
  title: string;
  detail: string;
  status: string;
  rawStatus: string;
  statusColor: StatusColor;
  date: string;
  actions: RowAction[];
};

const icons = { recepciones: Package, traspasos: Truck, inventarios: ClipboardList, mermas: XCircle };
const eyebrows: Record<OperationKind, string> = {
  recepciones: "Operativa · Compras",
  traspasos: "Operativa · Multilocal",
  inventarios: "Operativa · Conteos",
  mermas: "Operativa · Control",
};
const titles: Record<OperationKind, string> = {
  recepciones: "Recepciones",
  traspasos: "Traspasos",
  inventarios: "Inventarios",
  mermas: "Mermas",
};
const descriptions: Record<OperationKind, string> = {
  recepciones: "Registra mercancía y actualiza el coste real del stock.",
  traspasos: "Mueve producto entre locales con trazabilidad completa.",
  inventarios: "Cuenta por zonas y detecta diferencias antes de cerrar.",
  mermas: "Registra pérdidas en segundos y entiende dónde se escapa el margen.",
};
const actionLabels: Record<OperationKind, string> = {
  recepciones: "Nueva recepción",
  traspasos: "Nuevo traspaso",
  inventarios: "Abrir inventario",
  mermas: "Registrar merma",
};

function formatDate(value: string) {
  return new Date(value).toLocaleDateString("es-ES", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

function formatCurrency(value: number) {
  return `${new Decimal(String(value)).toFixed(2).replace(".", ",")} €`;
}

function newRef() {
  return crypto.randomUUID();
}

export function OperationsPage({ kind }: { kind: OperationKind }) {
  const Icon = icons[kind];
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [rows, setRows] = useState<DisplayRow[]>([]);
  const [metrics, setMetrics] = useState<[string, string, string, string]>(["—", "—", "—", "—"]);
  const [busyId, setBusyId] = useState("");
  const [orgId, setOrgId] = useState("");
  const [locations, setLocations] = useState<Location[]>([]);
  const [products, setProducts] = useState<ProductOption[]>([]);
  const [packs, setPacks] = useState<PackOption[]>([]);
  const [suppliers, setSuppliers] = useState<SupplierOption[]>([]);

  const [modalOpen, setModalOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  // Traspasos
  const [trFrom, setTrFrom] = useState("");
  const [trTo, setTrTo] = useState("");
  const [trLines, setTrLines] = useState<Array<{ productId: string; qty: string }>>([{ productId: "", qty: "" }]);

  // Mermas
  const [wLocation, setWLocation] = useState("");
  const [wProduct, setWProduct] = useState("");
  const [wQty, setWQty] = useState("");
  const [wReason, setWReason] = useState("");

  // Recepciones
  const [rLocation, setRLocation] = useState("");
  const [rSupplier, setRSupplier] = useState("");
  const [rDocNumber, setRDocNumber] = useState("");
  const [rDocDate, setRDocDate] = useState(() => new Date().toISOString().slice(0, 10));
  const [rLines, setRLines] = useState<Array<{ packId: string; qty: string; price: string }>>([
    { packId: "", qty: "", price: "" },
  ]);

  // Inventarios
  const [ivLocation, setIvLocation] = useState("");
  const [countModal, setCountModal] = useState<{ id: string; locationId: string } | null>(null);
  const [countQtys, setCountQtys] = useState<Record<string, string>>({});
  const [countSaving, setCountSaving] = useState(false);
  const [countError, setCountError] = useState("");

  async function loadReference() {
    const supabase = createClient();
    if (!supabase) return null;
    // Datos de referencia independientes entre sí: una sola ronda de peticiones en paralelo.
    const [{ data: membership }, { data: locationRows }, { data: productRows }, { data: packRows }, { data: supplierRows }] = await Promise.all([
      supabase.from("memberships").select("org_id").limit(1).maybeSingle(),
      supabase.from("locations").select("id, name").eq("active", true).order("name"),
      supabase.from("products").select("id, name, base_unit").eq("active", true).order("name"),
      supabase
        .from("product_packs")
        .select("id, product_id, name, is_purchase_default, products(name, base_unit)")
        .eq("is_purchase_default", true),
      supabase.from("suppliers").select("id, name").eq("active", true).order("name"),
    ]);
    if (membership) setOrgId(membership.org_id);
    const loadedLocations = (locationRows ?? []) as Location[];
    setLocations(loadedLocations);
    setProducts((productRows ?? []) as ProductOption[]);
    setPacks(
      ((packRows ?? []) as unknown as Array<{ id: string; product_id: string; name: string; products: { name: string; base_unit: string } | null }>).map(
        (pack) => ({
          id: pack.id,
          product_id: pack.product_id,
          product_name: pack.products?.name ?? "Producto",
          pack_name: pack.name,
          base_unit: pack.products?.base_unit ?? "",
        }),
      ),
    );
    setSuppliers((supplierRows ?? []) as SupplierOption[]);
    return { supabase, locations: loadedLocations };
  }

  async function loadRows(locationsOverride?: Location[] | Promise<Location[]>) {
    setLoading(true);
    setLoadError("");
    const supabase = createClient();
    if (!supabase) {
      setLoadError("Configura las variables de Supabase para continuar.");
      setLoading(false);
      return;
    }

    if (kind === "recepciones") {
      const { data, error } = await supabase
        .from("goods_receipts")
        .select("id, doc_number, doc_date, status, suppliers(name), locations(name), receipt_lines(packs_qty, pack_price)")
        .order("doc_date", { ascending: false });
      if (error) {
        setLoadError("No se pudieron cargar las recepciones.");
        setLoading(false);
        return;
      }
      const records = (data ?? []) as unknown as Array<{
        id: string; doc_number: string | null; doc_date: string; status: "open" | "closed" | "cancelled";
        suppliers: { name: string } | null; locations: { name: string } | null;
        receipt_lines: Array<{ packs_qty: number; pack_price: number }>;
      }>;
      setRows(
        records.map((r) => ({
          id: r.id,
          title: r.doc_number ? `Albarán ${r.doc_number}` : "Albarán sin número",
          detail: r.suppliers?.name ?? "Proveedor sin asignar",
          status: r.locations?.name ?? "Local sin asignar",
          rawStatus: r.status,
          statusColor: r.status === "closed" ? "green" : r.status === "cancelled" ? "red" : "orange",
          date: formatDate(r.doc_date),
          actions: [],
        })),
      );
      const openCount = records.filter((r) => r.status === "open").length;
      const total = records.reduce((sum, r) => sum + r.receipt_lines.reduce((s, l) => s + l.packs_qty * l.pack_price, 0), 0);
      setMetrics([String(openCount), formatCurrency(total), "—", "—"]);
    }

    if (kind === "traspasos") {
      const { data, error } = await supabase
        .from("transfers")
        .select("id, status, created_at, from_location_id, to_location_id, transfer_lines(id, qty_sent)")
        .order("created_at", { ascending: false });
      if (error) {
        setLoadError("No se pudieron cargar los traspasos.");
        setLoading(false);
        return;
      }
      const records = (data ?? []) as unknown as Array<{
        id: string; status: "draft" | "in_transit" | "received" | "cancelled"; created_at: string;
        from_location_id: string; to_location_id: string; transfer_lines: Array<{ id: string; qty_sent: number }>;
      }>;
      const knownLocations = await (locationsOverride ?? locations);
      const locationName = (id: string) => knownLocations.find((loc) => loc.id === id)?.name ?? "?";
      const statusLabel: Record<"draft" | "in_transit" | "received" | "cancelled", string> = { draft: "Borrador", in_transit: "En tránsito", received: "Recibido", cancelled: "Cancelado" };
      const statusColor: Record<"draft" | "in_transit" | "received" | "cancelled", StatusColor> = { draft: "purple", in_transit: "orange", received: "green", cancelled: "red" };
      setRows(
        records.map((t) => {
          const actions: RowAction[] = [];
          /* eslint-disable react-hooks/immutability -- los handlers se definen más abajo y se llaman mutuamente con loadRows */
          if (t.status === "draft") {
            actions.push({ label: "Enviar", tone: "primary", onClick: () => void handleSendTransfer(t.id) });
            actions.push({ label: "Eliminar", tone: "danger", onClick: () => void handleDeleteTransfer(t.id) });
          } else if (t.status === "in_transit") {
            actions.push({ label: "Recibir", tone: "primary", onClick: () => void handleReceiveTransfer(t.id) });
            actions.push({ label: "Cancelar", tone: "danger", onClick: () => void handleCancelTransfer(t.id) });
          }
          /* eslint-enable react-hooks/immutability */
          return {
            id: t.id,
            title: `${locationName(t.from_location_id)} → ${locationName(t.to_location_id)}`,
            detail: `${t.transfer_lines.length} producto${t.transfer_lines.length === 1 ? "" : "s"}`,
            status: statusLabel[t.status],
            rawStatus: t.status,
            statusColor: statusColor[t.status],
            date: formatDate(t.created_at),
            actions,
          };
        }),
      );
      const pending = records.filter((t) => t.status === "draft" || t.status === "in_transit").length;
      const inTransit = records.filter((t) => t.status === "in_transit").length;
      setMetrics([String(pending), `${inTransit} en tránsito`, "—", "—"]);
    }

    if (kind === "inventarios") {
      const { data, error } = await supabase
        .from("inventory_counts")
        .select("id, status, started_at, location_id, locations(name), count_lines(id)")
        .order("started_at", { ascending: false });
      if (error) {
        setLoadError("No se pudieron cargar los inventarios.");
        setLoading(false);
        return;
      }
      const records = (data ?? []) as unknown as Array<{
        id: string; status: "open" | "closed" | "cancelled"; started_at: string; location_id: string;
        locations: { name: string } | null; count_lines: Array<{ id: string }>;
      }>;
      const statusLabel: Record<"open" | "closed" | "cancelled", string> = { open: "En progreso", closed: "Cerrado", cancelled: "Cancelado" };
      const statusColor: Record<"open" | "closed" | "cancelled", StatusColor> = { open: "orange", closed: "green", cancelled: "red" };
      setRows(
        records.map((c) => {
          const actions: RowAction[] = [];
          if (c.status === "open") {
            actions.push({
              label: "Contar",
              tone: "primary",
              onClick: () => {
                setCountModal({ id: c.id, locationId: c.location_id });
                setCountQtys({});
                setCountError("");
              },
            });
          }
          return {
            id: c.id,
            title: `Inventario ${c.locations?.name ?? "?"}`,
            detail: `${c.count_lines.length} línea${c.count_lines.length === 1 ? "" : "s"} contadas`,
            status: statusLabel[c.status],
            rawStatus: c.status,
            statusColor: statusColor[c.status],
            date: formatDate(c.started_at),
            actions,
          };
        }),
      );
      const openCount = records.filter((c) => c.status === "open").length;
      setMetrics([String(openCount), "—", "—", "—"]);
    }

    if (kind === "mermas") {
      const { data, error } = await supabase
        .from("stock_movements")
        .select("id, qty, unit_cost, reason, occurred_at, products(name, base_unit), locations(name)")
        .eq("type", "waste")
        .order("occurred_at", { ascending: false })
        .limit(100);
      if (error) {
        setLoadError("No se pudieron cargar las mermas.");
        setLoading(false);
        return;
      }
      const records = (data ?? []) as unknown as Array<{
        id: number; qty: number; unit_cost: number | null; reason: string | null; occurred_at: string;
        products: { name: string; base_unit: string } | null; locations: { name: string } | null;
      }>;
      setRows(
        records.map((m) => ({
          id: String(m.id),
          title: m.products?.name ?? "Producto",
          detail: `${new Decimal(String(Math.abs(m.qty))).toFixed(2)} ${m.products?.base_unit ?? ""}${m.reason ? ` · ${m.reason}` : ""}`,
          status: m.locations?.name ?? "Local",
          rawStatus: "registrada",
          statusColor: "red",
          date: formatDate(m.occurred_at),
          actions: [],
        })),
      );
      const totalValue = records.reduce((sum, m) => sum + Math.abs(m.qty) * (m.unit_cost ?? 0), 0);
      setMetrics([String(records.length), formatCurrency(totalValue), "—", "—"]);
    }

    setLoading(false);
  }

  useEffect(() => {
    async function bootstrap() {
      // Referencia y listado a la vez; el listado solo espera a los locales si los necesita (traspasos).
      const ref = loadReference();
      await Promise.all([ref, loadRows(ref.then((r) => r?.locations ?? []))]);
    }
    void bootstrap();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  function resetForms() {
    setFormError("");
    setTrFrom("");
    setTrTo("");
    setTrLines([{ productId: "", qty: "" }]);
    setWLocation("");
    setWProduct("");
    setWQty("");
    setWReason("");
    setRLocation("");
    setRSupplier("");
    setRDocNumber("");
    setRDocDate(new Date().toISOString().slice(0, 10));
    setRLines([{ packId: "", qty: "", price: "" }]);
    setIvLocation("");
  }

  function openModal() {
    resetForms();
    setModalOpen(true);
  }

  function closeModal() {
    if (saving) return;
    setModalOpen(false);
  }

  async function handleCreateTransfer() {
    setFormError("");
    if (!trFrom || !trTo) { setFormError("Elige local de origen y destino."); return; }
    if (trFrom === trTo) { setFormError("El origen y el destino deben ser distintos."); return; }
    const validLines = trLines.filter((line) => line.productId && Number(line.qty) > 0);
    if (validLines.length === 0) { setFormError("Añade al menos una línea con cantidad."); return; }

    setSaving(true);
    const supabase = createClient();
    if (!supabase) { setFormError("Supabase no está configurado."); setSaving(false); return; }

    const { data: transfer, error: transferError } = await supabase
      .from("transfers")
      .insert({ org_id: orgId, from_location_id: trFrom, to_location_id: trTo })
      .select("id")
      .single();
    if (transferError || !transfer) {
      setFormError("No se pudo crear el traspaso.");
      setSaving(false);
      return;
    }

    const { error: linesError } = await supabase.from("transfer_lines").insert(
      validLines.map((line) => ({ transfer_id: transfer.id, product_id: line.productId, qty_sent: Number(line.qty) })),
    );
    if (linesError) {
      setFormError("El traspaso se creó pero no se pudieron guardar las líneas.");
      setSaving(false);
      return;
    }

    setSaving(false);
    setModalOpen(false);
    await loadRows();
  }

  async function handleSendTransfer(id: string) {
    setBusyId(id);
    const supabase = createClient();
    if (!supabase) { setBusyId(""); return; }
    const { error } = await supabase.rpc("send_transfer", { p_transfer: id });
    if (error) setLoadError("No se pudo enviar el traspaso.");
    setBusyId("");
    await loadRows();
  }

  async function handleReceiveTransfer(id: string) {
    setBusyId(id);
    const supabase = createClient();
    if (!supabase) { setBusyId(""); return; }
    const { error } = await supabase.rpc("receive_transfer", { p_transfer: id });
    if (error) setLoadError("No se pudo recibir el traspaso.");
    setBusyId("");
    await loadRows();
  }

  async function handleCancelTransfer(id: string) {
    setBusyId(id);
    const supabase = createClient();
    if (!supabase) { setBusyId(""); return; }
    const { error } = await supabase.rpc("cancel_transfer", { p_transfer: id });
    if (error) setLoadError("No se pudo cancelar el traspaso.");
    setBusyId("");
    await loadRows();
  }

  async function handleDeleteTransfer(id: string) {
    setBusyId(id);
    const supabase = createClient();
    if (!supabase) { setBusyId(""); return; }
    const { error } = await supabase.from("transfers").delete().eq("id", id);
    if (error) setLoadError("No se pudo eliminar el traspaso.");
    setBusyId("");
    await loadRows();
  }

  async function handleRegisterWaste() {
    setFormError("");
    if (!wLocation || !wProduct || !(Number(wQty) > 0)) {
      setFormError("Elige local, producto y una cantidad mayor que cero.");
      return;
    }
    setSaving(true);
    const supabase = createClient();
    if (!supabase) { setFormError("Supabase no está configurado."); setSaving(false); return; }
    const { error } = await supabase.rpc("register_movement", {
      p_location: wLocation,
      p_product: wProduct,
      p_type: "waste",
      p_qty: Number(wQty),
      p_reason: wReason.trim() || null,
      p_client_ref: newRef(),
    });
    if (error) {
      setFormError("No se pudo registrar la merma. Revisa que tengas acceso a ese local.");
      setSaving(false);
      return;
    }
    setSaving(false);
    setModalOpen(false);
    await loadRows();
  }

  async function handleCreateReceipt() {
    setFormError("");
    if (!rLocation) { setFormError("Elige un local."); return; }
    const validLines = rLines.filter((line) => line.packId && Number(line.qty) > 0 && Number(line.price) >= 0);
    if (validLines.length === 0) { setFormError("Añade al menos una línea con cantidad y precio."); return; }

    setSaving(true);
    const supabase = createClient();
    if (!supabase) { setFormError("Supabase no está configurado."); setSaving(false); return; }

    const { data: receipt, error: receiptError } = await supabase
      .from("goods_receipts")
      .insert({
        org_id: orgId,
        location_id: rLocation,
        supplier_id: rSupplier || null,
        doc_number: rDocNumber.trim() || null,
        doc_date: rDocDate,
      })
      .select("id")
      .single();
    if (receiptError || !receipt) {
      setFormError("No se pudo crear la recepción.");
      setSaving(false);
      return;
    }

    const { error: linesError } = await supabase.from("receipt_lines").insert(
      validLines.map((line) => ({ receipt_id: receipt.id, pack_id: line.packId, packs_qty: Number(line.qty), pack_price: Number(line.price) })),
    );
    if (linesError) {
      setFormError("La recepción se creó pero no se pudieron guardar las líneas.");
      setSaving(false);
      return;
    }

    const { error: postError } = await supabase.rpc("post_receipt", { p_receipt: receipt.id });
    if (postError) {
      setFormError("La recepción se guardó pero no se pudo confirmar el stock.");
      setSaving(false);
      return;
    }

    setSaving(false);
    setModalOpen(false);
    await loadRows();
  }

  async function handleOpenCount() {
    setFormError("");
    if (!ivLocation) { setFormError("Elige un local."); return; }
    setSaving(true);
    const supabase = createClient();
    if (!supabase) { setFormError("Supabase no está configurado."); setSaving(false); return; }
    const { error } = await supabase.from("inventory_counts").insert({ org_id: orgId, location_id: ivLocation });
    if (error) {
      setFormError(error.code === "23505" ? "Ya hay un inventario abierto en ese local." : "No se pudo abrir el inventario.");
      setSaving(false);
      return;
    }
    setSaving(false);
    setModalOpen(false);
    await loadRows();
  }

  async function handleSaveCountLines() {
    if (!countModal) return;
    setCountError("");
    const entries = Object.entries(countQtys).filter(([, qty]) => qty.trim() !== "" && Number(qty) >= 0);
    if (entries.length === 0) { setCountError("Introduce al menos una cantidad."); return; }
    setCountSaving(true);
    const supabase = createClient();
    if (!supabase) { setCountError("Supabase no está configurado."); setCountSaving(false); return; }
    const { error } = await supabase.from("count_lines").insert(
      entries.map(([productId, qty]) => ({ count_id: countModal.id, product_id: productId, qty: Number(qty), client_ref: newRef() })),
    );
    if (error) {
      setCountError("No se pudieron guardar las líneas contadas.");
      setCountSaving(false);
      return;
    }
    setCountQtys({});
    setCountSaving(false);
    await loadRows();
  }

  async function handleCloseCount() {
    if (!countModal) return;
    setCountSaving(true);
    setCountError("");
    const supabase = createClient();
    if (!supabase) { setCountError("Supabase no está configurado."); setCountSaving(false); return; }
    if (Object.values(countQtys).some((qty) => qty.trim() !== "")) {
      await handleSaveCountLines();
    }
    const { error } = await supabase.rpc("close_count", { p_count: countModal.id, p_zero_uncounted: true });
    if (error) {
      setCountError("No se pudo cerrar el inventario.");
      setCountSaving(false);
      return;
    }
    setCountSaving(false);
    setCountModal(null);
    await loadRows();
  }

  const statusOptions: Record<OperationKind, Array<{ value: string; label: string }>> = {
    recepciones: [
      { value: "open", label: "Abierta" },
      { value: "closed", label: "Cerrada" },
      { value: "cancelled", label: "Cancelada" },
    ],
    traspasos: [
      { value: "draft", label: "Borrador" },
      { value: "in_transit", label: "En tránsito" },
      { value: "received", label: "Recibido" },
      { value: "cancelled", label: "Cancelado" },
    ],
    inventarios: [
      { value: "open", label: "En progreso" },
      { value: "closed", label: "Cerrado" },
    ],
    mermas: [],
  };
  const filteredRows = rows
    .filter((row) => `${row.title} ${row.detail} ${row.status}`.toLowerCase().includes(query.toLowerCase()))
    .filter((row) => !statusFilter || row.rawStatus === statusFilter);

  return (
    <main className="operations-page">
      <header className="operations-topbar">
        <Link href="/" className="back-link"><ArrowLeft size={16} /> Resumen</Link>
        <span className="operations-brand"><span>NEXO</span> · {titles[kind]}</span>
        <div className="operations-top-actions">
          <button aria-label="Notificaciones"><Bell size={17} /></button>
          <span>MC</span>
        </div>
      </header>
      <div className="operations-content">
        <div className="operations-heading">
          <div>
            <p className="operation-eyebrow">{eyebrows[kind]}</p>
            <h1>{titles[kind]}</h1>
            <p>{descriptions[kind]}</p>
          </div>
          <button className="operation-primary" onClick={openModal}>
            <CirclePlus size={17} /> {actionLabels[kind]}
          </button>
        </div>
        <div className="operation-metrics">
          <div><span>Pendientes</span><strong>{metrics[0]}</strong><small>requieren atención</small></div>
          <div><span>Valor asociado</span><strong>{metrics[1]}</strong><small>movimientos registrados</small></div>
          <div><span>Principal alerta</span><strong>{metrics[2]}</strong><small>revisar esta semana</small></div>
          <div><span>Periodo</span><strong>{metrics[3]}</strong><small>día de negocio</small></div>
        </div>
        <section className="operations-panel">
          <div className="operations-toolbar">
            <div className="operations-search">
              <Search size={16} />
              <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por producto, local o documento" />
            </div>
            {statusOptions[kind].length > 0 && (
              <div className="operations-filter">
                <Filter size={14} />
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value)}
                  aria-label="Filtrar por estado"
                  style={{ border: 0, outline: 0, background: "transparent", color: "inherit", font: "inherit", appearance: "none", WebkitAppearance: "none", paddingRight: 4 }}
                >
                  <option value="">Todos los estados</option>
                  {statusOptions[kind].map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
                <ChevronDown size={14} />
              </div>
            )}
          </div>
          <div className="operation-table-head">
            <span>Referencia</span><span>Detalle</span><span>Local / estado</span><span>Fecha</span><span />
          </div>
          {loading && (
            <div className="operation-row"><div className="operation-reference"><span className={`operation-icon purple`}><Icon size={16} /></span><strong>Cargando...</strong></div><span>Consultando Supabase</span><span /><span /><span /></div>
          )}
          {!loading && loadError && (
            <div className="operation-row"><div className="operation-reference"><span className="operation-icon red"><Icon size={16} /></span><strong>No se pudo cargar</strong></div><span>{loadError}</span><span /><span /><span /></div>
          )}
          {!loading && !loadError && filteredRows.length === 0 && (
            <div className="operation-row"><div className="operation-reference"><span className="operation-icon purple"><Icon size={16} /></span><strong>Sin resultados</strong></div><span>Todavía no hay registros.</span><span /><span /><span /></div>
          )}
          {!loading && !loadError && filteredRows.map((row) => (
            <div className="operation-row" key={row.id}>
              <div className="operation-reference">
                <span className={`operation-icon ${row.statusColor}`}><Icon size={16} /></span>
                <strong>{row.title}</strong>
              </div>
              <span>{row.detail}</span>
              <span className={`operation-status ${row.statusColor}`}>{row.status}</span>
              <span>{row.date}</span>
              <div className="op-row-actions">
                {row.actions.map((action) => (
                  <button
                    key={action.label}
                    className={`op-action-${action.tone}`}
                    disabled={busyId === row.id}
                    onClick={action.onClick}
                  >
                    {busyId === row.id ? "..." : action.label}
                  </button>
                ))}
              </div>
            </div>
          ))}
        </section>
      </div>

      {modalOpen && (
        <div className="op-modal-layer" onClick={closeModal}>
          <section className="op-modal" onClick={(event) => event.stopPropagation()}>
            <div className="op-modal-heading">
              <div><p className="operation-eyebrow">{eyebrows[kind]}</p><h2>{actionLabels[kind]}</h2></div>
              <button className="op-modal-close" onClick={closeModal} aria-label="Cerrar"><X size={18} /></button>
            </div>

            {kind === "traspasos" && (
              <>
                <div className="op-modal-grid">
                  <label>Local origen
                    <select value={trFrom} onChange={(e) => setTrFrom(e.target.value)}>
                      <option value="">Elige un local</option>
                      {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                    </select>
                  </label>
                  <label>Local destino
                    <select value={trTo} onChange={(e) => setTrTo(e.target.value)}>
                      <option value="">Elige un local</option>
                      {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="op-modal-lines">
                  {trLines.map((line, index) => (
                    <div className="op-modal-line-row" key={index}>
                      <select value={line.productId} onChange={(e) => setTrLines(trLines.map((l, i) => i === index ? { ...l, productId: e.target.value } : l))}>
                        <option value="">Producto</option>
                        {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                      <input type="number" min="0" step="any" placeholder="Cant." value={line.qty} onChange={(e) => setTrLines(trLines.map((l, i) => i === index ? { ...l, qty: e.target.value } : l))} />
                      <button onClick={() => setTrLines(trLines.filter((_, i) => i !== index))} aria-label="Quitar línea"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
                <button className="op-modal-add-line" onClick={() => setTrLines([...trLines, { productId: "", qty: "" }])}><Plus size={14} /> Añadir línea</button>
                <button className="op-modal-submit" onClick={handleCreateTransfer} disabled={saving}>{saving ? "Creando..." : "Crear traspaso"}</button>
              </>
            )}

            {kind === "mermas" && (
              <>
                <label>Local
                  <select value={wLocation} onChange={(e) => setWLocation(e.target.value)}>
                    <option value="">Elige un local</option>
                    {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                  </select>
                </label>
                <label>Producto
                  <select value={wProduct} onChange={(e) => setWProduct(e.target.value)}>
                    <option value="">Elige un producto</option>
                    {products.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <label>Cantidad {wProduct && `(${products.find((p) => p.id === wProduct)?.base_unit ?? ""})`}
                  <input type="number" min="0" step="any" value={wQty} onChange={(e) => setWQty(e.target.value)} placeholder="0" />
                </label>
                <label>Motivo
                  <input value={wReason} onChange={(e) => setWReason(e.target.value)} placeholder="Ej. Rotura, caducidad..." />
                </label>
                <button className="op-modal-submit" onClick={handleRegisterWaste} disabled={saving}>{saving ? "Registrando..." : "Registrar merma"}</button>
              </>
            )}

            {kind === "recepciones" && (
              <>
                <div className="op-modal-grid">
                  <label>Local
                    <select value={rLocation} onChange={(e) => setRLocation(e.target.value)}>
                      <option value="">Elige un local</option>
                      {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                    </select>
                  </label>
                  <label>Proveedor (opcional)
                    <select value={rSupplier} onChange={(e) => setRSupplier(e.target.value)}>
                      <option value="">Sin proveedor</option>
                      {suppliers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="op-modal-grid">
                  <label>Nº de albarán
                    <input value={rDocNumber} onChange={(e) => setRDocNumber(e.target.value)} placeholder="Ej. A-2841" />
                  </label>
                  <label>Fecha
                    <input type="date" value={rDocDate} onChange={(e) => setRDocDate(e.target.value)} />
                  </label>
                </div>
                <div className="op-modal-lines">
                  {rLines.map((line, index) => (
                    <div className="op-modal-line-row with-price" key={index}>
                      <select value={line.packId} onChange={(e) => setRLines(rLines.map((l, i) => i === index ? { ...l, packId: e.target.value } : l))}>
                        <option value="">Producto</option>
                        {packs.map((p) => <option key={p.id} value={p.id}>{p.product_name} · {p.pack_name}</option>)}
                      </select>
                      <input type="number" min="0" step="any" placeholder="Uds." value={line.qty} onChange={(e) => setRLines(rLines.map((l, i) => i === index ? { ...l, qty: e.target.value } : l))} />
                      <input type="number" min="0" step="any" placeholder="Precio €" value={line.price} onChange={(e) => setRLines(rLines.map((l, i) => i === index ? { ...l, price: e.target.value } : l))} />
                      <button onClick={() => setRLines(rLines.filter((_, i) => i !== index))} aria-label="Quitar línea"><Trash2 size={14} /></button>
                    </div>
                  ))}
                </div>
                <button className="op-modal-add-line" onClick={() => setRLines([...rLines, { packId: "", qty: "", price: "" }])}><Plus size={14} /> Añadir línea</button>
                <button className="op-modal-submit" onClick={handleCreateReceipt} disabled={saving}>{saving ? "Registrando..." : "Registrar recepción"}</button>
              </>
            )}

            {kind === "inventarios" && (
              <>
                <label>Local
                  <select value={ivLocation} onChange={(e) => setIvLocation(e.target.value)}>
                    <option value="">Elige un local</option>
                    {locations.map((loc) => <option key={loc.id} value={loc.id}>{loc.name}</option>)}
                  </select>
                </label>
                <button className="op-modal-submit" onClick={handleOpenCount} disabled={saving}>{saving ? "Abriendo..." : "Abrir inventario"}</button>
              </>
            )}

            {formError && <p className="op-modal-error">{formError}</p>}
          </section>
        </div>
      )}

      {countModal && (
        <div className="op-modal-layer" onClick={() => !countSaving && setCountModal(null)}>
          <section className="op-modal" onClick={(event) => event.stopPropagation()}>
            <div className="op-modal-heading">
              <div><p className="operation-eyebrow">Conteo</p><h2>Contar productos</h2></div>
              <button className="op-modal-close" onClick={() => setCountModal(null)} aria-label="Cerrar"><X size={18} /></button>
            </div>
            <div className="op-modal-count-list">
              {products.map((product) => (
                <div className="op-modal-count-row" key={product.id}>
                  <span>{product.name} <small>({product.base_unit})</small></span>
                  <input
                    type="number" min="0" step="any" placeholder="0"
                    value={countQtys[product.id] ?? ""}
                    onChange={(e) => setCountQtys({ ...countQtys, [product.id]: e.target.value })}
                  />
                </div>
              ))}
            </div>
            {countError && <p className="op-modal-error">{countError}</p>}
            <div className="op-modal-actions">
              <button className="op-modal-submit op-modal-secondary" onClick={handleSaveCountLines} disabled={countSaving}>{countSaving ? "Guardando..." : "Guardar conteo"}</button>
              <button className="op-modal-submit" onClick={handleCloseCount} disabled={countSaving}>{countSaving ? "Cerrando..." : "Cerrar inventario"}</button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
