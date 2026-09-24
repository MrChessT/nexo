"use client";

// Kit de gráficas SVG de Nexo. Las cifras llegan calculadas (decimal.js en el servicio) como cadena
// y ya formateadas en `display`; aquí solo se convierten a número para POSICIONAR marcas en píxeles.
// Paleta validada (verde de marca saturado, azul, naranja, violeta; orden fijo, nunca cíclico).

import { useEffect, useRef, useState } from "react";
import { Table2 } from "lucide-react";
import type { ChartSpec } from "@/components/copiloto/types";
import "./charts.css";

export const SERIES_COLORS = ["#0f8a5f", "#2a78d6", "#eb6834", "#4a3aa7"] as const;
const POSITIVE = "#2a78d6";
const NEGATIVE = "#d03b3b";

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new ResizeObserver((entries) => setWidth(Math.floor(entries[0]?.contentRect.width ?? 0)));
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/** Solo para geometría: el valor exacto sigue siendo la cadena decimal. */
const toPx = (value: string) => Number(value);

function niceStep(range: number, ticks: number): number {
  const raw = range / ticks;
  const power = 10 ** Math.floor(Math.log10(raw || 1));
  const n = raw / power;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * power;
}

function scaleTicks(min: number, max: number, count = 4): number[] {
  const lo = Math.min(0, min);
  const hi = Math.max(0, max);
  const step = niceStep(hi - lo || 1, count);
  const start = Math.floor(lo / step) * step;
  const end = Math.ceil(hi / step) * step;
  const ticks: number[] = [];
  for (let v = start; v <= end + step / 2; v += step) ticks.push(Math.round(v * 1e6) / 1e6);
  return ticks;
}

const compact = new Intl.NumberFormat("es-ES", { notation: "compact", maximumFractionDigits: 1 });
function tickLabel(value: number, format: ChartSpec["format"]): string {
  const n = compact.format(value);
  return format === "money" ? `${n} €` : format === "percent" ? `${n} %` : format === "days" ? `${n} d` : n;
}

function roundedTopBar(x: number, y: number, w: number, h: number, r = 4): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

function roundedEndBar(x0: number, x1: number, y: number, h: number, r = 4): string {
  const w = Math.abs(x1 - x0);
  if (w <= 0) return "";
  const rr = Math.min(r, h / 2, w);
  if (x1 >= x0) return `M${x0},${y}H${x1 - rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 - rr},${y + h}H${x0}Z`;
  return `M${x0},${y}H${x1 + rr}Q${x1},${y} ${x1},${y + rr}V${y + h - rr}Q${x1},${y + h} ${x1 + rr},${y + h}H${x0}Z`;
}

interface Tip {
  x: number;
  y: number;
  title: string;
  rows: Array<{ color: string; name: string; value: string }>;
}

function Tooltip({ tip }: { tip: Tip | null }) {
  if (!tip) return null;
  return (
    <div className="chart-tooltip" style={{ left: tip.x, top: tip.y }} role="status">
      <span className="chart-tooltip-title">{tip.title}</span>
      {tip.rows.map((row) => (
        <span key={row.name} className="chart-tooltip-row">
          <i style={{ background: row.color }} />
          <b>{row.value}</b>
          {row.name}
        </span>
      ))}
    </div>
  );
}

