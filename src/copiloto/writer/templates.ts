// Plantillas deterministas: se usan si no hay LLM, si falla o si el verificador rechaza su texto.
// Solo usan cifras que ya están en el informe.
import type { DecisionReport, Evaluation, Scope } from "../agent/report";
import type { ToolRow } from "../tools/types";

function scopeText(scope: Scope): string {
  const parts: string[] = [];
  if (scope.productos.length > 0) parts.push(scope.productos.join(", "));
  if (scope.espacio) parts.push(`en ${scope.espacio}`);
  else if (scope.locales.length === 1) parts.push(`en ${scope.locales[0]}`);
  else if (scope.locales.length > 1) parts.push(`en tus ${scope.locales.length} locales`);
  if (scope.periodo) parts.push(`(${scope.periodo})`);
  return parts.join(" ");
}

function list(rows: ToolRow[], render: (row: ToolRow) => string, max = 5): string {
  return rows.slice(0, max).map((row) => `• ${render(row)}`).join("\n");
}

const URGENCY_TEXT = { baja: "baja", media: "media", alta: "alta", critica: "crítica" } as const;

function urgent(evaluations: Evaluation[]): Evaluation[] {
  return evaluations.filter((e) => e.relevance >= 0.5).sort((a, b) => b.urgencyScore - a.urgencyScore);
}

export function renderTemplate(report: DecisionReport): string {
  const o = report.outcome;
  switch (o.kind) {
    case "aclaracion":
      return o.clarify.question;
    case "fuera_de_ambito":
      return "Solo puedo ayudarte con el inventario: stock, movimientos, precios, traspasos, inventarios, recepciones y mermas.";
    case "bloqueado":
      return "No puedo hacer eso. Pregúntame por el stock, los movimientos o las operaciones de tus locales.";
    case "conversacion":
      return "Puedo consultar stock, consumo, mermas, precios, pedidos pendientes, gasto por proveedor y desvíos de inventario, y preparar operaciones para que las confirmes: pedidos, mermas, traspasos, recepciones, precios, altas de producto, mínimos y archivar. Recuerdo de qué hablamos («¿y en el Vivero?») y puedes confirmar con un «sí, adelante». Antes de proponer un cambio compruebo duplicados y cifras raras. Prueba con «prepara el pedido de la semana para Parador» o «¿cuánto he gastado este mes?».";
    case "navegacion":
      return o.navigate.auto ? `Te llevo a ${o.destino}.` : `¿Quieres ir a ${o.destino}?`;
    case "borrador": {
      const review = o.draft.checks?.filter((c) => c.status === "revisar") ?? [];
      if (review.length > 0) {
        return `He preparado un borrador: ${o.draft.title}. Antes de confirmarlo revisa ${review.length === 1 ? "este aviso" : "estos avisos"}: ${review.map((c) => c.detail).join(" ")}`;
      }
      return `He preparado un borrador: ${o.draft.title}. Revísalo y confírmalo si es correcto.`;
    }
    case "error":
      return o.message;
    case "resuelto":
      return o.message;
    case "consulta":
      return renderQuery(o);
  }
}

