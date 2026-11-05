import { VT_25, type DiodeParams } from "./mna";
import { AMBIENT_C } from "./resistor";
import type { Rng } from "./rng";

export type DiodeType = "1N4007" | "led-rojo" | "led-verde" | "led-azul" | "led-blanco";
export const DIODE_TYPES: DiodeType[] = ["1N4007", "led-rojo", "led-verde", "led-azul", "led-blanco"];

export interface DiodeModel {
  name: string;
  led: boolean;
  /** Tensión directa típica `vf` a la corriente de referencia `iref` (de acá sale Is). */
  vf: number;
  iref: number;
  /** Factor de idealidad (los LED de InGaN tienen un n efectivo alto). */
  n: number;
  /** Resistencia serie (Ω). */
  rs: number;
  /** Corriente directa continua máxima de la hoja de datos (A). */
  ifMax: number;
  /** Resistencia térmica juntura-ambiente (°C/W) y constante de tiempo térmica (s). */
  rth: number;
  tau: number;
  /** Temperatura de juntura máxima de la hoja de datos y temperatura a la que se abre (°C). */
  tjMax: number;
  tBurn: number;
  /** Coeficiente de temperatura de Vf a corriente constante (V/°C). */
  tc: number;
  /** Dispersión de Vf entre muestras del mismo lote (σ, V). */
  vfSigma: number;
  /** LED: color de la luz, tinte del encapsulado, longitud de onda dominante y si es transparente. */
  light?: string;
  tint?: string;
  nm?: number;
  clear?: boolean;
}

/**
 * Modelos ajustados a hojas de datos típicas.
 * - 1N4007: el modelo SPICE clásico (Is ≈ 7 nA, n ≈ 1,81, Rs ≈ 34 mΩ): 0,55 V a 1 mA, 0,91 V a 1 A.
 * - LED de 5 mm: Vf según el material (AlGaInP rojo, GaP verde, InGaN azul/blanco), 20 mA nominal
 *   y 30 mA máximo. Rth ≈ 350 °C/W en el encapsulado de epoxi.
 */
export const DIODE_MODELS: Record<DiodeType, DiodeModel> = {
  "1N4007": { name: "1N4007", led: false, vf: 0.906, iref: 1, n: 1.808, rs: 0.034, ifMax: 1, rth: 50, tau: 10, tjMax: 175, tBurn: 250, tc: -2e-3, vfSigma: 0.008 },
  "led-rojo": { name: "LED rojo", led: true, vf: 1.82, iref: 0.02, n: 1.9, rs: 2.5, ifMax: 0.03, rth: 350, tau: 1.5, tjMax: 100, tBurn: 170, tc: -2e-3, vfSigma: 0.025, light: "#ff2414", tint: "#c81a12", nm: 625 },
  "led-verde": { name: "LED verde", led: true, vf: 2.1, iref: 0.02, n: 2.1, rs: 4, ifMax: 0.03, rth: 350, tau: 1.5, tjMax: 100, tBurn: 170, tc: -2e-3, vfSigma: 0.03, light: "#6cff2e", tint: "#2f9a26", nm: 570 },
  "led-azul": { name: "LED azul", led: true, vf: 3.05, iref: 0.02, n: 3.2, rs: 10, ifMax: 0.03, rth: 350, tau: 1.5, tjMax: 100, tBurn: 170, tc: -3e-3, vfSigma: 0.04, light: "#2b5cff", tint: "#2440c8", nm: 470 },
  "led-blanco": { name: "LED blanco", led: true, vf: 3.1, iref: 0.02, n: 3.2, rs: 10, ifMax: 0.03, rth: 350, tau: 1.5, tjMax: 100, tBurn: 170, tc: -3e-3, vfSigma: 0.04, light: "#f4f6ff", tint: "#eef2f6", clear: true },
};

/** Parámetros de Shockley de un modelo, con la Vf corrida `dvf` voltios (dispersión o temperatura). */
export function diodeParams(m: DiodeModel, dvf = 0): DiodeParams {
  const nvt = m.n * VT_25;
  return { is: m.iref * Math.exp(-(m.vf + dvf - m.iref * m.rs) / nvt), n: m.n, rs: m.rs };
}

