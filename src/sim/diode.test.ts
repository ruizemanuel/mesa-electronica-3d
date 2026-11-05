import { describe, expect, it } from "vitest";
import { Bench } from "./bench";
import { CIRCUITS, isValidHole, netOfHole } from "./circuits";
import { DIODE_MODELS, DIODE_TYPES, DiodePart, diodeParams, ifAt, vfAt } from "./diode";
import { DIAL_POSITIONS, positionOf } from "./dmm";
import { Netlist, VT_25, solve, type DiodeParams } from "./mna";
import { Rng } from "./rng";

function settle(b: Bench, seconds = 1): void {
  for (let t = 0; t < seconds; t += 0.02) b.step(0.02);
  b.refreshDmm();
}

const D1N4007 = diodeParams(DIODE_MODELS["1N4007"]);
const RED = diodeParams(DIODE_MODELS["led-rojo"]);

/** Solución "a mano" de fuente + R + diodo: bisección sobre la corriente (independiente del MNA). */
function seriesByHand(v: number, r: number, p: DiodeParams): number {
  let lo = 0;
  let hi = v / r;
  for (let k = 0; k < 200; k++) {
    const i = (lo + hi) / 2;
    if (i * r + vfAt(p, i) > v) hi = i;
    else lo = i;
  }
  return (lo + hi) / 2;
}

describe("MNA con diodos (Newton-Raphson)", () => {
  it("fuente + resistor + 1N4007 coincide con la solución a mano", () => {
    const s = solve(new Netlist().v("V", "in", "0", 5).r("R", "in", "a", 1000).d("D", "a", "0", D1N4007), "0");
    const i = seriesByHand(5, 1000, D1N4007);
    expect(s.converged).toBe(true);
    expect(Math.abs(s.iD("D") - i)).toBeLessThan(i * 1e-6);
    expect(Math.abs(s.iR("R") - i)).toBeLessThan(i * 1e-6); // KCL: la misma corriente
    expect(s.v("a")).toBeGreaterThan(0.6);
    expect(s.v("a")).toBeLessThan(0.65);
  });

  it("en inversa casi no conduce y toda la tensión queda sobre el diodo", () => {
    const s = solve(new Netlist().v("V", "in", "0", 5).r("R", "in", "k", 1000).d("D", "0", "k", D1N4007), "0");
    expect(s.converged).toBe(true);
    expect(Math.abs(s.iD("D"))).toBeLessThan(1e-8);
    expect(s.v("k")).toBeGreaterThan(4.9999);
  });

  it("converge sin ayuda en casos duros: LED directo a 30 V con 50 mΩ de cables", () => {
    const s = solve(new Netlist().v("V", "in", "0", 30).r("cable", "in", "a", 0.05).d("D", "a", "0", RED), "0");
    expect(s.converged).toBe(true);
    expect(s.iterations).toBeLessThan(150);
    // con Rs = 2,5 Ω la corriente queda limitada solo por la resistencia interna
    expect(s.iD("D")).toBeGreaterThan(9);
    expect(Math.abs(s.iD("D") * 0.05 + vfAt(RED, s.iD("D")) - 30)).toBeLessThan(1e-4);
  });

  it("converge con una fuente de corriente empujando un diodo (fuente en CC)", () => {
    const s = solve(new Netlist().i("I", "0", "a", 3).r("Rsh", "a", "0", 1e7).d("D", "a", "0", D1N4007), "0");
    expect(s.converged).toBe(true);
    expect(Math.abs(s.iD("D") - 3)).toBeLessThan(1e-6);
    expect(s.v("a")).toBeCloseTo(vfAt(D1N4007, 3), 5);
  });

  it("dos LED en antiparalelo: conduce solo el que está en directa", () => {
    const s = solve(
      new Netlist().v("V", "in", "0", 5).r("R", "in", "a", 330).d("D1", "a", "0", RED).d("D2", "0", "a", RED),
      "0",
    );
    expect(s.converged).toBe(true);
    expect(s.iD("D1")).toBeGreaterThan(8e-3);
    expect(Math.abs(s.iD("D2"))).toBeLessThan(1e-11); // solo la de gmin (1 pS)
  });

  it("arrancar desde la solución anterior (warm start) ahorra iteraciones", () => {
    const net = new Netlist().v("V", "in", "0", 12).r("R", "in", "a", 470).d("D", "a", "0", RED);
    const cold = solve(net, "0");
    const warm = solve(net, "0", undefined, { guess: cold.junctionVoltages() });
    expect(warm.iterations).toBeLessThan(cold.iterations);
    expect(warm.iterations).toBeLessThanOrEqual(2);
    expect(Math.abs(warm.iD("D") - cold.iD("D"))).toBeLessThan(1e-9);
  });

  it("un circuito sin diodos sigue resolviéndose en una sola pasada", () => {
    const s = solve(new Netlist().v("V", "in", "0", 10).r("R1", "in", "m", 1000).r("R2", "m", "0", 1000), "0");
    expect(s.iterations).toBe(1);
    expect(s.v("m")).toBeCloseTo(5, 8);
  });

  it("potencia del diodo = V·I en bornes (juntura + Rs)", () => {
    const s = solve(new Netlist().v("V", "in", "0", 5).r("R", "in", "a", 100).d("D", "a", "0", RED), "0");
    expect(s.pD("D")).toBeCloseTo(s.v("a") * s.iD("D"), 12);
  });
});

