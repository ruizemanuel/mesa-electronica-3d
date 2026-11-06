import { CapacitorPart, REVERSE_LEAK } from "./capacitor";
import { CIRCUITS, netOfHole, type CapacitorDef, type CircuitDef, type DiodeDef } from "./circuits";
import { DiodePart, diodeParams, type DiodeType } from "./diode";
import { Multimeter, NODE, type DmmWindow } from "./dmm";
import { FunctionGenerator } from "./fgen";
import { Netlist, solve, type Solution } from "./mna";
import { BenchSupply, type PsuMode } from "./psu";
import { ResistorPart, type ResistorSpec } from "./resistor";
import { Rng, hashSeed } from "./rng";
import { Oscilloscope, PROBE_R } from "./scope";
import { Transient, type CapState } from "./transient";

export type PsuPost = "psu+" | "psu-" | "psuGnd";
export type ProbeTarget = { kind: "hole"; hole: string } | { kind: "post"; post: PsuPost } | null;
/** Puntas del multímetro. */
export type ProbeColor = "red" | "black";
/** Todo lo que se puede apoyar en el circuito: puntas del multímetro, del osciloscopio y su pinza de masa. */
export type ProbeId = ProbeColor | "ch1" | "ch2" | "sgnd";
export const PROBE_IDS: ProbeId[] = ["red", "black", "ch1", "ch2", "sgnd"];

export const GROUND = "psu-";
/** Tierra del enchufe: la comparten la masa del osciloscopio, la del generador y el borne GND de la fuente. */
export const EARTH = "earth";
const LEAD_PSU = 0.03; // Ω, cable banana–cocodrilo + contacto
const LEAD_PROBE = 0.05; // Ω por punta de prueba
const JUMPER = 0.015; // Ω, puente de protoboard
const LEAD_GEN = 0.05; // Ω, cable BNC–cocodrilo
const LEAD_SCOPE_GND = 0.1; // Ω, cablecito de masa de la punta del osciloscopio
/** Ancho de banda (−3 dB) del convertidor TRUE RMS del multímetro: −1 % a 1 kHz, −30 % a 8 kHz. */
export const DMM_AC_BW = 8000;
/** Pasos de Euler implícito después de una discontinuidad (alcanzan para apagar los modos rígidos). */
export const BE_STEPS = 3;

export interface ResistorReading {
  id: string;
  v: number;
  i: number;
  p: number;
}
/** Diodo: tensión y corriente de ánodo a cátodo (negativas en inversa). */
export interface DiodeReading {
  id: string;
  v: number;
  i: number;
  p: number;
}

export type BenchEvent =
  | { kind: "fuse"; which: "mA" | "A" }
  | { kind: "burn"; id: string }
  | { kind: "smoke"; id: string }
  | { kind: "diodeBurn"; id: string; peak: number; led: boolean }
  | { kind: "capBurst"; id: string }
  | { kind: "cc"; on: boolean };

/** Fila de los cálculos teóricos de un circuito con capacitores. */
export interface AnalysisRow {
  label: string;
  theory: string;
  real: string;
}

/** Cuántos pasos de simulación se permiten por cuadro (si no alcanzan, la simulación va en cámara lenta). */
export interface StepBudget {
  maxSteps: number;
  /** Tope de tiempo de CPU por cuadro (ms); sin tope si no se indica (tests, grabador). */
  maxMs?: number;
}

/** Acumuladores de un cuadro de análisis transitorio. */
interface FrameStats {
  t: number;
  iMa2: number;
  iA2: number;
  vout: number;
  iout: number;
}

const fmt = (x: number, unit: string, digits = 3) => {
  if (!isFinite(x)) return "—";
  const abs = Math.abs(x);
  const pre: [number, string][] = [
    [1e3, "k"],
    [1, ""],
    [1e-3, "m"],
    [1e-6, "µ"],
    [1e-9, "n"],
  ];
  const [s, p] = pre.find(([s]) => abs >= s * 0.9995) ?? pre[pre.length - 1];
  return `${Number((x / s).toPrecision(digits)).toString().replace(".", ",")} ${p}${unit}`;
};

