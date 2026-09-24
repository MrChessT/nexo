// Validación zod de borradores y de las ediciones que la app puede enviar al confirmar.
import Decimal from "decimal.js";
import { baseUnitOf } from "../domain";
import { formatDecimal } from "../entities/units";
import { z } from "zod";
import { DecimalString, ROLES, type Draft } from "../contract/index";
import type { SessionContext } from "../domain";

const positive = DecimalString.refine((v) => new Decimal(v).gt(0), "debe ser mayor que cero");
const nonNegative = DecimalString.refine((v) => new Decimal(v).gte(0), "no puede ser negativo");
const id = z.string().min(1);
const baseUnit = z.enum(["g", "ml", "ud"]);
const quantityInput = z.object({ amount: positive, unit: z.string().min(1), packId: id.optional() });

const base = z.object({
  draftId: z.uuid(),
  title: z.string().min(1).max(300),
  requiredRole: z.enum(ROLES),
  canConfirm: z.boolean(),
  coherence: z.number().min(0).max(1),
  warnings: z.array(z.string()),
  editable: z.array(z.string()),
  expiresAt: z.iso.datetime(),
  checks: z
    .array(
      z.object({
        id: z.string().min(1),
        label: z.string().min(1),
        status: z.enum(["ok", "aviso", "revisar"]),
        detail: z.string().min(1).max(400),
        probability: z.number().min(0).max(1).nullable(),
      }),
    )
    .max(12)
    .optional(),
  acknowledged: z.boolean().optional(),
});

export const WasteDraftSchema = base.extend({
  kind: z.literal("merma"),
  locationId: id,
  locationName: z.string(),
  areaId: id.nullable(),
  areaName: z.string().nullable(),
  productId: id,
  productName: z.string(),
  qtyBase: positive,
  baseUnit,
  input: quantityInput,
  reason: z.string().max(200).nullable(),
});

export const TransferDraftSchema = base
  .extend({
    kind: z.literal("traspaso"),
    fromLocationId: id,
    fromLocationName: z.string(),
    toLocationId: id,
    toLocationName: z.string(),
    lines: z.array(z.object({ productId: id, productName: z.string(), qtyBase: positive, baseUnit, input: quantityInput })).min(1).max(20),
    send: z.boolean(),
    note: z.string().max(300).nullable(),
  })
  .refine((d) => d.fromLocationId !== d.toLocationId, "origen y destino deben ser distintos");

export const ReceiptDraftSchema = base.extend({
  kind: z.literal("recepcion"),
  locationId: id,
  locationName: z.string(),
  supplierId: id.nullable(),
  supplierName: z.string().nullable(),
  docNumber: z.string().max(60).nullable(),
  docDate: z.iso.date(),
  lines: z
    .array(
      z.object({
        packId: id,
        packName: z.string(),
        productId: id,
        productName: z.string(),
        packsQty: positive,
        packPrice: nonNegative.nullable(),
        priceSource: z.enum(["ultimo_precio", "usuario"]).nullable(),
      }),
    )
    .min(1)
    .max(50),
});

export const CountCloseDraftSchema = base.extend({
  kind: z.literal("cierre_inventario"),
  countId: id,
  locationId: id,
  locationName: z.string(),
  zeroUncounted: z.boolean(),
  preview: z.object({
    countedProducts: z.number().int().min(0),
    adjustments: z.array(
      z.object({
        productId: id,
        productName: z.string(),
        expected: DecimalString,
        counted: DecimalString,
        diff: DecimalString,
        baseUnit,
        diffValue: DecimalString,
      }),
    ),
    totalDiffValue: DecimalString,
  }),
});

export const PriceDraftSchema = base.extend({
  kind: z.literal("precio"),
  productId: id,
  productName: z.string(),
  packId: id,
  packName: z.string(),
  packQtyBase: positive,
  baseUnit,
  supplierId: id,
  supplierName: z.string(),
  oldPrice: nonNegative.nullable(),
  newPrice: nonNegative,
  unitCost: z.string(),
});

const productName = z
  .string()
  .trim()
  .min(2, "el nombre es demasiado corto")
  .max(80, "el nombre es demasiado largo")
  .refine((v) => (v.match(/\p{L}/gu) ?? []).length >= 2, "el nombre debe tener letras");

export const NewProductDraftSchema = base
  .extend({
    kind: z.literal("producto_nuevo"),
    name: productName,
    dimension: z.enum(["mass", "volume", "count"]),
    baseUnit,
    categoryId: id.nullable(),
    categoryName: z.string().nullable(),
    packName: z.string().trim().min(1).max(60).nullable(),
    packQtyBase: positive.nullable(),
    supplierId: id.nullable(),
    supplierName: z.string().nullable(),
    price: nonNegative.nullable(),
    locationIds: z.array(id).max(50),
    locationNames: z.array(z.string()).max(50),
  })
  .refine((d) => (d.packName === null) === (d.packQtyBase === null), "el formato necesita nombre y contenido")
  .refine((d) => d.price === null || d.packName !== null, "el precio necesita un formato")
  .refine((d) => d.price === null || d.supplierId !== null, "el precio necesita un proveedor");

