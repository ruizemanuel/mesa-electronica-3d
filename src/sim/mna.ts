/**
 * Análisis nodal modificado (MNA) para circuitos DC, con diodos no lineales.
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
 * - Diodo D(a, k): modelo de Shockley I = Is·(e^(Vj/(n·Vt)) − 1) con resistencia serie Rs
 *   (nodo interno entre Rs y la juntura). Con diodos el sistema deja de ser lineal y se
 *   resuelve con Newton-Raphson: en cada iteración el diodo se reemplaza por su modelo
 *   linealizado (conductancia + fuente de corriente) y el salto de tensión de la juntura se
 *   limita como en SPICE (pnjlim), porque con la exponencial Newton puro diverge.
 * - Capacitor C(a, b): en continua es un circuito abierto. El análisis transitorio (transient.ts)
 *   lo reemplaza por su modelo de compañía.
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
export interface DiodeParams {
  /** Corriente de saturación (A). */
  is: number;
  /** Factor de idealidad. */
  n: number;
  /** Resistencia serie (Ω). */
  rs: number;
  /** Tensión térmica kT/q (V); por defecto a 25 °C. */
  vt?: number;
}
export interface DiodeEl extends DiodeParams {
  kind: "D";
  id: string;
  /** Ánodo. */
  a: NodeId;
  /** Cátodo. */
  k: NodeId;
}
export interface CapacitorEl {
  kind: "C";
  id: string;
  a: NodeId;
  b: NodeId;
  farads: number;
}
export type Element = ResistorEl | VSourceEl | ISourceEl | DiodeEl | CapacitorEl;

/** kT/q a 25 °C. */
export const VT_25 = (1.380649e-23 * 298.15) / 1.602176634e-19;

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
  /** Diodo de ánodo `a` y cátodo `k`. */
  d(id: string, a: NodeId, k: NodeId, p: DiodeParams): this {
    if (!(p.is > 0) || !(p.n > 0) || !(p.rs >= 0)) throw new Error(`Diodo ${id} inválido`);
    this.elements.push({ kind: "D", id, a, k, is: p.is, n: p.n, rs: p.rs, vt: p.vt });
    return this;
  }
  /** Capacitor de `farads` entre `a` y `b` (abierto en continua). */
  c(id: string, a: NodeId, b: NodeId, farads: number): this {
    if (!(farads > 0)) throw new Error(`Capacitor ${id} inválido: ${farads}`);
    this.elements.push({ kind: "C", id, a, b, farads });
    return this;
  }
}

/** Punto de trabajo de un diodo en la solución. */
interface DiodeOp {
  el: DiodeEl;
  /** Tensión de juntura (sin la caída en Rs). */
  vj: number;
  /** Corriente de ánodo a cátodo. */
  i: number;
}

export class Solution {
  constructor(
    private readonly nodeIndex: Map<NodeId, number>,
    private readonly x: Float64Array,
    private readonly vIndex: Map<string, number>,
    private readonly resistors: Map<string, ResistorEl>,
    private readonly diodes: Map<string, DiodeOp> = new Map(),
    /** Iteraciones de Newton-Raphson (1 si el circuito es lineal). */
    readonly iterations = 1,
    readonly converged = true,
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
  hasDiode(id: string): boolean {
    return this.diodes.has(id);
  }
  /** Corriente por el diodo, de ánodo a cátodo. */
  iD(id: string): number {
    return this.diodes.get(id)?.i ?? 0;
  }
  /** Tensión de juntura del diodo (sin la caída en su resistencia serie). */
  vD(id: string): number {
    return this.diodes.get(id)?.vj ?? 0;
  }
  /** Potencia disipada en el diodo (juntura + resistencia serie). */
  pD(id: string): number {
    const d = this.diodes.get(id);
    if (!d) return 0;
    return d.i * (this.v(d.el.a) - this.v(d.el.k));
  }
  /** Tensiones de juntura, para arrancar la próxima resolución cerca de esta (warm start). */
  junctionVoltages(): Map<string, number> {
    return new Map([...this.diodes].map(([id, d]) => [id, d.vj]));
  }
}

export const GMIN = 1e-12;

export interface SolveOptions {
  /** Tensiones de juntura iniciales por id de diodo (por defecto 0 V). */
  guess?: ReadonlyMap<string, number>;
  maxIter?: number;
}

/** Corriente y conductancia de la juntura; más allá de 80·nVt la exponencial sigue como su recta tangente. */
export function junction(v: number, is: number, nvt: number): { i: number; g: number } {
  const u = v / nvt;
  if (u > 80) {
    const e = Math.exp(80);
    return { i: is * (e * (1 + u - 80) - 1), g: (is * e) / nvt };
  }
  const e = Math.exp(u);
  return { i: is * (e - 1), g: (is * e) / nvt };
}

/** Limitación del paso de tensión de una juntura pn (pnjlim de SPICE 3). */
export function pnjlim(vnew: number, vold: number, nvt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * nvt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / nvt;
      return arg > 0 ? vold + nvt * Math.log(arg) : vcrit;
    }
    return nvt * Math.log(vnew / nvt);
  }
  return vnew;
}