export class Bench {
  readonly psu: BenchSupply;
  readonly dmm: Multimeter;
  readonly gen = new FunctionGenerator();
  readonly scope = new Oscilloscope();
  circuit: CircuitDef = CIRCUITS[0];
  readonly parts = new Map<string, ResistorPart>();
  readonly diodes = new Map<string, DiodePart>();
  readonly caps = new Map<string, CapacitorPart>();
  readonly jumperPresent = new Map<string, boolean>();
  readonly probes: Record<ProbeId, ProbeTarget> = { red: null, black: null, ch1: null, ch2: null, sgnd: null };
  time = 0;
  sol: Solution | null = null;
  /** Potencia media de cada resistor en el último cuadro (W). */
  readonly power = new Map<string, number>();
  /** Velocidad de la simulación respecto del tiempo real en el último cuadro (1 = tiempo real). */
  speed = 1;
  /** Paso de integración del último cuadro (s); 0 si el circuito se resolvió en continua. */
  lastH = 0;
  budget: StepBudget = { maxSteps: 20000 };
  private listeners: ((e: BenchEvent) => void)[] = [];
  private rngParts: Rng;
  private lastMode: PsuMode = "OFF";
  /** Tensiones de juntura de la última solución: arrancan Newton-Raphson cerca del resultado. */
  private guess = new Map<string, number>();
  /** Estado de los capacitores (tensión y corriente), que sobrevive entre cuadros. */
  private capState = new Map<string, CapState>();
  private lastSig = "";
  private lastGenRev = -1;
  private tCarry = 0;
  private lastTaus: number[] = [];
  /** Fase del generador como contador entero de pasos dentro del período (así los flancos caen justo en un paso). */
  private genStep = 0;
  private genSteps = 1;
  private dmmWin: DmmWindow & { y: number; sumV: number; sumY: number; sumY2: number; sumIma: number; sumIA: number } = this.emptyWindow();
  private dmmForce = false;

  constructor(seed = 20261104) {
    this.psu = new BenchSupply(new Rng(hashSeed("psu", seed)));
    this.dmm = new Multimeter(new Rng(hashSeed("dmm", seed)), hashSeed("dmm-cal", seed));
    this.rngParts = new Rng(hashSeed("parts", seed));
    this.loadCircuit(CIRCUITS[0].id);
  }

  on(fn: (e: BenchEvent) => void): void {
    this.listeners.push(fn);
  }
  private emit(e: BenchEvent): void {
    for (const l of this.listeners) l(e);
  }

  loadCircuit(id: string): void {
    const def = CIRCUITS.find((c) => c.id === id);
    if (!def) throw new Error(`Circuito ${id} desconocido`);
    this.circuit = def;
    this.parts.clear();
    for (const r of def.resistors) this.parts.set(r.id, new ResistorPart(r.id, { ...r.spec }, this.rngParts));
    this.diodes.clear();
    for (const d of def.diodes ?? []) this.diodes.set(d.id, new DiodePart(d.id, d.type, this.rngParts));
    this.caps.clear();
    for (const c of def.capacitors ?? []) this.caps.set(c.id, new CapacitorPart(c.id, c.nominal, this.rngParts));
    this.capState.clear();
    this.guess.clear();
    this.jumperPresent.clear();
    for (const j of def.jumpers) this.jumperPresent.set(j.id, j.present ?? true);
    this.psu.output = false;
    this.psu.vset = def.vset;
    this.psu.iset = def.iset;
    for (const p of PROBE_IDS) this.probes[p] = null;
    const g = def.gen;
    this.gen.setOutput(false);
    if (g) {
      this.gen.setWave(g.wave);
      this.gen.offset = 0;
      this.gen.setVpp(g.vpp);
      this.gen.setOffset(g.offset);
      this.gen.setFreq(g.freq);
      this.gen.param = "freq";
    }
    const s = def.scope;
    const sc = this.scope;
    if (s) {
      const hole = (h?: string): ProbeTarget => (h ? { kind: "hole", hole: h } : null);
      this.probes.ch1 = hole(s.ch1);
      this.probes.ch2 = hole(s.ch2);
      this.probes.sgnd = hole(s.gnd);
      sc.setTdiv(s.tdiv);
      sc.hpos = s.hpos ?? 0;
      s.ch.forEach((c, i) => Object.assign(sc.ch[i], { on: c.on ?? true, vdiv: c.vdiv, pos: c.pos, coupling: c.coupling ?? "DC" }));
      Object.assign(sc.trig, { src: s.trig.src, level: s.trig.level, slope: s.trig.slope ?? "rise", mode: "AUTO" });
    }
    sc.running = true;
    sc.cursor.mode = "off";
    sc.clear();
    this.sol = null;
    this.power.clear();
    this.tCarry = 0;
    this.lastSig = "";
    this.dmmWin = this.emptyWindow();
  }

  setResistor(id: string, spec: ResistorSpec): void {
    this.parts.get(id)?.renew(spec);
  }

