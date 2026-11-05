import type { Netlist, Solution } from "./mna";
import { Rng, hashSeed } from "./rng";

export type Dial = "OFF" | "VAC" | "VDC" | "mVDC" | "OHM" | "CONT" | "mA" | "A";
/** Orden físico de la llave selectora (sentido horario). */
export const DIAL_POSITIONS: Dial[] = ["OFF", "VAC", "VDC", "mVDC", "OHM", "CONT", "mA", "A"];
export const DIAL_LABEL: Record<Dial, string> = {
  OFF: "OFF",
  VAC: "V~",
  VDC: "V⎓",
  mVDC: "mV⎓",
  OHM: "Ω",
  CONT: "·)))",
  mA: "mA⎓",
  A: "A⎓",
};
export type Jack = "VOhm" | "mA" | "A";

export interface Range {
  /** Fondo de escala en unidades base (V, A, Ω). */
  fs: number;
  /** Resolución en unidades base. */
  res: number;
  unit: string;
  /** Factor de la unidad mostrada (mV → 1e-3). */
  mult: number;
  /** Exactitud ±(pct % de lectura + dgt dígitos). */
  pct: number;
  dgt: number;
  maxCounts: number;
}
const R = (fs: number, res: number, unit: string, mult: number, pct: number, dgt: number, maxCounts = 6000): Range => ({
  fs,
  res,
  unit,
  mult,
  pct,
  dgt,
  maxCounts,
});

export const RANGES: Record<Exclude<Dial, "OFF">, Range[]> = {
  VDC: [R(6, 1e-3, "V", 1, 0.5, 2), R(60, 1e-2, "V", 1, 0.5, 2), R(600, 0.1, "V", 1, 0.5, 2), R(1000, 1, "V", 1, 0.5, 2, 1000)],
  mVDC: [R(0.6, 1e-4, "mV", 1e-3, 0.5, 2)],
  VAC: [R(6, 1e-3, "V", 1, 1.0, 3), R(60, 1e-2, "V", 1, 1.0, 3), R(600, 0.1, "V", 1, 1.0, 3), R(750, 1, "V", 1, 1.0, 3, 750)],
  OHM: [
    R(600, 0.1, "Ω", 1, 0.8, 3),
    R(6e3, 1, "kΩ", 1e3, 0.5, 2),
    R(60e3, 10, "kΩ", 1e3, 0.5, 2),
    R(600e3, 100, "kΩ", 1e3, 0.5, 2),
    R(6e6, 1e3, "MΩ", 1e6, 0.8, 3),
    R(60e6, 1e4, "MΩ", 1e6, 1.5, 3),
  ],
  CONT: [R(600, 0.1, "Ω", 1, 0.8, 3)],
  mA: [R(0.06, 1e-5, "mA", 1e-3, 0.8, 3), R(0.6, 1e-4, "mA", 1e-3, 0.8, 3)],
  A: [R(6, 1e-3, "A", 1, 1.2, 3), R(10, 1e-2, "A", 1, 1.2, 3, 1000)],
};

export const decimalsOf = (r: Range): number => Math.max(0, Math.round(-Math.log10(r.res / r.mult)));

/** Fusible con modelo I²t simplificado: t_fusión ≈ k / ((I/In)² − 1). */
export class Fuse {
  heat = 0;
  blown = false;
  constructor(
    readonly rating: number,
    readonly k: number,
    readonly label: string,
  ) {}
  step(i: number, dt: number): boolean {
    if (this.blown) return false;
    const r = Math.abs(i) / this.rating;
    if (r > 1.1) {
      this.heat += (dt * (r * r - 1)) / this.k;
      if (this.heat >= 1) {
        this.blown = true;
        return true;
      }
    } else {
      this.heat = Math.max(0, this.heat - dt / 5);
    }
    return false;
  }
  replace(): void {
    this.heat = 0;
    this.blown = false;
  }
}

export interface DmmDisplay {
  on: boolean;
  /** Texto de 7 segmentos: "-4.702", "OL", "LEAd", "" */
  text: string;
  unit: string;
  acdc: "DC" | "AC" | "";
  auto: boolean;
  hold: boolean;
  rel: boolean;
  beep: boolean;
  continuity: boolean;
  /** Barra analógica 0..1 */
  bar: number;
  /** Valor mostrado en unidades base (null si OL / apagado / alerta). */
  value: number | null;
  baseUnit: "V" | "A" | "Ω" | "";
  range: Range | null;
  leadAlert: boolean;
}

const EMPTY: DmmDisplay = {
  on: false,
  text: "",
  unit: "",
  acdc: "",
  auto: false,
  hold: false,
  rel: false,
  beep: false,
  continuity: false,
  bar: 0,
  value: null,
  baseUnit: "",
  range: null,
  leadAlert: false,
};

export const NODE = {
  COM: "dmm:COM",
  VOhm: "dmm:VOhm",
  mA: "dmm:mA",
  A: "dmm:A",
} as const;