describe("Modelos de diodos y LED", () => {
  it("1N4007: 0,5–0,6 V a 1 mA y menos de 1,1 V a 1 A (hoja de datos)", () => {
    expect(vfAt(D1N4007, 1e-3)).toBeGreaterThan(0.5);
    expect(vfAt(D1N4007, 1e-3)).toBeLessThan(0.6);
    expect(vfAt(D1N4007, 1)).toBeGreaterThan(0.85);
    expect(vfAt(D1N4007, 1)).toBeLessThan(1.1);
  });

  it("la Vf de cada LED a 20 mA depende del color", () => {
    const vf = (t: keyof typeof DIODE_MODELS) => vfAt(diodeParams(DIODE_MODELS[t]), 0.02);
    expect(vf("led-rojo")).toBeGreaterThan(1.75);
    expect(vf("led-rojo")).toBeLessThan(1.95);
    expect(vf("led-verde")).toBeGreaterThan(2.0);
    expect(vf("led-verde")).toBeLessThan(2.2);
    for (const t of ["led-azul", "led-blanco"] as const) {
      expect(vf(t)).toBeGreaterThan(2.9);
      expect(vf(t)).toBeLessThan(3.2);
    }
  });

  it("ifAt es la inversa de vfAt", () => {
    for (const t of DIODE_TYPES) {
      const p = diodeParams(DIODE_MODELS[t]);
      for (const i of [1e-6, 1e-3, 0.02, 0.5]) expect(Math.abs(ifAt(p, vfAt(p, i)) - i)).toBeLessThan(i * 1e-6);
    }
  });

  it("cada muestra tiene su propia Vf dentro de la dispersión del lote", () => {
    const rng = new Rng(7);
    const vfs = Array.from({ length: 300 }, () => vfAt(new DiodePart("D", "led-rojo", rng).params(), 0.02));
    const min = Math.min(...vfs);
    const max = Math.max(...vfs);
    expect(max - min).toBeGreaterThan(0.03);
    expect(min).toBeGreaterThan(1.82 - 2 * 0.025 - 0.01);
    expect(max).toBeLessThan(1.82 + 2 * 0.025 + 0.01);
  });

  it("al calentarse baja la Vf (≈ −2 mV/°C a corriente constante)", () => {
    const d = new DiodePart("D", "1N4007", new Rng(3));
    const cold = vfAt(d.params(), 0.01);
    d.tempC = 75;
    const hot = vfAt(d.params(), 0.01);
    expect((hot - cold) / 50).toBeCloseTo(-2e-3, 5);
  });

  it("el brillo crece con la corriente y es nulo en inversa", () => {
    const d = new DiodePart("L", "led-verde", new Rng(4));
    d.step(0.005, 0.01, 0.02);
    const b5 = d.brightness;
    d.step(0.02, 0.042, 0.02);
    expect(d.brightness).toBeGreaterThan(3 * b5);
    expect(d.brightness).toBeCloseTo(1, 1);
    d.step(-1e-9, 0, 0.02);
    expect(d.brightness).toBe(0);
  });

  it("un LED a 20 mA queda tibio; a 0,5 A se quema en menos de un segundo", () => {
    const ok = new DiodePart("L", "led-rojo", new Rng(5));
    for (let t = 0; t < 30; t += 0.02) ok.step(0.02, 0.037, 0.02);
    expect(ok.state).toBe("ok");
    expect(ok.tempC).toBeLessThan(45);

    const bad = new DiodePart("L", "led-rojo", new Rng(5));
    let t = 0;
    while (bad.state === "ok" && t < 5) {
      bad.step(0.5, 0.5 * vfAt(bad.params(), 0.5), 0.02);
      t += 0.02;
    }
    expect(bad.state).toBe("quemado");
    expect(t).toBeLessThan(1);
    expect(bad.peak).toBe(0.5);
  });

  it("el 1N4007 aguanta 1 A sin pasar su temperatura máxima", () => {
    const d = new DiodePart("D", "1N4007", new Rng(6));
    for (let t = 0; t < 120; t += 0.05) d.step(1, vfAt(d.params(), 1), 0.05);
    expect(d.state).toBe("ok");
    expect(d.tempC).toBeLessThan(DIODE_MODELS["1N4007"].tjMax);
    expect(d.tempC).toBeGreaterThan(60);
  });

  it("VT a 25 °C ≈ 25,7 mV", () => {
    expect(VT_25).toBeCloseTo(0.025693, 5);
  });
});

