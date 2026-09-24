import { createHash } from "node:crypto";
import { ROLES, type Role } from "../contract/index";
import { baseUnitOf, type Dimension, type SessionContext } from "../domain";
import { AuthError, type AuthUser, type ContextPort } from "../security/auth";
import { DataError, userClient, type SupabaseSettings } from "./client";

interface ProductRow {
  id: string;
  name: string;
  dimension: Dimension;
  category: { name: string } | null;
  packs: Array<{ id: string; name: string; qty_base: string; is_count_default: boolean; is_purchase_default: boolean; active: boolean }>;
}

function fail(what: string, error: unknown): never {
  throw new DataError(`No se pudo leer ${what}`, { cause: error });
}

/** Contexto del usuario leído con su JWT: rol, locales accesibles (RLS), espacios y catálogo. */
export class SupabaseContext implements ContextPort {
  constructor(private readonly settings: SupabaseSettings) {}

  async load(user: AuthUser, orgId: string): Promise<SessionContext> {
    const db = userClient(this.settings, user.token);

    // Todo en una sola ronda. RLS limita cada tabla igual que antes; la pertenencia se comprueba la
    // primera, así un usuario ajeno recibe "forbidden" aunque el resto de consultas hayan fallado.
    // Los espacios se filtran por el join con sus locales (activos, de la organización) en lugar de
    // esperar a tener la lista de locales: mismo resultado, una petición menos en serie.
    const [membership, locations, products, areas, suppliers, categories, archived] = await Promise.all([
      db.from("memberships").select("role").eq("org_id", orgId).eq("user_id", user.userId).maybeSingle(),
      db.from("locations").select("id,name,timezone,day_cutoff").eq("org_id", orgId).eq("active", true).order("name"),
      db
        .from("products")
        .select("id,name,dimension,category:categories(name),packs:product_packs(id,name,qty_base:qty_base::text,is_count_default,is_purchase_default,active)")
        .eq("org_id", orgId)
        .eq("active", true)
        .order("name"),
      db
        .from("storage_areas")
        .select("id,location_id,name,location:locations!inner(org_id,active)")
        .eq("location.org_id", orgId)
        .eq("location.active", true)
        .order("sort_order"),
      db.from("suppliers").select("id,name").eq("org_id", orgId).eq("active", true).order("name"),
      db.from("categories").select("id,name").eq("org_id", orgId).order("name"),
      db.from("products").select("id,name").eq("org_id", orgId).eq("active", false).order("name").limit(2000),
    ]);
    if (membership.error) fail("la pertenencia", membership.error);
    const role = membership.data?.role as Role | undefined;
    if (!role || !ROLES.includes(role)) throw new AuthError("forbidden", "No perteneces a esta organización");
    if (locations.error) fail("los locales", locations.error);
    if (products.error) fail("el catálogo", products.error);
    if (areas.error) fail("los espacios", areas.error);
    // Proveedores, categorías y archivados solo alimentan las acciones de catálogo: si fallan, el resto sigue.
    const refs = (result: { data: unknown; error: unknown }) =>
      result.error ? [] : ((result.data ?? []) as Array<{ id: string; name: string }>).map((r) => ({ id: String(r.id), name: String(r.name) }));

    const productRows = (products.data ?? []) as unknown as ProductRow[];
    const catalogHash = createHash("sha256")
      .update(JSON.stringify(productRows.map((p) => [p.id, p.name, p.category?.name ?? null, p.packs.map((k) => [k.id, k.name, k.qty_base])])))
      .digest("hex")
      .slice(0, 16);

    return {
      userId: user.userId,
      orgId,
      role,
      locations: (locations.data ?? []).map((l) => ({
        id: l.id as string,
        name: l.name as string,
        timezone: (l.timezone as string) ?? "Europe/Madrid",
        dayCutoff: ((l.day_cutoff as string) ?? "06:00").slice(0, 5),
      })),
      areas: (areas.data ?? []).map((a) => ({ id: a.id as string, locationId: a.location_id as string, name: a.name as string })),
      products: productRows.map((p) => ({
        id: p.id,
        name: p.name,
        dimension: p.dimension,
        baseUnit: baseUnitOf(p.dimension),
        category: p.category?.name ?? null,
        packs: p.packs
          .filter((k) => k.active)
          .map((k) => ({ id: k.id, name: k.name, qtyBase: String(k.qty_base), isCountDefault: k.is_count_default, isPurchaseDefault: k.is_purchase_default })),
      })),
      suppliers: refs(suppliers),
      categories: refs(categories),
      archivedProducts: refs(archived),
      catalogHash,
    };
  }
}
