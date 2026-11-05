import { CIRCUITS, netOfHole, type CircuitDef } from "./circuits";
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

export type BenchEvent =
  | { kind: "fuse"; which: "mA" | "A" }
  | { kind: "burn"; id: string }
  | { kind: "smoke"; id: string }
  | { kind: "cc"; on: boolean };

export class Bench {
  readonly psu: BenchSupply;
  readonly dmm: Multimeter;
  circuit: CircuitDef = CIRCUITS[0];
  readonly parts = new Map<string, ResistorPart>();
  readonly jumperPresent = new Map<string, boolean>();
  readonly probes: Record<ProbeColor, ProbeTarget> = { red: null, black: null };
  time = 0;
  sol: Solution | null = null;
  private listeners: ((e: BenchEvent) => void)[] = [];
  private rngParts: Rng;
  private lastMode: PsuMode = "OFF";

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
    this.jumperPresent.clear();
    for (const j of def.jumpers) this.jumperPresent.set(j.id, true);
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
    if (!this.psu.output) {
      return { sol: solve(this.build(ohmRange, "OFF", opts), GROUND), mode: "OFF" };
    }
    let sol = solve(this.build(ohmRange, "CV", opts), GROUND);
    const iout = -sol.iV("psu:V");
    if (iout > this.psu.iset) {
      sol = solve(this.build(ohmRange, "CC", opts), GROUND);
      return { sol, mode: "CC" };
    }
    return { sol, mode: "CV" };
  }

  /** Avanza la simulación dt segundos (térmica, fusibles, displays). */
  step(dt: number): void {
    this.time += dt;
    const { sol, mode } = this.solveAt(this.dmm.ohmRangeForStep());
    this.sol = sol;
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

  /** Valores teóricos: resistores nominales, fuente ideal a Vset, sin instrumento. */
  theory(): { parts: ResistorReading[]; itotal: number; ptotal: number } {
    const sol = solve(this.build(-1, "CV", { withDmm: false, ideal: true }), GROUND);
    const itotal = -sol.iV("psu:V");
    return { parts: this.readingsFrom(sol), itotal, ptotal: itotal * this.psu.vset };
  }

  /** Valores "verdaderos" del circuito real, sin el multímetro conectado. */
  truth(): { parts: ResistorReading[]; itotal: number; vout: number; mode: PsuMode } {
    const { sol, mode } = this.solveAt(-1, { withDmm: false });
    const vout = sol.vab("psu+", "psu-");
    const itotal = mode === "CV" ? -sol.iV("psu:V") : mode === "CC" ? this.psu.iset : 0;
    return { parts: this.readingsFrom(sol), itotal, vout, mode };
  }

  describeTarget(t: ProbeTarget): string {
    if (!t) return "libre";
    if (t.kind === "post") return t.post === "psu+" ? "borne + fuente" : t.post === "psu-" ? "borne − fuente" : "borne GND fuente";
    return t.hole.startsWith("R") ? `riel ${t.hole.split(":")[0].slice(2)} (${t.hole.startsWith("RT") ? "sup." : "inf."})` : `agujero ${t.hole}`;
  }
}