function renderQuery(o: Extract<DecisionReport["outcome"], { kind: "consulta" }>): string {
  const { result, scope, evaluations, notices } = o;
  const where = scopeText(scope);
  const notice = notices.length > 0 ? `\n${notices.join(" ")}` : "";
  if (result.count === 0) {
    const empty: Record<typeof result.tool, string> = {
      query_stock: `No hay stock registrado ${where}.`,
      query_movements: `No hay movimientos ${where}.`,
      query_prices: `No hay precios registrados ${where}.`,
      query_pending_transfers: `No hay traspasos pendientes de recibir ${where}.`,
      query_count_variance: `No hay desvíos de inventario ${where}.`,
      query_reorder: `No falta nada ${where} para ${result.totals.horizonte ?? "los próximos días"}.`,
      query_orders: `No hay pedidos abiertos ${where}.`,
      query_spend: `No hay compras registradas ${where}.`,
    };
    return `${empty[result.tool].replace(/\s+\./, ".")}${notice}`;
  }
  const more = result.truncated ? `\n…y ${result.count - result.rows.length} más.` : "";
  switch (result.tool) {
    case "query_stock": {
      const head =
        result.count === 1
          ? `Stock ${where}: ${result.rows[0]!.cantidad} (${result.rows[0]!.valor}).`
          : `Stock ${where}: valor total ${result.totals.valor_total}. Bajo mínimo: ${result.totals.bajo_minimo}.`;
      if (result.count === 1) return `${head}${result.rows[0]!.bajo_minimo ? ` Está por debajo del mínimo (${result.rows[0]!.minimo}).` : ""}${notice}`;
      return `${head}\n${list(result.rows, (r) => `${r.producto} (${r.local}${r.espacio ? ` · ${r.espacio}` : ""}): ${r.cantidad}${r.bajo_minimo ? " ⚠ bajo mínimo" : ""}`)}${more}${notice}`;
    }
    case "query_movements":
      return `Movimientos ${where}: ${result.totals.movimientos} registros.\n${list(result.rows, (r) => `${r.tipo} · ${r.producto}: ${r.cantidad} (${r.valor})`)}${more}${notice}`;
    case "query_prices": {
      const rises = urgent(evaluations);
      const head = `Precios desde el ${result.totals.desde}: ${result.totals.subidas} subidas.`;
      const body = rises.length > 0
        ? list(rises.map((e) => e.data), (d) => `${d.product}: ${d.old_price} → ${d.new_price} (${d.change_pct})`)
        : list(result.rows, (r) => `${r.producto} (${r.formato}, ${r.proveedor}): ${r.precio_actual}`);
      return `${head}\n${body}${notice}`;
    }
    case "query_pending_transfers":
      return `${result.totals.traspasos === "1" ? "Hay 1 traspaso" : `Hay ${result.totals.traspasos} traspasos`} sin recibir (${result.totals.valor_en_transito} en tránsito).\n${list(result.rows, (r) => `${r.origen} → ${r.destino}, enviado hace ${r.enviado_hace}: ${r.productos}`)}${more}${notice}`;
    case "query_count_variance": {
      const relevant = urgent(evaluations);
      const rows = relevant.length > 0 ? relevant.map((e) => e.data) : [];
      const head = `Desvíos de inventario desde el ${result.totals.desde}: ${plural(result.totals.desvios ?? "0", "producto", "productos")}, valor neto ${result.totals.valor_neto}.`;
      const body = rows.length > 0
        ? list(rows, (d) => `${d.product} (${d.venue}): ${d.diff}, ${d.diff_value} — urgencia ${URGENCY_TEXT[relevant.find((e) => e.data === d)!.urgency]}`)
        : list(result.rows, (r) => `${r.producto} (${r.local}): ${r.diferencia}, ${r.valor}`);
      return `${head}\n${body}${notice}`;
    }
    case "query_orders": {
      const t = result.totals;
      const head = `${plural(t.pendientes ?? "0", "pedido pendiente", "pedidos pendientes")} de recibir (${t.valor_pendiente})${t.retrasados !== "0" ? `, ${t.retrasados} con retraso` : ""}${t.borradores !== "0" ? ` y ${plural(t.borradores ?? "0", "borrador sin enviar", "borradores sin enviar")}` : ""}.`;
      return `${head}\n${list(result.rows, (r) => `${r.proveedor} → ${r.local}: ${r.estado}${r.retraso ? " ⚠ con retraso" : ""}, entrega ${r.entrega}, ${r.importe}`)}${more}${notice}`;
    }
    case "query_spend":
      return `Compras del ${result.totals.desde} al ${result.totals.hasta}: ${result.totals.total} en ${plural(result.totals.albaranes ?? "0", "albarán", "albaranes")}.\n${list(result.rows, (r) => `${r.proveedor}: ${r.importe} (${r.porcentaje})`)}${more}${notice}`;
    case "query_reorder": {
      if (evaluations.length === 0) {
        return `Para ${result.totals.horizonte} conviene reponer ${plural(result.totals.productos ?? "0", "producto", "productos")}:\n${list(
          result.rows,
          (r) => `${r.producto} (${r.local}): quedan ${r.stock}, pedir ${r.sugerido}`,
        )}${more}${notice}`;
      }
      const relevant = urgent(evaluations);
      const rows = relevant.length > 0 ? relevant.map((e) => ({ d: e.data, u: e.urgency })) : evaluations.map((e) => ({ d: e.data, u: e.urgency }));
      return `Para ${result.totals.horizonte} conviene reponer ${plural(String(rows.length), "producto", "productos")}:\n${list(
        rows.map((r) => ({ ...r.d, urgencia: URGENCY_TEXT[r.u] })),
        (d) => `${d.product} (${d.venue}): quedan ${d.stock}, pedir ${d.suggested} — urgencia ${d.urgencia}`,
      )}${notice}`;
    }
  }
}

function plural(count: string, one: string, many: string): string {
  return `${count} ${count === "1" ? one : many}`;
}
