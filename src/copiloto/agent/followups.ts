// Botones de seguimiento tras una consulta: «Precios», «Consumo del mes», «Ficha», «Qué reponer»,
// «Preparar pedido». Cada uno guarda en la sesión la consulta ya resuelta (mismos productos y locales):
// al pulsarlo se ejecuta sin volver a llamar a Jev (respuesta inmediata y sin dudas que resolver).
import type { ToolName } from "../tools/tools";
import type { CatalogPlan, QueryPlan } from "./interpret";

export interface FollowUp {
  id: string;
  label: string;
  plan: QueryPlan | CatalogPlan;
}

/** Como mucho estos productos se arrastran a la siguiente consulta (la familia «ron» puede ser larga). */
const MAX_PRODUCTS = 12;

export function followUpsFor(plan: QueryPlan, hasLowStock: boolean): Array<Omit<FollowUp, "id">> {
  const products = plan.products.slice(0, MAX_PRODUCTS).map((p) => ({ ...p, segmentIndex: 0, amount: null, unit: null, price: null, quantityOutcome: null }));
  const query = (tool: ToolName, label: string, periodo: QueryPlan["periodo"] = "no_indicado"): Omit<FollowUp, "id"> => ({
    label,
    plan: { type: "consultar", tool, locationIds: plan.locationIds, locationsDefaulted: plan.locationsDefaulted, areaId: null, products, periodo },
  });
  const order = (): Array<Omit<FollowUp, "id">> =>
    plan.locationIds.length === 1
      ? [{ label: "Preparar pedido", plan: { type: "catalogo", accion: "preparar_pedido", locationId: plan.locationIds[0]!, locationOutcome: "actuar", products, periodo: plan.periodo } }]
      : [];
  const one = products.length === 1;
  const some = products.length > 0;
  const out: Array<Omit<FollowUp, "id">> = [];
  switch (plan.tool) {
    case "query_stock":
      if (some) out.push(query("query_prices", "Precios"), query("query_movements", "Consumo del mes", "mes"));
      if (one) out.push(query("query_product", "Ficha"));
      if (hasLowStock || !some) out.push(query("query_reorder", "Qué reponer"));
      break;
    case "query_movements":
      if (some) out.push(query("query_stock", "Stock actual"), query("query_prices", "Precios"));
      break;
    case "query_prices":
      if (some) out.push(query("query_stock", "Stock actual"), query("query_movements", "Consumo del mes", "mes"));
      break;
    case "query_product":
      out.push(query("query_movements", "Consumo del mes", "mes"), query("query_prices", "Evolución del precio"));
      break;
    case "query_reorder":
      out.push(...order());
      break;
    case "query_orders":
    case "query_pending_transfers":
      out.push(query("query_reorder", "Qué reponer"));
      break;
    case "query_count_variance":
    case "query_spend":
      break;
  }
  return out.slice(0, 4);
}
