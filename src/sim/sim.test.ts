import { describe, expect, it } from "vitest";
import { Bench } from "./bench";
import { CIRCUITS, isValidHole } from "./circuits";
import { Netlist, solve } from "./mna";
import { colorBands, eSeriesValues, formatSI, ResistorPart } from "./resistor";
import { Rng } from "./rng";

const close = (a: number, b: number, rel = 1e-7) => expect(Math.abs(a - b)).toBeLessThanOrEqual(Math.abs(b) * rel + 1e-12);

describe("MNA", () => {
  it("resuelve un divisor de tensión exacto", () => {
    const net = new Netlist().v("V1", "in", "0", 10).r("R1", "in", "mid", 1000).r("R2", "mid", "0", 3000);
    const s = solve(net, "0");
    close(s.v("mid"), 7.5);
    close(s.iR("R1"), 2.5e-3);
    close(s.iV("V1"), -2.5e-3); // la fuente entrega corriente: iV negativa
    close(s.pR("R2"), 7.5 * 2.5e-3);
  });

  it("resuelve paralelo con fuente de corriente", () => {
    const net = new Netlist().i("I1", "0", "a", 0.01).r("R1", "a", "0", 1000).r("R2", "a", "0", 1000);
    const s = solve(net, "0");
    close(s.v("a"), 5);
  });

  it("tolera nodos flotantes gracias a gmin", () => {
    const net = new Netlist().v("V1", "a", "0", 5).r("R1", "a", "0", 100).r("Rf", "x", "y", 10);
    const s = solve(net, "0");
    expect(Math.abs(s.v("x"))).toBeLessThan(1e-6);
  });
});

describe("Resistores", () => {
  it("genera la serie E12 entre 10 Ω y 1 MΩ", () => {
    const v = eSeriesValues(10, 1e6);
    expect(v[0]).toBe(10);
    expect(v).toContain(4700);
    expect(v).toContain(1e6);
    expect(v.length).toBe(12 * 5 + 1);
  });

  it("código de colores 4 y 5 bandas", () => {
    expect(colorBands(4700, 0.05).map((b) => b.name)).toEqual(["amarillo", "violeta", "rojo", "dorado"]);
    expect(colorBands(4700, 0.01).map((b) => b.name)).toEqual(["amarillo", "violeta", "negro", "marrón", "marrón"]);
    expect(colorBands(10, 0.05).map((b) => b.name)).toEqual(["marrón", "negro", "negro", "dorado"]);
    expect(colorBands(4.7, 0.05).map((b) => b.name)).toEqual(["amarillo", "violeta", "dorado", "dorado"]);
    expect(colorBands(1e6, 0.05).map((b) => b.name)).toEqual(["marrón", "negro", "verde", "dorado"]);
  });

  it("valor real dentro de tolerancia", () => {
    const rng = new Rng(1);
    for (let k = 0; k < 500; k++) {
      const p = new ResistorPart("R", { nominal: 1000, tolerance: 0.05, power: 0.25 }, rng);
      expect(p.r25).toBeGreaterThanOrEqual(950);
      expect(p.r25).toBeLessThanOrEqual(1050);
    }
  });

  it("se calienta a ~150 °C a potencia nominal y se quema al doble+", () => {
    const p = new ResistorPart("R", { nominal: 100, tolerance: 0.05, power: 0.25 }, new Rng(2));
    for (let t = 0; t < 120; t += 0.05) p.step(0.25, 0.05);
    expect(p.tempC).toBeGreaterThan(145);
    expect(p.tempC).toBeLessThan(151);
    expect(p.state).toBe("ok");
    for (let t = 0; t < 60; t += 0.05) p.step(0.75, 0.05);
    expect(p.state).toBe("quemado");
    expect(p.ohms).toBe(1e12);
  });

  it("formato SI con coma decimal", () => {
    expect(formatSI(4700, "Ω")).toBe("4,7 kΩ");
    expect(formatSI(0.00512, "A")).toBe("5,12 mA");
    expect(formatSI(2.2e6, "Ω")).toBe("2,2 MΩ");
    expect(formatSI(-5e-12, "A")).toBe("-5 pA");
    expect(formatSI(7e-18, "W")).toBe("0 W");
  });
});

