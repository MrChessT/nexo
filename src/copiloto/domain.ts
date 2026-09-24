import type { BaseUnit, Role } from "./contract/index";

export type Dimension = "mass" | "volume" | "count";

export interface Location {
  id: string;
  name: string;
  timezone: string;
  dayCutoff: string;
}

export interface Area {
  id: string;
  locationId: string;
  name: string;
}

export interface Pack {
  id: string;
  name: string;
  qtyBase: string;
  isCountDefault: boolean;
  isPurchaseDefault: boolean;
}

export interface Product {
  id: string;
  name: string;
  dimension: Dimension;
  baseUnit: BaseUnit;
  category: string | null;
  /** Marca, tipo («Ginebra»), formato y nombre en carta: ayudan a encontrar el producto. */
  notes?: string | null;
  packs: Pack[];
}

/** Proveedor o categoría del catálogo (id + nombre). */
export interface NamedRef {
  id: string;
  name: string;
}

/** Contexto del usuario, cacheado por sesión. Todo lo que contiene ya ha pasado por RLS. */
export interface SessionContext {
  userId: string;
  orgId: string;
  role: Role;
  locations: Location[];
  areas: Area[];
  products: Product[];
  /** Proveedores activos y categorías: para precios y altas de producto desde el chat. */
  suppliers: NamedRef[];
  categories: NamedRef[];
  /** Productos archivados: solo nombre, para detectar duplicados al dar de alta. */
  archivedProducts: NamedRef[];
  /** Huella del catálogo para invalidar embeddings y cachés. */
  catalogHash: string;
}

export function baseUnitOf(dimension: Dimension): BaseUnit {
  return dimension === "mass" ? "g" : dimension === "volume" ? "ml" : "ud";
}

const ROLE_RANK: Record<Role, number> = { staff: 0, manager: 1, admin: 2, owner: 3 };

export function hasRole(role: Role, required: Role): boolean {
  return ROLE_RANK[role] >= ROLE_RANK[required];
}

export function areaLabel(area: Area, locations: Location[]): string {
  const location = locations.find((l) => l.id === area.locationId);
  return `${location?.name ?? "?"} · ${area.name}`;
}
