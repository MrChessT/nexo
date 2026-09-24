// Vía rápida sin Jev para la pregunta más frecuente: «¿cuánto X queda (en Y)?», «stock de X».
// Solo si el mensaje no dice NADA más que el producto, el local y palabras de stock: cualquier otra
// palabra («gastado», «pedido», «precio», «roto»…), una cifra (podría ser un recuento) o un espacio lo
// deja en manos de Jev. Es solo lectura: nunca escribe nada.
import type { SessionContext } from "../domain";
import { tokenize } from "../entities/normalize";
import { parseQuantities } from "../entities/quantity-parser";
import type { Retriever } from "../entities/retriever";
import { mentionsArea } from "./routing";
import type { QueryPlan } from "./interpret";

/** Palabras que caben en una pregunta de stock pura. */
const STOCK_WORDS = new Set([
  "cuanto", "cuanta", "cuantos", "cuantas", "queda", "quedan", "hay", "tenemos", "tengo", "teneis", "stock", "existencias",
  "de", "del", "en", "el", "la", "los", "las", "que", "me", "nos", "y", "a", "al", "botella", "botellas", "caja", "cajas",
  "unidad", "unidades", "lata", "latas", "bolsa", "bolsas", "barril", "barriles", "ahora", "mismo", "actualmente", "todavia",
  "aun", "dime", "mira",
]);

/** El producto debe destacar tanto como en los atajos («/stock agua»). */
const MIN_SCORE = 0.8;
const MIN_LEAD = 1.3;
/** Un tipo genérico («ginebra») trae la familia: todos los que empatan con el mejor. */
const MAX_FAMILY = 12;

export async function fastStockPlan(message: string, ctx: SessionContext, retriever: Retriever): Promise<QueryPlan | null> {
  if (parseQuantities(message).length > 0 || /\d/.test(message) || mentionsArea(message, ctx)) return null;
  const words = tokenize(message);
  const locationWords = new Map<string, string>();
  for (const l of ctx.locations) for (const w of tokenize(l.name)) if (w.length >= 3) locationWords.set(w, l.id);
  const named = new Set(words.filter((w) => locationWords.has(w)).map((w) => locationWords.get(w)!));
  const rest = words.filter((w) => !STOCK_WORDS.has(w) && !locationWords.has(w));
  // Hace falta alguna palabra de stock: «beefeater» a secas puede ser otra cosa.
  if (rest.length === 0 || !words.some((w) => ["cuanto", "cuanta", "cuantos", "cuantas", "queda", "quedan", "hay", "stock", "existencias"].includes(w))) return null;

  const found = await retriever.retrieve(ctx.products, rest.join(" "), MAX_FAMILY + 1, ctx.catalogHash);
  const [first, second] = found;
  // Todas las palabras que quedan tienen que ser del producto (si no, hay algo más en el mensaje).
  if (!first || first.score < Math.max(MIN_SCORE, rest.length * 0.8)) return null;
  const family = second && first.score < second.score * MIN_LEAD ? found.filter((c) => c.score >= first.score - 1e-9) : [first];
  if (family.length > MAX_FAMILY || (second && family.length === 1 && first.score < second.score * MIN_LEAD)) return null;

  const all = ctx.locations.map((l) => l.id);
  return {
    type: "consultar",
    tool: "query_stock",
    locationIds: named.size > 0 ? [...named] : all,
    locationsDefaulted: named.size === 0,
    areaId: null,
    products: family.map((c) => ({ product: c.product, segmentIndex: 0, amount: null, unit: null, price: null, quantityOutcome: null })),
    periodo: "no_indicado",
  };
}
