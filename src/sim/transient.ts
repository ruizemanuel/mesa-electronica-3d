import { GMIN, VT_25, junction, pnjlim, type Netlist, type NodeId } from "./mna";

/**
 * Análisis transitorio de paso fijo sobre el mismo MNA (Newton-Raphson para los diodos incluido).
 *
 * Cada capacitor se reemplaza por su modelo de compañía: una conductancia Geq en paralelo con una
 * fuente de corriente Ieq que guarda la historia.
 * - Trapezoidal (el método por defecto, de 2.º orden):  Geq = 2C/h,  Ieq = Geq·v(n) + i(n).
 * - Euler implícito (1.er orden, amortigua):            Geq = C/h,   Ieq = Geq·v(n).
 * El trapezoidal tiene un defecto conocido: después de un salto brusco (el flanco de una cuadrada,
 * un puente que se saca) la corriente del capacitor oscila de paso a paso ("ringing"), sobre todo si
 * hay constantes de tiempo mucho más cortas que el paso. Por eso, como hace SPICE, los pasos que
 * siguen a una discontinuidad se resuelven con Euler implícito, que amortigua: en medios pasos de h/2,
 * que tienen la misma Geq = C/(h/2) = 2C/h, así la matriz no cambia.
 *
 * Como la matriz no depende de los valores de las fuentes ni de la historia, se factoriza una sola vez
 * y se guarda la respuesta del circuito a cada "entrada" por separado (superposición): X_j = A⁻¹·e_j.
 * Las entradas son las fuentes de tensión y de corriente, la Ieq de cada capacitor y la corriente de
 * cada juntura. En cada paso la solución es x = Σ u_j·X_j. Los diodos son las únicas entradas no
 * lineales: su corriente se busca con Newton-Raphson (con pnjlim) en un sistema de k×k, donde k es la
 * cantidad de diodos y la matriz es la impedancia que "ven" las junturas. Así cada paso cuesta
 * O(N·entradas) en lugar de una eliminación gaussiana O(N³), y entran miles de pasos por cuadro.
 */
export type Method = "trap" | "be";

export interface CapState {
  v: number;
  i: number;
}

interface CapInfo {
  id: string;
  a: number;
  b: number;
  c: number;
  geq: number;
  input: number;
}
interface DiodeInfo {
  id: string;
  /** Nodo de la juntura (interno si hay Rs) y cátodo. */
  p: number;
  q: number;
  /** Ánodo y cátodo externos (para la potencia con Rs incluida). */
  a: number;
  k: number;
  is: number;
  nvt: number;
  vcrit: number;
  input: number;
}

/** Factorización LU con pivoteo parcial (in situ). Devuelve false si la matriz es singular. */
export function luFactor(A: Float64Array, N: number, piv: Int32Array): boolean {
  for (let i = 0; i < N; i++) piv[i] = i;
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
    if (max < 1e-300) return false;
    if (p !== k) {
      for (let j = 0; j < N; j++) {
        const t = A[k * N + j];
        A[k * N + j] = A[p * N + j];
        A[p * N + j] = t;
      }
      const t = piv[k];
      piv[k] = piv[p];
      piv[p] = t;
    }
    const d = A[k * N + k];
    for (let i = k + 1; i < N; i++) {
      const f = (A[i * N + k] /= d);
      if (f === 0) continue;
      for (let j = k + 1; j < N; j++) A[i * N + j] -= f * A[k * N + j];
    }
  }
  return true;
}

/** Resuelve LU·x = P·b. `out` recibe la solución. */
export function luSolve(LU: Float64Array, N: number, piv: Int32Array, b: Float64Array, out: Float64Array): void {
  for (let i = 0; i < N; i++) {
    let s = b[piv[i]];
    for (let j = 0; j < i; j++) s -= LU[i * N + j] * out[j];
    out[i] = s;
  }
  for (let i = N - 1; i >= 0; i--) {
    let s = out[i];
    for (let j = i + 1; j < N; j++) s -= LU[i * N + j] * out[j];
    out[i] = s / LU[i * N + i];
  }
}

