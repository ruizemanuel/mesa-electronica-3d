import { DIODE_MODELS, diodeParams, ifAt, type DiodeType } from "../sim/diode";
import { formatSI } from "../sim/resistor";

/** Un punto de la curva armado con dos lecturas del cuaderno. */
export interface IvPoint {
  id: number;
  /** Componente medido (el color de la serie sigue al componente, no al orden). */
  type: DiodeType;
  /** Tensión en el diodo (V) y corriente (A). */
  v: number;
  i: number;
  /** Números de las anotaciones de donde salió. */
  from: string;
}

/**
 * Series del gráfico: los tres primeros colores de la paleta categórica de referencia (versión para
 * fondo oscuro), validados de a pares también para dispersión. Cada serie tiene además su forma
 * de marcador y una etiqueta directa, así no depende solo del color.
 */
export const IV_SLOTS = [
  { color: "#3987e5", shape: "circle" },
  { color: "#d95926", shape: "square" },
  { color: "#199e70", shape: "triangle" },
] as const;
export const IV_MAX_SERIES = IV_SLOTS.length;

export const DIODE_LABEL: Record<DiodeType, string> = {
  "1N4007": "1N4007",
  "led-rojo": "LED rojo",
  "led-verde": "LED verde",
  "led-azul": "LED azul",
  "led-blanco": "LED blanco",
};

/** Marcas de escala "lindas" (1, 2, 2,5, 5 × 10ⁿ) que cubren [min, max]. */
export function niceTicks(min: number, max: number, target = 5): number[] {
  const span = Math.max(1e-12, max - min);
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw)!;
  const out: number[] = [];
  const start = Math.floor(min / step + 1e-9) * step;
  for (let t = start; t < max + step * 0.999; t += step) out.push(Math.round(t / step) * step);
  return out;
}

/** Series en orden de aparición, con su lugar fijo en la paleta. */
export function ivSeries(points: IvPoint[]): { type: DiodeType; slot: number; points: IvPoint[] }[] {
  const order: DiodeType[] = [];
  for (const p of points) if (!order.includes(p.type)) order.push(p.type);
  return order.map((type, slot) => ({ type, slot, points: points.filter((p) => p.type === type).sort((a, b) => a.v - b.v) }));
}

const W = 360;
const H = 228;
const M = { l: 44, r: 14, t: 24, b: 32 };
const SURFACE = "#0c0d0f";
const INK = "#e7e9ec";
const MUTED = "#9aa1ab";
const GRID = "#2a2e35";

const fmt = (x: number, dec: number) => x.toFixed(dec).replace(".", ",").replace(/^-0(,0+)?$/, "0$1");

function marker(shape: string, x: number, y: number, color: string): string {
  const ring = `stroke="${SURFACE}" stroke-width="2"`;
  if (shape === "square") return `<rect x="${x - 4.5}" y="${y - 4.5}" width="9" height="9" rx="1.5" fill="${color}" ${ring}/>`;
  if (shape === "triangle") return `<path d="M${x} ${y - 5.5} L${x + 5.2} ${y + 4} L${x - 5.2} ${y + 4} Z" fill="${color}" ${ring} stroke-linejoin="round"/>`;
  return `<circle cx="${x}" cy="${y}" r="4.5" fill="${color}" ${ring}/>`;
}

/** Leyenda HTML (solo con dos o más series). */
export function ivLegend(points: IvPoint[]): string {
  const series = ivSeries(points);
  if (series.length < 2) return "";
  return series
    .map(({ type, slot }) => {
      const s = IV_SLOTS[slot];
      return `<span class="iv-key"><svg width="12" height="12" viewBox="-6 -6 12 12">${marker(s.shape, 0, 0, s.color)}</svg>${DIODE_LABEL[type]}</span>`;
    })
    .join("");
}

