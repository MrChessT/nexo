// Borradores de catálogo: cambiar precio, dar de alta, cambiar mínimo/objetivo y archivar.
//
// Reparto de trabajo (igual que en el resto del agente):
//   · el CÓDIGO extrae los datos del mensaje, aplica las reglas exactas (precio igual, duplicado
//     literal, mínimo por encima del objetivo…) y calcula con decimal.js;
//   · JEV revisa lo que exige criterio, en la misma llamada nº 2 que la coherencia: ¿es un duplicado
//     escrito de otra forma?, ¿el nombre es un producto real?, ¿el precio o el mínimo son razonables?,
//     ¿qué categoría y cómo se mide?;
//   · el USUARIO confirma. Si alguna comprobación queda en «revisar», debe marcar «lo he revisado».
import Decimal from "decimal.js";
import type { JsonValue, Questions } from "@typesafe-ai/sdk";
import type { ArchiveDraft, DraftCheck, MinimumDraft, NavigateEvent, NewProductDraft, PriceDraft } from "../contract/index";
import { baseUnitOf, type Dimension, type NamedRef, type SessionContext } from "../domain";
import type { CatalogPlan, ClarifyPlan } from "../agent/interpret";
import {
  asksHardDelete,
  containerFromText,
  extractNewProductName,
  lastQuantity,
  mentionedPack,
  mentionedSupplier,
  minimumField,
  parseMoney,
  sizeFromText,
  unitWordFromText,
} from "../entities/catalog-parser";
import { normalize } from "../entities/normalize";
import { lexicalScore } from "../entities/retriever";
import { formatBase, formatDecimal, formatMoney } from "../entities/units";
import { asChoice, asNoul, gateChoice, gateNoulNo, gateNoulYes } from "../gates/gate";
import type { Thresholds } from "../gates/thresholds";
import { minimumQuestions, newProductQuestions, NINGUNO, priceChangeQuestions, type Medida } from "../jev/catalog";
import type { JevAnswer } from "../jev/client";
import type { InventoryDataSource } from "../tools/types";
import type { BuildResult } from "./builder";
import { draftBase, resolveQuantity } from "./builder";

/** Revisión de Jev que el agente añade a la llamada nº 2 del borrador. */
export interface Review {
  /** Bloques del state que referencian las preguntas (se suman a `request` y `draft`). */
  state: Record<string, JsonValue>;
  questions: Questions;
  /**
   * Aplica las respuestas (vacías si Jev no responde): completa el borrador y sus comprobaciones,
   * o devuelve una aclaración / un error si hay que parar antes de proponer nada.
   */
  apply(answers: Record<string, JevAnswer>, thresholds: Thresholds): ReviewResult;
}

export type ReviewResult = { kind: "ok" } | { kind: "clarify"; plan: ClarifyPlan } | { kind: "error"; message: string; navigate?: NavigateEvent };

export interface CatalogBuildInput {
  plan: CatalogPlan;
  message: string;
  ctx: SessionContext;
  source: InventoryDataSource;
  overrides: Record<string, string>;
  now: Date;
}

const MAX_SIMILAR = 5;

const pct = (value: Decimal) => `${value.gt(0) ? "+" : ""}${formatDecimal(value, 1)} %`;
const probability = (p: number | undefined) => (p === undefined ? null : Math.round(p * 100) / 100);

const SIZE_FACTORS: Record<string, [number, string]> = { ml: [1, "ml"], cl: [10, "ml"], l: [1000, "ml"], lt: [1000, "ml"], g: [1, "g"], gr: [1, "g"], kg: [1000, "g"] };

/**
 * Nombre comparable para detectar duplicados literales: sin tildes, mayúsculas, signos ni espacios,
 * y con los tamaños en unidad base ("Coca Cola 0,2 l" = "Coca-Cola 20cl" = "cocacola200ml").
 */
