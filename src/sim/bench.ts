import { CIRCUITS, netOfHole, type CircuitDef, type DiodeDef } from "./circuits";
import { DiodePart, diodeParams, type DiodeType } from "./diode";
import { Multimeter, NODE } from "./dmm";
import { Netlist, solve, type Solution } from "./mna";
import { BenchSupply, type PsuMode } from "./psu";
import { ResistorPart, type ResistorSpec } from "./resistor";
import { Rng, hashSeed } from "./rng";

export type PsuPost = "psu+" | "psu-" | "psuGnd";
export type ProbeTarget = { kind: "hole"; hole: string } | { kind: "post"; post: PsuPost } | null;
export type ProbeColor = "red" | "black";

export const GROUND = "psu-";
const LEAD_PSU = 0.03; // Ω, cable banana–cocodrilo + contacto
const LEAD_PROBE = 0.05; // Ω por punta de prueba
const JUMPER = 0.015; // Ω, puente de protoboard

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
  | { kind: "cc"; on: boolean };

export class Bench {
  readonly psu: BenchSupply;
  readonly dmm: Multimeter;
  circuit: CircuitDef = CIRCUITS[0];
  readonly parts = new Map<string, ResistorPart>();
  readonly diodes = new Map<string, DiodePart>();
  readonly jumperPresent = new Map<string, boolean>();
  readonly probes: Record<ProbeColor, ProbeTarget> = { red: null, black: null };
  time = 0;
  sol: Solution | null = null;
  private listeners: ((e: BenchEvent) => void)[] = [];
  private rngParts: Rng;
  private lastMode: PsuMode = "OFF";
  /** Tensiones de juntura de la última solución: arrancan Newton-Raphson cerca del resultado. */
  private guess = new Map<string, number>();

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
    this.guess.clear();
    this.jumperPresent.clear();
    for (const j of def.jumpers) this.jumperPresent.set(j.id, j.present ?? true);
    this.psu.output = false;
    this.psu.vset = def.vset;
    this.psu.iset = def.iset;
    this.probes.red = null;
    this.probes.black = null;
    this.sol = null;
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

  /** Agujeros donde quedaron el ánodo y el cátodo (según la orientación actual). */
  diodeHoles(def: DiodeDef): { a: string; k: string } {
    const part = this.diodes.get(def.id);
    return part?.reversed ? { a: def.k, k: def.a } : { a: def.a, k: def.k };
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

  /** Netlist completo: protoboard + fuente + multímetro con sus puntas. */
  build(ohmRange: number, psuMode: PsuMode, opts: { withDmm?: boolean; ideal?: boolean } = {}): Netlist {
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
    if (ideal) {
      if (psuMode !== "OFF") net.v("psu:V", "psu+", "psu-", this.psu.vset);
    } else {
      this.psu.stamp(net, psuMode, "psu+", "psu-");
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

  /** Avanza la simulación dt segundos (térmica, fusibles, displays). */
  step(dt: number): void {
    this.time += dt;
    const { sol, mode } = this.solveAt(this.dmm.ohmRangeForStep());
    this.sol = sol;
    for (const [id, v] of sol.junctionVoltages()) this.guess.set(id, v);
    const vout = sol.vab("psu+", "psu-");
    const iout = mode === "CV" ? -sol.iV("psu:V") : mode === "CC" ? this.psu.iset - vout / 1e7 : 0;
    this.psu.update(vout, iout, mode, dt);
    if ((mode === "CC") !== (this.lastMode === "CC")) this.emit({ kind: "cc", on: mode === "CC" });
    this.lastMode = mode;

    for (const r of this.circuit.resistors) {
      const part = this.parts.get(r.id)!;
      const before = part.state;
      part.step(sol.pR(r.id), dt);
      if (part.state !== before) {
        if (part.state === "quemado") this.emit({ kind: "burn", id: r.id });
        else if (part.state === "humo") this.emit({ kind: "smoke", id: r.id });
      }
    }
    for (const part of this.diodes.values()) {
      const before = part.state;
      part.step(sol.iD(part.id), sol.pD(part.id), dt);
      if (part.state === "quemado" && before !== "quemado") this.emit({ kind: "diodeBurn", id: part.id, peak: part.peak, led: part.model.led });
    }
    if (this.dmm.fuseMa.step(sol.iR("dmm:shMa"), dt)) this.emit({ kind: "fuse", which: "mA" });
    if (this.dmm.fuseA.step(sol.iR("dmm:shA"), dt)) this.emit({ kind: "fuse", which: "A" });

    this.dmm.update(dt, (r) => (r === this.dmm.ohmRangeForStep() ? sol : this.solveAt(r).sol));
  }

  /** Fuerza una lectura inmediata del multímetro (al cambiar de modo o mover puntas). */
  refreshDmm(): void {
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

  describeTarget(t: ProbeTarget): string {
    if (!t) return "libre";
    if (t.kind === "post") return t.post === "psu+" ? "borne + fuente" : t.post === "psu-" ? "borne − fuente" : "borne GND fuente";
    return t.hole.startsWith("R") ? `riel ${t.hole.split(":")[0].slice(2)} (${t.hole.startsWith("RT") ? "sup." : "inf."})` : `agujero ${t.hole}`;
  }
}
