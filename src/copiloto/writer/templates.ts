// Plantillas deterministas: se usan si no hay LLM, si falla o si el verificador rechaza su texto.
// Solo usan cifras que ya están en el informe.
import type { DecisionReport, Evaluation, Scope } from "../agent/report";
import type { ToolRow } from "../tools/types";

function scopeText(scope: Scope): string {
  const parts: string[] = [];
  // Con muchos productos («ron» → 7 rones) se dice cuántos; los nombres ya van en la lista.
  if (scope.productos.length > 3) parts.push(`de ${scope.productos.length} productos`);
  else if (scope.productos.length > 0) parts.push(`de ${scope.productos.join(", ")}`);
  if (scope.espacio) parts.push(`en ${scope.espacio}`);
  else if (scope.locales.length === 1) parts.push(`en ${scope.locales[0]}`);
  else if (scope.locales.length > 1) parts.push(`en tus ${scope.locales.length} locales`);
  if (scope.periodo) parts.push(`(${scope.periodo})`);
  return parts.join(" ");
}

function list(rows: ToolRow[], render: (row: ToolRow) => string, max = 5): string {
  return rows.slice(0, max).map((row) => `• ${render(row)}`).join("\n");
}

/** Orden de los tipos de movimiento en el resumen: primero lo que más se mira. */
const MOVEMENT_ORDER = ["consumo", "compra", "merma", "traspaso enviado", "traspaso recibido", "ajuste de inventario", "ajuste manual", "apertura"];
const MOVEMENT_PLURAL: Record<string, string> = { compra: "compras", merma: "mermas", "traspaso enviado": "traspasos enviados", "traspaso recibido": "traspasos recibidos", "ajuste de inventario": "ajustes de inventario", "ajuste manual": "ajustes manuales" };
const movementRank = (tipo: string) => (MOVEMENT_ORDER.includes(tipo) ? MOVEMENT_ORDER.indexOf(tipo) : MOVEMENT_ORDER.length);
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
      if (o.charla === "gracias") return "¡De nada!";
      if (o.charla === "adios") return "¡Hasta luego!";
      if (o.charla === "hola") return "¡Hola! ¿Qué necesitas?";
      return "Consulto stock, precios, consumo, pedidos y gasto, y te preparo mermas, traspasos, recepciones y pedidos para que los confirmes. Prueba: «¿cuánta coca queda en el Vivero?» o «pasa 2 cajas de tónica del Parador a Pickels».";
    case "navegacion":
      return o.navigate.auto ? `Te llevo a ${o.destino}.` : `¿Quieres ir a ${o.destino}?`;
    case "borrador": {
      const review = o.draft.checks?.filter((c) => c.status === "revisar") ?? [];
      if (review.length > 0) {
        return `He preparado un borrador. Antes de confirmarlo revisa ${review.length === 1 ? "este aviso" : "estos avisos"}: ${review.map((c) => c.detail).join(" ")}`;
      }
      // El título ya va en la tarjeta del borrador: el texto no lo repite.
      return "Revísalo y confírmalo si está bien.";
    }
    case "error":
      return o.message;
    case "resuelto":
      return o.message;
    case "consulta":
      return renderQuery(o);
  }
}

/** Los avisos («Sigo con…», «No has indicado local…») van delante: explican lo que viene después. */
function renderQuery(o: Extract<DecisionReport["outcome"], { kind: "consulta" }>): string {
  // Con tabla, el texto es solo el titular: la lista va en la tabla.
  const full = renderQueryBody(o);
  const body = o.tabulated ? full.split("\n").filter((line) => !line.startsWith("• ") && !line.startsWith("…y ")).join("\n") : full;
  return o.notices.length > 0 ? `${o.notices.join(" ")}\n${body}` : body;
}