export class Transient {
  readonly N: number;
  readonly h: number;
  /** Solución del último paso: tensiones de nodo y luego corrientes de las fuentes de tensión. */
  readonly x: Float64Array;
  /** Pasos en los que Newton-Raphson no convergió (diagnóstico). */
  failures = 0;
  private readonly nodeIndex = new Map<NodeId, number>();
  private readonly vRow = new Map<string, number>();
  private readonly inputOf = new Map<string, number>();
  private readonly resistors = new Map<string, { a: number; b: number; ohms: number }>();
  private readonly capIdx = new Map<string, number>();
  private readonly diodeIdx = new Map<string, number>();
  private readonly caps: CapInfo[] = [];
  private readonly diodes: DiodeInfo[] = [];
  /** Respuestas X_j, una fila de N por entrada. */
  private readonly X: Float64Array;
  /** Valor de cada entrada en el paso actual. */
  private readonly u: Float64Array;
  private readonly m: number;
  /** Primera entrada que es un capacitor y primera que es un diodo. */
  private readonly c0: number;
  private readonly d0: number;
  /** Respuesta de la tensión de cada capacitor y de cada juntura a cada entrada (filas de m). */
  private readonly Gc: Float64Array;
  private readonly Gd: Float64Array;
  // estado confirmado y pendiente (step() calcula, commit() acepta)
  private readonly capV: Float64Array;
  private readonly capI: Float64Array;
  private readonly capVn: Float64Array;
  private readonly capIn: Float64Array;
  private readonly vj: Float64Array;
  private readonly vjn: Float64Array;
  private readonly id: Float64Array;
  // auxiliares de Newton (k×k)
  private readonly nrJ: Float64Array;
  private readonly nrR: Float64Array;
  private readonly nrF: Float64Array;
  private readonly nrG: Float64Array;
  private readonly nrPiv: Int32Array;
  private readonly nrD: Float64Array;
  private readonly nrX: Float64Array;

