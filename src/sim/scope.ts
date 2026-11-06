import { Rng } from "./rng";

/**
 * Osciloscopio digital de 2 canales, 8 divisiones verticales × 10 horizontales, con puntas ×10
 * (10 MΩ). Las escalas se indican en la punta, como en los reales.
 *
 * Adquisición: el banco le pasa una muestra por paso de la simulación (`push`). Se guardan en un
 * buffer circular espaciadas por lo menos un intervalo de muestreo (10·t/div ÷ 1000), así a escalas
 * lentas se diezma (y, como en un osciloscopio real, una señal rápida puede aparecer "alias"). La
 * pantalla se arma interpolando 1001 puntos alrededor del instante de disparo, que se calcula con
 * precisión de fracción de muestra: así la traza queda quieta.
 *
 * Disparo por flanco con histéresis (0,15 div), modos AUTO / NORMAL / SINGLE y RUN/STOP. A partir de
 * 100 ms/div pasa a modo ROLL. Acoplamiento DC, AC (pasaaltos de ≈ 7 Hz) o GND por canal. El
 * conversor es de 8 bits (25 niveles por división) con ruido de ≈ 0,4 niveles y recorta a ±5 div.
 */
export const VDIVS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10];
export const TDIVS = [1e-6, 2e-6, 5e-6, 1e-5, 2e-5, 5e-5, 1e-4, 2e-4, 5e-4, 1e-3, 2e-3, 5e-3, 1e-2, 2e-2, 5e-2, 0.1, 0.2, 0.5, 1];
export const HDIVS = 10;
export const VDIVS_ON_SCREEN = 8;
/** Puntos de la traza en pantalla (0…POINTS). */
export const POINTS = 1000;
/** Niveles del conversor por división (8 bits sobre ±5,12 div). */
export const ADC_PER_DIV = 25;
export const ADC_LIMIT = 5.12;
export const ROLL_TDIV = 0.1;
/** Impedancia de entrada con la punta ×10. */
export const PROBE_R = 10e6;

export type Coupling = "DC" | "AC" | "GND";
export type TrigMode = "AUTO" | "NORMAL" | "SINGLE";
export type Slope = "rise" | "fall";
export type CursorMode = "off" | "time" | "volt";
export type ScopeStatus = "AUTO" | "TRIG'D" | "WAIT" | "STOP" | "ROLL";

export interface Channel {
  on: boolean;
  vdiv: number;
  /** Posición vertical (div): la traza se corre esta cantidad de divisiones. */
  pos: number;
  coupling: Coupling;
}

export interface Measure {
  vmax: number;
  vmin: number;
  vpp: number;
  mean: number;
  rms: number;
  freq: number | null;
  /** Instante (desde el comienzo de la pantalla) del primer cruce subiendo por el nivel medio. */
  cross: number | null;
  /** La señal se sale del rango del conversor: las mediciones no son válidas. */
  clipped: boolean;
}

export interface ScopeRecord {
  /** Tensión de cada punto (V, ya con acoplamiento y ruido); NaN donde no hay datos. */
  volts: [Float32Array, Float32Array];
  /** Instante del primer punto respecto del disparo (s) y separación entre puntos. */
  t0: number;
  dt: number;
  triggered: boolean;
  /** Cambia con cada adquisición nueva (para redibujar solo cuando hace falta). */
  stamp: number;
}

const nextUp = (list: number[], x: number) => list.find((v) => v >= x * 0.999) ?? list[list.length - 1];