/** Gráfico I-V en SVG: puntos medidos unidos por una línea fina y, opcional, la curva del modelo nominal. */
export function ivChartSvg(points: IvPoint[], showTheory: boolean): string {
  const series = ivSeries(points);
  const vs = points.map((p) => p.v);
  const is = points.map((p) => p.i * 1e3);
  const vMin = Math.min(0, ...vs);
  const vMax = Math.max(1, ...vs.map((v) => v * 1.08));
  const iMax = Math.max(1, ...is.map((i) => i * 1.12));
  const xt = niceTicks(vMin, vMax, 6);
  const yt = niceTicks(0, iMax, 5);
  const x0 = xt[0];
  const x1 = xt[xt.length - 1];
  const y1 = yt[yt.length - 1];
  const X = (v: number) => M.l + ((v - x0) / (x1 - x0)) * (W - M.l - M.r);
  const Y = (ma: number) => H - M.b - (ma / y1) * (H - M.t - M.b);
  const xdec = Math.max(0, -Math.floor(Math.log10(xt[1] - xt[0]) + 1e-9));
  const ydec = Math.max(0, -Math.floor(Math.log10(yt[1] - yt[0]) + 1e-9));

  let g = "";
  for (const t of yt) {
    g += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(t)}" y2="${Y(t)}" stroke="${GRID}" stroke-width="1"/>`;
    g += `<text x="${M.l - 6}" y="${Y(t) + 3.5}" text-anchor="end" fill="${MUTED}" font-size="10">${fmt(t, ydec)}</text>`;
  }
  for (const t of xt) {
    g += `<line x1="${X(t)}" x2="${X(t)}" y1="${M.t}" y2="${H - M.b}" stroke="${GRID}" stroke-width="1" stroke-opacity="0.55"/>`;
    g += `<text x="${X(t)}" y="${H - M.b + 14}" text-anchor="middle" fill="${MUTED}" font-size="10">${fmt(t, xdec)}</text>`;
  }
  g += `<text x="${W - M.r}" y="${H - 4}" text-anchor="end" fill="${MUTED}" font-size="10.5">V en el diodo (V)</text>`;
  g += `<text x="${M.l - 6}" y="${M.t - 12}" text-anchor="end" fill="${MUTED}" font-size="10.5">I (mA)</text>`;
  g += `<line x1="${M.l}" x2="${W - M.r}" y1="${Y(0)}" y2="${Y(0)}" stroke="#4a505a" stroke-width="1"/>`;

  if (showTheory) {
    for (const { type, slot } of series) {
      const p = diodeParams(DIODE_MODELS[type]);
      const pts: string[] = [];
      for (let k = 0; k <= 160; k++) {
        const v = x0 + ((x1 - x0) * k) / 160;
        const ma = ifAt(p, v) * 1e3;
        if (ma > y1) {
          pts.push(`${X(v).toFixed(1)},${Y(y1).toFixed(1)}`);
          break;
        }
        pts.push(`${X(v).toFixed(1)},${Y(Math.max(0, ma)).toFixed(1)}`);
      }
      g += `<polyline points="${pts.join(" ")}" fill="none" stroke="${IV_SLOTS[slot].color}" stroke-width="1.5" stroke-dasharray="4 3" stroke-opacity="0.8"/>`;
    }
  }

  for (const { type, slot, points: ps } of series) {
    const s = IV_SLOTS[slot];
    if (ps.length > 1) g += `<polyline points="${ps.map((p) => `${X(p.v).toFixed(1)},${Y(p.i * 1e3).toFixed(1)}`).join(" ")}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"/>`;
    for (const p of ps) {
      const x = X(p.v);
      const y = Y(p.i * 1e3);
      g += `<g class="iv-pt">${marker(s.shape, x, y, s.color)}<circle cx="${x}" cy="${y}" r="10" fill="transparent"><title>${DIODE_LABEL[type]}: ${formatSI(p.v, "V", 4)} · ${formatSI(p.i, "A", 3)} (${p.from})</title></circle></g>`;
    }
    // etiqueta directa junto al último punto
    const last = ps[ps.length - 1];
    const lx = Math.min(W - M.r - 4, X(last.v) - 8);
    const ly = Math.max(M.t + 10, Y(last.i * 1e3) - 9);
    g += `<text x="${lx}" y="${ly}" text-anchor="end" fill="${INK}" font-size="10.5" font-weight="600" paint-order="stroke" stroke="${SURFACE}" stroke-width="3">${DIODE_LABEL[type]}</text>`;
  }
  if (!points.length) g += `<text x="${(M.l + W - M.r) / 2}" y="${(M.t + H - M.b) / 2}" text-anchor="middle" fill="${MUTED}" font-size="11.5">Todavía no hay puntos</text>`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Curva corriente-tensión medida" font-family="Inter, Segoe UI, sans-serif">${g}</svg>`;
}