export const MinimumDraftSchema = base.extend({
  kind: z.literal("minimo"),
  locationId: id,
  locationName: z.string(),
  productId: id,
  productName: z.string(),
  field: z.enum(["min_qty", "par_qty"]),
  oldValue: nonNegative.nullable(),
  newValue: nonNegative,
  baseUnit,
  input: z.object({ amount: DecimalString, unit: z.string().min(1), packId: id.optional() }),
});

export const ArchiveDraftSchema = base.extend({
  kind: z.literal("archivar"),
  productId: id,
  productName: z.string(),
  stockQty: DecimalString,
  baseUnit,
});

const SCHEMAS = {
  merma: WasteDraftSchema,
  traspaso: TransferDraftSchema,
  recepcion: ReceiptDraftSchema,
  cierre_inventario: CountCloseDraftSchema,
  precio: PriceDraftSchema,
  producto_nuevo: NewProductDraftSchema,
  minimo: MinimumDraftSchema,
  archivar: ArchiveDraftSchema,
} as const;

export function validateDraft<D extends Draft>(draft: D): D {
  return SCHEMAS[draft.kind].parse(draft) as D;
}

export class EditError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EditError";
  }
}

export type Edits = Record<string, string | boolean | null>;

function matches(pattern: string, path: string): boolean {
  const re = new RegExp(`^${pattern.replace(/\./g, "\\.").replace(/\*/g, "\\d+")}$`);
  return re.test(path);
}

/**
 * Aplica ediciones de la lista blanca del borrador y vuelve a validar con zod.
 * Rechaza cualquier ruta no editable y cualquier id que no pertenezca al contexto del usuario.
 */
export function applyEdits(draft: Draft, edits: Edits, ctx: SessionContext): Draft {
  const copy = structuredClone(draft) as Draft & Record<string, unknown>;
  for (const [path, value] of Object.entries(edits)) {
    if (!draft.editable.some((pattern) => matches(pattern, path))) throw new EditError(`El campo ${path} no se puede editar`);
    const parts = path.split(".");
    let target: Record<string, unknown> = copy;
    for (const part of parts.slice(0, -1)) {
      const next = target[part];
      if (next === null || typeof next !== "object") throw new EditError(`Ruta no válida: ${path}`);
      target = next as Record<string, unknown>;
    }
    target[parts.at(-1)!] = value;
  }

  // Coherencias que el esquema no ve.
  if (copy.kind === "merma" && copy.areaId) {
    const area = ctx.areas.find((a) => a.id === copy.areaId);
    if (!area || area.locationId !== copy.locationId) throw new EditError("El espacio no pertenece al local");
    copy.areaName = area.name;
  }
  if (copy.kind === "traspaso" && copy.send && !["manager", "admin", "owner"].includes(ctx.role)) {
    throw new EditError("Enviar un traspaso requiere rol de encargado");
  }
  if (copy.kind === "recepcion") {
    for (const line of copy.lines) if (edits[`lines.${copy.lines.indexOf(line)}.packPrice`] !== undefined) line.priceSource = "usuario";
  }
  if (copy.kind === "precio" && edits.newPrice !== undefined && typeof copy.newPrice === "string" && /^\d+(\.\d+)?$/.test(copy.newPrice)) {
    copy.unitCost = `${formatDecimal(new Decimal(copy.newPrice).div(copy.packQtyBase), 4)} €/${copy.baseUnit}`;
    if (copy.oldPrice !== null && new Decimal(copy.oldPrice).eq(copy.newPrice)) throw new EditError("El precio nuevo es igual al actual");
  }
  if (copy.kind === "producto_nuevo") {
    if (edits.categoryId !== undefined) {
      const category = copy.categoryId ? ctx.categories.find((c) => c.id === copy.categoryId) : null;
      if (copy.categoryId && !category) throw new EditError("Esa categoría no existe");
      copy.categoryName = category?.name ?? null;
    }
    if (edits.dimension !== undefined) copy.baseUnit = baseUnitOf(copy.dimension);
    if (edits.packName === null || edits.packName === "") {
      copy.packName = null;
      copy.packQtyBase = null;
      copy.price = null;
    }
    if (edits.price === "") copy.price = null;
  }
  if (copy.kind === "minimo" && edits.newValue !== undefined) copy.input = { amount: String(copy.newValue), unit: copy.baseUnit };

  try {
    return validateDraft(copy);
  } catch (err) {
    const issue = err instanceof z.ZodError ? err.issues[0] : undefined;
    throw new EditError(issue ? `${issue.path.join(".")}: ${issue.message}` : "Edición no válida");
  }
}
