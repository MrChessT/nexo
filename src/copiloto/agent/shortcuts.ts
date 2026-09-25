// Atajos deterministas: se resuelven sin Jev. Formato "/comando [texto]".
import type { AppRoute } from "../contract/index";
import type { Product, SessionContext } from "../domain";
import type { Retriever } from "../entities/retriever";
import type { ToolName } from "../tools/tools";
import type { ClarifyPlan, Plan, QueryPlan } from "./interpret";

const ROUTES: Record<string, AppRoute> = {
  inicio: "/",
  dashboard: "/",
  productos: "/productos",
  stock: "/stock",
  recepciones: "/recepciones",
  traspasos: "/traspasos",
  inventarios: "/inventarios",
  mermas: "/mermas",
  informes: "/informes",
  graficas: "/informes",
  analisis: "/informes",
};

const TOOLS: Record<string, ToolName> = {
  stock: "query_stock",
  // Como /stock, pero sin texto consulta en vez de navegar (lo usa el menú de funciones del panel).
  existencias: "query_stock",
  movimientos: "query_movements",
  precios: "query_prices",
  pendientes: "query_pending_transfers",
  desvios: "query_count_variance",
  reponer: "query_reorder",
  falta: "query_reorder",
  pedidos: "query_orders",
  gasto: "query_spend",
  ficha: "query_product",
  consumo: "query_top_usage",
};

export const SHORTCUT_HELP = Object.keys(TOOLS).map((k) => `/${k}`).concat(Object.keys(ROUTES).map((k) => `/${k}`));

/** Puntuación mínima y ventaja sobre el segundo candidato para aceptar un producto sin preguntar. */
const MIN_SCORE = 0.8;
const MIN_LEAD = 1.3;

export function isShortcut(message: string): boolean {
  return /^\/[a-záéíóúñ]+/i.test(message.trim());
}

export async function resolveShortcut(
  message: string,
  ctx: SessionContext,
  retriever: Retriever,
  pageLocationId?: string,
  /** Producto ya elegido por el usuario en una aclaración. */
  forcedProduct?: Product,
): Promise<Plan | null> {
  const match = /^\/([a-záéíóúñ]+)\s*(.*)$/i.exec(message.trim());
  if (!match) return null;
  const command = match[1]!.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const arg = match[2]!.trim();

  if (command === "ayuda") return { type: "conversar" };
  const tool = TOOLS[command];
  // "/stock" sin texto navega; "/stock agua" consulta.
  if (!tool || (ROUTES[command] && !arg)) {
    const route = ROUTES[command];
    return route ? { type: "navegar", route, filters: pageLocationId ? { locationId: pageLocationId } : {}, auto: true } : null;
  }

  const plan: QueryPlan = {
    type: "consultar",
    tool,
    locationIds: pageLocationId ? [pageLocationId] : ctx.locations.map((l) => l.id),
    locationsDefaulted: !pageLocationId,
    areaId: null,
    products: [],
    periodo: "no_indicado",
  };
  if (!arg) return plan;

  // Un local nombrado en el argumento filtra por local: "/stock vivero".
  const words = arg.toLowerCase();
  const location = ctx.locations.find((l) => words.includes(l.name.toLowerCase()));
  const productQuery = location ? arg.replace(new RegExp(location.name, "i"), "").trim() : arg;
  if (location) {
    plan.locationIds = [location.id];
    plan.locationsDefaulted = false;
  }
  if (!productQuery) return plan;
  if (forcedProduct) {
    plan.products = [{ product: forcedProduct, segmentIndex: 0, amount: null, unit: null, price: null, quantityOutcome: null }];
    return plan;
  }

  const found = await retriever.retrieve(ctx.products, productQuery, 3, ctx.catalogHash);
  const [first, second] = found;
  if (!first || first.score < MIN_SCORE) return plan;
  if (second && first.score < second.score * MIN_LEAD) {
    const clarify: ClarifyPlan = {
      type: "clarify",
      field: "producto",
      question: `¿A qué producto te refieres con «${productQuery}»?`,
      options: found.map((c) => ({ id: c.product.name, label: c.product.name, probability: null })),
      segmentIndex: 0,
    };
    return clarify;
  }
  plan.products = [{ product: first.product, segmentIndex: 0, amount: null, unit: null, price: null, quantityOutcome: null }];
  return plan;
}
