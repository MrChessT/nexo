"use client";

import Link from "next/link";
import { ArrowLeft, ArrowRight, Bell, CheckCircle2, ChevronDown, CirclePlus, ClipboardList, FileText, Filter, Package, Search, Truck, XCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import "./operations.css";

type OperationKind = "recepciones" | "traspasos" | "inventarios" | "mermas";

type OperationConfig = {
  kind: OperationKind;
  eyebrow: string;
  title: string;
  description: string;
  action: string;
  metrics: [string, string, string, string];
  rows: Array<[string, string, string, string, "green" | "orange" | "purple" | "red"]>;
};

type OperationRow = [string, string, string, string, "green" | "orange" | "purple" | "red"];

type ReceiptQueryRow = {
  id: string;
  doc_number: string | null;
  doc_date: string;
  status: "open" | "closed" | "cancelled";
  suppliers: { name: string } | null;
  locations: { name: string } | null;
};

const configs: Record<OperationKind, OperationConfig> = {
  recepciones: {
    kind: "recepciones", eyebrow: "Operativa · Compras", title: "Recepciones", description: "Registra mercancía y actualiza el coste real del stock.", action: "Nueva recepción", metrics: ["—", "—", "—", "—"],
    rows: [["Albarán #A-2841", "Distribuciones Ceres", "Parador", "Hoy, 09:42", "green"], ["Albarán #A-2838", "Bebidas del Sur", "Vivero", "Ayer, 18:10", "green"], ["Albarán #A-2832", "Frutas La Vega", "Pickels", "21 sep, 11:24", "orange"]],
  },
  traspasos: {
    kind: "traspasos", eyebrow: "Operativa · Multilocal", title: "Traspasos", description: "Mueve producto entre locales con trazabilidad completa.", action: "Nuevo traspaso", metrics: ["2", "1 en tránsito", "700 ml", "Esta semana"],
    rows: [["Parador → Pickels", "12 productos", "En tránsito", "Hace 18 min", "orange"], ["Vivero → Parador", "8 productos", "Recibido", "Hoy, 08:30", "green"], ["La Oliva → Vivero", "4 productos", "Borrador", "Ayer, 16:12", "purple"]],
  },
  inventarios: {
    kind: "inventarios", eyebrow: "Operativa · Conteos", title: "Inventarios", description: "Cuenta por zonas y detecta diferencias antes de cerrar.", action: "Abrir inventario", metrics: ["1", "42 / 184", "-79,17 €", "Último cierre"],
    rows: [["Inventario Parador", "42 de 184 productos", "En progreso", "Actualizado hace 2 min", "orange"], ["Inventario Pickels", "184 productos", "Cerrado", "22 sep, 06:14", "green"], ["Inventario Vivero", "184 productos", "Cerrado", "20 sep, 05:58", "green"]],
  },
  mermas: {
    kind: "mermas", eyebrow: "Operativa · Control", title: "Mermas", description: "Registra pérdidas en segundos y entiende dónde se escapa el margen.", action: "Registrar merma", metrics: ["14", "286,40 €", "Rotura", "Este mes"],
    rows: [["Ginebra Nordes", "2 botellas · Rotura", "Parador", "Hace 38 min", "red"], ["Lima fresca", "1,2 kg · Caducidad", "La Oliva", "Ayer, 22:10", "orange"], ["Tónica Fever-Tree", "6 ud · Error preparación", "Pickels", "21 sep, 02:43", "red"]],
  },
};

const icons = { recepciones: Package, traspasos: Truck, inventarios: ClipboardList, mermas: XCircle };

export function OperationsPage({ kind }: { kind: OperationKind }) {
  const config = configs[kind];
  const Icon = icons[kind];
  const [query, setQuery] = useState("");
  const [receiptRows, setReceiptRows] = useState<OperationRow[]>([]);
  const [loading, setLoading] = useState(kind === "recepciones");

  useEffect(() => {
    if (kind !== "recepciones") return;
    async function loadReceipts() {
      const supabase = createClient();
      if (!supabase) {
        setReceiptRows([["Recepciones no disponibles", "Configura Supabase", "", "", "red"]]);
        setLoading(false);
        return;
      }
      const { data, error: queryError } = await supabase
        .from("goods_receipts")
        .select("id, doc_number, doc_date, status, suppliers(name), locations(name)")
        .order("doc_date", { ascending: false });
      if (queryError) {
        setReceiptRows([["No se pudieron cargar las recepciones", "Revisa la conexión", "", "", "red"]]);
        setLoading(false);
        return;
      }
      const records = (data ?? []) as ReceiptQueryRow[];
      setReceiptRows(records.map((receipt) => [
        receipt.doc_number ? `Albarán ${receipt.doc_number}` : "Albarán sin número",
        receipt.suppliers?.name ?? "Proveedor sin asignar",
        receipt.locations?.name ?? "Local sin asignar",
        new Date(receipt.doc_date).toLocaleDateString("es-ES"),
        receipt.status === "closed" ? "green" : receipt.status === "cancelled" ? "red" : "orange",
      ]));
      setLoading(false);
    }
    void loadReceipts();
  }, [kind]);

  const rows = kind === "recepciones"
    ? loading
      ? [["Cargando recepciones", "Consultando Supabase", "", "", "purple"] as OperationRow]
      : receiptRows
    : config.rows;
  const filteredRows = rows.filter((row) => row.join(" ").toLowerCase().includes(query.toLowerCase()));

  return <main className="operations-page"><header className="operations-topbar"><Link href="/" className="back-link"><ArrowLeft size={16} /> Resumen</Link><span className="operations-brand"><span>NEXO</span> · {config.title}</span><div className="operations-top-actions"><button aria-label="Notificaciones"><Bell size={17} /></button><span>MC</span></div></header><div className="operations-content"><div className="operations-heading"><div><p className="operation-eyebrow">{config.eyebrow}</p><h1>{config.title}</h1><p>{config.description}</p></div><button className="operation-primary"><CirclePlus size={17} /> {config.action}</button></div><div className="operation-metrics"><div><span>Pendientes</span><strong>{config.metrics[0]}</strong><small>requieren atención</small></div><div><span>Valor asociado</span><strong>{config.metrics[1]}</strong><small>movimientos registrados</small></div><div><span>Principal alerta</span><strong>{config.metrics[2]}</strong><small>revisar esta semana</small></div><div><span>Periodo</span><strong>{config.metrics[3]}</strong><small>día de negocio</small></div></div><section className="operations-panel"><div className="operations-toolbar"><div className="operations-search"><Search size={16} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Buscar por producto, local o documento" /></div><button className="operations-filter"><Filter size={14} /> Filtros <ChevronDown size={14} /></button><button className="operations-filter">Todos los estados <ChevronDown size={14} /></button></div><div className="operation-table-head"><span>Referencia</span><span>Detalle</span><span>Local / estado</span><span>Fecha</span><span /></div>{filteredRows.map((row) => <div className="operation-row" key={`${row[0]}-${row[3]}`}><div className="operation-reference"><span className={`operation-icon ${row[4]}`}><Icon size={16} /></span><strong>{row[0]}</strong></div><span>{row[1]}</span><span className={`operation-status ${row[4]}`}>{row[2]}</span><span className="operation-date">{row[3]}</span><button className="operation-open" aria-label={`Abrir ${row[0]}`}><ArrowRight size={16} /></button></div>)}{filteredRows.length === 0 && <div className="operations-empty"><FileText size={22} /><strong>No hay resultados</strong><span>Prueba con otro término de búsqueda.</span></div>}</section><div className="operation-tip"><CheckCircle2 size={18} /><span><strong>Todo queda trazado.</strong> Los cambios de stock se registran como movimientos inmutables y siempre puedes volver a su documento de origen.</span></div></div></main>;
}