  /** Coloca un diodo nuevo (del mismo tipo u otro) en el mismo lugar y orientación. */
  setDiode(id: string, type?: DiodeType): void {
    this.diodes.get(id)?.renew(type);
    this.guess.delete(id);
  }
  /** Saca el diodo y lo vuelve a poner al revés. */
  flipDiode(id: string): void {
    this.diodes.get(id)?.flip();
    this.guess.delete(id);
  }
  /** Coloca un capacitor nuevo (descargado), opcionalmente de otro valor. */
  setCapacitor(id: string, nominal?: number): void {
    this.caps.get(id)?.renew(nominal);
    this.capState.delete(id);
    this.guess.delete(`${id}:rev`);
  }
  /** Saca el electrolítico y lo vuelve a poner al revés (conserva la carga, con el signo cambiado). */
  flipCapacitor(id: string): void {
    const c = this.caps.get(id);
    if (!c?.polarized) return;
    c.flip();
    const s = this.capState.get(id);
    if (s) this.capState.set(id, { v: -s.v, i: 0 });
    this.guess.delete(`${id}:rev`);
  }
  /** Descarga el capacitor (un corto con la punta de un destornillador, como en el taller). */
  dischargeCapacitor(id: string): void {
    this.capState.set(id, { v: 0, i: 0 });
  }

  /** Agujeros donde quedaron el ánodo y el cátodo (según la orientación actual). */
  diodeHoles(def: DiodeDef): { a: string; k: string } {
    const part = this.diodes.get(def.id);
    return part?.reversed ? { a: def.k, k: def.a } : { a: def.a, k: def.k };
  }
  /** Agujeros de la pata + y de la pata − del capacitor (según la orientación actual). */
  capHoles(def: CapacitorDef): { p: string; n: string } {
    const part = this.caps.get(def.id);
    return part?.reversed ? { p: def.b, n: def.a } : { p: def.a, n: def.b };
  }

  /** ¿Los puentes están como en el circuito original? (ninguno quitado ni agregado) */
  jumpersAsBuilt(): boolean {
    return this.circuit.jumpers.every((j) => this.jumperPresent.get(j.id) === (j.present ?? true));
  }
  /** ¿Se quitó algún puente que venía puesto? (para medir corriente en serie) */
  jumperRemoved(): boolean {
    return this.circuit.jumpers.some((j) => (j.present ?? true) && !this.jumperPresent.get(j.id));
  }

  netOf(t: ProbeTarget, free: string): string {
    if (!t) return free;
    if (t.kind === "hole") return netOfHole(t.hole);
    return t.post === "psuGnd" ? "psu:gnd" : t.post;
  }

  /** ¿El circuito necesita análisis transitorio? (capacitores, o el generador encendido) */
  get transient(): boolean {
    return this.caps.size > 0 || (!!this.circuit.gen && this.gen.output);
  }

  /**
   * La masa del osciloscopio está apoyada en otro nodo que la masa del generador: como las dos van a
   * la tierra del enchufe, ese nodo queda en corto con la masa del generador (el clásico lazo de masa).
   */
  groundLoop(): boolean {
    const g = this.circuit.gen;
    if (!g || !this.probes.sgnd) return false;
    return this.netOf(this.probes.sgnd, "probe:sgnd") !== netOfHole(g.neg);
  }

