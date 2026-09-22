import Decimal from "decimal.js";

export { Decimal };

export function decimal(value: Decimal.Value): Decimal {
  return new Decimal(value);
}