/** Tensión en bornes de un diodo para una corriente directa dada (inversa del modelo). */
export function vfAt(p: DiodeParams, amps: number): number {
  const nvt = p.n * (p.vt ?? VT_25);
  return nvt * Math.log(1 + amps / p.is) + amps * p.rs;
}

/** Corriente directa para una tensión en bornes dada (bisección sobre vfAt, que es monótona). */
export function ifAt(p: DiodeParams, volts: number): number {
  if (volts <= 0) return p.is * (Math.exp(volts / (p.n * (p.vt ?? VT_25))) - 1);
  let lo = 0;
  let hi = 100;
  for (let k = 0; k < 200; k++) {
    const mid = (lo + hi) / 2;
    if (vfAt(p, mid) > volts) hi = mid;
    else lo = mid;
  }
  return (lo + hi) / 2;
}

export type DiodeState = "ok" | "quemado";

/**
 * Diodo o LED físico: Vf propia dentro de la dispersión del lote, Vf que baja con la temperatura
 * y modelo térmico de primer orden. Si la juntura pasa `tBurn` se abre (los LED se queman por
 * el hilo de oro), como un resistor quemado.
 */
export class DiodePart {
  type: DiodeType;
  /** Puesto al revés: la pata del ánodo en el agujero previsto para el cátodo. */
  reversed = false;
  tempC = AMBIENT_C;
  state: DiodeState = "ok";
  /** Corrimiento de Vf de esta muestra respecto del típico (V). */
  vfOffset = 0;
  /** Último punto de trabajo (corriente ánodo→cátodo, potencia) y brillo relativo (1 = 20 mA). */
  current = 0;
  power = 0;
  brightness = 0;
  /** Corriente máxima alcanzada (para explicar por qué se quemó). */
  peak = 0;

  constructor(
    readonly id: string,
    type: DiodeType,
    private readonly rng: Rng,
  ) {
    this.type = type;
    this.renew(type);
  }

  get model(): DiodeModel {
    return DIODE_MODELS[this.type];
  }

  /** Coloca uno nuevo (otra muestra del lote), opcionalmente de otro tipo. Mantiene la orientación. */
  renew(type: DiodeType = this.type): void {
    this.type = type;
    this.vfOffset = this.rng.gaussTrunc(this.model.vfSigma, 2);
    this.tempC = AMBIENT_C;
    this.state = "ok";
    this.current = 0;
    this.power = 0;
    this.brightness = 0;
    this.peak = 0;
  }

  flip(): void {
    this.reversed = !this.reversed;
  }

  /** Parámetros eléctricos actuales: dispersión de fabricación + temperatura de juntura. */
  params(): DiodeParams {
    return diodeParams(this.model, this.vfOffset + this.model.tc * (this.tempC - AMBIENT_C));
  }

  /** Avanza el modelo térmico con la corriente (ánodo→cátodo) y la potencia del último paso. */
  step(amps: number, watts: number, dt: number): void {
    const m = this.model;
    if (this.state === "quemado") {
      this.current = 0;
      this.power = 0;
      this.brightness = 0;
      this.tempC += (AMBIENT_C - this.tempC) * (1 - Math.exp(-dt / m.tau));
      return;
    }
    this.current = amps;
    this.power = Math.max(0, watts);
    this.peak = Math.max(this.peak, amps);
    const target = AMBIENT_C + this.power * m.rth;
    this.tempC = target + (this.tempC - target) * Math.exp(-dt / m.tau);
    // la eficiencia luminosa cae con la temperatura de juntura (~0,5 %/°C)
    const eff = Math.max(0.15, 1 - 0.005 * (this.tempC - AMBIENT_C));
    this.brightness = m.led ? (Math.max(0, amps) / 0.02) * eff : 0;
    if (this.tempC > m.tBurn) {
      this.state = "quemado";
      this.current = 0;
      this.brightness = 0;
    }
  }
}