export function comparableName(name: string): string {
  return normalize(name)
    .replace(/(\d+(?:[.,]\d+)?)\s*(ml|cl|lt|l|gr|g|kg)\b/g, (_, amount: string, unit: string) => {
      const [factor, base] = SIZE_FACTORS[unit]!;
      return `${new Decimal(amount.replace(",", ".")).mul(factor).toString()}${base}`;
    })
    .replace(/[^a-z0-9]+/g, "");
}

function productNav(productId: string): NavigateEvent {
  return { route: "/productos", filters: { productId }, auto: false };
}

function check(id: string, label: string, status: DraftCheck["status"], detail: string, p: number | null = null): DraftCheck {
  return { id, label, status, detail, probability: p };
}

export class CatalogDraftBuilder {
  async build(input: CatalogBuildInput): Promise<BuildResult> {
    switch (input.plan.accion) {
      case "cambiar_precio":
        return this.price(input);
      case "nuevo_producto":
        return this.newProduct(input);
      case "cambiar_minimo":
        return this.minimum(input);
      case "archivar_producto":
        return this.archive(input);
    }
  }

  // Cambiar precio ------------------------------------------------------------------

  private async price({ plan, message, ctx, source, overrides, now }: CatalogBuildInput): Promise<BuildResult> {
    const [p, ...rest] = plan.products;
    if (!p) return { kind: "error", message: "No sé de qué producto cambiar el precio." };
    const product = p.product;
    const warnings: string[] = [];
    if (rest.length > 0) warnings.push("Solo cambio un precio por mensaje; pide el resto por separado.");
    if (p.productOutcome === "confirmar") warnings.push(`Revisa el producto: ${product.name}.`);

    const newPriceText = overrides.precio ?? parseMoney(message) ?? p.price;
    if (!newPriceText) {
      return { kind: "clarify", plan: { type: "clarify", field: "cantidad", question: `¿Cuál es el nuevo precio de ${product.name}? (por ejemplo, «15,50 €»)`, options: [] } };
    }
    const newPrice = new Decimal(newPriceText);

    if (product.packs.length === 0) {
      return { kind: "error", message: `${product.name} no tiene formatos de compra: añade uno en su ficha y vuelve a pedírmelo.`, navigate: productNav(product.id) };
    }
    const pack =
      product.packs.find((k) => k.id === overrides.formato) ??
      mentionedPack(message, product) ??
      product.packs.find((k) => k.isPurchaseDefault) ??
      (product.packs.length === 1 ? product.packs[0]! : null);
    if (!pack) {
      return {
        kind: "clarify",
        plan: {
          type: "clarify",
          field: "formato",
          question: `¿El precio de ${product.name} es por…?`,
          options: product.packs.slice(0, 4).map((k) => ({ id: `pack:${k.id}`, label: k.name, probability: null })),
        },
      };
    }

    const current = await source.supplierPrices([pack.id]);
    const supplier =
      ctx.suppliers.find((s) => s.id === overrides.proveedor) ??
      mentionedSupplier(message, ctx.suppliers) ??
      (current.length === 1 ? { id: current[0]!.supplierId, name: current[0]!.supplierName } : null);
    if (!supplier) {
      if (ctx.suppliers.length === 0) {
        return { kind: "error", message: "Todavía no hay proveedores. Crea uno desde la ficha del producto y vuelve a pedírmelo.", navigate: productNav(product.id) };
      }
      const known = current.map((c) => ({ id: c.supplierId, name: c.supplierName }));
      const others = ctx.suppliers.filter((s) => !known.some((k) => k.id === s.id));
      return {
        kind: "clarify",
        plan: {
          type: "clarify",
          field: "proveedor",
          question: known.length > 1 ? `${product.name} tiene varios proveedores. ¿De cuál es el precio?` : `¿De qué proveedor es el precio de ${product.name}?`,
          options: [...known, ...others].slice(0, 4).map((s) => ({ id: s.id, label: s.name, probability: null })),
        },
      };
    }

    const previous = current.find((c) => c.supplierId === supplier.id);
    const oldPrice = previous ? new Decimal(previous.lastPrice) : null;
    if (oldPrice && oldPrice.eq(newPrice)) {
      return { kind: "error", message: `${pack.name} de ${product.name} ya cuesta ${formatMoney(newPrice)} con ${supplier.name}. No hay nada que cambiar.` };
    }

    // Reglas exactas del código.
    const checks: DraftCheck[] = [];
    let change: Decimal | null = null;
    if (newPrice.isZero()) {
      checks.push(check("precio_cero", "Precio", "revisar", "El precio nuevo es 0 €: el producto contaría como gratis en el coste."));
    } else if (oldPrice && !oldPrice.isZero()) {
      change = newPrice.minus(oldPrice).div(oldPrice).mul(100);
      const ratio = newPrice.div(oldPrice);
      if (ratio.gte(2) || ratio.lte(new Decimal(1).div(3))) {
        checks.push(check("variacion", "Variación", "revisar", `Cambio muy grande: ${formatMoney(oldPrice)} → ${formatMoney(newPrice)} (${pct(change)}). ¿Falta o sobra una cifra?`));
      } else if (change.abs().gte(25)) {
        checks.push(check("variacion", "Variación", "aviso", `${pct(change)} respecto al último precio (${formatMoney(oldPrice)}).`));
      } else {
        checks.push(check("variacion", "Variación", "ok", `${pct(change)} respecto al último precio (${formatMoney(oldPrice)}).`));
      }
    } else {
      const others = current.filter((c) => c.supplierId !== supplier.id);
      checks.push(
        check(
          "variacion",
          "Proveedor",
          "aviso",
          others.length > 0
            ? `Primer precio de ${supplier.name} para este formato (otros proveedores: ${others.map((o) => `${o.supplierName} ${formatMoney(o.lastPrice)}`).join(", ")}).`
            : `Primer precio registrado para ${pack.name}.`,
        ),
      );
    }

    const unitCost = newPrice.div(pack.qtyBase);
    const draft: PriceDraft = {
      ...draftBase("precio", `Precio de ${pack.name} · ${product.name} (${supplier.name}): ${oldPrice ? `${formatMoney(oldPrice)} → ` : ""}${formatMoney(newPrice)}`, ctx, warnings, now),
      kind: "precio",
      productId: product.id,
      productName: product.name,
      packId: pack.id,
      packName: pack.name,
      packQtyBase: pack.qtyBase,
      baseUnit: product.baseUnit,
      supplierId: supplier.id,
      supplierName: supplier.name,
      oldPrice: oldPrice?.toString() ?? null,
      newPrice: newPrice.toString(),
      unitCost: `${formatDecimal(unitCost, 4)} €/${product.baseUnit}`,
      checks,
    };

    const review: Review = {
      state: {
        change: {
          product: product.name,
          category: product.category,
          pack: pack.name,
          supplier: supplier.name,
          old_price: oldPrice ? formatMoney(oldPrice) : null,
          new_price: formatMoney(newPrice),
          change_pct: change ? pct(change) : null,
        },
      },
      questions: priceChangeQuestions(),
      apply: (answers, t) => {
        plausibility(draft.checks!, asNoul(answers.precio_plausible)?.noul, t, "Precio razonable", "el precio");
        return { kind: "ok" };
      },
    };
    return {
      kind: "draft",
      draft,
      summary: { operation: "change purchase price", product: product.name, pack: pack.name, supplier: supplier.name, old_price: oldPrice ? formatMoney(oldPrice) : "none", new_price: formatMoney(newPrice) },
      review,
    };
  }