/**
 * Multímetro digital de 6000 cuentas, autorango, modelado eléctricamente:
 * - V: 10 MΩ entre VΩ y COM (provoca el efecto de carga real).
 * - Ω: medición ratiométrica con fuente de prueba de 1 V y resistencia de referencia por rango.
 * - mA: shunt + fusible 440 mA (caída 1,8 mV/mA). A: shunt + fusible 11 A (30 mV/A).
 * Las bornas mA y A tienen el shunt SIEMPRE conectado: medir tensión con la punta en la borna
 * de corriente es un cortocircuito, como en la vida real.
 */
export class Multimeter {
  dial: Dial = "OFF";
  red: Jack = "VOhm";
  auto = true;
  rangeIdx = 0;
  hold = false;
  relRef: number | null = null;
  readonly rin = 10e6;
  readonly rMa = 1.8;
  readonly rA = 0.03;
  readonly ohmVs = 1.0;
  readonly fuseMa = new Fuse(0.44, 0.5, "F 440 mA / 1000 V");
  readonly fuseA = new Fuse(11, 10, "F 11 A / 1000 V");
  display: DmmDisplay = { ...EMPTY };
  private readonly calib = new Map<string, { gain: number; off: number }>();
  private updateTimer = 0;
  private lastRaw = 0;

  /**
   * `rng` alimenta el ruido de cada lectura; `calSeed` fija la "personalidad" de calibración del
   * instrumento: cada rango tiene su error de ganancia y offset propio, independiente del orden de uso.
   */
  constructor(
    private readonly rng: Rng,
    private readonly calSeed = 1,
  ) {}

  ranges(): Range[] {
    return this.dial === "OFF" ? [] : RANGES[this.dial];
  }
  get range(): Range | null {
    return this.ranges()[this.rangeIdx] ?? null;
  }

  setDial(d: Dial): void {
    if (d === this.dial) return;
    this.dial = d;
    this.rangeIdx = 0;
    this.auto = true;
    this.hold = false;
    this.relRef = null;
    this.updateTimer = 0;
  }
  rotate(step: number): void {
    const i = DIAL_POSITIONS.indexOf(this.dial);
    const j = Math.min(DIAL_POSITIONS.length - 1, Math.max(0, i + step));
    this.setDial(DIAL_POSITIONS[j]);
  }
  pressRange(): void {
    const n = this.ranges().length;
    if (n <= 1) return;
    if (this.auto) this.auto = false;
    else if (this.rangeIdx + 1 >= n) {
      this.auto = true;
      this.rangeIdx = 0;
    } else this.rangeIdx++;
    this.relRef = null;
    this.updateTimer = 0;
  }
  pressHold(): void {
    if (this.dial === "OFF") return;
    this.hold = !this.hold;
  }
  pressRel(): void {
    if (this.dial === "OFF") return;
    if (this.relRef !== null) this.relRef = null;
    else if (this.display.value !== null) {
      this.relRef = this.display.value + (this.relRef ?? 0);
      this.auto = false;
    }
    this.updateTimer = 0;
  }

  get ohmMode(): boolean {
    return this.dial === "OHM" || this.dial === "CONT";
  }
  /** Resistencia de referencia del óhmetro para un rango. */
  rref(rangeIdx: number): number {
    const r = RANGES[this.dial === "CONT" ? "CONT" : "OHM"][rangeIdx] ?? RANGES.OHM[0];
    return r.fs / 2;
  }

  /** Agrega los elementos internos del instrumento al netlist. */
  stamp(net: Netlist, ohmRangeIdx: number): void {
    if (this.dial === "VDC" || this.dial === "VAC" || this.dial === "mVDC") {
      net.r("dmm:rin", NODE.VOhm, NODE.COM, this.rin);
    } else if (this.ohmMode) {
      net.v("dmm:ohmV", "dmm:ohmSrc", NODE.COM, this.ohmVs);
      net.r("dmm:rref", "dmm:ohmSrc", NODE.VOhm, this.rref(Math.max(0, ohmRangeIdx)));
    }
    if (!this.fuseMa.blown) net.r("dmm:shMa", NODE.mA, NODE.COM, this.rMa);
    if (!this.fuseA.blown) net.r("dmm:shA", NODE.A, NODE.COM, this.rA);
  }

  /** Rango de óhmetro a usar al resolver el circuito "en régimen". */
  ohmRangeForStep(): number {
    return this.ohmMode ? this.rangeIdx : -1;
  }