function LineChart({ spec, width, height }: { spec: ChartSpec; width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  // Eje X común (las series pueden tener fechas distintas, p. ej. precios por albarán).
  const xKeys = [...new Set(spec.series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  const labelOf = new Map(spec.series.flatMap((s) => s.points.map((p) => [p.x, p.label] as const)));
  const index = new Map(xKeys.map((k, i) => [k, i]));
  const n = xKeys.length;
  const values = spec.series.flatMap((s) => s.points.map((p) => toPx(p.value)));
  const ticks = scaleTicks(Math.min(...values, 0), Math.max(...values, 0));
  const single = spec.series.length === 1;
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const top = 14;
  const h = height - top - 26;
  const yRaw = (v: number) => top + h - ((v - lo) / (hi - lo || 1)) * h;
  // Etiquetas al final de cada línea solo si no chocan y los nombres son cortos; si no, basta la leyenda.
  const ends = spec.series.map((s) => yRaw(toPx(s.points.at(-1)?.value ?? "0"))).sort((p, q) => p - q);
  const separated = ends.every((y, i) => i === 0 || y - ends[i - 1]! >= 13);
  const endLabels = single || (spec.series.length <= 4 && separated && spec.series.every((s) => s.name.length <= 14));
  const m = { top, right: endLabels ? (single ? 72 : 96) : 16, bottom: 26, left: 58 };
  const w = Math.max(0, width - m.left - m.right);
  const x = (i: number) => m.left + (n <= 1 ? w / 2 : (i / (n - 1)) * w);
  const y = yRaw;
  const everyNth = Math.max(1, Math.ceil(n / Math.max(2, Math.floor(w / 64))));
  const pathOf = (s: ChartSpec["series"][number]) => s.points.map((p, i) => `${i === 0 ? "M" : "L"}${x(index.get(p.x)!)},${y(toPx(p.value))}`).join(" ");

  function onMove(event: React.PointerEvent<SVGRectElement>) {
    const box = event.currentTarget.getBoundingClientRect();
    const rel = event.clientX - box.left;
    setHover(Math.max(0, Math.min(n - 1, Math.round((rel / (box.width || 1)) * (n - 1)))));
  }

  const hoverKey = hover === null ? null : xKeys[hover]!;
  const tip: Tip | null =
    hoverKey === null || hover === null
      ? null
      : {
          x: Math.min(x(hover) + 12, width - 190),
          y: m.top,
          title: labelOf.get(hoverKey) ?? "",
          rows: spec.series.map((s, i) => ({ color: SERIES_COLORS[i]!, name: s.name, value: s.points.find((p) => p.x === hoverKey)?.display ?? "—" })),
        };

  return (
    <>
      <svg width={width} height={height} role="img" aria-label={spec.title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.left} x2={m.left + w} y1={y(t)} y2={y(t)} className={t === 0 ? "chart-axis" : "chart-grid"} />
            <text x={m.left - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{tickLabel(t, spec.format)}</text>
          </g>
        ))}
        {xKeys.map((key, i) =>
          i % everyNth === 0 ? (
            <text key={key} x={x(i)} y={height - 8} className="chart-tick" textAnchor={n > 1 && i === 0 ? "start" : "middle"}>{labelOf.get(key)}</text>
          ) : null,
        )}
        {single && spec.series[0] && spec.series[0].points.length > 1 && (
          <path d={`${pathOf(spec.series[0])} L${x(index.get(spec.series[0].points.at(-1)!.x)!)},${y(0)} L${x(index.get(spec.series[0].points[0]!.x)!)},${y(0)}Z`} fill={SERIES_COLORS[0]} opacity={0.1} />
        )}
        {spec.series.map((s, si) => (
          <path key={s.key} d={pathOf(s)} fill="none" stroke={SERIES_COLORS[si]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        ))}
        {spec.series.map((s, si) => {
          const last = s.points.at(-1);
          if (!last) return null;
          const cx = x(index.get(last.x)!);
          return (
            <g key={`${s.key}-end`}>
              <circle cx={cx} cy={y(toPx(last.value))} r={4} fill={SERIES_COLORS[si]} stroke="#fff" strokeWidth={2} />
              {endLabels && (
                <text x={cx + 9} y={y(toPx(last.value))} className="chart-end-label" dominantBaseline="middle">
                  {single ? last.display : s.name}
                </text>
              )}
            </g>
          );
        })}
        {hover !== null && hoverKey !== null && (
          <g>
            <line x1={x(hover)} x2={x(hover)} y1={m.top} y2={m.top + h} className="chart-crosshair" />
            {spec.series.map((s, si) => {
              const p = s.points.find((pt) => pt.x === hoverKey);
              return p ? <circle key={s.key} cx={x(hover)} cy={y(toPx(p.value))} r={4} fill={SERIES_COLORS[si]} stroke="#fff" strokeWidth={2} /> : null;
            })}
          </g>
        )}
        <rect x={m.left} y={m.top} width={w} height={h} fill="transparent" onPointerMove={onMove} onPointerLeave={() => setHover(null)} />
      </svg>
      <Tooltip tip={tip} />
    </>
  );
}

function ColumnChart({ spec, width, height }: { spec: ChartSpec; width: number; height: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = spec.series[0]?.points ?? [];
  const ticks = scaleTicks(0, Math.max(...points.map((p) => toPx(p.value)), 0));
  const m = { top: 22, right: 12, bottom: 28, left: 58 };
  const w = Math.max(0, width - m.left - m.right);
  const h = height - m.top - m.bottom;
  const hi = ticks.at(-1)!;
  const band = w / Math.max(points.length, 1);
  const barW = Math.min(24, band * 0.6);
  const y = (v: number) => m.top + h - (v / (hi || 1)) * h;
  const tip: Tip | null =
    hover === null || !points[hover]
      ? null
      : { x: Math.min(m.left + band * hover + band / 2 + 12, width - 180), y: m.top, title: points[hover].label, rows: [{ color: SERIES_COLORS[0], name: spec.series[0]!.name, value: points[hover].display }] };
  return (
    <>
      <svg width={width} height={height} role="img" aria-label={spec.title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={m.left} x2={m.left + w} y1={y(t)} y2={y(t)} className={t === 0 ? "chart-axis" : "chart-grid"} />
            <text x={m.left - 8} y={y(t)} className="chart-tick" textAnchor="end" dominantBaseline="middle">{tickLabel(t, spec.format)}</text>
          </g>
        ))}
        {points.map((p, i) => {
          const cx = m.left + band * i + band / 2;
          const top = y(toPx(p.value));
          return (
            <g key={p.x} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={m.left + band * i} y={m.top} width={band} height={h} fill="transparent" />
              <path d={roundedTopBar(cx - barW / 2, top, barW, m.top + h - top)} fill={SERIES_COLORS[0]} opacity={hover === null || hover === i ? 1 : 0.55} />
              <text x={cx} y={top - 6} className="chart-value" textAnchor="middle">{p.display}</text>
              <text x={cx} y={height - 9} className="chart-tick" textAnchor="middle">{p.label}</text>
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </>
  );
}

/** Barras horizontales: ranking (bar) o ± alrededor de cero (diverging). */
function HorizontalChart({ spec, width }: { spec: ChartSpec; width: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const points = spec.series[0]?.points ?? [];
  const diverging = spec.kind === "diverging";
  const rowH = 30;
  const barH = 16;
  const labelW = Math.min(170, Math.max(96, width * 0.34));
  const values = points.map((p) => toPx(p.value));
  const hasNegative = values.some((v) => v < 0);
  // Hueco para la etiqueta de referencia arriba y para los valores de barras negativas a la izquierda.
  const m = { top: spec.reference ? 22 : 8, right: 76, bottom: 24, left: labelW + 10 + (hasNegative ? 64 : 0) };
  const height = m.top + m.bottom + rowH * points.length;
  const w = Math.max(0, width - m.left - m.right);
  const ref = spec.reference ? toPx(spec.reference.value) : null;
  const ticks = scaleTicks(Math.min(...values, 0), Math.max(...values, ref ?? 0, 0), 3);
  const lo = ticks[0]!;
  const hi = ticks.at(-1)!;
  const x = (v: number) => m.left + ((v - lo) / (hi - lo || 1)) * w;
  const tip: Tip | null =
    hover === null || !points[hover]
      ? null
      : {
          x: Math.min(x(Math.max(0, toPx(points[hover].value))) + 12, width - 180),
          y: m.top + rowH * hover,
          title: points[hover].label,
          rows: [{ color: diverging ? (toPx(points[hover].value) < 0 ? NEGATIVE : POSITIVE) : SERIES_COLORS[0], name: spec.series[0]!.name, value: points[hover].display }],
        };
  return (
    <>
      <svg width={width} height={height} role="img" aria-label={spec.title}>
        {ticks.map((t) => (
          <g key={t}>
            <line x1={x(t)} x2={x(t)} y1={m.top} y2={height - m.bottom} className={t === 0 ? "chart-axis" : "chart-grid"} />
            <text x={x(t)} y={height - 8} className="chart-tick" textAnchor="middle">{tickLabel(t, spec.format)}</text>
          </g>
        ))}
        {ref !== null && spec.reference && (
          <g>
            <line x1={x(ref)} x2={x(ref)} y1={m.top - 4} y2={height - m.bottom} className="chart-reference" />
            <text x={x(ref)} y={m.top - 9} className="chart-reference-label" textAnchor="middle">{spec.reference.label}</text>
          </g>
        )}
        {points.map((p, i) => {
          const v = toPx(p.value);
          const y0 = m.top + rowH * i + (rowH - barH) / 2;
          const color = diverging ? (v < 0 ? NEGATIVE : POSITIVE) : SERIES_COLORS[0];
          const end = x(v);
          const labelX = v < 0 ? end - 6 : end + 6;
          return (
            <g key={p.x} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
              <rect x={0} y={m.top + rowH * i} width={width} height={rowH} fill="transparent" />
              <text x={labelW} y={y0 + barH / 2} className="chart-category" textAnchor="end" dominantBaseline="middle">
                <title>{p.label}</title>
                {p.label.length > 26 ? `${p.label.slice(0, 25)}…` : p.label}
              </text>
              <path d={roundedEndBar(x(0), end, y0, barH)} fill={color} opacity={hover === null || hover === i ? 1 : 0.55} />
              <text x={labelX} y={y0 + barH / 2} className="chart-value" textAnchor={v < 0 ? "end" : "start"} dominantBaseline="middle">
                {p.display}
              </text>
            </g>
          );
        })}
      </svg>
      <Tooltip tip={tip} />
    </>
  );
}

function DataTable({ spec }: { spec: ChartSpec }) {
  const keys = [...new Set(spec.series.flatMap((s) => s.points.map((p) => p.x)))];
  if (spec.kind === "line") keys.sort();
  const labelOf = new Map(spec.series.flatMap((s) => s.points.map((p) => [p.x, p.label] as const)));
  return (
    <div className="chart-table-wrap">
      <table className="chart-table">
        <thead>
          <tr>
            <th>{spec.kind === "line" ? "Fecha" : "Concepto"}</th>
            {spec.series.map((s) => (
              <th key={s.key}>{s.name}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {keys.map((key) => (
            <tr key={key}>
              <td>{labelOf.get(key)}</td>
              {spec.series.map((s) => (
                <td key={s.key}>{s.points.find((p) => p.x === key)?.display ?? "—"}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function ChartCard({ spec, compact = false }: { spec: ChartSpec; compact?: boolean }) {
  const { ref, width } = useWidth<HTMLDivElement>();
  const [table, setTable] = useState(false);
  const height = compact ? 180 : 250;
  const empty = spec.empty || spec.series.every((s) => s.points.length === 0);
  return (
    <section className={`chart-card${compact ? " compact" : ""}`}>
      <header className="chart-head">
        <div>
          <h3>{spec.title}</h3>
          <p>{spec.subtitle}</p>
        </div>
        {!empty && (
          <button type="button" className={`chart-table-toggle${table ? " active" : ""}`} onClick={() => setTable((t) => !t)} aria-pressed={table} title="Ver como tabla">
            <Table2 size={14} />
            <span>Tabla</span>
          </button>
        )}
      </header>
      {spec.series.length >= 2 && !table && (
        <div className="chart-legend">
          {spec.series.map((s, i) => (
            <span key={s.key}>
              <i style={{ background: SERIES_COLORS[i] }} />
              {s.name}
            </span>
          ))}
        </div>
      )}
      <div className="chart-body" ref={ref}>
        {empty ? (
          <p className="chart-empty">{spec.empty ?? "Sin datos."}</p>
        ) : table ? (
          <DataTable spec={spec} />
        ) : width > 0 ? (
          spec.kind === "line" ? (
            <LineChart spec={spec} width={width} height={height} />
          ) : spec.kind === "column" ? (
            <ColumnChart spec={spec} width={width} height={height} />
          ) : (
            <HorizontalChart spec={spec} width={width} />
          )
        ) : null}
      </div>
    </section>
  );
}
