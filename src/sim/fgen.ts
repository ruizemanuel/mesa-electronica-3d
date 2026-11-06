export type Wave = "sine" | "square" | "triangle";
export const WAVES: Wave[] = ["sine", "square", "triangle"];
export const WAVE_LABEL: Record<Wave, string> = { sine: "Senoidal", square: "Cuadrada", triangle: "Triangular" };
export type GenParam = "freq" | "vpp" | "offset";

/**
 * Generador de funciones de 0,1 Hz a 20 kHz con salida de 50 Ω (como los reales). La amplitud y el
 * offset que se programan son los de circuito abierto ("High-Z"): con una carga de 50 Ω llega la mitad.
 * La salida tiene un límite de ±10 V (20 Vpp), así que offset y amplitud se recortan entre sí.
 * La masa de la salida (la malla del BNC) está unida a la tierra del enchufe, igual que la del
 * osciloscopio.
 */
export class FunctionGenerator {
  readonly rout = 50;
  readonly vLimit = 10;
  readonly fMin = 0.1;
  readonly fMax = 20e3;
  wave: Wave = "sine";
  freq = 1000;
  vpp = 2;
  offset = 0;
  output = false;
  /** Parámetro que edita la perilla. */
  param: GenParam = "freq";
  /** Contador de cambios de ajuste (el banco lo usa para marcar una discontinuidad). */
  revision = 0;

  setWave(w: Wave): void {
    if (w !== this.wave) this.revision++;
    this.wave = w;
  }
  setFreq(f: number): void {
    const v = Math.min(this.fMax, Math.max(this.fMin, roundSig(f, 4)));
    if (v !== this.freq) this.revision++;
    this.freq = v;
  }
  setVpp(v: number): void {
    const max = 2 * (this.vLimit - Math.abs(this.offset));
    const x = Math.min(max, Math.max(0.002, Math.round(v * 1000) / 1000));
    if (x !== this.vpp) this.revision++;
    this.vpp = x;
  }
  setOffset(v: number): void {
    const max = this.vLimit - this.vpp / 2;
    const x = Math.min(max, Math.max(-max, Math.round(v * 1000) / 1000));
    if (x !== this.offset) this.revision++;
    this.offset = x;
  }
  setOutput(on: boolean): void {
    if (on !== this.output) this.revision++;
    this.output = on;
  }

  /** Paso de la perilla para el parámetro activo (`mult` = ×10 o ×0,1 con Shift / Alt). */
  nudge(dir: number, mult = 1): void {
    if (this.param === "freq") {
      // cambia la segunda cifra significativa: 1000 → 1100 → 1200…  (y 990 → 1000 sin saltear)
      const f = this.freq;
      const up = dir > 0;
      const mag = 10 ** Math.floor(Math.log10(up ? f : f * 0.9999) - 1);
      this.setFreq(f + dir * mag * mult);
    } else if (this.param === "vpp") this.setVpp(this.vpp + dir * 0.1 * mult);
    else this.setOffset(this.offset + dir * 0.1 * mult);
  }

  /**
   * Forma de onda normalizada (−1…1) en la fase φ ∈ [0, 1). Las tres cruzan el cero subiendo en φ = 0.
   * `left` = límite por izquierda (en un flanco de la cuadrada, el valor de justo antes).
   */
  static shape(w: Wave, phase: number, left = false): number {
    const p = phase - Math.floor(phase);
    switch (w) {
      case "sine":
        return Math.sin(2 * Math.PI * p);
      case "square":
        if (left) return p > 0 && p <= 0.5 ? 1 : -1;
        return p < 0.5 ? 1 : -1;
      case "triangle":
        return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    }
  }

  /** Tensión a circuito abierto en la fase φ (0 si la salida está apagada). */
  valueAt(phase: number, left = false): number {
    if (!this.output) return 0;
    return this.offset + (this.vpp / 2) * FunctionGenerator.shape(this.wave, phase, left);
  }

  /** Fases en las que la forma de onda salta (discontinuidades): los flancos de la cuadrada. */
  get edges(): number[] {
    return this.wave === "square" ? [0, 0.5] : [];
  }
}

export function roundSig(x: number, digits: number): number {
  if (x === 0 || !isFinite(x)) return x;
  const p = 10 ** (digits - 1 - Math.floor(Math.log10(Math.abs(x))));
  return Math.round(x * p) / p;
}

/** Frecuencia legible: 1,59 kHz · 50,0 Hz */
export function formatFreq(f: number): string {
  const [v, u] = f >= 1e3 ? [f / 1e3, "kHz"] : [f, "Hz"];
  const txt = v >= 100 ? v.toFixed(1) : v >= 10 ? v.toFixed(2) : v.toFixed(3);
  return `${txt.replace(".", ",")} ${u}`;
}