  constructor(net: Netlist, ground: NodeId, h: number, gmin = GMIN) {
    if (!(h > 0)) throw new Error(`Paso inválido: ${h}`);
    this.h = h;
    const idx = (n: NodeId): number => {
      if (n === ground) return -1;
      let k = this.nodeIndex.get(n);
      if (k === undefined) {
        k = this.nodeIndex.size;
        this.nodeIndex.set(n, k);
      }
      return k;
    };
    const jNode = (id: string, a: NodeId, rs: number): NodeId => (rs > 0 ? `${id}#j` : a);
    const vsrc: { id: string; p: number; q: number; volts: number }[] = [];
    const isrc: { id: string; f: number; t: number; amps: number }[] = [];
    for (const el of net.elements) {
      if (el.kind === "R") {
        this.resistors.set(el.id, { a: idx(el.a), b: idx(el.b), ohms: el.ohms });
      } else if (el.kind === "V") {
        vsrc.push({ id: el.id, p: idx(el.pos), q: idx(el.neg), volts: el.volts });
      } else if (el.kind === "I") {
        isrc.push({ id: el.id, f: idx(el.from), t: idx(el.to), amps: el.amps });
      } else if (el.kind === "C") {
        this.capIdx.set(el.id, this.caps.length);
        this.caps.push({ id: el.id, a: idx(el.a), b: idx(el.b), c: el.farads, geq: (2 * el.farads) / h, input: 0 });
      } else {
        const nvt = el.n * (el.vt ?? VT_25);
        const a = idx(el.a);
        const k = idx(el.k);
        const p = idx(jNode(el.id, el.a, el.rs));
        this.diodeIdx.set(el.id, this.diodes.length);
        this.diodes.push({ id: el.id, p, q: k, a, k, is: el.is, nvt, vcrit: nvt * Math.log(nvt / (Math.SQRT2 * el.is)), input: 0 });
        if (el.rs > 0) this.resistors.set(`${el.id}#rs`, { a, b: p, ohms: el.rs });
      }
    }
    const n = this.nodeIndex.size;
    const N = n + vsrc.length;
    this.N = N;
    const A = new Float64Array(N * N);
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
    for (const r of this.resistors.values()) stampG(r.a, r.b, 1 / r.ohms);
    for (const d of this.diodes) stampG(d.p, d.q, gmin); // gmin en paralelo con cada juntura, como SPICE
    for (const c of this.caps) stampG(c.a, c.b, c.geq);
    vsrc.forEach((v, j) => {
      const row = n + j;
      this.vRow.set(v.id, row);
      add(v.p, row, 1);
      add(v.q, row, -1);
      add(row, v.p, 1);
      add(row, v.q, -1);
    });

    // entradas: fuentes de tensión, de corriente, historia de cada capacitor y corriente de cada juntura
    const m = vsrc.length + isrc.length + this.caps.length + this.diodes.length;
    this.m = m;
    this.c0 = vsrc.length + isrc.length;
    this.d0 = this.c0 + this.caps.length;
    this.u = new Float64Array(m);
    const E = new Float64Array(m * N); // vectores de excitación
    let j = 0;
    for (const v of vsrc) {
      E[j * N + this.vRow.get(v.id)!] = 1;
      this.u[j] = v.volts;
      this.inputOf.set(v.id, j++);
    }
    for (const s of isrc) {
      if (s.f >= 0) E[j * N + s.f] -= 1;
      if (s.t >= 0) E[j * N + s.t] += 1;
      this.u[j] = s.amps;
      this.inputOf.set(s.id, j++);
    }
    for (const c of this.caps) {
      c.input = j;
      if (c.a >= 0) E[j * N + c.a] += 1; // Ieq inyectada en a
      if (c.b >= 0) E[j * N + c.b] -= 1;
      j++;
    }
    for (const d of this.diodes) {
      d.input = j;
      if (d.p >= 0) E[j * N + d.p] -= 1; // la juntura saca la corriente de p y la entrega en q
      if (d.q >= 0) E[j * N + d.q] += 1;
      j++;
    }

    const piv = new Int32Array(N);
    if (!luFactor(A, N, piv)) throw new Error("Matriz singular: revisá fuentes de tensión en lazo o en paralelo");
    this.X = new Float64Array(m * N);
    const col = new Float64Array(N);
    for (let k = 0; k < m; k++) {
      luSolve(A, N, piv, E.subarray(k * N, (k + 1) * N), col);
      this.X.set(col, k * N);
    }
    const vdiff = (k: number, a: number, b: number) => (a >= 0 ? this.X[k * N + a] : 0) - (b >= 0 ? this.X[k * N + b] : 0);
    this.Gc = new Float64Array(this.caps.length * m);
    this.caps.forEach((c, i) => {
      for (let k = 0; k < m; k++) this.Gc[i * m + k] = vdiff(k, c.a, c.b);
    });
    const kd = this.diodes.length;
    this.Gd = new Float64Array(kd * m);
    this.diodes.forEach((d, i) => {
      for (let k = 0; k < m; k++) this.Gd[i * m + k] = vdiff(k, d.p, d.q);
    });

    this.x = new Float64Array(N);
    const nc = this.caps.length;
    this.capV = new Float64Array(nc);
    this.capI = new Float64Array(nc);
    this.capVn = new Float64Array(nc);
    this.capIn = new Float64Array(nc);
    this.vj = new Float64Array(kd);
    this.vjn = new Float64Array(kd);
    this.id = new Float64Array(kd);
    this.nrJ = new Float64Array(kd * kd);
    this.nrR = new Float64Array(kd);
    this.nrF = new Float64Array(kd);
    this.nrG = new Float64Array(kd);
    this.nrPiv = new Int32Array(kd);
    this.nrD = new Float64Array(kd);
    this.nrX = new Float64Array(kd);
  }

  // ------------------------------------------------------------------ entradas y estado

  /** Cambia el valor de una fuente de tensión (V) o de corriente (A) para los próximos pasos. */
  setSource(id: string, value: number): void {
    const k = this.inputOf.get(id);
    if (k === undefined) throw new Error(`Fuente ${id} inexistente`);
    this.u[k] = value;
  }
  hasSource(id: string): boolean {
    return this.inputOf.has(id);
  }

