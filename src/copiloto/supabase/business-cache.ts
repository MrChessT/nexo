// Caché del negocio entre mensajes: las lecturas pesadas e históricas (movimientos, precios,
// inventarios cerrados, compras) se reutilizan durante un minuto. Lo que cambia al momento y
// define la respuesta (stock, pedidos y traspasos abiertos, inventario en curso) NO se cachea.
//
// La clave incluye al usuario (RLS decide lo que ve cada uno) y una «versión» de la organización
// que sube con cada escritura confirmada desde el asistente: tras confirmar, nada viejo se reutiliza.
import { LruCache } from "../cache/lru";
import type { InventoryDataSource } from "../tools/types";

const TTL_MS = 60 * 1000;
const shared = new LruCache<Promise<unknown>>(2000, TTL_MS);
const versions = new Map<string, number>();

/** Llamar tras cualquier escritura de la organización (confirmar un borrador). */
export function invalidateBusinessCache(orgId: string): void {
  versions.set(orgId, (versions.get(orgId) ?? 0) + 1);
}

export function cachedSource(source: InventoryDataSource, scope: { orgId: string; userId: string }, cache: LruCache<Promise<unknown>> = shared): InventoryDataSource {
  const cached =
    <A extends unknown[], R>(name: string, fn: (...args: A) => Promise<R>) =>
    (...args: A): Promise<R> => {
      const key = `${scope.orgId}:${versions.get(scope.orgId) ?? 0}:${scope.userId}:${name}:${JSON.stringify(args)}`;
      const hit = cache.get(key) as Promise<R> | undefined;
      if (hit) return hit;
      const pending = fn.apply(source, args);
      cache.set(key, pending);
      // Un error no se queda en caché.
      pending.catch(() => cache.delete(key));
      return pending;
    };
  return {
    // Históricos: se cachean.
    movements: cached("movements", source.movements),
    prices: cached("prices", source.prices),
    countResults: cached("countResults", source.countResults),
    purchases: cached("purchases", source.purchases),
    // Estado actual: siempre fresco.
    balances: (...a) => source.balances(...a),
    areaBalances: (...a) => source.areaBalances(...a),
    locationProducts: (...a) => source.locationProducts(...a),
    openCount: (...a) => source.openCount(...a),
    supplierPrices: (...a) => source.supplierPrices(...a),
    transfers: (...a) => source.transfers(...a),
    openOrders: (...a) => source.openOrders(...a),
    orders: (...a) => source.orders(...a),
  };
}
