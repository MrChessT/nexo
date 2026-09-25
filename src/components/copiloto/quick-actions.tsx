"use client";

// Menú de funciones del asistente: consultas que se ejecutan al momento con los atajos deterministas
// del servidor (sin Jev) y accesos a las pantallas donde se registran las operaciones. Local y
// producto son filtros opcionales comunes a todas.
import { useEffect, useRef, useState, type ComponentType } from "react";
import {
  ArrowLeftRight,
  Boxes,
  ClipboardCheck,
  ClipboardList,
  FileText,
  MapPin,
  PackageCheck,
  Repeat,
  Scale,
  Search,
  ShoppingBag,
  ShoppingCart,
  Tag,
  Trash2,
  TrendingUp,
  Truck,
  Wallet,
  X,
} from "lucide-react";
import { createClient } from "@/lib/supabase/client";

type Icon = ComponentType<{ size?: number }>;

interface QueryFn {
  /** Comando del atajo en el servidor (/existencias, /reponer…). */
  command: string;
  label: string;
  hint: string;
  icon: Icon;
  /** Sin producto no tiene sentido (la ficha). */
  needsProduct?: boolean;
}

interface OperationFn {
  route: string;
  label: string;
  hint: string;
  icon: Icon;
}

export const QUERY_FUNCTIONS: QueryFn[] = [
  { command: "existencias", label: "Stock", hint: "Cuánto queda", icon: Boxes },
  { command: "reponer", label: "Qué reponer", hint: "Lo que falta para los próximos días", icon: ShoppingCart },
  { command: "precios", label: "Precios", hint: "Último precio y subidas", icon: Tag },
  { command: "ficha", label: "Ficha", hint: "Precio, stock y consumo de un producto", icon: FileText, needsProduct: true },
  { command: "consumo", label: "Lo que más se gasta", hint: "Ranking del último mes", icon: TrendingUp },
  { command: "movimientos", label: "Movimientos", hint: "Consumo, compras y mermas de la semana", icon: ArrowLeftRight },
  { command: "pendientes", label: "Traspasos pendientes", hint: "Enviados sin recibir", icon: Truck },
  { command: "pedidos", label: "Pedidos abiertos", hint: "Por enviar, en camino o con retraso", icon: ClipboardList },
  { command: "gasto", label: "Gasto en compras", hint: "Por proveedor, último mes", icon: Wallet },
  { command: "desvios", label: "Desvíos de inventario", hint: "Diferencias del último recuento", icon: Scale },
];

export const OPERATION_FUNCTIONS: OperationFn[] = [
  { route: "/mermas", label: "Merma", hint: "Roturas, caducados, invitaciones", icon: Trash2 },
  { route: "/recepciones", label: "Recepción", hint: "Lo que llega del proveedor", icon: PackageCheck },
  { route: "/traspasos", label: "Traspaso", hint: "Entre locales", icon: Repeat },
  { route: "/inventarios", label: "Inventario", hint: "Contar y cerrar", icon: ClipboardCheck },
  { route: "/pedidos", label: "Pedido", hint: "Preparar y enviar", icon: ShoppingBag },
];

/** Comando del atajo y texto que se enseña en el chat («Stock · Vivero · Beefeater»). */
export function buildQuery(fn: Pick<QueryFn, "command" | "label">, location: string, product: string): { message: string; display: string } {
  const args = [product.trim(), location].filter(Boolean);
  return { message: `/${fn.command}${args.length ? ` ${args.join(" ")}` : ""}`, display: [fn.label, location, product.trim()].filter(Boolean).join(" · ") };
}

interface Props {
  disabled: boolean;
  onRun: (message: string, display: string) => void;
  onClose: () => void;
}

export function QuickActions({ disabled, onRun, onClose }: Props) {
  const [locations, setLocations] = useState<Array<{ id: string; name: string }>>([]);
  const [location, setLocation] = useState("");
  const [product, setProduct] = useState("");
  const [missing, setMissing] = useState(false);
  const productRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const supabase = createClient();
    if (!supabase) return;
    void supabase
      .from("locations")
      .select("id, name")
      .eq("active", true)
      .order("name")
      .then(({ data }) => setLocations(data ?? []));
  }, []);

  function run(fn: QueryFn) {
    if (fn.needsProduct && !product.trim()) {
      setMissing(true);
      productRef.current?.focus();
      return;
    }
    const { message, display } = buildQuery(fn, location, product);
    onRun(message, display);
  }

  function go(fn: OperationFn) {
    const id = locations.find((l) => l.name === location)?.id;
    window.location.assign(id ? `${fn.route}?local=${id}` : fn.route);
  }

  return (
    <div className="copiloto-functions" role="dialog" aria-label="Funciones">
      <div className="copiloto-functions-head">
        <div>
          <strong>Funciones</strong>
          <small>Al momento, sin escribir al asistente</small>
        </div>
        <button type="button" className="icon-button" onClick={onClose} aria-label="Cerrar funciones">
          <X size={15} />
        </button>
      </div>

      <div className="copiloto-functions-filters">
        <label>
          <MapPin size={13} />
          <select value={location} onChange={(e) => setLocation(e.target.value)} aria-label="Local">
            <option value="">Todos los locales</option>
            {locations.map((l) => (
              <option key={l.id} value={l.name}>{l.name}</option>
            ))}
          </select>
        </label>
        <label className={missing && !product.trim() ? "missing" : ""}>
          <Search size={13} />
          <input
            ref={productRef}
            value={product}
            onChange={(e) => {
              setProduct(e.target.value);
              setMissing(false);
            }}
            placeholder="Producto (opcional)"
            aria-label="Producto"
            maxLength={80}
          />
        </label>
      </div>
      {missing && !product.trim() && <p className="copiloto-functions-note">La ficha necesita un producto.</p>}

      <p className="copiloto-section">Consultar</p>
      <div className="copiloto-functions-grid">
        {QUERY_FUNCTIONS.map((fn) => (
          <button type="button" key={fn.command} disabled={disabled} onClick={() => run(fn)}>
            <span className="copiloto-functions-icon"><fn.icon size={16} /></span>
            <span>
              <b>{fn.label}</b>
              <small>{fn.hint}</small>
            </span>
          </button>
        ))}
      </div>

      <p className="copiloto-section">Registrar</p>
      <div className="copiloto-functions-grid operations">
        {OPERATION_FUNCTIONS.map((fn) => (
          <button type="button" key={fn.route} onClick={() => go(fn)}>
            <span className="copiloto-functions-icon"><fn.icon size={16} /></span>
            <span>
              <b>{fn.label}</b>
              <small>{fn.hint}</small>
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}