  /** Netlist completo: protoboard + fuente + generador + osciloscopio + multímetro con sus puntas. */
  build(ohmRange: number, psuMode: PsuMode, opts: { withDmm?: boolean; ideal?: boolean; genValue?: number } = {}): Netlist {
    const withDmm = opts.withDmm ?? true;
    const ideal = opts.ideal ?? false;
    const net = new Netlist();
    const small = (r: number) => (ideal ? 1e-6 : r);
    net.r("lead:psu+", "psu+", "RT+", small(LEAD_PSU));
    net.r("lead:psu-", "psu-", "RB-", small(LEAD_PSU));
    for (const j of this.circuit.jumpers) {
      if (!this.jumperPresent.get(j.id)) continue;
      const a = netOfHole(j.a);
      const b = netOfHole(j.b);
      if (a !== b) net.r(`jumper:${j.id}`, a, b, small(JUMPER));
    }
    for (const r of this.circuit.resistors) {
      const part = this.parts.get(r.id)!;
      net.r(r.id, netOfHole(r.a), netOfHole(r.b), ideal ? part.spec.nominal : part.ohms);
    }
    for (const d of this.circuit.diodes ?? []) {
      const part = this.diodes.get(d.id)!;
      if (!ideal && part.state === "quemado") continue; // abierto
      const h = this.diodeHoles(d);
      net.d(d.id, netOfHole(h.a), netOfHole(h.k), ideal ? diodeParams(part.model) : part.params());
    }
    for (const c of this.circuit.capacitors ?? []) {
      const part = this.caps.get(c.id)!;
      if (!ideal && part.state === "inflado") continue; // la válvula se abrió: queda abierto
      const h = this.capHoles(c);
      const p = netOfHole(h.p);
      const n = netOfHole(h.n);
      if (part.polarized && !ideal) {
        net.r(`${c.id}:esr`, p, `${c.id}#i`, part.model.esr);
        net.c(c.id, `${c.id}#i`, n, part.farads);
        net.d(`${c.id}:rev`, n, p, REVERSE_LEAK);
      } else net.c(c.id, p, n, ideal ? part.nominal : part.farads);
    }
    if (ideal) {
      if (psuMode !== "OFF") net.v("psu:V", "psu+", "psu-", this.psu.vset);
    } else {
      this.psu.stamp(net, psuMode, "psu+", "psu-");
    }
    net.r("psu:gndEarth", "psu:gnd", EARTH, 0.01);
    // generador: salida de 50 Ω referida a tierra; con OUTPUT apagado el relé la desconecta
    const g = this.circuit.gen;
    if (g) {
      net.r("lead:gen-", EARTH, netOfHole(g.neg), small(LEAD_GEN));
      if (this.gen.output) {
        net.v("gen:V", "gen:int", EARTH, opts.genValue ?? this.gen.valueAt(this.genStep / this.genSteps));
        net.r("gen:rout", "gen:int", "gen:out", ideal ? this.gen.rout : this.gen.rout);
        net.r("lead:gen+", "gen:out", netOfHole(g.pos), small(LEAD_GEN));
      }
    }
    // osciloscopio: 10 MΩ de cada punta a tierra, y el cablecito de masa
    if (!ideal) {
      net.r("scope:r1", this.netOf(this.probes.ch1, "probe:ch1"), EARTH, PROBE_R);
      net.r("scope:r2", this.netOf(this.probes.ch2, "probe:ch2"), EARTH, PROBE_R);
      net.r("scope:gnd", this.netOf(this.probes.sgnd, "probe:sgnd"), EARTH, LEAD_SCOPE_GND);
    }
    if (withDmm) {
      net.r("lead:red", this.netOf(this.probes.red, "probe:red"), NODE[this.dmm.red], LEAD_PROBE);
      net.r("lead:black", this.netOf(this.probes.black, "probe:black"), NODE.COM, LEAD_PROBE);
      this.dmm.stamp(net, ohmRange);
    }
    return net;
  }

  /** Resuelve con la lógica CV/CC de la fuente. */
  solveAt(ohmRange: number, opts: { withDmm?: boolean } = {}): { sol: Solution; mode: PsuMode } {
    const so = { guess: this.guess };
    if (!this.psu.output) {
      return { sol: solve(this.build(ohmRange, "OFF", opts), GROUND, undefined, so), mode: "OFF" };
    }
    let sol = solve(this.build(ohmRange, "CV", opts), GROUND, undefined, so);
    const iout = -sol.iV("psu:V");
    if (iout > this.psu.iset) {
      sol = solve(this.build(ohmRange, "CC", opts), GROUND, undefined, so);
      return { sol, mode: "CC" };
    }
    return { sol, mode: "CV" };
  }

  /** Avanza la simulación dt segundos (circuito, térmica, fusibles, instrumentos). */
  step(dt: number): void {
    if (this.transient) {
      this.stepTransient(dt);
      return;
    }
    this.lastH = 0;
    this.speed = 1;
    const t0 = this.time;
    this.time += dt;
    const { sol, mode } = this.solveAt(this.dmm.ohmRangeForStep());
    this.sol = sol;
    for (const [id, v] of sol.junctionVoltages()) this.guess.set(id, v);
    const vout = sol.vab("psu+", "psu-");
    const iout = mode === "CV" ? -sol.iV("psu:V") : mode === "CC" ? this.psu.iset - vout / 1e7 : 0;
    this.psu.update(vout, iout, mode, dt);
    this.noteMode(mode);

    for (const r of this.circuit.resistors) {
      this.power.set(r.id, sol.pR(r.id));
      this.stepResistor(r.id, sol.pR(r.id), dt);
    }
    for (const part of this.diodes.values()) this.stepDiode(part, sol.iD(part.id), sol.pD(part.id), dt);
    if (this.dmm.fuseMa.step(sol.iR("dmm:shMa"), dt)) this.emit({ kind: "fuse", which: "mA" });
    if (this.dmm.fuseA.step(sol.iR("dmm:shA"), dt)) this.emit({ kind: "fuse", which: "A" });

    // el osciloscopio ve una continua: dos muestras por cuadro (un cambio se ve como un escalón)
    const v1 = sol.vab(this.netOf(this.probes.ch1, "probe:ch1"), EARTH);
    const v2 = sol.vab(this.netOf(this.probes.ch2, "probe:ch2"), EARTH);
    this.scope.push(t0 + Math.min(this.scope.ts, dt / 2), v1, v2);
    this.scope.push(this.time, v1, v2);
    this.scope.update();

    this.dmm.update(dt, (r) => (r === this.dmm.ohmRangeForStep() ? sol : this.solveAt(r).sol));
  }