  /** Carga el estado de capacitores (por id) y las tensiones de juntura (warm start). */
  loadState(caps?: ReadonlyMap<string, CapState>, junctions?: ReadonlyMap<string, number>): void {
    this.caps.forEach((c, i) => {
      const s = caps?.get(c.id);
      this.capV[i] = s?.v ?? 0;
      this.capI[i] = s?.i ?? 0;
    });
    this.diodes.forEach((d, i) => (this.vj[i] = junctions?.get(d.id) ?? 0));
  }
  /** Copia el estado confirmado desde otro sistema con los mismos capacitores y diodos. */
  copyStateFrom(o: Transient): void {
    this.capV.set(o.capV);
    this.capI.set(o.capI);
    this.vj.set(o.vj);
  }
  saveState(caps: Map<string, CapState>, junctions: Map<string, number>): void {
    this.caps.forEach((c, i) => caps.set(c.id, { v: this.capV[i], i: this.capI[i] }));
    this.diodes.forEach((d, i) => junctions.set(d.id, this.vj[i]));
  }

  // ------------------------------------------------------------------ pasos

  /**
   * Calcula un paso de h (queda pendiente hasta `commit()`). Con `method = "be"` da dos medios pasos
   * de Euler implícito (para después de una discontinuidad). Devuelve false si Newton no convergió.
   */
  step(method: Method = "trap"): boolean {
    const { caps, m, N } = this;
    this.capVn.set(this.capV);
    this.capIn.set(this.capI);
    this.vjn.set(this.vj);
    let ok = true;
    const subs = method === "be" ? 2 : 1;
    for (let s = 0; s < subs; s++) {
      for (let i = 0; i < caps.length; i++) {
        const c = caps[i];
        this.u[c.input] = c.geq * this.capVn[i] + (method === "trap" ? this.capIn[i] : 0);
      }
      ok = this.solveDiodes() && ok;
      for (let i = 0; i < caps.length; i++) {
        const c = caps[i];
        let v = 0;
        const row = i * m;
        for (let k = 0; k < m; k++) v += this.Gc[row + k] * this.u[k];
        const dv = v - this.capVn[i];
        this.capIn[i] = method === "trap" ? c.geq * dv - this.capIn[i] : c.geq * dv;
        this.capVn[i] = v;
      }
    }
    // solución completa (superposición)
    const x = this.x;
    x.fill(0);
    for (let k = 0; k < m; k++) {
      const uk = this.u[k];
      if (uk === 0) continue;
      const off = k * N;
      for (let r = 0; r < N; r++) x[r] += uk * this.X[off + r];
    }
    if (!ok) this.failures++;
    return ok;
  }

  /** Acepta el último paso calculado. */
  commit(): void {
    this.capV.set(this.capVn);
    this.capI.set(this.capIn);
    this.vj.set(this.vjn);
  }

  /**
   * Newton-Raphson en las junturas: vj = base + M·f(vj), donde base es la tensión que pondría el resto
   * de las entradas y M la matriz de impedancias entre junturas. Arranca desde la solución anterior.
   */
  private solveDiodes(): boolean {
    const kd = this.diodes.length;
    if (kd === 0) return true;
    const { m, d0, Gd, u } = this;
    const base = this.nrD;
    for (let i = 0; i < kd; i++) {
      let s = 0;
      const row = i * m;
      for (let k = 0; k < d0; k++) s += Gd[row + k] * u[k];
      base[i] = s;
    }
    const v = this.vjn;
    let converged = false;
    for (let it = 0; it < 200; it++) {
      for (let i = 0; i < kd; i++) {
        const d = this.diodes[i];
        const jn = junction(v[i], d.is, d.nvt);
        this.nrF[i] = jn.i;
        this.nrG[i] = jn.g;
      }
      // r = v − base − M·f ;  J = I − M·diag(g)
      for (let i = 0; i < kd; i++) {
        let s = v[i] - base[i];
        for (let e = 0; e < kd; e++) {
          const Mie = Gd[i * m + d0 + e];
          s -= Mie * this.nrF[e];
          this.nrJ[i * kd + e] = (i === e ? 1 : 0) - Mie * this.nrG[e];
        }
        this.nrR[i] = -s;
      }
      let dx: Float64Array;
      if (kd === 1) {
        this.nrR[0] /= this.nrJ[0];
        dx = this.nrR;
      } else {
        if (!luFactor(this.nrJ, kd, this.nrPiv)) break;
        luSolve(this.nrJ, kd, this.nrPiv, this.nrR, this.nrX);
        dx = this.nrX;
      }
      let done = true;
      for (let i = 0; i < kd; i++) {
        const d = this.diodes[i];
        const vnew = v[i] + dx[i];
        const lim = pnjlim(vnew, v[i], d.nvt, d.vcrit);
        if (lim !== vnew || Math.abs(dx[i]) > 1e-9 + 1e-7 * Math.abs(vnew)) done = false;
        v[i] = lim;
      }
      if (done) {
        converged = true;
        break;
      }
    }
    for (let i = 0; i < kd; i++) {
      const d = this.diodes[i];
      const c = junction(v[i], d.is, d.nvt).i;
      this.id[i] = c;
      u[d.input] = c;
    }
    return converged;
  }