describe("Circuitos con diodos", () => {
  it("las patas de los diodos van en agujeros válidos y los LED en columnas vecinas de la misma tira", () => {
    for (const c of CIRCUITS) {
      for (const d of c.diodes ?? []) {
        expect([d.a, d.k].every(isValidHole), `${c.id}/${d.id}`).toBe(true);
        expect(netOfHole(d.a)).not.toBe(netOfHole(d.k));
        if (DIODE_MODELS[d.type].led) {
          expect(d.a.slice(-1)).toBe(d.k.slice(-1)); // misma fila
          expect(Math.abs(parseInt(d.a) - parseInt(d.k))).toBe(1); // 2,54 mm entre patas
        }
      }
    }
  });

  it("LED con 330 Ω a 5 V: ≈ 9 mA, brilla y la Vf es la del rojo", () => {
    const b = new Bench();
    b.loadCircuit("led");
    b.psu.output = true;
    settle(b);
    const led = b.diodes.get("LED1")!;
    const t = b.truth().diodes[0];
    expect(t.i).toBeGreaterThan(8.5e-3);
    expect(t.i).toBeLessThan(10.5e-3);
    expect(t.v).toBeGreaterThan(1.7);
    expect(t.v).toBeLessThan(1.9);
    expect(Math.abs(t.i - (5 - t.v) / b.parts.get("R1")!.ohms)).toBeLessThan(1e-4);
    expect(led.brightness).toBeGreaterThan(0.35);
    expect(led.state).toBe("ok");
    expect(b.psu.mode).toBe("CV");
  });

  it("con la misma resistencia, el azul toma menos corriente que el rojo", () => {
    const b = new Bench();
    b.loadCircuit("led");
    b.psu.output = true;
    settle(b, 0.2);
    const red = b.truth().diodes[0].i;
    b.setDiode("LED1", "led-azul");
    settle(b, 0.2);
    const blue = b.truth().diodes[0].i;
    expect(blue).toBeLessThan(red * 0.75);
    expect(b.truth().diodes[0].v).toBeGreaterThan(2.8);
  });

  it("sin resistencia (puente J3) y 0,5 A de límite el LED se quema y el circuito queda abierto", () => {
    const b = new Bench();
    b.loadCircuit("led");
    b.psu.output = true;
    settle(b, 0.2);
    const events: string[] = [];
    b.on((e) => events.push(e.kind));
    b.jumperPresent.set("J3", true);
    settle(b, 1.5);
    const led = b.diodes.get("LED1")!;
    expect(led.state).toBe("quemado");
    expect(led.peak).toBeGreaterThan(0.45);
    expect(events).toContain("diodeBurn");
    expect(b.truth().itotal).toBeLessThan(1e-6);
    b.setDiode("LED1");
    expect(b.diodes.get("LED1")!.state).toBe("ok");
  });

  it("sin resistencia pero con la fuente limitada a 25 mA, el LED sobrevive (CC)", () => {
    const b = new Bench();
    b.loadCircuit("led");
    b.psu.iset = 0.025;
    b.psu.output = true;
    b.jumperPresent.set("J3", true);
    settle(b, 10);
    const led = b.diodes.get("LED1")!;
    expect(led.state).toBe("ok");
    expect(b.psu.mode).toBe("CC");
    expect(Math.abs(b.truth().diodes[0].i - 0.025)).toBeLessThan(1e-4);
  });

  it("1N4007 en directa ≈ 0,62 V; dado vuelta bloquea y queda con −5 V", () => {
    const b = new Bench();
    b.loadCircuit("diodo");
    b.psu.output = true;
    settle(b, 0.5);
    let d = b.truth().diodes[0];
    expect(d.v).toBeGreaterThan(0.58);
    expect(d.v).toBeLessThan(0.66);
    expect(d.i).toBeGreaterThan(4.2e-3);
    b.flipDiode("D1");
    settle(b, 0.5);
    d = b.truth().diodes[0];
    expect(Math.abs(d.i)).toBeLessThan(1e-7);
    expect(d.v).toBeLessThan(-4.99);
  });

  it("la caída del diodo casi no cambia al duplicar la corriente", () => {
    const b = new Bench();
    b.loadCircuit("diodo");
    b.psu.output = true;
    settle(b, 0.3);
    const v5 = b.truth().diodes[0].v;
    b.psu.vset = 10;
    settle(b, 0.3);
    const d10 = b.truth().diodes[0];
    expect(d10.v - v5).toBeGreaterThan(0.02);
    expect(d10.v - v5).toBeLessThan(0.05);
  });

  it("curva I-V: la corriente es casi nula debajo del codo y sube de golpe arriba", () => {
    const b = new Bench();
    b.loadCircuit("curva");
    b.psu.output = true;
    const at = (v: number) => {
      b.psu.vset = v;
      settle(b, 0.1);
      return b.truth().diodes[0];
    };
    expect(at(1.0).i).toBeLessThan(1e-6);
    const p15 = at(1.5);
    expect(p15.i).toBeLessThan(2e-4);
    const p3 = at(3);
    expect(p3.i).toBeGreaterThan(50 * p15.i);
    const p5 = at(5);
    expect(p3.i).toBeGreaterThan(8e-3);
    expect(p5.i).toBeGreaterThan(2.5 * p3.i * 0.9);
    expect(p5.v - p3.v).toBeLessThan(0.15);
  });
});