describe("Circuitos", () => {
  it("todos los agujeros de los presets existen en el protoboard", () => {
    for (const c of CIRCUITS) {
      for (const r of c.resistors) expect([r.a, r.b].every(isValidHole), `${c.id}/${r.id}`).toBe(true);
      for (const j of c.jumpers) expect([j.a, j.b].every(isValidHole), `${c.id}/${j.id}`).toBe(true);
    }
  });

  it("la teoría del divisor serie coincide con el cálculo a mano", () => {
    const b = new Bench();
    b.loadCircuit("serie");
    const t = b.theory();
    const I = 10 / (1000 + 2200 + 4700);
    close(t.itotal, I, 1e-6);
    close(t.parts.find((p) => p.id === "R2")!.v, I * 2200, 1e-6);
  });

  it("la teoría del paralelo suma las corrientes de rama", () => {
    const b = new Bench();
    b.loadCircuit("paralelo");
    const t = b.theory();
    const sum = t.parts.reduce((s, p) => s + p.i, 0);
    close(t.itotal, sum, 1e-6);
    close(t.itotal, 5 / 1000 + 5 / 2200 + 5 / 4700, 1e-6);
  });
});

/** Helpers de banco */
function measure(b: Bench, settle = 1): void {
  for (let t = 0; t < settle; t += 0.05) b.step(0.05);
  b.refreshDmm();
}

describe("Fuente CV/CC", () => {
  it("entra en limitación de corriente", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.setResistor("R1", { nominal: 10, tolerance: 0.05, power: 2 });
    b.psu.vset = 5;
    b.psu.iset = 0.1;
    b.psu.output = true;
    b.step(0.01);
    expect(b.psu.mode).toBe("CC");
    close(b.psu.iout, 0.1, 1e-4);
    expect(b.psu.vout).toBeLessThan(1.2);
  });
});

