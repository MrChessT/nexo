// Catálogo real de Vivero 55 (supabase/seed/03_catalogo_vivero55.sql) como productos del dominio,
// con los mismos formatos que crea el seed. Solo para pruebas y evaluación: así el asistente se
// mide con los nombres de verdad («Beefeater», «Larios 12»…) y no solo con el catálogo de ejemplo.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pack, Product } from "../domain";

export interface ViveroRow {
  sku: string;
  name: string;
  category: string;
  sub: string;
  brand: string;
  fmt: string;
  ml: number | null;
  unit: string;
  packLabel: string;
  pack: number;
  /** Precio de compra por unidad de catálogo (botella, kg, ud), sin IVA. */
  cost: number;
  /** Nombre del proveedor. */
  supplier: string;
  /** Mínimo y objetivo en unidades de catálogo. */
  min: number;
  par: number;
  menu: string | null;
}

/** Valores SQL de una fila «('a','b',1,null)» → lista (comillas dobles '' ya resueltas). */
function sqlValues(row: string): Array<string | null> {
  const out: Array<string | null> = [];
  const re = /'((?:[^']|'')*)'|(null)|(-?\d+(?:\.\d+)?)/g;
  for (let m = re.exec(row); m; m = re.exec(row)) out.push(m[1] !== undefined ? m[1].replace(/''/g, "'") : m[2] ? null : m[3]!);
  return out;
}

export function viveroRows(root = process.cwd()): ViveroRow[] {
  const sql = readFileSync(join(root, "supabase/seed/03_catalogo_vivero55.sql"), "utf8");
  const categories = new Map<string, string>();
  const catBlock = /insert into tmp_cat values([\s\S]*?);/.exec(sql)?.[1] ?? "";
  for (const m of catBlock.matchAll(/\('([^']*)','((?:[^']|'')*)',\d+\)/g)) categories.set(m[1]!, m[2]!.replace(/''/g, "'"));
  const suppliers = new Map<string, string>();
  const supBlock = /insert into tmp_sup values([\s\S]*?);\n/.exec(sql)?.[1] ?? "";
  for (const line of supBlock.split("\n").filter((l) => l.trim().startsWith("("))) {
    const v = sqlValues(line);
    suppliers.set(v[0]!, v[1]!);
  }
  const prodBlock = /insert into tmp_prod values([\s\S]*?);\n/.exec(sql)?.[1] ?? "";
  return prodBlock
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.startsWith("("))
    .map((l) => {
      const v = sqlValues(l);
      return {
        sku: v[0]!,
        name: v[1]!,
        category: categories.get(v[2]!) ?? v[2]!,
        sub: v[3] ?? "",
        brand: v[4] ?? "",
        fmt: v[5] ?? "",
        ml: v[6] === null ? null : Number(v[6]),
        unit: v[7] ?? "",
        packLabel: v[8] ?? "",
        pack: Number(v[9] ?? 1),
        cost: Number(v[10] ?? 0),
        supplier: suppliers.get(v[12] ?? "") ?? v[12] ?? "proveedor",
        min: Number(v[13] ?? 0),
        par: Number(v[14] ?? 0),
        menu: v[16] ?? null,
      };
    });
}

/** Mismos formatos que el seed: el de conteo (botella, barril, kg) y el de compra (caja, bandeja…). */
export function viveroProducts(root = process.cwd()): Product[] {
  return viveroRows(root).map((r, n) => {
    const id = `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`;
    const dimension: Product["dimension"] = r.unit === "kg" ? "mass" : r.ml !== null && (r.unit === "botella" || r.unit === "barril") ? "volume" : "count";
    const factor = dimension === "mass" ? 1000 : dimension === "volume" ? r.ml! : 1;
    const packs: Pack[] = [];
    const pack = (name: string, qty: number, count: boolean, purchase: boolean) =>
      // Único por producto: nº de producto (8 cifras) + nº de formato (4). Antes se recortaba el id del
      // producto y todos los productos compartían los mismos ids de formato.
      packs.push({ id: `${id.slice(0, -12)}${String(n + 1).padStart(8, "0")}${String(packs.length + 1).padStart(4, "0")}`, name, qtyBase: String(qty), isCountDefault: count, isPurchaseDefault: purchase });
    if (dimension === "volume") pack(r.unit === "barril" ? r.fmt.split(" ·")[0]! : `Botella ${r.fmt.split(" ·")[0]}`, factor, true, r.pack === 1);
    else if (dimension === "mass") pack("Kg", 1000, true, r.pack === 1);
    if (r.pack > 1) pack(r.packLabel, r.pack * factor, false, true);
    else if (packs.length === 0) pack(r.fmt.split(" ")[0]!.replace(/^./, (c) => c.toUpperCase()), 1, false, true);
    return {
      id,
      name: r.name,
      dimension,
      baseUnit: dimension === "mass" ? "g" : dimension === "volume" ? "ml" : "ud",
      category: r.category,
      // Igual que las notas del seed: marca, tipo, formato y nombre en carta.
      notes: [r.brand, r.sub, r.fmt, r.menu ? `Carta: ${r.menu}` : ""].filter(Boolean).join(" · "),
      packs,
    };
  });
}
