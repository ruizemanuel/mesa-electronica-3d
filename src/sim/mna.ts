/**
 * Análisis nodal modificado (MNA) para circuitos DC lineales.
 *
 * Convenciones:
 * - Tensiones de nodo referidas a `ground`.
 * - Fuente de tensión V(pos, neg): impone v(pos) - v(neg) = volts. Su corriente de rama
 *   `iV(id)` es la que circula de `pos` a `neg` POR DENTRO de la fuente; una fuente que
 *   entrega potencia tiene iV < 0.
 * - Fuente de corriente I(from, to): `amps` circula de `from` a `to` por dentro de la
 *   fuente, es decir, inyecta `amps` en el nodo `to`.
 * - Corriente de resistor `iR(id)`: de `a` a `b`.
 * - Se agrega gmin de cada nodo a masa (como SPICE) para que los nodos flotantes no
 *   hagan singular la matriz.
 */
export type NodeId = string;

export interface ResistorEl {
  kind: "R";
  id: string;
  a: NodeId;
  b: NodeId;
  ohms: number;
}
export interface VSourceEl {
  kind: "V";
  id: string;
  pos: NodeId;
  neg: NodeId;
  volts: number;
}
export interface ISourceEl {
  kind: "I";
  id: string;
  from: NodeId;
  to: NodeId;
  amps: number;
}
export type Element = ResistorEl | VSourceEl | ISourceEl;

export class Netlist {
  readonly elements: Element[] = [];

  r(id: string, a: NodeId, b: NodeId, ohms: number): this {
    if (!(ohms > 0)) throw new Error(`Resistencia ${id} inválida: ${ohms}`);
    this.elements.push({ kind: "R", id, a, b, ohms });
    return this;
  }
  v(id: string, pos: NodeId, neg: NodeId, volts: number): this {
    this.elements.push({ kind: "V", id, pos, neg, volts });
    return this;
  }
  i(id: string, from: NodeId, to: NodeId, amps: number): this {
    this.elements.push({ kind: "I", id, from, to, amps });
    return this;
  }
}

export class Solution {
  constructor(
    private readonly nodeIndex: Map<NodeId, number>,
    private readonly x: Float64Array,
    private readonly vIndex: Map<string, number>,
    private readonly resistors: Map<string, ResistorEl>,
  ) {}

  /** Tensión del nodo respecto de masa. Nodos desconocidos valen 0. */
  v(node: NodeId): number {
    const k = this.nodeIndex.get(node);
    return k === undefined ? 0 : this.x[k];
  }
  /** Diferencia de tensión v(a) - v(b). */
  vab(a: NodeId, b: NodeId): number {
    return this.v(a) - this.v(b);
  }
  /** Corriente por la fuente de tensión, de pos a neg por dentro de la fuente. */
  iV(id: string): number {
    const k = this.vIndex.get(id);
    if (k === undefined) throw new Error(`Fuente ${id} inexistente`);
    return this.x[k];
  }
  /** Corriente por el resistor de a hacia b. */
  iR(id: string): number {
    const r = this.resistors.get(id);
    if (!r) return 0;
    return (this.v(r.a) - this.v(r.b)) / r.ohms;
  }
  hasResistor(id: string): boolean {
    return this.resistors.has(id);
  }
  /** Potencia disipada en el resistor. */
  pR(id: string): number {
    const r = this.resistors.get(id);
    if (!r) return 0;
    const dv = this.v(r.a) - this.v(r.b);
    return (dv * dv) / r.ohms;
  }
}

export const GMIN = 1e-12;

export function solve(net: Netlist, ground: NodeId, gmin = GMIN): Solution {
  const nodeIndex = new Map<NodeId, number>();
  const idx = (n: NodeId): number => {
    if (n === ground) return -1;
    let k = nodeIndex.get(n);
    if (k === undefined) {
      k = nodeIndex.size;
      nodeIndex.set(n, k);
    }
    return k;
  };
  const resistors = new Map<string, ResistorEl>();
  const vsrc: VSourceEl[] = [];
  for (const el of net.elements) {
    if (el.kind === "R") {
      idx(el.a);
      idx(el.b);
      resistors.set(el.id, el);
    } else if (el.kind === "V") {
      idx(el.pos);
      idx(el.neg);
      vsrc.push(el);
    } else {
      idx(el.from);
      idx(el.to);
    }
  }
  const n = nodeIndex.size;
  const m = vsrc.length;
  const N = n + m;
  const A = new Float64Array(N * N);
  const z = new Float64Array(N);
  const add = (r: number, c: number, val: number) => {
    if (r >= 0 && c >= 0) A[r * N + c] += val;
  };

  for (let k = 0; k < n; k++) add(k, k, gmin);

  for (const el of net.elements) {
    if (el.kind === "R") {
      const g = 1 / el.ohms;
      const a = idx(el.a);
      const b = idx(el.b);
      add(a, a, g);
      add(b, b, g);
      add(a, b, -g);
      add(b, a, -g);
    } else if (el.kind === "I") {
      const f = idx(el.from);
      const t = idx(el.to);
      if (f >= 0) z[f] -= el.amps;
      if (t >= 0) z[t] += el.amps;
    }
  }
  const vIndex = new Map<string, number>();
  vsrc.forEach((el, j) => {
    const row = n + j;
    vIndex.set(el.id, row);
    const p = idx(el.pos);
    const q = idx(el.neg);
    add(p, row, 1);
    add(q, row, -1);
    add(row, p, 1);
    add(row, q, -1);
    z[row] = el.volts;
  });

  const x = solveDense(A, z, N);
  if (!x) throw new Error("Matriz singular: revisá fuentes de tensión en lazo o en paralelo");
  return new Solution(nodeIndex, x, vIndex, resistors);
}

/** Eliminación gaussiana con pivoteo parcial. A es N×N fila-mayor; no se modifica. */
export function solveDense(Ain: Float64Array, bin: Float64Array, N: number): Float64Array | null {
  const A = Ain.slice();
  const b = bin.slice();
  for (let k = 0; k < N; k++) {
    let p = k;
    let max = Math.abs(A[k * N + k]);
    for (let i = k + 1; i < N; i++) {
      const v = Math.abs(A[i * N + k]);
      if (v > max) {
        max = v;
        p = i;
      }
    }
    if (max < 1e-300) return null;
    if (p !== k) {
      for (let j = 0; j < N; j++) {
        const t = A[k * N + j];
        A[k * N + j] = A[p * N + j];
        A[p * N + j] = t;
      }
      const t = b[k];
      b[k] = b[p];
      b[p] = t;
    }
    const piv = A[k * N + k];
    for (let i = k + 1; i < N; i++) {
      const f = A[i * N + k] / piv;
      if (f === 0) continue;
      A[i * N + k] = 0;
      for (let j = k + 1; j < N; j++) A[i * N + j] -= f * A[k * N + j];
      b[i] -= f * b[k];
    }
  }
  const x = new Float64Array(N);
  for (let i = N - 1; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < N; j++) s -= A[i * N + j] * x[j];
    x[i] = s / A[i * N + i];
  }
  return x;
}