describe("Multímetro: prueba de diodos", () => {
  const diodeTest = (circuit: string, red: string, black: string) => {
    const b = new Bench();
    b.loadCircuit(circuit);
    b.dmm.setDial("OHM");
    b.dmm.pressSelect();
    expect(b.dmm.dial).toBe("DIODE");
    b.probes.red = { kind: "hole", hole: red };
    b.probes.black = { kind: "hole", hole: black };
    settle(b, 0.4);
    return b;
  };

  it("Ω, ▶| y ·))) comparten una posición de la llave y se recorren con SELECT", () => {
    const b = new Bench();
    b.dmm.setDial("mVDC");
    b.dmm.rotate(1);
    expect(b.dmm.dial).toBe("OHM");
    b.dmm.pressSelect();
    expect(b.dmm.dial).toBe("DIODE");
    b.dmm.pressSelect();
    expect(b.dmm.dial).toBe("CONT");
    b.dmm.pressSelect();
    expect(b.dmm.dial).toBe("OHM");
    b.dmm.setDial("DIODE");
    b.dmm.rotate(1);
    expect(b.dmm.dial).toBe("mA");
    expect(DIAL_POSITIONS).toHaveLength(7);
    expect(positionOf("CONT")).toBe("OHM");
    b.dmm.setDial("VDC");
    b.dmm.pressSelect(); // en V⎓ no hace nada
    expect(b.dmm.dial).toBe("VDC");
  });

  it("1N4007 en directa marca ≈ 0,55 V con el indicador ▶|", () => {
    const b = diodeTest("diodo", "12a", "12j");
    const d = b.dmm.display;
    expect(d.diode).toBe(true);
    expect(d.unit).toBe("V");
    expect(d.text).toMatch(/^0\.5\d\d$/);
  });

  it("en inversa y con las puntas al aire marca OL", () => {
    expect(diodeTest("diodo", "12j", "12a").dmm.display.text).toBe("OL");
    const b = new Bench();
    b.dmm.setDial("DIODE");
    settle(b, 0.2);
    expect(b.dmm.display.text).toBe("OL");
  });

  it("con las puntas en corto marca 0,000", () => {
    expect(diodeTest("diodo", "3a", "3b").dmm.display.text).toMatch(/^-?0\.00[01]$/);
  });

  it("un LED rojo marca ≈ 1,6 V y se prende apenas con el milivatio de prueba", () => {
    const b = diodeTest("led", "12j", "11j");
    const v = b.dmm.display.value!;
    expect(v).toBeGreaterThan(1.55);
    expect(v).toBeLessThan(1.7);
    const led = b.diodes.get("LED1")!;
    expect(led.brightness).toBeGreaterThan(0.02);
    expect(led.brightness).toBeLessThan(0.1);
  });

  it("un LED blanco todavía entra en la escala (≈ 2,6 V)", () => {
    const b = new Bench();
    b.loadCircuit("led");
    b.setDiode("LED1", "led-blanco");
    b.dmm.setDial("DIODE");
    b.probes.red = { kind: "hole", hole: "12j" };
    b.probes.black = { kind: "hole", hole: "11j" };
    settle(b, 0.3);
    expect(b.dmm.display.value!).toBeGreaterThan(2.5);
    expect(b.dmm.display.value!).toBeLessThan(2.8);
  });

  it("sobre un resistor de 1 kΩ marca 1,000 V (es una fuente de 1 mA)", () => {
    const b = new Bench();
    b.loadCircuit("ohm");
    b.dmm.setDial("DIODE");
    b.probes.red = { kind: "hole", hole: "14a" };
    b.probes.black = { kind: "hole", hole: "14j" };
    settle(b, 0.2);
    const r = b.parts.get("R1")!.ohms;
    expect(Math.abs(b.dmm.display.value! - r * 1e-3)).toBeLessThan(0.03);
  });
});