  private noteMode(mode: PsuMode): void {
    if ((mode === "CC") !== (this.lastMode === "CC")) this.emit({ kind: "cc", on: mode === "CC" });
    this.lastMode = mode;
  }
  private stepResistor(id: string, p: number, dt: number): void {
    const part = this.parts.get(id)!;
    const before = part.state;
    part.step(p, dt);
    if (part.state !== before) {
      if (part.state === "quemado") this.emit({ kind: "burn", id });
      else if (part.state === "humo") this.emit({ kind: "smoke", id });
    }
  }
  private stepDiode(part: DiodePart, i: number, p: number, dt: number): void {
    const before = part.state;
    part.step(i, p, dt);
    if (part.state === "quemado" && before !== "quemado") this.emit({ kind: "diodeBurn", id: part.id, peak: part.peak, led: part.model.led });
  }

  // ------------------------------------------------------------------ análisis transitorio

  /**
   * Paso de integración: lo bastante fino para la señal del generador (64 puntos por período), para la
   * base de tiempo del osciloscopio (250 puntos por pantalla) y para las constantes de tiempo del
   * circuito (16 puntos por τ: el trapezoidal es de 2.º orden, con eso el error queda en ≈ 0,1 %).
   * Con el generador, el período queda dividido en una cantidad entera de pasos (par, con la cuadrada)
   * para que los flancos caigan justo al principio de un paso.
   */
  private chooseH(): { h: number; steps: number } {
    let target = 1e-3;
    target = Math.min(target, this.scope.span / 250);
    for (const tau of this.lastTaus) target = Math.min(target, Math.max(tau, 16e-6) / 16);
    target = Math.max(target, 0.25e-6);
    if (this.circuit.gen && this.gen.output) {
      const T = 1 / this.gen.freq;
      target = Math.min(target, T / 64);
      let steps = Math.max(2, Math.ceil(T / target - 1e-9));
      if (this.gen.wave !== "sine" && steps % 2) steps++;
      return { h: T / steps, steps };
    }
    return { h: target, steps: this.genSteps };
  }

  private emptyWindow() {
    return { duration: 0, vMean: 0, vAcRms: 0, iMa: 0, iA: 0, y: NaN, sumV: 0, sumY: 0, sumY2: 0, sumIma: 0, sumIA: 0 };
  }

  private makeSys(mode: PsuMode, ohm: number, h: number): Transient {
    const sys = new Transient(this.build(ohm, mode), GROUND, h);
    sys.loadState(this.capState, this.guess);
    return sys;
  }

