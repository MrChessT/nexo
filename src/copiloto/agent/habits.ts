// Memoria del negocio por usuario: qué locales y productos usa más. Solo contadores.
// Se usa con prudencia: el local habitual y los productos frecuentes solo ordenan las opciones de
// una aclaración (el habitual va primero); nunca deciden por el usuario.
import { LruCache } from "../cache/lru";

export interface Habits {
  locations: Record<string, number>;
  products: Record<string, number>;
}

export interface HabitsPersistence {
  load(orgId: string, userId: string): Promise<Habits | null>;
  save(orgId: string, userId: string, habits: Habits): Promise<void>;
}

/** Productos que se recuerdan como mucho (los más usados). */
const MAX_PRODUCTS = 50;
/** Para proponer un local habitual: al menos estos usos y esta proporción del total. */
const MIN_USES = 5;
const MIN_SHARE = 0.7;

export const emptyHabits = (): Habits => ({ locations: {}, products: {} });

/** Local que el usuario usa casi siempre (entre los que hoy puede ver), o nada. */
export function preferredLocation(habits: Habits | undefined, validIds: string[]): string | undefined {
  if (!habits) return undefined;
  const entries = Object.entries(habits.locations).filter(([id]) => validIds.includes(id));
  const total = entries.reduce((n, [, c]) => n + c, 0);
  const [best] = entries.sort((a, b) => b[1] - a[1]);
  return best && best[1] >= MIN_USES && best[1] / total >= MIN_SHARE ? best[0] : undefined;
}

/** Suma un uso de estos locales y productos. Devuelve una copia (no muta la entrada). */
export function recordUse(habits: Habits, use: { locationIds: string[]; productIds: string[] }): Habits {
  const next: Habits = { locations: { ...habits.locations }, products: { ...habits.products } };
  for (const id of use.locationIds) next.locations[id] = (next.locations[id] ?? 0) + 1;
  for (const id of use.productIds) next.products[id] = (next.products[id] ?? 0) + 1;
  next.products = Object.fromEntries(Object.entries(next.products).sort((a, b) => b[1] - a[1]).slice(0, MAX_PRODUCTS));
  return next;
}

/** Caché compartida entre peticiones de la instancia; la copia buena está en Supabase. */
const shared = new LruCache<Habits>(5000, 30 * 60 * 1000);

export class HabitsStore {
  constructor(
    private readonly persistence?: HabitsPersistence,
    private readonly cache: LruCache<Habits> = shared,
  ) {}

  async get(orgId: string, userId: string): Promise<Habits> {
    const key = `${orgId}:${userId}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    const loaded = (await this.persistence?.load(orgId, userId).catch(() => null)) ?? emptyHabits();
    this.cache.set(key, loaded);
    return loaded;
  }

  async record(orgId: string, userId: string, use: { locationIds: string[]; productIds: string[] }): Promise<void> {
    if (use.locationIds.length === 0 && use.productIds.length === 0) return;
    const next = recordUse(await this.get(orgId, userId), use);
    this.cache.set(`${orgId}:${userId}`, next);
    await this.persistence?.save(orgId, userId, next);
  }
}