  private rawValue(sol: Solution, ohmRangeIdx: number): number {
    switch (this.dial) {
      case "VDC":
      case "mVDC":
        return sol.vab(NODE.VOhm, NODE.COM);
      case "VAC":
        return 0; // señal continua pura: acoplamiento de AC la bloquea
      case "OHM":
      case "CONT": {
        const vx = sol.vab(NODE.VOhm, NODE.COM);
        const den = this.ohmVs - vx;
        if (den <= 1e-12) return Infinity;
        return (this.rref(ohmRangeIdx) * vx) / den;
      }
      case "mA":
        return sol.hasResistor("dmm:shMa") ? sol.iR("dmm:shMa") : 0;
      case "A":
        return sol.hasResistor("dmm:shA") ? sol.iR("dmm:shA") : 0;
      default:
        return 0;
    }
  }

  private cal(rangeKey: string, r: Range): { gain: number; off: number } {
    let c = this.calib.get(rangeKey);
    if (!c) {
      const cr = new Rng(hashSeed(rangeKey, this.calSeed));
      c = {
        gain: cr.gaussTrunc((r.pct * 1e-2) / 3, 2.2),
        off: cr.uniform(-0.6, 0.6) * r.dgt,
      };
      this.calib.set(rangeKey, c);
    }
    return c;
  }

  get leadAlert(): boolean {
    return (this.red === "A" && this.dial !== "A" && this.dial !== "OFF") || (this.red === "mA" && this.dial !== "mA" && this.dial !== "OFF");
  }

  /**
   * Actualiza el display (≈3 lecturas/s, como un DMM real).
   * `solveAt(r)` devuelve la solución del circuito con el óhmetro en el rango r (-1 = no óhmetro).
   */
  update(dt: number, solveAt: (ohmRange: number) => Solution, force = false): void {
    if (this.dial === "OFF") {
      this.display = { ...EMPTY };
      return;
    }
    this.updateTimer -= dt;
    if (!force && this.updateTimer > 0) return;
    this.updateTimer = 0.33;

    const ranges = this.ranges();
    const acdc = this.dial === "VAC" ? "AC" : this.dial === "OHM" || this.dial === "CONT" ? "" : "DC";
    const baseUnit = this.dial === "mA" || this.dial === "A" ? "A" : this.ohmMode ? "Ω" : "V";

    if (this.leadAlert) {
      this.display = { ...EMPTY, on: true, text: "LEAd", leadAlert: true, beep: true, acdc, baseUnit };
      return;
    }
    if (this.hold) {
      this.display = { ...this.display, hold: true, beep: false };
      return;
    }

    let raw: number;
    if (this.ohmMode) {
      if (this.auto && ranges.length > 1) {
        let chosen = ranges.length - 1;
        raw = this.rawValue(solveAt(chosen), chosen);
        for (let i = 0; i < ranges.length; i++) {
          const v = this.rawValue(solveAt(i), i);
          if (Math.abs(v) / ranges[i].res <= ranges[i].maxCounts) {
            chosen = i;
            raw = v;
            break;
          }
        }
        this.rangeIdx = chosen;
      } else {
        raw = this.rawValue(solveAt(this.rangeIdx), this.rangeIdx);
      }
    } else {
      raw = this.rawValue(solveAt(-1), -1);
      if (this.auto && ranges.length > 1) {
        let i = this.rangeIdx;
        // sube mientras desborda; baja con histéresis (cabe en el rango inferior con margen)
        while (i < ranges.length - 1 && Math.abs(raw) / ranges[i].res > ranges[i].maxCounts) i++;
        while (i > 0 && Math.abs(raw) / ranges[i - 1].res < 0.9 * ranges[i - 1].maxCounts) i--;
        this.rangeIdx = i;
      }
    }
    this.lastRaw = raw;
    const r = ranges[this.rangeIdx];
    const c = this.cal(`${this.dial}:${this.rangeIdx}`, r);
    const noise = this.rng.gaussTrunc(0.35, 3);
    let shown = isFinite(raw) ? raw * (1 + c.gain) + (c.off + noise) * r.res : Infinity;
    if (this.relRef !== null && isFinite(shown)) shown -= this.relRef;
    let counts = isFinite(shown) ? Math.round(shown / r.res) : Infinity;
    if (Object.is(counts, -0)) counts = 0;
    const ol = !isFinite(counts) || Math.abs(counts) > r.maxCounts;
    const dec = decimalsOf(r);
    const valueShown = counts * r.res;
    const text = ol ? "OL" : (valueShown / r.mult).toFixed(dec);
    const continuity = this.dial === "CONT";
    const beep = continuity && isFinite(raw) && raw >= 0 && raw < 30;
    this.display = {
      on: true,
      text,
      unit: r.unit,
      acdc,
      auto: this.auto,
      hold: false,
      rel: this.relRef !== null,
      beep,
      continuity,
      bar: ol ? 1 : Math.min(1, Math.abs(valueShown) / (r.maxCounts * r.res)),
      value: ol ? null : valueShown,
      baseUnit,
      range: r,
      leadAlert: false,
    };
  }

  /** Último valor crudo (verdadero en bornes del instrumento), útil para depurar. */
  get trueValue(): number {
    return this.lastRaw;
  }
}
