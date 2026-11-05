import type { Netlist } from "./mna";
import { Rng } from "./rng";

export type PsuMode = "CV" | "CC" | "OFF";

/**
 * Fuente de laboratorio lineal 0–30 V / 0–3 A con limitación de corriente (CV/CC).
 * Los displays tienen su propia exactitud (±(0,5 % + 2 díg.)) distinta de la del multímetro.
 */
export class BenchSupply {
  readonly vMax = 30;
  readonly iMax = 3;
  readonly rout = 0.002; // Ω en modo CV
  vset = 5.0;
  iset = 0.1;
  output = false;
  mode: PsuMode = "OFF";
  /** Valores verdaderos en bornes. */
  vout = 0;
  iout = 0;
  /** Hasta cuándo (tiempo de sim) el display muestra el valor programado tras girar una perilla. */
  showSetUntil = -1;
  private readonly vGain: number;
  private readonly vOff: number;
  private readonly iGain: number;
  private readonly iOff: number;
  private dispV = 0;
  private dispI = 0;
  private dispTimer = 0;

  constructor(rng: Rng) {
    this.vGain = rng.gaussTrunc(0.5e-2 / 3, 2);
    this.vOff = rng.uniform(-1.2, 1.2) * 0.01;
    this.iGain = rng.gaussTrunc(0.5e-2 / 3, 2);
    this.iOff = rng.uniform(-1.2, 1.2) * 0.001;
  }

  setVoltage(v: number, now: number): void {
    this.vset = Math.min(this.vMax, Math.max(0, Math.round(v * 100) / 100));
    this.showSetUntil = now + 1.5;
  }
  setCurrent(i: number, now: number): void {
    this.iset = Math.min(this.iMax, Math.max(0, Math.round(i * 1000) / 1000));
    this.showSetUntil = now + 1.5;
  }

  /** Estampa la fuente en el netlist entre los bornes `pos` y `neg`. */
  stamp(net: Netlist, mode: PsuMode, pos: string, neg: string): void {
    if (mode === "CV") {
      net.v("psu:V", "psu:int", neg, this.vset);
      net.r("psu:rout", "psu:int", pos, this.rout);
    } else if (mode === "CC") {
      net.i("psu:I", neg, pos, this.iset);
      net.r("psu:rshunt", pos, neg, 1e7); // impedancia de salida finita en CC
    }
  }

  /** Actualiza lecturas internas (dt en s). */
  update(vout: number, iout: number, mode: PsuMode, dt: number): void {
    this.vout = vout;
    this.iout = iout;
    this.mode = mode;
    this.dispTimer -= dt;
    if (this.dispTimer <= 0) {
      this.dispTimer = 0.25;
      this.dispV = vout * (1 + this.vGain) + this.vOff;
      this.dispI = iout * (1 + this.iGain) + this.iOff;
    }
  }

  /** Lo que muestran los displays (V con 2 decimales, A con 3). */
  display(now: number): { v: string; a: string; showingSet: boolean } {
    const showingSet = !this.output || now < this.showSetUntil;
    const v = showingSet ? this.vset : Math.max(0, this.dispV);
    const a = showingSet ? this.iset : Math.max(0, this.dispI);
    return { v: v.toFixed(2).padStart(5, "0"), a: a.toFixed(3), showingSet };
  }
}