  // Alta de producto ----------------------------------------------------------------

  private async newProduct({ plan, message, ctx, overrides, now }: CatalogBuildInput): Promise<BuildResult> {
    const name = extractNewProductName(message, ctx.suppliers, ctx.locations);
    if (!name) {
      return { kind: "clarify", plan: { type: "clarify", field: "sentido", question: "¿Cómo se llama el producto nuevo? Escribe el nombre tal y como quieres verlo en el catálogo.", options: [] } };
    }

    // El usuario ya respondió que es un producto existente: no se crea nada.
    const chosen = overrides.duplicado?.startsWith("dup:") ? overrides.duplicado.slice(4) : null;
    if (chosen) {
      const active = ctx.products.find((p) => p.id === chosen);
      const archived = ctx.archivedProducts.find((p) => p.id === chosen);
      const existing = active ?? archived;
      return {
        kind: "error",
        message: existing
          ? `De acuerdo, no creo nada: ya tienes «${existing.name}»${archived ? " (archivado; puedes restaurarlo desde su ficha)" : ""}.`
          : "De acuerdo, no creo nada.",
        ...(existing ? { navigate: productNav(existing.id) } : {}),
      };
    }

    // Duplicado literal: regla del código, sin preguntar a Jev.
    const key = comparableName(name);
    const same = ctx.products.find((p) => comparableName(p.name) === key);
    if (same) return { kind: "error", message: `Ya existe «${same.name}» en el catálogo. No lo creo otra vez.`, navigate: productNav(same.id) };
    const sameArchived = ctx.archivedProducts.find((p) => comparableName(p.name) === key);
    if (sameArchived) {
      return { kind: "error", message: `«${sameArchived.name}» ya existe, pero está archivado. Restáuralo desde su ficha en lugar de crearlo de nuevo.`, navigate: productNav(sameArchived.id) };
    }

    // Parecidos: activos y archivados, por coincidencia léxica. Jev decide si son el mismo artículo.
    const pool: Array<{ ref: NamedRef; category: string | null; formats: string[]; archived: boolean; score: number }> = [
      ...ctx.products.map((p) => ({ ref: { id: p.id, name: p.name }, category: p.category, formats: p.packs.map((k) => k.name), archived: false, score: lexicalScore(name, p) })),
      ...ctx.archivedProducts.map((a) => ({
        ref: a,
        category: null,
        formats: [],
        archived: true,
        score: lexicalScore(name, { id: a.id, name: a.name, dimension: "count", baseUnit: "ud", category: null, packs: [] }),
      })),
    ];
    const best = Math.max(0, ...pool.map((c) => c.score));
    const similar = pool
      .filter((c) => c.score > 0 && c.score >= Math.max(0.8, best * 0.5))
      .sort((a, b) => b.score - a.score)
      .slice(0, MAX_SIMILAR);

    // Datos que el código sí puede leer del mensaje.
    const size = sizeFromText(name) ?? sizeFromText(message);
    const container = containerFromText(message);
    const unitWord = unitWordFromText(message);
    const priceText = overrides.precio ?? parseMoney(message);
    const explicitCategory = ctx.categories.find((c) => new RegExp(`\\bcategor[ií]a\\s+(?:de\\s+)?${escape(normalize(c.name))}\\b`).test(normalize(message)));
    const supplier = ctx.suppliers.find((s) => s.id === overrides.proveedor) ?? mentionedSupplier(message, ctx.suppliers);
    if (priceText && !supplier && ctx.suppliers.length > 0) {
      return {
        kind: "clarify",
        plan: {
          type: "clarify",
          field: "proveedor",
          question: `¿A qué proveedor le compras ${name} a ${formatMoney(priceText)}?`,
          options: ctx.suppliers.slice(0, 4).map((s) => ({ id: s.id, label: s.name, probability: null })),
        },
      };
    }

    const locations = plan.locationId ? ctx.locations.filter((l) => l.id === plan.locationId) : [];
    const warnings: string[] = [];
    const draft: NewProductDraft = {
      ...draftBase("producto_nuevo", `Nuevo producto: ${name}`, ctx, warnings, now),
      kind: "producto_nuevo",
      name,
      dimension: size?.dimension ?? "count",
      baseUnit: baseUnitOf(size?.dimension ?? "count"),
      categoryId: explicitCategory?.id ?? null,
      categoryName: explicitCategory?.name ?? null,
      packName: null,
      packQtyBase: null,
      supplierId: supplier?.id ?? null,
      supplierName: supplier?.name ?? null,
      price: null,
      locationIds: locations.map((l) => l.id),
      locationNames: locations.map((l) => l.name),
      checks: [],
    };

    /** Formato de compra según cómo se mide: "Botella 70 cl", "Caja 24 × 33 cl", "Caja 24 ud". */
    const packFor = (dimension: Dimension): { name: string; qtyBase: Decimal } | null => {
      if (dimension === "count") {
        if (container) return { name: `${container.word} ${container.units.toString()} ud`, qtyBase: container.units };
        return priceText ? { name: "Unidad", qtyBase: new Decimal(1) } : null;
      }
      if (!size || size.dimension !== dimension) return null;
      if (container) return { name: `${container.word} ${container.units.toString()} × ${size.label}`, qtyBase: size.qtyBase.mul(container.units) };
      return { name: `${unitWord ?? (dimension === "volume" ? "Botella" : "Paquete")} ${size.label}`, qtyBase: size.qtyBase };
    };

    const categoryNames = new Map(ctx.categories.map((c) => [c.name, c]));
    const review: Review = {
      state: {
        new_product: { name, pack: packFor(draft.dimension)?.name ?? null, price: priceText ? formatMoney(priceText) : null, size: size?.label ?? null },
        similar: similar.map((s) => ({ name: s.ref.name, category: s.category, formats: s.formats, archived: s.archived })),
      },
      questions: newProductQuestions({ similar: similar.length, categories: explicitCategory ? [] : [...categoryNames.keys()], askDimension: true, hasPrice: !!priceText }),
      apply: (answers, t) => {
        const checks = draft.checks!;
        const jevAnswered = Object.keys(answers).length > 0;

        // 1) Duplicados escritos de otra forma.
        if (overrides.duplicado === "crear") {
          checks.push(check("duplicado", "Duplicados", "aviso", "Has indicado que no es ninguno de los productos parecidos."));
        } else if (similar.length > 0) {
          const scored = similar.map((s, i) => ({ s, p: asNoul(answers[`duplicado_${i}`])?.noul }));
          const top = scored.filter((x) => x.p !== undefined).sort((a, b) => b.p! - a.p!)[0];
          if (!top) {
            checks.push(check("duplicado", "Duplicados", "revisar", `No he podido comprobar si ya existe. Parecidos: ${similar.map((s) => `«${s.ref.name}»`).join(", ")}.`));
          } else {
            const gate = gateNoulNo({ type: "noul", noul: top.p! }, t.duplicado);
            if (gate === "preguntar") {
              return {
                kind: "clarify",
                plan: {
                  type: "clarify",
                  field: "duplicado",
                  question: `Ya tienes «${top.s.ref.name}»${top.s.archived ? " (archivado)" : ""} en el catálogo. ¿Es el mismo producto que «${name}»?`,
                  options: [
                    { id: `dup:${top.s.ref.id}`, label: `Sí, es «${top.s.ref.name}»`, probability: probability(top.p) },
                    { id: "crear", label: "No, es otro: créalo", probability: probability(1 - top.p!) },
                  ],
                },
              };
            }
            checks.push(
              gate === "confirmar"
                ? check("duplicado", "Duplicados", "revisar", `Se parece mucho a «${top.s.ref.name}»${top.s.archived ? " (archivado)" : ""}. Asegúrate de que no es el mismo.`, probability(top.p))
                : check("duplicado", "Duplicados", "ok", `No coincide con ningún producto existente (el más parecido: «${top.s.ref.name}»).`, probability(1 - top.p!)),
            );
          }
        } else {
          checks.push(check("duplicado", "Duplicados", "ok", "No hay ningún producto parecido en el catálogo."));
        }

        // 2) ¿Es un producto real o un texto sin sentido?
        const sense = asNoul(answers.tiene_sentido)?.noul;
        if (overrides.sentido === "crear_igual") {
          checks.push(check("sentido", "Nombre", "revisar", "Has confirmado que quieres crearlo aunque el nombre no parece un producto."));
        } else if (sense === undefined) {
          if (jevAnswered || similar.length === 0) checks.push(check("sentido", "Nombre", "aviso", "No he podido comprobar el nombre: revísalo."));
        } else {
          const gate = gateNoulYes({ type: "noul", noul: sense }, t.sentido);
          if (gate === "preguntar") {
            return {
              kind: "clarify",
              plan: {
                type: "clarify",
                field: "sentido",
                question: `«${name}» no parece un producto de inventario. ¿Lo creo igualmente? Si no, escríbeme el nombre correcto.`,
                options: [{ id: "crear_igual", label: "Sí, créalo así", probability: probability(sense) }],
              },
            };
          }
          checks.push(
            gate === "confirmar"
              ? check("sentido", "Nombre", "revisar", `No estoy seguro de que «${name}» sea un producto: revisa que esté bien escrito.`, probability(sense))
              : check("sentido", "Nombre", "ok", "Es un producto de inventario reconocible.", probability(sense)),
          );
        }

        // 3) Cómo se mide: Jev si está seguro; si no, lo que diga el tamaño del nombre.
        const medida = asChoice(answers.medida);
        const medidaGate = medida ? gateChoice(medida, t.categoria) : null;
        const dimension: Dimension =
          medidaGate?.outcome === "actuar" ? (medidaGate.choice as Medida) : (size?.dimension ?? (medidaGate?.choice as Medida | undefined) ?? "count");
        draft.dimension = dimension;
        draft.baseUnit = baseUnitOf(dimension);
        const unitLabel = { volume: "volumen (ml)", mass: "peso (g)", count: "unidades" }[dimension];
        checks.push(
          medidaGate?.outcome === "actuar" || (size && size.dimension === dimension)
            ? check("medida", "Medida", "ok", `Se contará por ${unitLabel}.`, medidaGate ? probability(medidaGate.probability) : null)
            : check("medida", "Medida", "aviso", `Se contará por ${unitLabel}; cámbialo si no es así.`, medidaGate ? probability(medidaGate.probability) : null),
        );

        // 4) Formato de compra y precio.
        const pack = packFor(dimension);
        draft.packName = pack?.name ?? null;
        draft.packQtyBase = pack?.qtyBase.toString() ?? null;
        if (priceText && pack) {
          draft.price = new Decimal(priceText).toString();
          plausibility(checks, asNoul(answers.precio_plausible)?.noul, t, "Precio razonable", "el precio");
        } else if (priceText) {
          warnings.push(`No sé a qué formato corresponde el precio (${formatMoney(priceText)}): añádelo en la ficha del producto.`);
        }
        if (!pack) checks.push(check("formato", "Formato", "aviso", "Sin formato de compra: añádelo después en su ficha."));

        // 5) Categoría: la del mensaje; si no, la que proponga Jev con seguridad suficiente.
        if (explicitCategory) {
          checks.push(check("categoria", "Categoría", "ok", `Categoría indicada: ${explicitCategory.name}.`));
        } else {
          const cat = asChoice(answers.categoria);
          const catGate = cat ? gateChoice(cat, t.categoria) : null;
          const chosenCategory = catGate && catGate.choice !== NINGUNO && catGate.outcome !== "preguntar" ? categoryNames.get(catGate.choice) : undefined;
          if (chosenCategory) {
            draft.categoryId = chosenCategory.id;
            draft.categoryName = chosenCategory.name;
            checks.push(check("categoria", "Categoría", catGate!.outcome === "actuar" ? "ok" : "aviso", `Categoría propuesta: ${chosenCategory.name}.`, probability(catGate!.probability)));
          } else if (ctx.categories.length > 0) {
            checks.push(check("categoria", "Categoría", "aviso", "Sin categoría: no encaja con claridad en ninguna existente."));
          }
        }

        if (draft.locationIds.length === 0) warnings.push("No lo activo en ningún local: hazlo desde su ficha o dime en cuál.");
        draft.title = `Nuevo producto: ${name}${draft.packName ? ` · ${draft.packName}` : ""}${draft.price ? ` · ${formatMoney(draft.price)}` : ""}`;
        return { kind: "ok" };
      },
    };
    return {
      kind: "draft",
      draft,
      summary: { operation: "add a new product to the catalog", name, price: priceText ? formatMoney(priceText) : "not stated", supplier: supplier?.name ?? "not stated" },
      review,
    };
  }