/** Estadística rápida de cada canal para AUTOSET (ventana de 0,2 s en dos mitades). */
class Tracker {
  private cur = { max: -Infinity, min: Infinity, sum: 0, dur: 0, t0: 0, crosses: 0, first: NaN, last: NaN };
  private prev = { ...this.cur };
  private above = false;
  private lastT = NaN;
  feed(t: number, v: number): void {
    if (isNaN(this.lastT)) {
      this.lastT = t;
      this.cur.t0 = t;
      return;
    }
    const dt = t - this.lastT;
    const c = this.cur;
    c.max = Math.max(c.max, v);
    c.min = Math.min(c.min, v);
    c.sum += v * dt;
    c.dur += dt;
    const ref = this.prev.dur > 0 ? this.prev : c;
    const mid = (ref.max + ref.min) / 2;
    const hyst = 0.1 * (ref.max - ref.min);
    if (!this.above && v > mid + hyst && ref.max - ref.min > 1e-3) {
      this.above = true;
      c.crosses++;
      if (isNaN(c.first)) c.first = t;
      c.last = t;
    } else if (this.above && v < mid - hyst) this.above = false;
    this.lastT = t;
    if (t - c.t0 >= 0.1) {
      this.prev = { ...c };
      this.cur = { max: -Infinity, min: Infinity, sum: 0, dur: 0, t0: t, crosses: 0, first: NaN, last: NaN };
    }
  }
  stats(): { max: number; min: number; mean: number; period: number | null } | null {
    const a = this.prev.dur > 0 ? this.prev : this.cur;
    if (!(a.dur > 0)) return null;
    const b = this.cur;
    const max = Math.max(a.max, b.max);
    const min = Math.min(a.min, b.min);
    const mean = (a.sum + (a === b ? 0 : b.sum)) / (a.dur + (a === b ? 0 : b.dur));
    const period = a.crosses >= 2 ? (a.last - a.first) / (a.crosses - 1) : null;
    return { max, min, mean, period };
  }
  reset(): void {
    this.cur = { max: -Infinity, min: Infinity, sum: 0, dur: 0, t0: 0, crosses: 0, first: NaN, last: NaN };
    this.prev = { ...this.cur };
    this.lastT = NaN;
  }
}

export class Oscilloscope {
  readonly ch: [Channel, Channel] = [
    { on: true, vdiv: 1, pos: 0, coupling: "DC" },
    { on: true, vdiv: 1, pos: 0, coupling: "DC" },
  ];
  tdiv = 1e-3;
  /** Posición horizontal: corrimiento del instante de disparo respecto del centro (s). */
  hpos = 0;
  readonly trig: { src: 0 | 1; slope: Slope; level: number; mode: TrigMode } = { src: 0, slope: "rise", level: 0, mode: "AUTO" };
  running = true;
  /** Cursores: posiciones como fracción de la pantalla (0…1, de izquierda a derecha o de abajo arriba). */
  readonly cursor: { mode: CursorMode; a: number; b: number; sel: 0 | 1; chan: 0 | 1 } = { mode: "off", a: 0.3, b: 0.6, sel: 0, chan: 0 };
  measure = true;
  status: ScopeStatus = "AUTO";
  record: ScopeRecord;
  measures: [Measure | null, Measure | null] = [null, null];
  /** Desfasaje de CH2 respecto de CH1 (grados; negativo = CH2 atrasa). */
  phase: number | null = null;

  private readonly cap = 8192;
  private readonly tBuf = new Float64Array(this.cap);
  private readonly vBuf: [Float32Array, Float32Array] = [new Float32Array(this.cap), new Float32Array(this.cap)];
  /** Índice absoluto de la muestra más nueva (-1: vacío). */
  private head = -1;
  private count = 0;
  private hp = [
    { x: 0, y: 0 },
    { x: 0, y: 0 },
  ];
  private trigArmed = false;
  private trigPrev = NaN;
  private readonly trigEvents = new Float64Array(64);
  private trigN = 0;
  private lastShownTrig = -Infinity;
  private lastShownAt = -Infinity;
  private lastPushT = NaN;
  private stampN = 0;
  private readonly rng: Rng;
  private readonly trackers = [new Tracker(), new Tracker()];
  private settingsKey = "";

  constructor(seed = 7) {
    this.rng = new Rng(seed);
    this.record = { volts: [new Float32Array(POINTS + 1).fill(NaN), new Float32Array(POINTS + 1).fill(NaN)], t0: -5 * this.tdiv, dt: (HDIVS * this.tdiv) / POINTS, triggered: false, stamp: 0 };
  }

  /** Intervalo de muestreo para la base de tiempo actual. */
  get ts(): number {
    return (HDIVS * this.tdiv) / POINTS;
  }
  get span(): number {
    return HDIVS * this.tdiv;
  }
  get roll(): boolean {
    return this.tdiv >= ROLL_TDIV * 0.999;
  }
  /** Muestras guardadas (para tests y diagnóstico). */
  get stored(): number {
    return this.count;
  }

  /** Borra lo adquirido (al cambiar la base de tiempo, como un osciloscopio real). */
  clear(): void {
    this.head = -1;
    this.count = 0;
    this.trigN = 0;
    this.trigArmed = false;
    this.trigPrev = NaN;
    this.lastShownTrig = -Infinity;
    this.lastShownAt = -Infinity;
    this.lastPushT = NaN;
  }

