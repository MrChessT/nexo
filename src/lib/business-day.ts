export function businessDay(occurredAt: Date, timezone: string, cutoff: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(occurredAt).reduce<Record<string, string>>((result, part) => {
    result[part.type] = part.value;
    return result;
  }, {});
  const localMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const cutoffParts = cutoff.split(":").map(Number);
  const cutoffHour = cutoffParts[0] ?? 0;
  const cutoffMinute = cutoffParts[1] ?? 0;
  const date = new Date(Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day)));
  if (localMinutes < cutoffHour * 60 + cutoffMinute) date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}
