export function formatCurrency(value: string | number, currency = "EUR"): string {
  return new Intl.NumberFormat("es-ES", { style: "currency", currency }).format(Number(value));
}

export function formatNumber(value: string | number, maximumFractionDigits = 2): string {
  return new Intl.NumberFormat("es-ES", { maximumFractionDigits }).format(Number(value));
}

export function formatDate(value: string | Date, timezone = "Europe/Madrid"): string {
  return new Intl.DateTimeFormat("es-ES", { dateStyle: "medium", timeZone: timezone }).format(new Date(value));
}
