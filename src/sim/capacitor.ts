import type { DiodeParams } from "./mna";
import { AMBIENT_C } from "./resistor";
import type { Rng } from "./rng";

export type CapKind = "ceramico" | "electrolitico";

/** Valores comerciales: cerámicos (X7R) hasta 470 nF y electrolíticos de 1 µF en adelante. */
export const CAP_VALUES = [
  1e-9, 2.2e-9, 4.7e-9, 10e-9, 22e-9, 47e-9, 100e-9, 220e-9, 470e-9, 1e-6, 2.2e-6, 4.7e-6, 10e-6, 22e-6, 47e-6, 100e-6, 220e-6,
  470e-6, 1000e-6,
];

export const kindOf = (farads: number): CapKind => (farads >= 0.999e-6 ? "electrolitico" : "ceramico");

export interface CapModel {
  kind: CapKind;
  /** Tolerancia: X7R ±10 % (K), electrolítico ±20 % (M). */
  tolerance: number;
  /** Tensión máxima (V). */
  vMax: number;
  /** Resistencia serie equivalente (Ω). */
  esr: number;
  /** Electrolítico: diámetro y alto de la lata, separación de patas (mm). Cerámico: diámetro del disco. */
  dia: number;
  len: number;
  pitch: number;
  /** Lo que lleva impreso: "104" o "100µF 25V". */
  marking: string;
  /** Resistencia térmica al aire (°C/W): convección natural sobre la superficie de la lata. */
  rth: number;
}

/** Código de 3 cifras de los cerámicos (en pF): 100 nF = 10·10⁴ pF → "104". */
export function ceramicCode(farads: number): string {
  const pf = Math.round(farads * 1e12);
  const exp = Math.max(0, Math.floor(Math.log10(pf)) - 1);
  const mant = Math.round(pf / 10 ** exp);
  return `${mant}${exp}`;
}

/** Formato de capacidad: 100 nF · 4,7 µF · 1000 µF (los electrolíticos se nombran en µF). */
export function formatCap(f: number): string {
  const [v, u] = f >= 0.999e-6 ? [f * 1e6, "µF"] : f >= 0.999e-9 ? [f * 1e9, "nF"] : [f * 1e12, "pF"];
  return `${Number(v.toPrecision(3)).toString().replace(".", ",")} ${u}`;
}

/**
 * Modelo de cada valor. La ESR de un electrolítico sale de su factor de pérdidas (tan δ ≈ 0,14):
 * ESR = tan δ / (ωC), evaluada a 1 kHz. El tamaño de la lata es el típico de 25 V (16 V el de 1000 µF).
 */
export function capModel(farads: number): CapModel {
  if (kindOf(farads) === "ceramico") {
    return { kind: "ceramico", tolerance: 0.1, vMax: 50, esr: 0, dia: farads > 150e-9 ? 6.5 : 5, len: 2.6, pitch: 5.08, marking: ceramicCode(farads), rth: 400 };
  }
  const uf = farads * 1e6;
  const [dia, len] = uf <= 22 ? [5, 11] : uf <= 100 ? [6.3, 11] : uf <= 220 ? [8, 11.5] : uf <= 470 ? [10, 12.5] : [10, 16];
  const vMax = uf >= 1000 ? 16 : 25;
  const esr = Math.min(3, Math.max(0.03, 0.14 / (2 * Math.PI * 1000 * farads)));
  const pitch = dia <= 5 ? 2.0 : dia <= 6.3 ? 2.5 : dia <= 8 ? 3.5 : 5.0;
  // h ≈ 12 W/m²·K sobre el costado y las tapas
  const area = (Math.PI * dia * len + (Math.PI * dia * dia) / 2) * 1e-6;
  return { kind: "electrolitico", tolerance: 0.2, vMax, esr, dia, len, pitch, marking: `${Number(uf.toPrecision(3))}µF ${vMax}V`, rth: 1 / (12 * area) };
}

/**
 * Un electrolítico polarizado al revés conduce: el óxido del ánodo se comporta como un diodo. Se
 * modela con un diodo en paralelo (ánodo en la pata −): ≈ 3 µA de fuga con la polaridad correcta
 * (la corriente de saturación) y ≈ 1 mA con 1,5 V al revés, que crece rápido de ahí en adelante.
 */
export const REVERSE_LEAK: DiodeParams = { is: 3e-6, n: 10, rs: 2 };

export type CapCondition = "ok" | "inflado";

/**
 * Capacitor físico: capacidad real dentro de la tolerancia y, los electrolíticos, polaridad y modelo
 * térmico. Con tensión inversa la fuga lo calienta; arriba de 125 °C se infla, abre la válvula de
 * seguridad del techo y queda abierto. Para eso hace falta una fuente que entregue corriente: con los
 * 50 Ω del generador solo se entibia.
 */
export class CapacitorPart {
  nominal = 0;
  farads = 0;
  model!: CapModel;
  /** Electrolítico puesto al revés (la pata − en el agujero previsto para la +). */
  reversed = false;
  tempC = AMBIENT_C;
  state: CapCondition = "ok";
  /** Tensión en bornes (pata + menos pata −, según cómo quedó puesto) del último paso. */
  volts = 0;
  readonly tau = 10; // s

  constructor(
    readonly id: string,
    nominal: number,
    private readonly rng: Rng,
  ) {
    this.renew(nominal);
  }

  get kind(): CapKind {
    return this.model.kind;
  }
  get polarized(): boolean {
    return this.model.kind === "electrolitico";
  }

  /** Coloca uno nuevo (otra muestra del lote), opcionalmente de otro valor. Mantiene la orientación. */
  renew(nominal: number = this.nominal): void {
    this.nominal = nominal;
    this.model = capModel(nominal);
    this.farads = nominal * (1 + this.rng.gaussTrunc(this.model.tolerance / 2.2, 2));
    this.tempC = AMBIENT_C;
    this.state = "ok";
    this.volts = 0;
    if (!this.polarized) this.reversed = false;
  }

  flip(): void {
    if (this.polarized) this.reversed = !this.reversed;
  }

  /** Avanza el modelo térmico con la potencia media disipada (fuga inversa + ESR). Devuelve true si se infló. */
  step(watts: number, dt: number): boolean {
    if (this.state === "inflado") {
      this.tempC += (AMBIENT_C - this.tempC) * (1 - Math.exp(-dt / this.tau));
      return false;
    }
    const target = AMBIENT_C + Math.max(0, watts) * this.model.rth;
    this.tempC = target + (this.tempC - target) * Math.exp(-dt / this.tau);
    if (this.tempC > 125) {
      this.state = "inflado";
      return true;
    }
    return false;
  }
}