  private stepTransient(dt: number): void {
    const { h, steps } = this.chooseH();
    this.lastH = h;
    // remapear la fase del generador si cambió la cantidad de pasos por período
    if (steps !== this.genSteps) {
      this.genStep = Math.round((this.genStep / this.genSteps) * steps) % steps;
      this.genSteps = steps;
    }
    const ohm = this.dmm.ohmRangeForStep();
    let mode: PsuMode = !this.psu.output ? "OFF" : this.lastMode === "CC" ? "CC" : "CV";
    let sys = this.makeSys(mode, ohm, h);
    const systems = new Map<PsuMode, Transient>([[mode, sys]]);
    const getSys = (m: PsuMode) => {
      let s = systems.get(m);
      if (!s) {
        s = this.makeSys(m, ohm, h);
        systems.set(m, s);
      }
      return s;
    };
    // firma de la topología: si cambió algo (un puente, una punta, la llave), el primer paso va con Euler
    const net = this.build(ohm, mode);
    const sig = net.elements.map((e) => `${e.kind}${e.id}`).join("|") + `|${this.probesKey()}`;
    // después de una discontinuidad se dan BE_STEPS pasos de Euler implícito (ver transient.ts)
    let beLeft = sig !== this.lastSig || this.gen.revision !== this.lastGenRev ? BE_STEPS : 0;
    this.lastSig = sig;
    this.lastGenRev = this.gen.revision;

    const genOn = !!this.circuit.gen && this.gen.output && sys.hasSource("gen:V");
    const square = this.gen.wave === "square";
    const half = this.genSteps / 2;
    const st: FrameStats = {
      t: 0,
      iMa2: 0,
      iA2: 0,
      vout: 0,
      iout: 0,
    };
    const resIds = this.circuit.resistors.map((r) => r.id);
    const diodeIds = [...this.diodes.keys()];
    const capIds = [...this.caps.keys()];
    const rE = new Float64Array(resIds.length);
    const dI = new Float64Array(diodeIds.length);
    const dP = new Float64Array(diodeIds.length);
    const cP = new Float64Array(capIds.length);
    // índices de lectura, que dependen del sistema (CV y CC numeran distinto los nodos)
    const ch1 = this.netOf(this.probes.ch1, "probe:ch1");
    const ch2 = this.netOf(this.probes.ch2, "probe:ch2");
    let tap = this.taps(sys, ch1, ch2, resIds);
    const alpha = 1 - Math.exp(-h / (1 / (2 * Math.PI * DMM_AC_BW))); // ancho de banda de V~
    const w = this.dmmWin;

    const available = dt + this.tCarry;
    const want = Math.floor(available / h + 1e-9);
    const max = Math.min(want, this.budget.maxSteps);
    const t0 = typeof performance === "object" ? performance.now() : 0;
    let n = 0;
    for (; n < max; n++) {
      if (this.budget.maxMs !== undefined && (n & 63) === 63 && performance.now() - t0 > this.budget.maxMs) break;
      const prev = this.genStep;
      this.genStep = (this.genStep + 1) % this.genSteps;
      if (genOn && square && (prev === 0 || prev === half)) beLeft = BE_STEPS;
      const be = beLeft > 0;
      if (be) beLeft--;
      if (genOn) sys.setSource("gen:V", this.gen.valueAt(this.genStep / this.genSteps, true));
      sys.step(be ? "be" : "trap");
      // fuente de laboratorio: pasa a CC si se supera el límite y vuelve a CV cuando la tensión llega a Vset
      if (mode !== "OFF") {
        const vo = sys.vab("psu+", "psu-");
        const sw = mode === "CV" ? -sys.iV("psu:V") > this.psu.iset : vo > this.psu.vset;
        if (sw) {
          const other = getSys(mode === "CV" ? "CC" : "CV");
          other.copyStateFrom(sys);
          if (genOn) other.setSource("gen:V", this.gen.valueAt(this.genStep / this.genSteps, true));
          mode = mode === "CV" ? "CC" : "CV";
          sys = other;
          tap = this.taps(sys, ch1, ch2, resIds);
          beLeft = BE_STEPS - 1;
          sys.step("be");
        }
      }
      sys.commit();
      this.time += h;
      st.t += h;
      const x = sys.x;
      const xv = (k: number) => (k >= 0 ? x[k] : 0);
      // instrumentos
      const earth = xv(tap.earth);
      this.scope.push(this.time, xv(tap.ch1) - earth, xv(tap.ch2) - earth);
      const vx = xv(tap.vohm) - xv(tap.com);
      w.y = isNaN(w.y) ? vx : w.y + (vx - w.y) * alpha;
      w.sumV += vx * h;
      w.sumY += w.y * h;
      w.sumY2 += w.y * w.y * h;
      const ima = tap.shMa ? (xv(tap.shMa.a) - xv(tap.shMa.b)) / tap.shMa.ohms : 0;
      const ia = tap.shA ? (xv(tap.shA.a) - xv(tap.shA.b)) / tap.shA.ohms : 0;
      w.sumIma += ima * h;
      w.sumIA += ia * h;
      w.duration += h;
      st.iMa2 += ima * ima * h;
      st.iA2 += ia * ia * h;
      if (mode !== "OFF") {
        const vo = sys.vab("psu+", "psu-");
        st.vout += vo * h;
        st.iout += (mode === "CV" ? -sys.iV("psu:V") : this.psu.iset - vo / 1e7) * h;
      }
      for (let i = 0; i < resIds.length; i++) {
        const r = tap.res[i];
        if (!r) continue;
        const dv = xv(r.a) - xv(r.b);
        rE[i] += ((dv * dv) / r.ohms) * h;
      }
      for (let i = 0; i < diodeIds.length; i++) {
        dI[i] += sys.iD(diodeIds[i]) * h;
        dP[i] += sys.pD(diodeIds[i]) * h;
      }
      for (let i = 0; i < capIds.length; i++) {
        const id = capIds[i];
        cP[i] += (sys.pD(`${id}:rev`) + sys.pR(`${id}:esr`)) * h;
      }
    }
    this.speed = dt > 0 ? (n * h) / dt : 1;
    this.tCarry = n === want ? available - n * h : 0;
    sys.saveState(this.capState, this.guess);
    this.noteMode(mode);
    const T = st.t;
    if (T > 0) {
      this.psu.update(st.vout / T, st.iout / T, mode, dt);
      resIds.forEach((id, i) => {
        this.power.set(id, rE[i] / T);
        this.stepResistor(id, rE[i] / T, T);
      });
      diodeIds.forEach((id, i) => this.stepDiode(this.diodes.get(id)!, dI[i] / T, dP[i] / T, T));
      capIds.forEach((id, i) => {
        const part = this.caps.get(id)!;
        part.volts = sys.vC(id);
        if (part.step(cP[i] / T, T)) this.emit({ kind: "capBurst", id });
      });
      if (this.dmm.fuseMa.step(Math.sqrt(st.iMa2 / T), T)) this.emit({ kind: "fuse", which: "mA" });
      if (this.dmm.fuseA.step(Math.sqrt(st.iA2 / T), T)) this.emit({ kind: "fuse", which: "A" });
    }
    this.lastTaus = capIds.map((id) => sys.capTau(id)).filter((t) => isFinite(t));
    this.sol = null;
    this.scope.update();

    // multímetro: lo que integró desde la última lectura
    if (w.duration > 0) {
      const mean = w.sumV / w.duration;
      const my = w.sumY / w.duration;
      w.vMean = mean;
      w.vAcRms = Math.sqrt(Math.max(0, w.sumY2 / w.duration - my * my));
      w.iMa = w.sumIma / w.duration;
      w.iA = w.sumIA / w.duration;
    }
    if (this.dmm.updateFrom(dt, w.duration > 0 ? w : null, this.dmmForce)) {
      this.dmmWin = this.emptyWindow();
      this.dmmForce = false;
    }
  }