describe("Multímetro", () => {
  it("mide tensión dentro de la especificación ±(0,5 % + 2 díg.)", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.psu.output = true;
    b.dmm.setDial("VDC");
    b.probes.red = { kind: "hole", hole: "14a" };
    b.probes.black = { kind: "hole", hole: "14j" };
    measure(b);
    const truth = b.truth().parts[0].v;
    const d = b.dmm.display;
    expect(d.text).toMatch(/^\d\.\d{3}$/);
    expect(Math.abs(d.value! - truth)).toBeLessThanOrEqual(truth * 0.005 + 2 * 0.001 + 1e-9);
  });

  it("efecto de carga: 10 MΩ en paralelo con 4,7 MΩ", () => {
    const b = new Bench();
    b.loadCircuit("carga");
    b.psu.output = true;
    b.dmm.setDial("VDC");
    b.probes.red = { kind: "hole", hole: "12a" };
    b.probes.black = { kind: "hole", hole: "12j" };
    measure(b);
    const r1 = b.parts.get("R1")!.ohms;
    const r2 = b.parts.get("R2")!.ohms;
    const r2p = (r2 * 10e6) / (r2 + 10e6);
    const expected = (10 * r2p) / (r1 + r2p);
    expect(Math.abs(b.dmm.trueValue - expected)).toBeLessThan(0.01);
    expect(b.dmm.display.value!).toBeLessThan(4.3);
  });

  it("óhmetro ratiométrico: lee el valor real + resistencia de las puntas", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.dmm.setDial("OHM");
    b.probes.red = { kind: "hole", hole: "14b" };
    b.probes.black = { kind: "hole", hole: "14i" };
    measure(b);
    const real = b.parts.get("R1")!.ohms;
    expect(b.dmm.display.unit).toBe("kΩ");
    close(b.dmm.trueValue, real + 0.1, 1e-6);
    expect(Math.abs(b.dmm.display.value! - real)).toBeLessThan(real * 0.006 + 3);
  });

  it("puntas abiertas en Ω muestran OL", () => {
    const b = new Bench();
    b.dmm.setDial("OHM");
    measure(b);
    expect(b.dmm.display.text).toBe("OL");
    expect(b.dmm.display.unit).toBe("MΩ");
  });

  it("mide corriente en serie al abrir un puente (con caída en el shunt)", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.psu.output = true;
    b.jumperPresent.set("J1", false);
    b.dmm.setDial("mA");
    b.dmm.red = "mA";
    b.probes.red = { kind: "hole", hole: "RT+:14" };
    b.probes.black = { kind: "hole", hole: "14a" };
    measure(b);
    const R = b.parts.get("R1")!.ohms;
    const expected = 5 / (R + 1.8 + 0.1 + 0.06 + 0.015 + 0.002);
    close(b.dmm.trueValue, expected, 1e-3);
    expect(b.dmm.display.unit).toBe("mA");
    expect(Math.abs(b.dmm.display.value! - expected)).toBeLessThan(expected * 0.009 + 3e-5);
  });

  it("medir tensión con la punta en la borna mA quema el fusible si la fuente lo permite", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.psu.iset = 1.0;
    b.psu.output = true;
    b.dmm.setDial("mA");
    b.dmm.red = "mA";
    b.probes.red = { kind: "post", post: "psu+" };
    b.probes.black = { kind: "post", post: "psu-" };
    const events: string[] = [];
    b.on((e) => events.push(e.kind));
    measure(b, 1);
    expect(b.dmm.fuseMa.blown).toBe(true);
    expect(events).toContain("fuse");
  });

  it("con la fuente limitada a 100 mA el fusible de 440 mA sobrevive", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.psu.iset = 0.1;
    b.psu.output = true;
    b.dmm.setDial("mA");
    b.dmm.red = "mA";
    b.probes.red = { kind: "post", post: "psu+" };
    b.probes.black = { kind: "post", post: "psu-" };
    measure(b, 3);
    expect(b.dmm.fuseMa.blown).toBe(false);
    expect(b.psu.mode).toBe("CC");
  });

  it("alerta LEAd si la punta está en la borna A y la llave en V", () => {
    const b = new Bench();
    b.dmm.setDial("VDC");
    b.dmm.red = "A";
    measure(b);
    expect(b.dmm.display.text).toBe("LEAd");
  });

  it("continuidad pita con las puntas en corto", () => {
    const b = new Bench();
    b.dmm.setDial("CONT");
    b.probes.red = { kind: "hole", hole: "3a" };
    b.probes.black = { kind: "hole", hole: "3e" };
    measure(b);
    expect(b.dmm.display.beep).toBe(true);
    expect(Math.abs(b.dmm.display.value!)).toBeLessThan(0.5);
  });

  it("la calibración de cada rango no depende del orden de uso", () => {
    const read = (warmup: boolean) => {
      const b = new Bench();
      b.loadCircuit("ohm");
      b.psu.output = true;
      if (warmup) {
        b.dmm.setDial("mA");
        b.dmm.red = "mA";
        measure(b, 0.2);
        b.dmm.red = "VOhm";
      }
      b.dmm.setDial("VDC");
      b.probes.red = { kind: "hole", hole: "14a" };
      b.probes.black = { kind: "hole", hole: "14j" };
      const vals: number[] = [];
      for (let k = 0; k < 40; k++) {
        b.step(0.34);
        vals.push(b.dmm.display.value!);
      }
      return vals.reduce((a, x) => a + x, 0) / vals.length;
    };
    expect(Math.abs(read(false) - read(true))).toBeLessThan(0.0015);
  });
});
