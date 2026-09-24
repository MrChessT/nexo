// Tabla de una consulta para el chat: las filas ya formateadas del resultado, con las columnas que
// importan en cada consulta. Con una sola fila no hace falta tabla (basta el texto).
import type { TableEvent } from "../contract/index";
import type { ToolResult, ToolRow } from "../tools/types";

type Column = TableEvent["columns"][number];

const text = (v: ToolRow[string] | undefined): string => (v === null || v === undefined || typeof v === "boolean" ? "" : v);

function columnsFor(result: ToolResult): { columns: Column[]; flag?: (row: ToolRow) => boolean } {
  switch (result.tool) {
    case "query_stock":
      if (result.totals.desglose === "local") {
        return {
          columns: [{ key: "producto", label: "Producto" }, { key: "cantidad", label: "Total", align: "right" }, { key: "desglose", label: "Por local" }],
          flag: (r) => r.bajo_minimo === true,
        };
      }
      if (result.totals.desglose === "espacio") {
        return { columns: [{ key: "espacio", label: "Sección" }, { key: "producto", label: "Producto" }, { key: "cantidad", label: "Cantidad", align: "right" }] };
      }
      return {
        columns: [{ key: "producto", label: "Producto" }, { key: "local", label: "Local" }, { key: "cantidad", label: "Cantidad", align: "right" }, { key: "valor", label: "Valor", align: "right" }],
        flag: (r) => r.bajo_minimo === true,
      };
    case "query_movements":
      return { columns: [{ key: "tipo", label: "Tipo" }, { key: "producto", label: "Producto" }, { key: "cantidad", label: "Cantidad", align: "right" }, { key: "valor", label: "Valor", align: "right" }] };
    case "query_prices":
      return { columns: [{ key: "producto", label: "Producto" }, { key: "proveedor", label: "Proveedor" }, { key: "precio_actual", label: "Precio", align: "right" }] };
    case "query_pending_transfers":
      return { columns: [{ key: "origen", label: "Desde" }, { key: "destino", label: "A" }, { key: "enviado_hace", label: "Enviado" }, { key: "productos", label: "Productos" }] };
    case "query_count_variance":
      return { columns: [{ key: "producto", label: "Producto" }, { key: "local", label: "Local" }, { key: "diferencia", label: "Diferencia", align: "right" }, { key: "valor", label: "Valor", align: "right" }] };
    case "query_reorder":
      return { columns: [{ key: "producto", label: "Producto" }, { key: "local", label: "Local" }, { key: "stock", label: "Quedan", align: "right" }, { key: "sugerido", label: "Pedir", align: "right" }] };
    case "query_orders":
      return {
        columns: [{ key: "proveedor", label: "Proveedor" }, { key: "local", label: "Local" }, { key: "estado", label: "Estado" }, { key: "entrega", label: "Entrega" }, { key: "importe", label: "Importe", align: "right" }],
        flag: (r) => r.retraso === true,
      };
    case "query_product":
      return {
        columns: [{ key: "local", label: "Local" }, { key: "cantidad", label: "Stock", align: "right" }, { key: "minimo", label: "Mínimo", align: "right" }],
        flag: (r) => r.bajo_minimo === true,
      };
    case "query_spend":
      return { columns: [{ key: "proveedor", label: "Proveedor" }, { key: "importe", label: "Importe", align: "right" }, { key: "porcentaje", label: "%", align: "right" }] };
    case "query_top_usage":
      return {
        columns: [
          { key: "posicion", label: "#", align: "right" },
          { key: "producto", label: "Producto" },
          { key: "cantidad", label: "Consumo", align: "right" },
          { key: "valor", label: "Valor", align: "right" },
          { key: "porcentaje", label: "%", align: "right" },
          { key: "desglose", label: "Por local" },
        ],
      };
  }
}

/** Consultas cuyo texto ordena por la valoración de Jev (urgencia, subidas): ahí manda el texto. */
const EVALUATED = new Set<ToolResult["tool"]>(["query_reorder", "query_prices", "query_count_variance"]);

/** null si no hay nada que tabular (una fila o ninguna) o si el texto va por urgencia valorada. */
export function tableFor(result: ToolResult, evaluated = false): TableEvent | null {
  if (result.rows.length < 2 || (evaluated && EVALUATED.has(result.tool))) return null;
  const { columns, flag } = columnsFor(result);
  const present = columns.filter((c) => result.rows.some((r) => text(r[c.key]) !== ""));
  const flagged = flag ? result.rows.flatMap((r, i) => (flag(r) ? [i] : [])) : [];
  return {
    columns: present,
    rows: result.rows.map((r) => Object.fromEntries(present.map((c) => [c.key, text(r[c.key])]))),
    ...(flagged.length > 0 ? { flagged } : {}),
    ...(result.truncated ? { more: result.count - result.rows.length } : {}),
  };
}
