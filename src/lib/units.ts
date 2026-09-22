import { Decimal } from "./decimal";

export type UnitDimension = "mass" | "volume" | "count";

export type Pack = {
  name: string;
  qtyBase: string;
};

export function packsToBase(packs: Decimal.Value, pack: Pack): Decimal {
  return new Decimal(packs).mul(pack.qtyBase);
}

export function baseToPacks(quantity: Decimal.Value, pack: Pack): Decimal {
  return new Decimal(quantity).div(pack.qtyBase);
}

export function openBottleFromWeight(weight: Decimal.Value, fullWeight: Decimal.Value, emptyWeight: Decimal.Value, qtyBase: Decimal.Value): Decimal {
  const result = new Decimal(weight).minus(emptyWeight).div(new Decimal(fullWeight).minus(emptyWeight)).mul(qtyBase);
  return Decimal.max(0, Decimal.min(new Decimal(qtyBase), result));
}

export function formatQuantity(quantity: Decimal.Value, dimension: UnitDimension, pack?: Pack): string {
  const value = new Decimal(quantity);
  if (pack && value.gte(pack.qtyBase)) {
    const fullPacks = value.div(pack.qtyBase).floor();
    const remainder = value.mod(pack.qtyBase);
    if (remainder.isZero()) return `${fullPacks.toString()} ${pack.name}`;
    return `${fullPacks.toString()} ${pack.name} + ${formatBase(remainder, dimension)}`;
  }
  return formatBase(value, dimension);
}

function formatBase(value: Decimal, dimension: UnitDimension): string {
  const unit = dimension === "volume" ? "ml" : dimension === "mass" ? "g" : "ud";
  return `${value.toString()} ${unit}`;
}
