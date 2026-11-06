import { formatFreq } from "../sim/fgen";
import { HDIVS, POINTS, VDIVS_ON_SCREEN, type Oscilloscope, type ScopeStatus } from "../sim/scope";

/**
 * Pantalla del osciloscopio (7", 800×480): cuadrícula de 10×8 divisiones, trazas, marcadores de
 * 0 V y de disparo, barra de estado arriba, canales abajo y, a la derecha, mediciones y cursores.
 * Se dibuja en cualquier canvas 2D (la textura del modelo 3D y la copia del panel son el mismo).
 */
export const CH_COLOR = ["#f2d21b", "#27d3f5"] as const;
const CURSOR_COLOR = ["#ffffff", "#ff9a3c"] as const;
const BG = "#05070a";
const BAR = "#10141a";
const INK = "#e6e9ee";
const MUTED = "#8a93a0";
const STATUS_STYLE: Record<ScopeStatus, { bg: string; fg: string }> = {
  "TRIG'D": { bg: "#2fbf5b", fg: "#06140a" },
  AUTO: { bg: "#3a7bd5", fg: "#f2f6ff" },
  WAIT: { bg: "#f0c419", fg: "#1c1600" },
  STOP: { bg: "#e5483d", fg: "#fff4f2" },
  ROLL: { bg: "#c9ced6", fg: "#121418" },
};

/** Rectángulo de la cuadrícula en píxeles del canvas (la usan el dibujo y el picking de la pantalla 3D). */
export function graticuleRect(w: number, h: number): { x: number; y: number; w: number; h: number } {
  return { x: (12 / 800) * w, y: (40 / 480) * h, w: (600 / 800) * w, h: (392 / 480) * h };
}

const PREFIX: [number, string][] = [
  [1e6, "M"],
  [1e3, "k"],
  [1, ""],
  [1e-3, "m"],
  [1e-6, "µ"],
  [1e-9, "n"],
];

/** Formato de ingeniería con cifras significativas fijas y coma decimal: 1,00 ms · −2,50 V · 100 kSa/s */
export function eng(v: number, unit: string, digits = 3, signed = false): string {
  if (!isFinite(v)) return "—";
  const abs = Math.abs(v);
  let scale = 1;
  let p = "";
  if (abs > 0) {
    [scale, p] = PREFIX[PREFIX.length - 1];
    for (const [s, pr] of PREFIX) {
      if (abs >= s * 0.9995) {
        scale = s;
        p = pr;
        break;
      }
    }
  }
  const x = abs / scale;
  const dec = Math.max(0, digits - 1 - Math.floor(Math.log10(Math.max(1, x))));
  const sign = v < 0 && x.toFixed(dec) !== (0).toFixed(dec) ? "−" : signed ? "+" : "";
  return `${sign}${x.toFixed(dec).replace(".", ",")} ${p}${unit}`;
}

function font(ctx: CanvasRenderingContext2D, size: number, weight = 600, mono = false): void {
  ctx.font = `${weight} ${size}px ${mono ? '"JetBrains Mono", ui-monospace, Consolas, monospace' : '"Inter", "Segoe UI", Arial, sans-serif'}`;
}

function label(ctx: CanvasRenderingContext2D, s: string, x: number, y: number, size: number, color: string, align: CanvasTextAlign = "left", weight = 600, mono = false): number {
  font(ctx, size, weight, mono);
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(s, x, y);
  return ctx.measureText(s).width;
}