  private probesKey(): string {
    return PROBE_IDS.map((p) => this.netOf(this.probes[p], `probe:${p}`)).join(",") + this.dmm.dial + this.dmm.red;
  }

  private taps(sys: Transient, ch1: string, ch2: string, resIds: string[]) {
    return {
      earth: sys.node(EARTH),
      ch1: sys.node(ch1),
      ch2: sys.node(ch2),
      vohm: sys.node(NODE.VOhm),
      com: sys.node(NODE.COM),
      shMa: sys.resistorNodes("dmm:shMa"),
      shA: sys.resistorNodes("dmm:shA"),
      res: resIds.map((id) => sys.resistorNodes(id)),
    };
  }

  /** Fuerza una lectura inmediata del multímetro (al cambiar de modo o mover puntas). */
  refreshDmm(): void {
    if (this.transient) {
      // con señales variables, la próxima lectura sale de lo que integre desde ahora
      this.dmmWin = this.emptyWindow();
      this.dmmForce = true;
      return;
    }
    const { sol } = this.solveAt(this.dmm.ohmRangeForStep());
    this.dmm.update(0, (r) => (r === this.dmm.ohmRangeForStep() ? sol : this.solveAt(r).sol), true);
  }

  private readingsFrom(sol: Solution): ResistorReading[] {
    return this.circuit.resistors.map((r) => {
      const v = sol.vab(netOfHole(r.a), netOfHole(r.b));
      const i = sol.iR(r.id);
      return { id: r.id, v: Math.abs(v), i: Math.abs(i), p: sol.pR(r.id) };
    });
  }
  private diodeReadingsFrom(sol: Solution): DiodeReading[] {
    return (this.circuit.diodes ?? []).map((d) => {
      const h = this.diodeHoles(d);
      return { id: d.id, v: sol.vab(netOfHole(h.a), netOfHole(h.k)), i: sol.iD(d.id), p: sol.pD(d.id) };
    });
  }

  /** Valores teóricos: componentes nominales (y sanos), fuente ideal a Vset, sin instrumento. */
  theory(): { parts: ResistorReading[]; diodes: DiodeReading[]; itotal: number; ptotal: number } {
    const sol = solve(this.build(-1, "CV", { withDmm: false, ideal: true }), GROUND);
    const itotal = -sol.iV("psu:V");
    return { parts: this.readingsFrom(sol), diodes: this.diodeReadingsFrom(sol), itotal, ptotal: itotal * this.psu.vset };
  }