export function solve(net: Netlist, ground: NodeId, gmin = GMIN, opts: SolveOptions = {}): Solution {
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
  const diodes: DiodeEl[] = [];
  /** Nodo de la juntura: interno (entre Rs y la juntura) o el ánodo si no hay Rs. */
  const jNode = (d: DiodeEl): NodeId => (d.rs > 0 ? `${d.id}#j` : d.a);
  for (const el of net.elements) {
    if (el.kind === "R") {
      idx(el.a);
      idx(el.b);
      resistors.set(el.id, el);
    } else if (el.kind === "V") {
      idx(el.pos);
      idx(el.neg);
      vsrc.push(el);
    } else if (el.kind === "D") {
      idx(el.a);
      idx(el.k);
      idx(jNode(el));
      diodes.push(el);
    } else if (el.kind === "C") {
      idx(el.a); // abierto en continua: solo cuenta como nodo
      idx(el.b);
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
  const stampG = (a: number, b: number, g: number) => {
    add(a, a, g);
    add(b, b, g);
    add(a, b, -g);
    add(b, a, -g);
  };

  for (let k = 0; k < n; k++) add(k, k, gmin);

  for (const el of net.elements) {
    if (el.kind === "R") {
      stampG(idx(el.a), idx(el.b), 1 / el.ohms);
    } else if (el.kind === "D") {
      if (el.rs > 0) stampG(idx(el.a), idx(jNode(el)), 1 / el.rs);
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

  const singular = () => new Error("Matriz singular: revisá fuentes de tensión en lazo o en paralelo");
  if (diodes.length === 0) {
    const x = solveDense(A, z, N);
    if (!x) throw singular();
    return new Solution(nodeIndex, x, vIndex, resistors);
  }

  // ---- Newton-Raphson sobre las junturas
  const st = diodes.map((el) => {
    const nvt = el.n * (el.vt ?? VT_25);
    return {
      el,
      nvt,
      vcrit: nvt * Math.log(nvt / (Math.SQRT2 * el.is)),
      p: idx(jNode(el)),
      q: idx(el.k),
      vj: opts.guess?.get(el.id) ?? 0,
      next: 0,
      g: 0,
      ieq: 0,
    };
  });
  const maxIter = opts.maxIter ?? 300;
  const Ai = new Float64Array(N * N);
  const zi = new Float64Array(N);
  const nodeV = (k: number, sol: Float64Array) => (k >= 0 ? sol[k] : 0);
  let x: Float64Array | null = null;
  let iter = 0;
  let converged = false;
  while (iter < maxIter) {
    iter++;
    Ai.set(A);
    zi.set(z);
    for (const d of st) {
      const { i, g } = junction(d.vj, d.el.is, d.nvt);
      d.g = g + gmin; // gmin en paralelo con cada juntura, como SPICE
      d.ieq = i - g * d.vj;
      const { p, q } = d;
      if (p >= 0) Ai[p * N + p] += d.g;
      if (q >= 0) Ai[q * N + q] += d.g;
      if (p >= 0 && q >= 0) {
        Ai[p * N + q] -= d.g;
        Ai[q * N + p] -= d.g;
      }
      if (p >= 0) zi[p] -= d.ieq;
      if (q >= 0) zi[q] += d.ieq;
    }
    x = solveDense(Ai, zi, N);
    if (!x) throw singular();
    let done = true;
    for (const d of st) {
      const vnew = nodeV(d.p, x) - nodeV(d.q, x);
      d.next = pnjlim(vnew, d.vj, d.nvt, d.vcrit);
      if (d.next !== vnew || Math.abs(vnew - d.vj) > 1e-6 * Math.max(Math.abs(vnew), Math.abs(d.vj)) + 1e-9) done = false;
    }
    if (done) {
      converged = true;
      break;
    }
    for (const d of st) d.vj = d.next;
  }
  // corriente de cada diodo según el modelo linealizado de la última resolución (así cumple KCL)
  const ops = new Map<string, DiodeOp>();
  for (const d of st) {
    const vj = nodeV(d.p, x!) - nodeV(d.q, x!);
    ops.set(d.el.id, { el: d.el, vj, i: d.g * vj + d.ieq });
  }
  return new Solution(nodeIndex, x!, vIndex, resistors, ops, iter, converged);
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