function pill(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Ícono de flanco (subida o bajada), dibujado con trazos: las flechas Unicode salen como emoji en algunos celulares. */
function slopeIcon(ctx: CanvasRenderingContext2D, x: number, y: number, s: number, rise: boolean, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = Math.max(1.5, s * 0.12);
  const lo = y + s / 2;
  const hi = y - s / 2;
  const [a, b] = rise ? [lo, hi] : [hi, lo];
  ctx.beginPath();
  ctx.moveTo(x - s * 0.6, a);
  ctx.lineTo(x, a);
  ctx.lineTo(x, b);
  ctx.lineTo(x + s * 0.6, b);
  ctx.stroke();
  // punta de flecha en el medio del flanco
  const dir = rise ? -1 : 1;
  ctx.beginPath();
  ctx.moveTo(x - s * 0.22, y - dir * s * 0.02);
  ctx.lineTo(x + s * 0.22, y - dir * s * 0.02);
  ctx.lineTo(x, y + dir * s * 0.3);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}

export interface ScopeDrawOptions {
  /** Reservado (sin uso por ahora). */
  fpsHint?: boolean;
  /** Velocidad de la simulación respecto del tiempo real (si es menor que 1 se avisa en pantalla). */
  speed?: number;
}

export function drawScope(ctx: CanvasRenderingContext2D, w: number, h: number, s: Oscilloscope, opts: ScopeDrawOptions = {}): void {
  const k = h / 480;
  const g = graticuleRect(w, h);
  const divX = g.w / HDIVS;
  const divY = g.h / VDIVS_ON_SCREEN;
  const midY = g.y + g.h / 2;
  ctx.save();
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, w, h);
  ctx.fillStyle = BAR;
  ctx.fillRect(0, 0, w, g.y - 6 * k);
  ctx.fillRect(0, g.y + g.h + 6 * k, w, h - (g.y + g.h + 6 * k));

  // ---------------------------------------------------------------- cuadrícula
  ctx.lineWidth = Math.max(1, k);
  ctx.strokeStyle = "rgba(150,160,176,0.30)";
  ctx.setLineDash([2 * k, 4 * k]);
  ctx.beginPath();
  for (let i = 1; i < HDIVS; i++) {
    const x = Math.round(g.x + i * divX) + 0.5;
    ctx.moveTo(x, g.y);
    ctx.lineTo(x, g.y + g.h);
  }
  for (let j = 1; j < VDIVS_ON_SCREEN; j++) {
    const y = Math.round(g.y + j * divY) + 0.5;
    ctx.moveTo(g.x, y);
    ctx.lineTo(g.x + g.w, y);
  }
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.strokeStyle = "rgba(170,180,196,0.55)";
  ctx.strokeRect(g.x + 0.5, g.y + 0.5, g.w, g.h);
  // ejes centrales con marcas de subdivisión (5 por división)
  ctx.beginPath();
  const cx = g.x + g.w / 2;
  for (let i = 0; i <= HDIVS * 5; i++) {
    const x = Math.round(g.x + (i * divX) / 5) + 0.5;
    const t = (i % 5 === 0 ? 6 : 3.5) * k;
    ctx.moveTo(x, midY - t);
    ctx.lineTo(x, midY + t);
  }
  for (let j = 0; j <= VDIVS_ON_SCREEN * 5; j++) {
    const y = Math.round(g.y + (j * divY) / 5) + 0.5;
    const t = (j % 5 === 0 ? 6 : 3.5) * k;
    ctx.moveTo(cx - t, y);
    ctx.lineTo(cx + t, y);
  }
  ctx.stroke();

  // ---------------------------------------------------------------- trazas y cursores (recortados a la cuadrícula)
  ctx.save();
  ctx.beginPath();
  ctx.rect(g.x, g.y, g.w, g.h);
  ctx.clip();
  const r = s.record;
  for (const c of [1, 0] as const) {
    if (!s.ch[c].on) continue;
    const vals = r.volts[c];
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i <= POINTS; i++) {
      const v = vals[i];
      if (isNaN(v)) {
        pen = false;
        continue;
      }
      const x = g.x + (i / POINTS) * g.w;
      const y = midY - s.adcDiv(c, v) * divY;
      if (pen) ctx.lineTo(x, y);
      else {
        ctx.moveTo(x, y);
        pen = true;
      }
    }
    ctx.lineJoin = "round";
    ctx.strokeStyle = CH_COLOR[c];
    ctx.globalAlpha = 0.2;
    ctx.lineWidth = 6 * k;
    ctx.stroke();
    ctx.globalAlpha = 1;
    ctx.lineWidth = 2 * k;
    ctx.stroke();
  }
  const cu = s.cursor;
  if (cu.mode !== "off") {
    for (const i of [0, 1] as const) {
      const f = i === 0 ? cu.a : cu.b;
      ctx.strokeStyle = CURSOR_COLOR[i];
      ctx.lineWidth = (cu.sel === i ? 2.4 : 1.2) * k;
      ctx.setLineDash([7 * k, 5 * k]);
      ctx.beginPath();
      if (cu.mode === "time") {
        const x = g.x + f * g.w;
        ctx.moveTo(x, g.y);
        ctx.lineTo(x, g.y + g.h);
      } else {
        const y = g.y + (1 - f) * g.h;
        ctx.moveTo(g.x, y);
        ctx.lineTo(g.x + g.w, y);
      }
      ctx.stroke();
      ctx.setLineDash([]);
      const name = i === 0 ? "A" : "B";
      if (cu.mode === "time") label(ctx, name, g.x + f * g.w + 5 * k, g.y + g.h - 12 * k, 16 * k, CURSOR_COLOR[i], "left", 800);
      else label(ctx, name, g.x + g.w - 8 * k, g.y + (1 - f) * g.h - 11 * k, 16 * k, CURSOR_COLOR[i], "right", 800);
    }
  }
  ctx.restore();

  // ---------------------------------------------------------------- marcadores
  // 0 V de cada canal, en el borde izquierdo
  for (const c of [0, 1] as const) {
    if (!s.ch[c].on) continue;
    const pos = s.ch[c].pos;
    const y = midY - Math.max(-4, Math.min(4, pos)) * divY;
    const x0 = g.x + 1;
    ctx.fillStyle = CH_COLOR[c];
    ctx.beginPath();
    if (Math.abs(pos) <= 4) {
      ctx.moveTo(x0, y - 9 * k);
      ctx.lineTo(x0 + 15 * k, y - 9 * k);
      ctx.lineTo(x0 + 23 * k, y);
      ctx.lineTo(x0 + 15 * k, y + 9 * k);
      ctx.lineTo(x0, y + 9 * k);
    } else {
      // fuera de pantalla: flecha hacia donde quedó
      const d = pos > 0 ? -1 : 1;
      ctx.moveTo(x0, y + d * 2 * k);
      ctx.lineTo(x0 + 18 * k, y + d * 2 * k);
      ctx.lineTo(x0 + 9 * k, y - d * 12 * k);
    }
    ctx.closePath();
    ctx.fill();
    if (Math.abs(pos) <= 4) label(ctx, String(c + 1), x0 + 8.5 * k, y + 0.5 * k, 14 * k, "#05070a", "center", 800);
  }
  // nivel de disparo en el borde derecho
  {
    const src = s.trig.src;
    const d = s.toDiv(src, s.trig.level);
    const y = midY - Math.max(-4, Math.min(4, d)) * divY;
    const x1 = g.x + g.w - 1;
    ctx.fillStyle = CH_COLOR[src];
    ctx.beginPath();
    ctx.moveTo(x1, y - 9 * k);
    ctx.lineTo(x1 - 15 * k, y - 9 * k);
    ctx.lineTo(x1 - 23 * k, y);
    ctx.lineTo(x1 - 15 * k, y + 9 * k);
    ctx.lineTo(x1, y + 9 * k);
    ctx.closePath();
    ctx.fill();
    label(ctx, "T", x1 - 8.5 * k, y + 0.5 * k, 13 * k, "#05070a", "center", 800);
  }
  // instante de disparo, arriba
  if (!s.roll) {
    const f = 0.5 - s.hpos / (HDIVS * s.tdiv);
    if (f >= 0 && f <= 1) {
      const x = g.x + f * g.w;
      ctx.fillStyle = "#ff9a3c";
      ctx.beginPath();
      ctx.moveTo(x - 8 * k, g.y + 1);
      ctx.lineTo(x + 8 * k, g.y + 1);
      ctx.lineTo(x + 8 * k, g.y + 11 * k);
      ctx.lineTo(x, g.y + 18 * k);
      ctx.lineTo(x - 8 * k, g.y + 11 * k);
      ctx.closePath();
      ctx.fill();
      label(ctx, "T", x, g.y + 7.5 * k, 12 * k, "#05070a", "center", 800);
    }
  }

  // ---------------------------------------------------------------- barra superior
  const barMid = (g.y - 6 * k) / 2;
  {
    const st = STATUS_STYLE[s.status];
    ctx.fillStyle = st.bg;
    pill(ctx, 10 * k, barMid - 12 * k, 82 * k, 24 * k, 5 * k);
    ctx.fill();
    label(ctx, s.status, 51 * k, barMid + 0.5 * k, 16 * k, st.fg, "center", 800);
    let x = 104 * k;
    ctx.fillStyle = "#ff9a3c";
    pill(ctx, x, barMid - 11 * k, 22 * k, 22 * k, 4 * k);
    ctx.fill();
    label(ctx, "H", x + 11 * k, barMid + 0.5 * k, 15 * k, "#05070a", "center", 800);
    x += 30 * k;
    x += label(ctx, eng(s.tdiv, "s"), x, barMid, 18 * k, INK, "left", 700, true) + 18 * k;
    if (Math.abs(s.hpos) > 1e-12) {
      label(ctx, "D", x, barMid, 16 * k, MUTED, "left", 700);
      label(ctx, eng(s.hpos, "s", 4, true), x + 16 * k, barMid, 17 * k, INK, "left", 600, true);
    }
    // disparo, a la derecha
    const src = s.trig.src;
    const xr = w - 12 * k;
    const lvl = eng(s.trig.level, "V");
    font(ctx, 18 * k, 700, true);
    const wl = ctx.measureText(lvl).width;
    label(ctx, lvl, xr, barMid, 18 * k, INK, "right", 700, true);
    const xs = xr - wl - 18 * k;
    slopeIcon(ctx, xs, barMid, 16 * k, s.trig.slope === "rise", INK);
    const xc = xs - 18 * k;
    font(ctx, 16 * k, 800);
    const wc = ctx.measureText(`CH${src + 1}`).width;
    label(ctx, `CH${src + 1}`, xc, barMid, 16 * k, CH_COLOR[src], "right", 800);
    const mode = s.trig.mode === "NORMAL" ? "NORM" : s.trig.mode;
    const xm = xc - wc - 14 * k;
    ctx.fillStyle = "#ff9a3c";
    pill(ctx, xm - 22 * k, barMid - 11 * k, 22 * k, 22 * k, 4 * k);
    ctx.fill();
    label(ctx, "T", xm - 11 * k, barMid + 0.5 * k, 15 * k, "#05070a", "center", 800);
    label(ctx, mode, xm - 30 * k, barMid, 15 * k, MUTED, "right", 700);
  }

  // ---------------------------------------------------------------- barra inferior: canales
  const by = (g.y + g.h + 6 * k + h) / 2;
  for (const c of [0, 1] as const) {
    const ch = s.ch[c];
    const x = (10 + c * 200) * k;
    const on = ch.on;
    ctx.fillStyle = on ? CH_COLOR[c] : "#2a2f37";
    pill(ctx, x, by - 13 * k, 46 * k, 26 * k, 5 * k);
    ctx.fill();
    label(ctx, `CH${c + 1}`, x + 23 * k, by + 0.5 * k, 15 * k, on ? "#05070a" : "#6b7380", "center", 800);
    label(ctx, eng(ch.vdiv, "V"), x + 56 * k, by, 18 * k, on ? INK : "#5a616c", "left", 700, true);
    const cpl = ch.coupling;
    ctx.strokeStyle = on ? (cpl === "DC" ? "rgba(230,233,238,0.5)" : CH_COLOR[c]) : "#3a404a";
    ctx.lineWidth = 1.4 * k;
    pill(ctx, x + 140 * k, by - 11 * k, 44 * k, 22 * k, 4 * k);
    ctx.stroke();
    label(ctx, cpl, x + 162 * k, by + 0.5 * k, 14 * k, on ? (cpl === "DC" ? INK : CH_COLOR[c]) : "#5a616c", "center", 800);
  }
  {
    const speed = opts.speed ?? 1;
    const xr = w - 12 * k;
    if (speed < 0.98) {
      label(ctx, `Simulación ×${speed.toFixed(2).replace(".", ",")}`, xr, by, 16 * k, "#f0b429", "right", 700);
    } else {
      label(ctx, eng(POINTS / (HDIVS * s.tdiv), "Sa/s"), xr, by, 16 * k, MUTED, "right", 600, true);
    }
  }

  // ---------------------------------------------------------------- panel derecho: mediciones y cursores
  const px = g.x + g.w + 12 * k;
  const pw = w - px - 10 * k;
  const line = 21 * k;
  let y = g.y + 12 * k;
  const row = (name: string, value: string, color = INK) => {
    label(ctx, name, px, y, 15 * k, MUTED, "left", 600);
    label(ctx, value, px + pw, y, 16 * k, color, "right", 700, true);
    y += line;
  };
  if (s.measure) {
    for (const c of [0, 1] as const) {
      if (!s.ch[c].on) continue;
      ctx.fillStyle = CH_COLOR[c];
      ctx.fillRect(px, y - 8 * k, 4 * k, 16 * k);
      label(ctx, `CH${c + 1}`, px + 10 * k, y, 16 * k, CH_COLOR[c], "left", 800);
      y += line + 1 * k;
      const m = s.measures[c];
      const amp = (v: number) => (!m ? "—" : m.clipped ? "?" : eng(v, "V"));
      row("Vpp", amp(m?.vpp ?? NaN));
      row("Prom", amp(m?.mean ?? NaN));
      row("Frec", m?.freq ? formatFreq(m.freq) : "—");
      y += 6 * k;
    }
    if (s.phase !== null) {
      label(ctx, "Fase CH2−CH1", px, y, 15 * k, MUTED, "left", 600);
      y += line;
      label(ctx, `${s.phase < 0 ? "−" : ""}${Math.abs(s.phase).toFixed(1).replace(".", ",")}°`, px + pw, y - 2 * k, 18 * k, INK, "right", 700, true);
      y += line;
    }
  }
  if (cu.mode !== "off") {
    const cv = s.cursorValues();
    const lines = cv.mode === "time" ? 4 : 3;
    let yc = g.y + g.h - (lines + 1) * line - 10 * k;
    ctx.fillStyle = "rgba(20,25,33,0.92)";
    pill(ctx, px - 6 * k, yc - 13 * k, pw + 12 * k, (lines + 1) * line + 12 * k, 6 * k);
    ctx.fill();
    const chan = cu.chan;
    label(ctx, cv.mode === "time" ? "Cursores t" : "Cursores V", px, yc, 15 * k, INK, "left", 800);
    label(ctx, `CH${chan + 1}`, px + pw, yc, 15 * k, CH_COLOR[chan], "right", 800);
    yc += line;
    const crow = (name: string, value: string, color = INK) => {
      label(ctx, name, px, yc, 15 * k, color === INK ? MUTED : color, "left", 700);
      label(ctx, value, px + pw, yc, 16 * k, color, "right", 700, true);
      yc += line;
    };
    const v = (x: number | null) => (x === null ? "—" : eng(x, "V"));
    if (cv.mode === "time") {
      crow("ΔT", eng(Math.abs(cv.dt), "s", 4));
      crow("1/ΔT", Math.abs(cv.dt) > 0 ? eng(1 / Math.abs(cv.dt), "Hz", 4) : "—");
      crow("A", v(cv.va), CURSOR_COLOR[0]);
      crow("B", v(cv.vb), CURSOR_COLOR[1]);
    } else {
      crow("A", v(cv.va), CURSOR_COLOR[0]);
      crow("B", v(cv.vb), CURSOR_COLOR[1]);
      crow("ΔV", v(cv.dv));
    }
  } else if (!s.measure) {
    label(ctx, "MEASURE:", px, y, 15 * k, MUTED, "left", 700);
    y += line;
    label(ctx, "mediciones", px, y, 15 * k, MUTED, "left", 500);
    y += line * 1.5;
    label(ctx, "CURSOR:", px, y, 15 * k, MUTED, "left", 700);
    y += line;
    label(ctx, "cursores", px, y, 15 * k, MUTED, "left", 500);
  }
  ctx.restore();
}
