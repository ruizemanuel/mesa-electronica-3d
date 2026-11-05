import { Rng } from "./rng";

export const E12 = [1.0, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];
export const E24 = [
  1.0, 1.1, 1.2, 1.3, 1.5, 1.6, 1.8, 2.0, 2.2, 2.4, 2.7, 3.0, 3.3, 3.6, 3.9, 4.3, 4.7, 5.1, 5.6, 6.2, 6.8, 7.5, 8.2, 9.1,
];

/** Valores comerciales entre min y max (inclusive) de una serie E. */
export function eSeriesValues(min = 10, max = 1e6, series = E12): number[] {
  const out: number[] = [];
  for (let dec = 1e-1; dec <= 1e7; dec *= 10) {
    for (const m of series) {
      const v = Math.round(m * dec * 1000) / 1000;
      if (v >= min - 1e-9 && v <= max + 1e-9) out.push(v);
    }
  }
  return out;
}

export type Tech = "carbon" | "metal";
export type PowerRating = 0.25 | 0.5 | 1 | 2;

export interface ResistorSpec {
  nominal: number;
  /** 0.05 (carbón, 4 bandas) o 0.01 (metal film, 5 bandas). */
  tolerance: 0.05 | 0.01;
  power: PowerRating;
}

export const techOf = (s: ResistorSpec): Tech => (s.tolerance === 0.01 ? "metal" : "carbon");

export interface BandColor {
  name: string;
  hex: string;
}
const DIGIT_COLORS: BandColor[] = [
  { name: "negro", hex: "#141414" },
  { name: "marrón", hex: "#6b3a1e" },
  { name: "rojo", hex: "#c8201e" },
  { name: "naranja", hex: "#e8721c" },
  { name: "amarillo", hex: "#f2cf1d" },
  { name: "verde", hex: "#2e8b3a" },
  { name: "azul", hex: "#1f4fb5" },
  { name: "violeta", hex: "#7a3fa0" },
  { name: "gris", hex: "#8a8a8a" },
  { name: "blanco", hex: "#f4f4f4" },
];
const GOLD: BandColor = { name: "dorado", hex: "#c9a43a" };
const SILVER: BandColor = { name: "plateado", hex: "#b8bcc2" };

/** Código de colores IEC 60062: 4 bandas para 5 %, 5 bandas para 1 %. */
export function colorBands(nominal: number, tolerance: 0.05 | 0.01): BandColor[] {
  const sig = tolerance === 0.01 ? 3 : 2;
  let exp = Math.floor(Math.log10(nominal)) - (sig - 1);
  let mant = Math.round(nominal / 10 ** exp);
  if (mant >= 10 ** sig) {
    mant /= 10;
    exp += 1;
  }
  const digits = String(mant).padStart(sig, "0").split("").map(Number);
  const bands = digits.map((d) => DIGIT_COLORS[d]);
  if (exp === -1) bands.push(GOLD);
  else if (exp === -2) bands.push(SILVER);
  else bands.push(DIGIT_COLORS[exp]);
  bands.push(tolerance === 0.01 ? DIGIT_COLORS[1] : GOLD);
  return bands;
}

/** Formato de ingeniería con coma decimal (es-AR): 4,7 kΩ */
export function formatSI(value: number, unit: string, digits = 3): string {
  if (!isFinite(value)) return `∞ ${unit}`;
  // por debajo de 1 fA / 1 fV / 1 fW es ruido numérico (gmin), no una magnitud física
  if (Math.abs(value) < 1e-15) value = 0;
  const abs = Math.abs(value);
  const prefixes: [number, string][] = [
    [1e6, "M"],
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
    [1e-12, "p"],
  ];
  let [scale, p] = prefixes[prefixes.length - 1];
  for (const [s, pr] of prefixes) {
    if (abs >= s * 0.9995) {
      scale = s;
      p = pr;
      break;
    }
  }
  if (abs === 0) {
    scale = 1;
    p = "";
  }
  const v = value / scale;
  const txt = Number(v.toPrecision(digits)).toString().replace(".", ",");
  return `${txt} ${p}${unit}`;
}

export type ResistorState = "ok" | "humo" | "quemado";

export const AMBIENT_C = 25;

/**
 * Resistor físico: valor real dentro de tolerancia, coeficiente térmico y modelo térmico de
 * primer orden. A potencia nominal el cuerpo llega a ~150 °C (típico para 1/4 W).
 */
export class ResistorPart {
  r25 = 0;
  tempC = AMBIENT_C;
  state: ResistorState = "ok";
  drift = 1;
  /** ppm/°C: carbón ≈ -400, metal film ≈ +50 */
  tcr = 0;
  constructor(
    readonly id: string,
    public spec: ResistorSpec,
    private readonly rng: Rng,
  ) {
    this.renew();
  }

  /** Coloca un resistor nuevo del mismo valor (otra muestra del lote). */
  renew(spec: ResistorSpec = this.spec): void {
    this.spec = spec;
    const tol = spec.tolerance;
    this.r25 = spec.nominal * (1 + this.rng.gaussTrunc(tol / 2.2, 2.0));
    this.tcr = techOf(spec) === "metal" ? this.rng.uniform(20, 50) * 1e-6 : this.rng.uniform(-500, -300) * 1e-6;
    this.tempC = AMBIENT_C;
    this.state = "ok";
    this.drift = 1;
  }

  get rth(): number {
    return 125 / this.spec.power; // °C/W
  }
  get tau(): number {
    return 6 * Math.sqrt(this.spec.power / 0.25); // s
  }

  /** Resistencia actual en Ω (incluye temperatura y daño). Quemado = circuito abierto. */
  get ohms(): number {
    if (this.state === "quemado") return 1e12;
    return this.r25 * (1 + this.tcr * (this.tempC - AMBIENT_C)) * this.drift;
  }

  step(powerW: number, dt: number): void {
    if (this.state === "quemado") {
      this.tempC += (AMBIENT_C - this.tempC) * (1 - Math.exp(-dt / this.tau));
      return;
    }
    const target = AMBIENT_C + powerW * this.rth;
    this.tempC = target + (this.tempC - target) * Math.exp(-dt / this.tau);
    if (this.tempC > 230) {
      this.state = "humo";
      this.drift *= 1 + 0.04 * dt * ((this.tempC - 230) / 100);
    } else if (this.state === "humo" && this.tempC < 180) {
      this.state = "ok"; // queda dañado (drift) pero deja de humear
    }
    if (this.tempC > 340) this.state = "quemado";
  }
}
