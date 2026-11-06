import { describe, expect, it } from "vitest";
import { DIODE_MODELS, diodeParams } from "./diode";
import { FunctionGenerator } from "./fgen";
import { Netlist, solve } from "./mna";
import { BE_STEPS } from "./bench";
import { Transient } from "./transient";

const D1N4007 = diodeParams(DIODE_MODELS["1N4007"]);

/** Fuente + R + C: devuelve v(C) en los instantes pedidos (el capacitor arranca descargado). */
function rcStep(h: number, method: "trap" | "be", tEnd: number, V = 5, R = 1000, C = 1e-6): number {
  const sys = new Transient(new Netlist().v("V", "in", "0", V).r("R", "in", "c", R).c("C", "c", "0", C), "0", h);
  const n = Math.round(tEnd / h);
  for (let k = 0; k < n; k++) {
    // la fuente "se enciende" en t = 0: es una discontinuidad, como hace el banco
    sys.step(k < BE_STEPS ? "be" : method);
    sys.commit();
  }
  return sys.v("c");
}

describe("Transitorio: capacitor con modelo de compañía", () => {
  it("carga RC: v(τ) = 63,2 % con trapezoidal (error < 0,01 %)", () => {
    const tau = 1e-3;
    const v = rcStep(10e-6, "trap", tau);
    expect(Math.abs(v - 5 * (1 - Math.exp(-1))) / 5).toBeLessThan(1e-4);
  });

  it("el trapezoidal es de 2.º orden y Euler implícito de 1.º: al dividir h por 2, el error baja ×4 y ×2", () => {
    const exact = 5 * (1 - Math.exp(-1));
    const err = (h: number, m: "trap" | "be") => Math.abs(rcStep(h, m, 1e-3) - exact);
    const rTrap = err(50e-6, "trap") / err(25e-6, "trap");
    const rBe = err(50e-6, "be") / err(25e-6, "be");
    expect(rTrap).toBeGreaterThan(3.6);
    expect(rTrap).toBeLessThan(4.4);
    expect(rBe).toBeGreaterThan(1.8);
    expect(rBe).toBeLessThan(2.2);
  });

  it("un capacitor cargado sin camino de descarga conserva la tensión", () => {
    const sys = new Transient(new Netlist().r("R", "a", "0", 1e3).c("C", "b", "0", 1e-6), "0", 1e-4);
    sys.loadState(new Map([["C", { v: 3, i: 0 }]]));
    for (let k = 0; k < 10000; k++) {
      sys.step();
      sys.commit();
    }
    expect(sys.vC("C")).toBeGreaterThan(2.9999); // solo lo descarga gmin (1 pS)
  });

  it("descarga sobre R: v(t) = V0·e^(−t/RC)", () => {
    const sys = new Transient(new Netlist().r("R", "c", "0", 2000).c("C", "c", "0", 0.5e-6), "0", 5e-6);
    sys.loadState(new Map([["C", { v: 10, i: -10 / 2000 }]]));
    for (let k = 0; k < 400; k++) {
      sys.step();
      sys.commit();
    }
    expect(sys.vC("C")).toBeCloseTo(10 * Math.exp(-2), 3);
  });

  it("sin ringing: tras un salto, unos pasos de Euler implícito evitan que la corriente oscile", () => {
    // capacitor grande con poca resistencia: τ = 0,5 µs ≪ h = 100 µs (sistema rígido)
    const run = (firstBE: boolean) => {
      const sys = new Transient(new Netlist().v("V", "in", "0", 5).r("R", "in", "c", 0.05).c("C", "c", "0", 10e-6), "0", 100e-6);
      const i: number[] = [];
      for (let k = 0; k < 8; k++) {
        sys.step(k < BE_STEPS && firstBE ? "be" : "trap");
        sys.commit();
        i.push(sys.iC("C"));
      }
      return i;
    };
    const trap = run(false);
    const be = run(true);
    // trapezoidal puro: la corriente cambia de signo paso a paso (ringing numérico)
    expect(trap[1] * trap[2]).toBeLessThan(0);
    expect(Math.abs(trap[7])).toBeGreaterThan(0.1);
    // con Euler después del salto: la corriente se apaga y el trapezoidal sigue sin oscilar
    for (const x of be.slice(BE_STEPS)) expect(Math.abs(x)).toBeLessThan(1e-6);
  });

  it("la constante de tiempo de cada capacitor sale de la respuesta precalculada", () => {
    const sys = new Transient(new Netlist().v("V", "in", "0", 1).r("R1", "in", "c", 1000).r("R2", "c", "0", 1000).c("C", "c", "0", 1e-6), "0", 1e-5);
    expect(sys.capTau("C")).toBeCloseTo(500e-6, 9); // R1‖R2 · C
  });
});

