import type { ResistorSpec } from "./resistor";

/**
 * Protoboard de 400 puntos: 30 columnas, filas a–e (mitad superior) y f–j (mitad inferior),
 * dos pares de rieles. Agujeros:  "14d" (columna 14, fila d)  ·  "RT+:5" (riel superior +, col. 5)
 *
 * Nets: cada tira vertical de 5 agujeros es un nodo (T14 = 14a..14e, B14 = 14f..14j);
 * cada riel es un nodo continuo (RT+, RT-, RB+, RB-).
 */
export const BB_COLS = 30;
export const TOP_ROWS = ["a", "b", "c", "d", "e"] as const;
export const BOTTOM_ROWS = ["f", "g", "h", "i", "j"] as const;
export const RAILS = ["RT-", "RT+", "RB-", "RB+"] as const;
export type RailName = (typeof RAILS)[number];

/** Columnas con agujero en los rieles (5 grupos de 5, como un protoboard real). */
export const railHasCol = (col: number): boolean => col >= 1 && col <= BB_COLS && (col - 1) % 6 !== 0;

export function netOfHole(hole: string): string {
  const m = /^(\d+)([a-j])$/.exec(hole);
  if (m) {
    const col = Number(m[1]);
    return "abcde".includes(m[2]) ? `T${col}` : `B${col}`;
  }
  const r = /^(R[TB][+-]):(\d+)$/.exec(hole);
  if (r) return r[1];
  throw new Error(`Agujero inválido: ${hole}`);
}

export function isValidHole(hole: string): boolean {
  const m = /^(\d+)([a-j])$/.exec(hole);
  if (m) return Number(m[1]) >= 1 && Number(m[1]) <= BB_COLS;
  const r = /^(R[TB][+-]):(\d+)$/.exec(hole);
  return !!r && railHasCol(Number(r[2]));
}

export interface ResistorDef {
  id: string;
  a: string;
  b: string;
  spec: ResistorSpec;
}
export interface JumperDef {
  id: string;
  a: string;
  b: string;
  color: string;
  /** Altura del arco del cable en mm (para que no se crucen). */
  arc?: number;
}
export interface CircuitDef {
  id: string;
  name: string;
  description: string;
  vset: number;
  iset: number;
  resistors: ResistorDef[];
  jumpers: JumperDef[];
  tasks: string[];
}

const q = (nominal: number, tolerance: 0.05 | 0.01 = 0.05, power: ResistorSpec["power"] = 0.25): ResistorSpec => ({
  nominal,
  tolerance,
  power,
});

export const WIRE = {
  red: "#d42a22",
  black: "#1c1c1c",
  yellow: "#e6c21b",
  green: "#2f9a3e",
  blue: "#2459c4",
  orange: "#e5741c",
  white: "#e8e8e8",
};