  setTdiv(t: number): void {
    const v = nextUp(TDIVS, t);
    if (v === this.tdiv) return;
    this.tdiv = v;
    this.hpos = Math.max(-5 * v, Math.min(5 * v, this.hpos));
    this.clear();
  }
  stepTdiv(dir: number): void {
    const i = TDIVS.indexOf(this.tdiv);
    this.setTdiv(TDIVS[Math.max(0, Math.min(TDIVS.length - 1, i + dir))]);
  }
  stepVdiv(c: 0 | 1, dir: number): void {
    const i = VDIVS.indexOf(this.ch[c].vdiv);
    const old = this.ch[c].vdiv;
    this.ch[c].vdiv = VDIVS[Math.max(0, Math.min(VDIVS.length - 1, i + dir))];
    // la posición se mantiene en volts (el nivel de 0 V no salta al cambiar de escala)
    this.ch[c].pos = Math.max(-4, Math.min(4, (this.ch[c].pos * old) / this.ch[c].vdiv));
  }

  // ------------------------------------------------------------------ adquisición

  /** Muestra de los dos canales (tensión de la punta respecto de la tierra) en el instante t. */
  push(t: number, v1: number, v2: number): void {
    this.trackers[0].feed(t, v1);
    this.trackers[1].feed(t, v2);
    if (!isNaN(this.lastPushT) && t < this.lastPushT + this.ts * 0.999) return;
    const dt = isNaN(this.lastPushT) ? 0 : t - this.lastPushT;
    this.lastPushT = t;
    const k = (this.head + 1) % this.cap;
    this.head++;
    this.count = Math.min(this.cap, this.count + 1);
    this.tBuf[k] = t;
    const raw = [v1, v2];
    for (let c = 0; c < 2; c++) {
      const ch = this.ch[c];
      let v = raw[c];
      const hp = this.hp[c];
      // pasaaltos de 1.er orden de ≈ 7 Hz (el capacitor de acoplamiento de la entrada)
      const a = dt > 0 ? 0.0227 / (0.0227 + dt) : 1;
      hp.y = a * (hp.y + v - hp.x);
      hp.x = v;
      if (ch.coupling === "AC") v = hp.y;
      else if (ch.coupling === "GND") v = 0;
      this.vBuf[c][k] = v;
    }
    this.detectTrigger(t);
  }

  private detectTrigger(t: number): void {
    const k = this.head % this.cap;
    const src = this.trig.src;
    const v = this.vBuf[src][k];
    const lvl = this.trig.level;
    const hyst = 0.15 * this.ch[src].vdiv;
    const rise = this.trig.slope === "rise";
    const prev = this.trigPrev;
    this.trigPrev = v;
    if (isNaN(prev)) return;
    if (rise ? v < lvl - hyst : v > lvl + hyst) this.trigArmed = true;
    if (this.trigArmed && (rise ? prev < lvl && v >= lvl : prev > lvl && v <= lvl)) {
      const tp = this.tBuf[(this.head - 1 + this.cap) % this.cap];
      const f = (lvl - prev) / (v - prev);
      this.trigEvents[this.trigN % this.trigEvents.length] = tp + (t - tp) * (isFinite(f) ? f : 1);
      this.trigN++;
      this.trigArmed = false;
    }
  }

  private get newest(): number {
    return this.head < 0 ? NaN : this.tBuf[this.head % this.cap];
  }
  private get oldest(): number {
    return this.count === 0 ? NaN : this.tBuf[(this.head - this.count + 1 + this.cap * 4) % this.cap];
  }