  // Mínimo / objetivo --------------------------------------------------------------------

  private async minimum({ plan, message, ctx, source, overrides, now }: CatalogBuildInput): Promise<BuildResult> {
    const [p] = plan.products;
    const locationId = plan.locationId;
    if (!p || !locationId) return { kind: "error", message: "Necesito el producto y el local." };
    const product = p.product;
    const field = minimumField(message);
    const levelName = field === "min_qty" ? "mínimo" : "objetivo";

    const quantity = p.amount ? { amount: p.amount, unit: p.unit } : lastQuantity(message);
    if (!quantity) {
      return { kind: "clarify", plan: { type: "clarify", field: "cantidad", question: `¿Qué ${levelName} quieres para ${product.name}? (por ejemplo, «4 botellas»)`, options: [] } };
    }
    const q = resolveQuantity({ ...p, amount: quantity.amount, unit: quantity.unit, quantityOutcome: p.quantityOutcome ?? null }, overrides);
    if ("type" in q) return { kind: "clarify", plan: q };

    const [levels, balances] = await Promise.all([
      source.locationProducts({ locationIds: [locationId], productIds: [product.id] }),
      source.balances({ locationIds: [locationId], productIds: [product.id] }),
    ]);
    const level = levels[0];
    const oldValue = level ? new Decimal(field === "min_qty" ? level.minQty : level.parQty) : null;
    const other = level ? new Decimal(field === "min_qty" ? level.parQty : level.minQty) : null;
    const stock = new Decimal(balances[0]?.qty ?? 0);
    const newValue = q.qtyBase;
    const location = ctx.locations.find((l) => l.id === locationId)!;
    const fmt = (v: Decimal.Value) => formatBase(v, product.baseUnit);
    if (oldValue && oldValue.eq(newValue)) {
      return { kind: "error", message: `El ${levelName} de ${product.name} en ${location.name} ya es ${fmt(newValue)}.` };
    }

    const checks: DraftCheck[] = [];
    if (field === "min_qty" && other && other.gt(0) && newValue.gt(other)) {
      checks.push(check("orden", "Mínimo y objetivo", "revisar", `El mínimo (${fmt(newValue)}) quedaría por encima del objetivo (${fmt(other)}).`));
    } else if (field === "par_qty" && other && other.gt(0) && newValue.lt(other)) {
      checks.push(check("orden", "Mínimo y objetivo", "revisar", `El objetivo (${fmt(newValue)}) quedaría por debajo del mínimo (${fmt(other)}).`));
    }
    if (newValue.isZero()) checks.push(check("cero", "Alerta", "aviso", field === "min_qty" ? "Con mínimo 0 no saltará ninguna alerta de stock bajo." : "Con objetivo 0 no se sugerirá reponer."));
    checks.push(
      field === "min_qty" && newValue.gt(stock)
        ? check("stock", "Stock actual", "aviso", `Ahora hay ${fmt(stock)}: quedará por debajo del mínimo en cuanto lo guardes.`)
        : check("stock", "Stock actual", "ok", `Ahora hay ${fmt(stock)}.`),
    );

    const warnings = [...q.warnings];
    if (plan.locationOutcome === "confirmar") warnings.push("Revisa el local.");
    const described = q.pack ? `${formatDecimal(q.input.amount, 4)} × ${q.pack.name} (${fmt(newValue)})` : fmt(newValue);
    const draft: MinimumDraft = {
      ...draftBase("minimo", `${levelName === "mínimo" ? "Mínimo" : "Objetivo"} de ${product.name} en ${location.name}: ${oldValue ? `${fmt(oldValue)} → ` : ""}${described}`, ctx, warnings, now),
      kind: "minimo",
      locationId,
      locationName: location.name,
      productId: product.id,
      productName: product.name,
      field,
      oldValue: oldValue?.toString() ?? null,
      newValue: newValue.toString(),
      baseUnit: product.baseUnit,
      input: q.input,
      checks,
    };
    const usualPack = product.packs.find((k) => k.isCountDefault) ?? product.packs.find((k) => k.isPurchaseDefault) ?? null;
    const review: Review = {
      state: {
        change: {
          product: product.name,
          level: field === "min_qty" ? "minimum stock (alert threshold)" : "target stock (par level)",
          new_value: described,
          previous_value: oldValue ? fmt(oldValue) : null,
          current_stock: fmt(stock),
          usual_pack: usualPack ? `${usualPack.name} = ${fmt(usualPack.qtyBase)}` : null,
        },
      },
      questions: minimumQuestions(),
      apply: (answers, t) => {
        plausibility(draft.checks!, asNoul(answers.valor_plausible)?.noul, t, "Cantidad razonable", `el ${levelName}`);
        return { kind: "ok" };
      },
    };
    return {
      kind: "draft",
      draft,
      summary: { operation: `set the ${field === "min_qty" ? "minimum" : "target"} stock level of a product in a venue`, product: product.name, venue: location.name, value: described },
      review,
    };
  }