describe("Transitorio con diodos (Newton-Raphson reducido a las junturas)", () => {
  it("sin capacitores, cada paso coincide con el punto de trabajo de continua", () => {
    const sys = new Transient(new Netlist().v("V", "in", "0", 0).r("R", "in", "a", 1000).d("D", "a", "0", D1N4007), "0", 1e-4);
    for (const v of [-5, 0.3, 0.6, 2, 5, 12, -1]) {
      sys.setSource("V", v);
      sys.step();
      sys.commit();
      const dc = solve(new Netlist().v("V", "in", "0", v).r("R", "in", "a", 1000).d("D", "a", "0", D1N4007), "0");
      expect(Math.abs(sys.iD("D") - dc.iD("D"))).toBeLessThan(1e-9 + 1e-6 * Math.abs(dc.iD("D")));
      expect(sys.v("a")).toBeCloseTo(dc.v("a"), 6);
    }
  });

  it("puente de 4 diodos (k = 4): coincide con el MNA de continua", () => {
    const bridge = (v: number) =>
      new Netlist()
        .v("V", "ac1", "ac2", v)
        .d("D1", "ac1", "p", D1N4007)
        .d("D2", "ac2", "p", D1N4007)
        .d("D3", "n", "ac1", D1N4007)
        .d("D4", "n", "ac2", D1N4007)
        .r("RL", "p", "n", 470)
        .r("Rref", "n", "0", 1e6);
    const sys = new Transient(bridge(0), "0", 1e-4);
    for (const v of [10, -10, 3, -0.5, 7]) {
      sys.setSource("V", v);
      sys.step();
      sys.commit();
      const dc = solve(bridge(v), "0");
      expect(dc.converged).toBe(true);
      expect(sys.iR("RL")).toBeCloseTo(dc.iR("RL"), 7);
      expect(sys.iR("RL")).toBeGreaterThanOrEqual(-1e-9); // siempre en el mismo sentido
    }
  });

  it("con un capacitor y una fuente continua, el transitorio llega al punto de trabajo de continua", () => {
    const net = new Netlist().v("V", "in", "0", 9).r("R", "in", "a", 100).d("D", "a", "b", D1N4007).r("RL", "b", "0", 1000).c("C", "b", "0", 47e-6);
    const sys = new Transient(net, "0", 1e-4);
    for (let k = 0; k < 5000; k++) {
      sys.step();
      sys.commit();
    }
    const dc = solve(net, "0");
    expect(sys.v("b")).toBeCloseTo(dc.v("b"), 5);
    expect(sys.iC("C")).toBeLessThan(1e-6);
  });
});

describe("Transitorio: respuesta en frecuencia de un RC", () => {
  /** Amplitud y fase de la salida de un pasabajos RC en régimen, con la senoidal del generador. */
  function lowpass(f: number, R = 1000, C = 100e-9): { gain: number; phase: number } {
    const steps = 200;
    const h = 1 / f / steps;
    const sys = new Transient(new Netlist().v("V", "in", "0", 0).r("R", "in", "c", R).c("C", "c", "0", C), "0", h);
    let s = 0;
    let c = 0;
    const periods = 30;
    for (let k = 1; k <= steps * periods; k++) {
      sys.setSource("V", FunctionGenerator.shape("sine", k / steps));
      sys.step();
      sys.commit();
      if (k > steps * (periods - 1)) {
        // proyección sobre seno y coseno (DFT de un período) para sacar amplitud y fase
        const ph = (2 * Math.PI * k) / steps;
        s += sys.v("c") * Math.sin(ph);
        c += sys.v("c") * Math.cos(ph);
      }
    }
    return { gain: (2 / steps) * Math.hypot(s, c), phase: (Math.atan2(c, s) * 180) / Math.PI };
  }

  it("en la frecuencia de corte la salida cae a 1/√2 y atrasa 45°", () => {
    const fc = 1 / (2 * Math.PI * 1000 * 100e-9);
    const r = lowpass(fc);
    expect(r.gain).toBeCloseTo(Math.SQRT1_2, 3);
    expect(r.phase).toBeCloseTo(-45, 1);
  });

  it("a 10·fc atenúa 20 dB por década", () => {
    const fc = 1 / (2 * Math.PI * 1000 * 100e-9);
    const r = lowpass(10 * fc);
    expect(r.gain).toBeCloseTo(1 / Math.sqrt(101), 3);
    expect(r.phase).toBeCloseTo((-Math.atan(10) * 180) / Math.PI, 1);
  });
});