  /** Interpola el buffer en los instantes t0 + i·dt. */
  private sample(t0: number, dt: number, out: [Float32Array, Float32Array]): void {
    const n = this.count;
    const base = this.head - n + 1;
    const at = (i: number) => this.tBuf[(base + i + this.cap * 4) % this.cap];
    // primera muestra con t ≥ t0 (búsqueda binaria)
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (at(mid) < t0) lo = mid + 1;
      else hi = mid;
    }
    let j = Math.max(1, lo);
    for (let i = 0; i <= POINTS; i++) {
      const t = t0 + i * dt;
      while (j < n - 1 && at(j) < t) j++;
      const ta = at(j - 1);
      const tb = at(j);
      for (let c = 0; c < 2; c++) {
        if (n < 2 || t < ta - 1e-12 || t > tb + 1e-12) {
          out[c][i] = NaN;
          continue;
        }
        const ka = (base + j - 1 + this.cap * 4) % this.cap;
        const kb = (base + j + this.cap * 4) % this.cap;
        const f = tb > ta ? (t - ta) / (tb - ta) : 0;
        const noise = this.rng.gaussTrunc(0.4 / ADC_PER_DIV, 3) * this.ch[c].vdiv;
        out[c][i] = this.vBuf[c][ka] + (this.vBuf[c][kb] - this.vBuf[c][ka]) * f + noise;
      }
    }
  }

  private build(tTrig: number, triggered: boolean): void {
    const dt = this.ts;
    const t0 = triggered ? tTrig + this.hpos - 5 * this.tdiv : tTrig - this.span;
    this.sample(t0, dt, this.record.volts);
    this.record.t0 = triggered ? this.hpos - 5 * this.tdiv : -this.span;
    this.record.dt = dt;
    this.record.triggered = triggered;
    this.record.stamp = ++this.stampN;
    this.computeMeasures();
  }

  /** Decide qué mostrar (una vez por cuadro). */
  update(): void {
    const key = JSON.stringify([this.ch, this.tdiv, this.hpos]);
    const settingsChanged = key !== this.settingsKey;
    this.settingsKey = key;
    if (!this.running) {
      this.status = "STOP";
      if (settingsChanged) this.computeMeasures();
      return;
    }
    const tN = this.newest;
    if (isNaN(tN)) return;
    if (this.roll) {
      this.status = "ROLL";
      this.build(tN, false);
      return;
    }
    const tOld = this.oldest;
    let found = NaN;
    const n = Math.min(this.trigN, this.trigEvents.length);
    for (let i = 0; i < n; i++) {
      const te = this.trigEvents[(this.trigN - 1 - i) % this.trigEvents.length];
      if (te <= this.lastShownTrig) break;
      if (te + this.hpos + 5 * this.tdiv <= tN && te + this.hpos - 5 * this.tdiv >= tOld) {
        found = te;
        break;
      }
    }
    if (!isNaN(found)) {
      this.lastShownTrig = found;
      this.lastShownAt = tN;
      this.build(found, true);
      this.status = "TRIG'D";
      if (this.trig.mode === "SINGLE") {
        this.running = false;
        this.status = "STOP";
      }
      return;
    }
    const waited = tN - this.lastShownAt;
    if (this.trig.mode === "AUTO" && waited > Math.max(3 * this.span, 0.06)) {
      if (tN - this.span >= tOld || this.count > 1) this.build(tN, false);
      this.status = "AUTO";
    } else if (waited > Math.max(3 * this.span, 0.06)) {
      this.status = "WAIT";
      if (settingsChanged) this.computeMeasures();
    } else if (settingsChanged) this.computeMeasures();
  }

  /** RUN/STOP. En SINGLE, RUN vuelve a armar el disparo. */
  toggleRun(): void {
    this.running = !this.running;
    if (this.running) this.lastShownTrig = this.newest;
  }
  single(): void {
    this.trig.mode = "SINGLE";
    this.running = true;
    this.lastShownTrig = this.newest;
    this.status = "WAIT";
  }

  // ------------------------------------------------------------------ pantalla y mediciones

  /** Posición vertical en divisiones (desde el centro) de una tensión del canal c, sin recortar. */
  toDiv(c: 0 | 1, v: number): number {
    return v / this.ch[c].vdiv + this.ch[c].pos;
  }
  /** Lo que muestra el conversor: cuantizado a 25 niveles/div y recortado a ±5,12 div. */
  adcDiv(c: 0 | 1, v: number): number {
    const d = Math.round(this.toDiv(c, v) * ADC_PER_DIV) / ADC_PER_DIV;
    return Math.max(-ADC_LIMIT, Math.min(ADC_LIMIT, d));
  }

  private computeMeasures(): void {
    const r = this.record;
    for (const c of [0, 1] as const) {
      if (!this.ch[c].on) {
        this.measures[c] = null;
        continue;
      }
      const vd = this.ch[c].vdiv;
      const pos = this.ch[c].pos;
      let n = 0;
      let max = -Infinity;
      let min = Infinity;
      let clipped = false;
      const q = new Float64Array(POINTS + 1);
      for (let i = 0; i <= POINTS; i++) {
        const raw = r.volts[c][i];
        if (isNaN(raw)) {
          q[i] = NaN;
          continue;
        }
        const d = this.adcDiv(c, raw);
        if (Math.abs(d) >= ADC_LIMIT) clipped = true;
        const v = (d - pos) * vd;
        q[i] = v;
        max = Math.max(max, v);
        min = Math.min(min, v);
        n++;
      }
      if (n < 2) {
        this.measures[c] = null;
        continue;
      }
      const vpp = max - min;
      const mid = (max + min) / 2;
      const hyst = 0.1 * vpp;
      const crosses: number[] = [];
      if (vpp > 0.4 * vd) {
        let armed = false;
        for (let i = 1; i <= POINTS; i++) {
          const a = q[i - 1];
          const b = q[i];
          if (isNaN(a) || isNaN(b)) continue;
          if (a < mid - hyst) armed = true;
          if (armed && a < mid && b >= mid) {
            crosses.push((i - 1 + (mid - a) / (b - a)) * r.dt);
            armed = false;
          }
        }
      }
      // promedio y valor eficaz sobre un número entero de períodos si se puede
      const [i0, i1] = crosses.length >= 2 ? [Math.ceil(crosses[0] / r.dt), Math.floor(crosses[crosses.length - 1] / r.dt)] : [0, POINTS];
      let s = 0;
      let s2 = 0;
      let m = 0;
      for (let i = i0; i <= i1; i++) {
        if (isNaN(q[i])) continue;
        s += q[i];
        s2 += q[i] * q[i];
        m++;
      }
      const freq = crosses.length >= 2 ? (crosses.length - 1) / (crosses[crosses.length - 1] - crosses[0]) : null;
      this.measures[c] = { vmax: max, vmin: min, vpp, mean: s / m, rms: Math.sqrt(s2 / m), freq, cross: crosses[0] ?? null, clipped };
    }
    const [a, b] = this.measures;
    if (a && b && a.freq && b.freq && a.cross !== null && b.cross !== null && Math.abs(a.freq - b.freq) < 0.05 * a.freq) {
      const T = 1 / a.freq;
      let d = (b.cross - a.cross) / T;
      d -= Math.round(d);
      this.phase = -360 * d;
      if (this.phase <= -180) this.phase += 360;
    } else this.phase = null;
  }

  /** Lecturas de los cursores para la pantalla y el panel. */
  cursorValues(): { mode: CursorMode; ta: number; tb: number; dt: number; va: number | null; vb: number | null; dv: number | null } {
    const cu = this.cursor;
    const c = cu.chan;
    if (cu.mode === "time") {
      const r = this.record;
      const at = (f: number) => {
        const x = f * POINTS;
        const i = Math.floor(x);
        const a = r.volts[c][Math.max(0, Math.min(POINTS, i))];
        const b = r.volts[c][Math.max(0, Math.min(POINTS, i + 1))];
        const v = a + (b - a) * (x - i);
        if (isNaN(v)) return null;
        // la tensión que muestra el conversor en ese punto
        return (this.adcDiv(c, v) - this.ch[c].pos) * this.ch[c].vdiv;
      };
      const ta = r.t0 + cu.a * this.span;
      const tb = r.t0 + cu.b * this.span;
      const va = at(cu.a);
      const vb = at(cu.b);
      return { mode: "time", ta, tb, dt: tb - ta, va, vb, dv: va !== null && vb !== null ? vb - va : null };
    }
    const toV = (f: number) => ((f - 0.5) * VDIVS_ON_SCREEN - this.ch[c].pos) * this.ch[c].vdiv;
    const va = toV(cu.a);
    const vb = toV(cu.b);
    return { mode: cu.mode, ta: 0, tb: 0, dt: 0, va, vb, dv: vb - va };
  }

  /**
   * AUTOSET: escala vertical para que la señal ocupe ≈ 6 div, base de tiempo para ver 2 a 3 períodos
   * y disparo en el nivel medio del canal con señal periódica. Como en los reales, necesita una señal
   * de más de ≈ 10 Hz para encontrar el período.
   */
  autoset(): void {
    let trigCh: 0 | 1 | null = null;
    let period: number | null = null;
    for (const c of [0, 1] as const) {
      const s = this.trackers[c].stats();
      const ch = this.ch[c];
      ch.coupling = "DC";
      if (!s) continue;
      const vpp = s.max - s.min;
      const peak = Math.max(Math.abs(s.max), Math.abs(s.min));
      if (vpp < 0.01 && peak < 0.01) continue;
      ch.on = true;
      ch.vdiv = vpp > 0.02 ? nextUp(VDIVS, vpp / 6) : nextUp(VDIVS, peak / 3);
      ch.pos = Math.max(-4, Math.min(4, -((s.max + s.min) / 2) / ch.vdiv));
      if (s.period && trigCh === null) {
        trigCh = c;
        period = s.period;
        this.trig.level = (s.max + s.min) / 2;
      }
    }
    if (trigCh !== null && period) {
      this.trig.src = trigCh;
      this.setTdiv(nextUp(TDIVS, (2.5 * period) / HDIVS));
    }
    this.trig.slope = "rise";
    this.trig.mode = "AUTO";
    this.hpos = 0;
    this.running = true;
    this.clear();
  }
}