  // Archivar ------------------------------------------------------------------------

  private async archive({ plan, message, ctx, source, now }: CatalogBuildInput): Promise<BuildResult> {
    const [p, ...rest] = plan.products;
    if (!p) return { kind: "error", message: "No sé qué producto archivar." };
    const product = p.product;
    const warnings: string[] = [];
    if (rest.length > 0) warnings.push("Solo archivo un producto por mensaje.");
    if (asksHardDelete(message)) {
      warnings.push("Desde el asistente no borro productos: los archivo (dejan de usarse pero conservan su historial). Para borrarlo del todo, hazlo desde su ficha.");
    }

    const locationIds = ctx.locations.map((l) => l.id);
    const [balances, transfers] = await Promise.all([
      source.balances({ locationIds, productIds: [product.id] }),
      source.transfers({ locationIds, status: ["in_transit"] }),
    ]);
    const withStock = balances.filter((b) => new Decimal(b.qty).gt(0));
    const total = withStock.reduce((acc, b) => acc.plus(b.qty), new Decimal(0));
    const inTransit = transfers.filter((t) => t.lines.some((l) => l.productId === product.id));
    const checks: DraftCheck[] = [];
    checks.push(
      withStock.length > 0
        ? check(
            "stock",
            "Stock",
            "revisar",
            `Aún quedan ${formatBase(total, product.baseUnit)} en ${withStock.map((b) => ctx.locations.find((l) => l.id === b.locationId)?.name ?? "?").join(", ")}. Seguirán contando en el valor del stock.`,
          )
        : check("stock", "Stock", "ok", "No queda stock en ningún local."),
    );
    if (inTransit.length > 0) checks.push(check("transito", "Traspasos", "revisar", `Está en ${inTransit.length === 1 ? "un traspaso" : `${inTransit.length} traspasos`} sin recibir.`));

    const draft: ArchiveDraft = {
      ...draftBase("archivar", `Archivar ${product.name}`, ctx, warnings, now),
      kind: "archivar",
      productId: product.id,
      productName: product.name,
      stockQty: total.toString(),
      baseUnit: product.baseUnit,
      checks,
    };
    return { kind: "draft", draft, summary: { operation: "archive (deactivate) a product so it is no longer used", product: product.name } };
  }
}

/** Plausibilidad (precio, mínimo) según Jev: bien, aviso o revisar obligatorio. */
function plausibility(checks: DraftCheck[], noul: number | undefined, t: Thresholds, label: string, what: string): void {
  if (noul === undefined) {
    checks.push(check("plausible", label, "aviso", `No he podido valorar si ${what} es razonable.`));
    return;
  }
  const gate = gateNoulYes({ type: "noul", noul }, t.plausible);
  checks.push(
    gate === "actuar"
      ? check("plausible", label, "ok", `${capitalize(what)} parece razonable.`, probability(noul))
      : gate === "confirmar"
        ? check("plausible", label, "aviso", `${capitalize(what)} es poco habitual: compruébalo.`, probability(noul))
        : check("plausible", label, "revisar", `${capitalize(what)} no parece razonable: ¿falta o sobra una cifra?`, probability(noul)),
  );
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

