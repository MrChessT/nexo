import type { InventoryDataSource } from "../tools/types";

/**
 * Fuente de datos que reutiliza, dentro de UNA petición, las lecturas idénticas: una vista de
 * informes pedía el mismo stock hasta 4 veces (KPIs, bajo mínimo, gráficas). Comparte la promesa,
 * así que dos lecturas iguales lanzadas a la vez también van juntas. Solo lectura y de vida corta:
 * se crea por petición, nunca se comparte entre usuarios ni sobrevive a una escritura.
 */
export function memoizeSource(source: InventoryDataSource): InventoryDataSource {
  const cache = new Map<string, Promise<unknown>>();
  const memo =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const key = `${name}:${JSON.stringify(args)}`;
      let hit = cache.get(key) as Promise<R> | undefined;
      if (!hit) {
        hit = fn.apply(source, args);
        cache.set(key, hit);
        // Un fallo no se queda en caché: el siguiente intento vuelve a consultar.
        hit.catch(() => cache.delete(key));
      }
      return hit;
    };
  return {
    openCount: memo("openCount", source.openCount),
    supplierPrices: memo("supplierPrices", source.supplierPrices),
    balances: memo("balances", source.balances),
    areaBalances: memo("areaBalances", source.areaBalances),
    locationProducts: memo("locationProducts", source.locationProducts),
    movements: memo("movements", source.movements),
    prices: memo("prices", source.prices),
    transfers: memo("transfers", source.transfers),
    countResults: memo("countResults", source.countResults),
    openOrders: memo("openOrders", source.openOrders),
  };
}