  // ------------------------------------------------------------------ lecturas

  /** Índice de un nodo en `x` (-1 para masa o nodos desconocidos). */
  node(n: NodeId): number {
    return this.nodeIndex.get(n) ?? -1;
  }
  v(n: NodeId): number {
    const k = this.nodeIndex.get(n);
    return k === undefined ? 0 : this.x[k];
  }
  vab(a: NodeId, b: NodeId): number {
    return this.v(a) - this.v(b);
  }
  /** Corriente por una fuente de tensión, de pos a neg por dentro (negativa si entrega potencia). */
  iV(id: string): number {
    const r = this.vRow.get(id);
    if (r === undefined) throw new Error(`Fuente ${id} inexistente`);
    return this.x[r];
  }
  hasResistor(id: string): boolean {
    return this.resistors.has(id);
  }
  iR(id: string): number {
    const r = this.resistors.get(id);
    if (!r) return 0;
    return ((r.a >= 0 ? this.x[r.a] : 0) - (r.b >= 0 ? this.x[r.b] : 0)) / r.ohms;
  }
  pR(id: string): number {
    const r = this.resistors.get(id);
    if (!r) return 0;
    const dv = (r.a >= 0 ? this.x[r.a] : 0) - (r.b >= 0 ? this.x[r.b] : 0);
    return (dv * dv) / r.ohms;
  }
  /** Índices de los nodos de un resistor (para leer `x` en bucles sin buscar en mapas). */
  resistorNodes(id: string): { a: number; b: number; ohms: number } | null {
    return this.resistors.get(id) ?? null;
  }
  hasDiode(id: string): boolean {
    return this.diodeIdx.has(id);
  }
  iD(id: string): number {
    const k = this.diodeIdx.get(id);
    return k === undefined ? 0 : this.id[k];
  }
  vD(id: string): number {
    const k = this.diodeIdx.get(id);
    return k === undefined ? 0 : this.vjn[k];
  }
  /** Potencia en el diodo (juntura + Rs). */
  pD(id: string): number {
    const k = this.diodeIdx.get(id);
    if (k === undefined) return 0;
    const d = this.diodes[k];
    return this.id[k] * ((d.a >= 0 ? this.x[d.a] : 0) - (d.k >= 0 ? this.x[d.k] : 0));
  }
  hasCap(id: string): boolean {
    return this.capIdx.has(id);
  }
  /** Tensión y corriente del capacitor en el último paso calculado (a → b). */
  vC(id: string): number {
    const k = this.capIdx.get(id);
    return k === undefined ? 0 : this.capVn[k];
  }
  iC(id: string): number {
    const k = this.capIdx.get(id);
    return k === undefined ? 0 : this.capIn[k];
  }
  get capIds(): string[] {
    return this.caps.map((c) => c.id);
  }
  get diodeIds(): string[] {
    return this.diodes.map((d) => d.id);
  }

  /**
   * Constante de tiempo de cada capacitor con el resto del circuito (diodos apagados): C·R_th, donde
   * R_th sale gratis de la respuesta precalculada: inyectando 1 A en el capacitor, v = 1/(Geq + 1/R_th).
   */
  capTau(id: string): number {
    const k = this.capIdx.get(id);
    if (k === undefined) return Infinity;
    const c = this.caps[k];
    const z = this.Gc[k * this.m + c.input];
    const gth = 1 / z - c.geq;
    return gth > 1e-15 ? c.c / gth : Infinity;
  }
}