function renderQueryBody(o: Extract<DecisionReport["outcome"], { kind: "consulta" }>): string {
  const { result, scope, evaluations } = o;
  const where = scopeText(scope);
  if (result.count === 0) {
    const empty: Record<typeof result.tool, string> = {
      query_stock: `No hay stock registrado ${where}.`,
      query_movements: `No hay movimientos ${where}.`,
      // El precio no depende del local: «No tengo precio de compra de Beefeater.»
      query_prices: scope.productos.length > 0 ? `No tengo precio de compra de ${scope.productos.join(", ")}.` : `No hay precios registrados ${where}.`,
      query_pending_transfers: `No hay traspasos pendientes de recibir ${where}.`,
      query_count_variance: `No hay desvíos de inventario ${where}.`,
      query_reorder: `No falta nada ${where} para ${result.totals.horizonte ?? "los próximos días"}.`,
      query_orders: `No hay pedidos abiertos ${where}.`,
      query_spend: `No hay compras registradas ${where}.`,
      query_product: result.totals.producto
        ? `${result.totals.producto} · ${result.totals.categoria}\nFormatos: ${result.totals.formatos}\nCompra: ${result.totals.compra}\nNo está activo en ningún local.`
        : "No encuentro ese producto en el catálogo.",
    };
    return `${empty[result.tool].replace(/\s+\./, ".")}`;
  }
  const more = result.truncated ? `\n…y ${result.count - result.rows.length} más.` : "";
  switch (result.tool) {
    case "query_stock": {
      if (result.totals.desglose === "espacio") return renderByArea(result.rows, result.totals, where, o.dato === "valor");
      // Euros solo si se pregunta por el valor: a «¿cuántas quedan?» se contesta con la cantidad.
      const money = o.dato === "valor";
      const low = result.totals.bajo_minimo !== "0" ? ` ${plural(result.totals.bajo_minimo ?? "0", "bajo mínimo", "bajo mínimo")}.` : "";
      if (result.totals.desglose === "local") {
        if (result.count === 1) {
          const r = result.rows[0]!;
          return `Stock ${where}: ${r.cantidad}${money ? ` (${r.valor})` : ""}.\n${r.desglose}${r.bajo_minimo ? "\n⚠ Bajo mínimo en algún local." : ""}`;
        }
        return `Stock ${where}${money ? `: valor total ${result.totals.valor_total}` : ""}.${low}\n${list(result.rows, (r) => `${r.producto}: ${r.cantidad} — ${r.desglose}`, 8)}${more}`;
      }
      const head =
        result.count === 1
          ? `Stock ${where}: ${result.rows[0]!.cantidad}${money ? ` (${result.rows[0]!.valor})` : ""}.`
          : `Stock ${where}${money ? `: valor total ${result.totals.valor_total}` : ""}.${low}`;
      if (result.count === 1) return `${head}${result.rows[0]!.bajo_minimo ? ` Bajo mínimo (${result.rows[0]!.minimo}).` : ""}`;
      return `${head}\n${list(result.rows, (r) => `${r.producto} (${r.local}${r.espacio ? ` · ${r.espacio}` : ""}): ${r.cantidad}${r.bajo_minimo ? " ⚠ bajo mínimo" : ""}`)}${more}`;
    }
    case "query_movements": {
      // Lo que importa arriba es el dinero por tipo (consumo, compras, mermas…), no cuántos registros hay.
      const byType = Object.entries(result.totals)
        .filter(([k]) => k.startsWith("valor_"))
        .map(([k, v]) => ({ tipo: k.slice(6).replace(/_/g, " "), valor: v }))
        .sort((a, b) => movementRank(a.tipo) - movementRank(b.tipo));
      const head = byType.length > 0 ? `${byType.map((t) => `${MOVEMENT_PLURAL[t.tipo] ?? t.tipo} ${t.valor}`).join(" · ")}.` : `${result.totals.movimientos} registros.`;
      return `Movimientos ${where}: ${head[0]!.toUpperCase()}${head.slice(1)}\n${list(result.rows, (r) => `${r.tipo} · ${r.producto}: ${r.cantidad} (${r.valor})`)}${more}`;
    }
    case "query_prices": {
      // Precio de productos concretos («¿a cuánto nos sale el Beefeater?»): el último, línea a línea.
      if (scope.productos.length > 0 && (o.dato === "precio" || result.count <= 3)) {
        return list(result.rows, (r) => `${r.producto} · ${r.formato}: ${r.precio_actual} (${r.proveedor}, ${r.fecha})${r.variacion ? `, antes ${r.precio_anterior}` : ""}`, 8).replace(/^• /, result.count === 1 ? "" : "• ");
      }
      const rises = urgent(evaluations);
      const head = `Precios desde el ${result.totals.desde}: ${result.totals.subidas} subidas.`;
      const body = rises.length > 0
        ? list(rises.map((e) => e.data), (d) => `${d.product}: ${d.old_price} → ${d.new_price} (${d.change_pct})`)
        : list(result.rows, (r) => `${r.producto} (${r.formato}, ${r.proveedor}): ${r.precio_actual}`);
      return `${head}\n${body}`;
    }
    case "query_pending_transfers":
      return `${result.totals.traspasos === "1" ? "Hay 1 traspaso" : `Hay ${result.totals.traspasos} traspasos`} sin recibir (${result.totals.valor_en_transito} en tránsito).\n${list(result.rows, (r) => `${r.origen} → ${r.destino}, enviado hace ${r.enviado_hace}: ${r.productos}`)}${more}`;
    case "query_count_variance": {
      const relevant = urgent(evaluations);
      const rows = relevant.length > 0 ? relevant.map((e) => e.data) : [];
      const head = `Desvíos de inventario desde el ${result.totals.desde}: ${plural(result.totals.desvios ?? "0", "producto", "productos")}, valor neto ${result.totals.valor_neto}.`;
      const body = rows.length > 0
        ? list(rows, (d) => `${d.product} (${d.venue}): ${d.diff}, ${d.diff_value} — urgencia ${URGENCY_TEXT[relevant.find((e) => e.data === d)!.urgency]}`)
        : list(result.rows, (r) => `${r.producto} (${r.local}): ${r.diferencia}, ${r.valor}`);
      return `${head}\n${body}`;
    }
    case "query_orders": {
      const t = result.totals;
      const head = `${plural(t.pendientes ?? "0", "pedido pendiente", "pedidos pendientes")} de recibir (${t.valor_pendiente})${t.retrasados !== "0" ? `, ${t.retrasados} con retraso` : ""}${t.borradores !== "0" ? ` y ${plural(t.borradores ?? "0", "borrador sin enviar", "borradores sin enviar")}` : ""}.`;
      return `${head}\n${list(result.rows, (r) => `${r.proveedor} → ${r.local}: ${r.estado}${r.retraso ? " ⚠ con retraso" : ""}, entrega ${r.entrega}, ${r.importe}`)}${more}`;
    }
    case "query_product": {
      const t = result.totals;
      if (o.dato === "proveedor") return `${t.producto}: se compra a ${t.proveedores}.`;
      if (o.dato === "formatos") return `${t.producto}: ${t.formatos}.`;
      if (o.dato === "precio") return `${t.producto}: ${t.compra}.`;
      if (o.dato === "minimo") return `Mínimos de ${t.producto}:\n${list(result.rows, (r) => `${r.local}: ${r.minimo ?? "sin mínimo"} (hay ${r.cantidad})`, 8)}`;
      const places = list(result.rows, (r) => `${r.local}: ${r.cantidad}${r.minimo ? ` (mínimo ${r.minimo})` : ""}${r.bajo_minimo ? " ⚠ bajo mínimo" : ""}`, 8);
      // Ficha en líneas cortas: se lee de un vistazo.
      return `${t.producto} · ${t.categoria}\nFormatos: ${t.formatos}\nCompra: ${t.compra}\nStock total: ${t.total}\n${places}`;
    }
    case "query_spend":
      return `Compras del ${result.totals.desde} al ${result.totals.hasta}: ${result.totals.total} en ${plural(result.totals.albaranes ?? "0", "albarán", "albaranes")}.\n${list(result.rows, (r) => `${r.proveedor}: ${r.importe} (${r.porcentaje})`)}${more}`;
    case "query_reorder": {
      if (evaluations.length === 0) {
        return `Para ${result.totals.horizonte} conviene reponer ${plural(result.totals.productos ?? "0", "producto", "productos")}:\n${list(
          result.rows,
          (r) => `${r.producto} (${r.local}): quedan ${r.stock}, pedir ${r.sugerido}`,
        )}${more}`;
      }
      const relevant = urgent(evaluations);
      const rows = relevant.length > 0 ? relevant.map((e) => ({ d: e.data, u: e.urgency })) : evaluations.map((e) => ({ d: e.data, u: e.urgency }));
      return `Para ${result.totals.horizonte} conviene reponer ${plural(String(rows.length), "producto", "productos")}:\n${list(
        rows.map((r) => ({ ...r.d, urgencia: URGENCY_TEXT[r.u] })),
        (d) => `${d.product} (${d.venue}): quedan ${d.stock}, pedir ${d.suggested} — urgencia ${d.urgencia}`,
      )}`;
    }
  }
}

/** «¿Qué hay en cada sección?»: un bloque por espacio con sus productos. */
function renderByArea(rows: ToolRow[], totals: Record<string, string>, where: string, money: boolean): string {
  const groups = new Map<string, ToolRow[]>();
  for (const r of rows) {
    const key = `${r.local} · ${r.espacio}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const blocks = [...groups.entries()].map(([area, items]) => {
    const total = Number(items[0]?.productos_espacio ?? items.length);
    const shown = items.map((r) => `${r.producto} ${r.cantidad}`).join(", ");
    return `• ${area} (${plural(String(total), "producto", "productos")}): ${shown}${total > items.length ? ` y ${total - items.length} más` : ""}`;
  });
  return `Stock por secciones ${where}: ${plural(totals.espacios ?? "0", "sección", "secciones")} con producto${money ? `, valor total ${totals.valor_total}` : ""}.\n${blocks.join("\n")}`;
}

function plural(count: string, one: string, many: string): string {
  return `${count} ${count === "1" ? one : many}`;
}