export const CIRCUITS: CircuitDef[] = [
  {
    id: "ohm",
    name: "Ley de Ohm: un resistor",
    description: "Una resistencia conectada a la fuente. Medí V, I y calculá P = V·I.",
    vset: 5,
    iset: 0.1,
    resistors: [{ id: "R1", a: "14d", b: "14g", spec: q(1000) }],
    jumpers: [
      { id: "J1", a: "RT+:14", b: "14a", color: WIRE.red },
      { id: "J2", a: "14j", b: "RB-:14", color: WIRE.black },
    ],
    tasks: [
      "Multímetro en V⎓, punta roja en VΩ: medí la tensión sobre R1 (agujeros 14a–e y 14f–j).",
      "Apagá la fuente, poné el multímetro en Ω y medí R1: vas a ver su valor REAL, no el nominal.",
      "Para medir corriente: quitá el puente J1, pasá la punta roja a la borna mA y poné las puntas en los dos agujeros que quedaron abiertos (en serie).",
      "Calculá P = V·I y comparala con V²/R e I²·R.",
    ],
  },
  {
    id: "serie",
    name: "Serie: divisor de tensión",
    description: "Tres resistencias en serie. La corriente es la misma en todo el lazo y las tensiones se reparten.",
    vset: 10,
    iset: 0.1,
    resistors: [
      { id: "R1", a: "8c", b: "12c", spec: q(1000) },
      { id: "R2", a: "12b", b: "16b", spec: q(2200) },
      { id: "R3", a: "18e", b: "18h", spec: q(4700) },
    ],
    jumpers: [
      { id: "J1", a: "RT+:8", b: "8a", color: WIRE.red },
      { id: "J2", a: "16d", b: "18d", color: WIRE.yellow, arc: 3 },
      { id: "J3", a: "18j", b: "RB-:18", color: WIRE.black },
    ],
    tasks: [
      "Medí la tensión en cada resistor y verificá que V1 + V2 + V3 = V de la fuente (ley de Kirchhoff de tensiones).",
      "Medí la corriente abriendo J1 y después abriendo J2: es la misma.",
      "Calculá la potencia de cada resistor. ¿Cuál disipa más y por qué?",
    ],
  },
  {
    id: "paralelo",
    name: "Paralelo",
    description: "Tres resistencias en paralelo. La tensión es la misma y las corrientes se suman.",
    vset: 5,
    iset: 0.2,
    resistors: [
      { id: "R1", a: "10d", b: "10g", spec: q(1000) },
      { id: "R2", a: "16d", b: "16g", spec: q(2200) },
      { id: "R3", a: "22d", b: "22g", spec: q(4700) },
    ],
    jumpers: [
      { id: "J1", a: "RT+:5", b: "5a", color: WIRE.red },
      { id: "J2", a: "5b", b: "10a", color: WIRE.yellow, arc: 4 },
      { id: "J3", a: "5c", b: "16a", color: WIRE.green, arc: 7 },
      { id: "J4", a: "5d", b: "22a", color: WIRE.blue, arc: 10 },
      { id: "J5", a: "10j", b: "RB-:10", color: WIRE.black },
      { id: "J6", a: "16j", b: "RB-:16", color: WIRE.black },
      { id: "J7", a: "22j", b: "RB-:22", color: WIRE.black },
    ],
    tasks: [
      "Medí la tensión sobre cada resistor: es la misma.",
      "Medí la corriente de cada rama (abrí J2, J3 o J4) y la total (abrí J1). Verificá I = I1 + I2 + I3 (Kirchhoff de corrientes).",
      "Calculá la resistencia equivalente con V/I y comparala con la teoría.",
    ],
  },
  {
    id: "mixto",
    name: "Mixto: serie-paralelo",
    description: "R1 en serie con el paralelo de R2 y R3.",
    vset: 9,
    iset: 0.1,
    resistors: [
      { id: "R1", a: "5c", b: "9c", spec: q(1000) },
      { id: "R2", a: "12d", b: "12g", spec: q(2200) },
      { id: "R3", a: "18d", b: "18g", spec: q(3300) },
    ],
    jumpers: [
      { id: "J1", a: "RT+:5", b: "5a", color: WIRE.red },
      { id: "J2", a: "9a", b: "12a", color: WIRE.yellow, arc: 3 },
      { id: "J3", a: "9b", b: "18a", color: WIRE.green, arc: 6 },
      { id: "J4", a: "12j", b: "RB-:12", color: WIRE.black },
      { id: "J5", a: "18j", b: "RB-:18", color: WIRE.black },
    ],
    tasks: [
      "Medí la tensión en R1 y en el paralelo R2‖R3.",
      "Medí la corriente total (J1) y la de cada rama (J2/J3 o J4/J5).",
      "Calculá la potencia total entregada por la fuente y comparala con la suma de las potencias de cada resistor.",
    ],
  },
  {
    id: "carga",
    name: "Efecto de carga del voltímetro",
    description: "Divisor con resistencias de 4,7 MΩ: la impedancia de entrada del multímetro (10 MΩ) altera la medición.",
    vset: 10,
    iset: 0.01,
    resistors: [
      { id: "R1", a: "8c", b: "12c", spec: q(4.7e6, 0.01) },
      { id: "R2", a: "12e", b: "12h", spec: q(4.7e6, 0.01) },
    ],
    jumpers: [
      { id: "J1", a: "RT+:8", b: "8a", color: WIRE.red },
      { id: "J2", a: "12j", b: "RB-:12", color: WIRE.black },
    ],
    tasks: [
      "En teoría el punto medio está a 5,00 V. Medilo: vas a leer cerca de 4 V.",
      "Explicación: los 10 MΩ del multímetro quedan en paralelo con R2 (4,7 MΩ ‖ 10 MΩ ≈ 3,2 MΩ).",
      "Probá con R1 = R2 = 10 kΩ: el error desaparece. Regla práctica: la impedancia del instrumento tiene que ser ≫ que la del circuito.",
    ],
  },
];