  /** Valores "verdaderos" del circuito real, sin el multímetro conectado. */
  truth(): { parts: ResistorReading[]; diodes: DiodeReading[]; itotal: number; vout: number; mode: PsuMode } {
    const { sol, mode } = this.solveAt(-1, { withDmm: false });
    const vout = sol.vab("psu+", "psu-");
    const itotal = mode === "CV" ? -sol.iV("psu:V") : mode === "CC" ? this.psu.iset : 0;
    return { parts: this.readingsFrom(sol), diodes: this.diodeReadingsFrom(sol), itotal, vout, mode };
  }

  /**
   * Cálculos de los circuitos con capacitores: teóricos (valores nominales, generador ideal) y con los
   * valores reales de los componentes y los 50 Ω del generador en serie.
   */
  analysis(): AnalysisRow[] {
    const kind = this.circuit.analysis;
    const R = this.parts.get("R1");
    const C = this.caps.get("C1");
    if (!kind || !R || !C) return [];
    const rg = this.gen.rout;
    const rows: AnalysisRow[] = [];
    if (kind === "rc") {
      const tN = R.spec.nominal * C.nominal;
      const tR = (R.ohms + rg) * C.farads;
      rows.push({ label: "τ = R·C", theory: fmt(tN, "s"), real: `${fmt(tR, "s")} (con los 50 Ω del generador)` });
      rows.push({ label: "63,2 % del salto", theory: fmt(0.632 * this.gen.vpp, "V"), real: "" });
      rows.push({ label: "Semiciclo / τ", theory: (0.5 / this.gen.freq / tN).toFixed(1).replace(".", ","), real: (0.5 / this.gen.freq / tR).toFixed(1).replace(".", ",") });
    } else if (kind === "lowpass") {
      const fcN = 1 / (2 * Math.PI * R.spec.nominal * C.nominal);
      const fcR = 1 / (2 * Math.PI * (R.ohms + rg) * C.farads);
      const f = this.gen.freq;
      const gain = (fc: number) => 1 / Math.sqrt(1 + (f / fc) ** 2);
      const ph = (fc: number) => (-Math.atan(f / fc) * 180) / Math.PI;
      rows.push({ label: "fc = 1/(2πRC)", theory: fmt(fcN, "Hz"), real: fmt(fcR, "Hz") });
      rows.push({ label: `Vsal/Vent a ${fmt(f, "Hz")}`, theory: gain(fcN).toFixed(3).replace(".", ","), real: gain(fcR).toFixed(3).replace(".", ",") });
      rows.push({ label: "Desfasaje", theory: `${ph(fcN).toFixed(1).replace(".", ",")}°`, real: `${ph(fcR).toFixed(1).replace(".", ",")}°` });
      rows.push({ label: "Ganancia", theory: `${(20 * Math.log10(gain(fcN))).toFixed(1).replace(".", ",")} dB`, real: `${(20 * Math.log10(gain(fcR))).toFixed(1).replace(".", ",")} dB` });
    } else {
      const vp = this.gen.vpp / 2 + this.gen.offset;
      const vd = 0.7; // caída típica del 1N4007 con los pulsos de corriente de carga
      const vpk = vp - vd;
      const filt = this.jumperPresent.get("J1") && C.state === "ok";
      const rip = (Rl: number, c: number) => vpk / Rl / (this.gen.freq * c);
      const ripN = rip(R.spec.nominal, C.nominal);
      const ripR = rip(R.ohms, C.farads);
      rows.push({ label: "Pico de salida ≈ Vp − Vd", theory: fmt(vpk, "V"), real: "" });
      if (filt) {
        rows.push({ label: "Ripple ΔV ≈ I/(f·C) (cota)", theory: fmt(ripN, "V"), real: fmt(ripR, "V") });
        rows.push({ label: "Promedio ≈ Vpico − ΔV/2", theory: fmt(vpk - ripN / 2, "V"), real: fmt(vpk - ripR / 2, "V") });
      } else rows.push({ label: "Promedio media onda ≈ Vpico/π", theory: fmt(vpk / Math.PI, "V"), real: "" });
    }
    return rows;
  }

  describeTarget(t: ProbeTarget): string {
    if (!t) return "libre";
    if (t.kind === "post") return t.post === "psu+" ? "borne + fuente" : t.post === "psu-" ? "borne − fuente" : "borne GND fuente";
    return t.hole.startsWith("R") ? `riel ${t.hole.split(":")[0].slice(2)} (${t.hole.startsWith("RT") ? "sup." : "inf."})` : `agujero ${t.hole}`;
  }
}
