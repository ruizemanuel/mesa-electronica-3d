import { describe, expect, it } from "vitest";
import { Bench } from "./bench";
import { CAP_VALUES, capModel, ceramicCode, formatCap, kindOf } from "./capacitor";
import { CIRCUITS, isValidHole } from "./circuits";
import { FunctionGenerator, formatFreq } from "./fgen";
import { Oscilloscope, POINTS } from "./scope";

/** Avanza el banco en cuadros de 20 ms, como el bucle de la app. */
function run(b: Bench, seconds: number): void {
  for (let t = 0; t < seconds - 1e-9; t += 0.02) b.step(0.02);
}

describe("Generador de funciones", () => {
  it("las tres formas de onda cruzan el cero subiendo en φ = 0 y tienen pico 1", () => {
    for (const w of ["sine", "square", "triangle"] as const) {
      expect(FunctionGenerator.shape(w, 0.25)).toBeCloseTo(1, 12);
      expect(FunctionGenerator.shape(w, 0.75)).toBeCloseTo(-1, 12);
    }
    expect(FunctionGenerator.shape("triangle", 0.125)).toBeCloseTo(0.5, 12);
    // en el flanco, el límite por izquierda es el valor de antes del salto
    expect(FunctionGenerator.shape("square", 0, true)).toBe(-1);
    expect(FunctionGenerator.shape("square", 0.5, true)).toBe(1);
  });

  it("amplitud y offset se limitan a la salida de ±10 V", () => {
    const g = new FunctionGenerator();
    g.setVpp(20);
    expect(g.vpp).toBe(20);
    g.setOffset(3);
    expect(g.offset).toBe(0); // con 20 Vpp no queda margen para offset
    g.setVpp(10);
    g.setOffset(8);
    expect(g.offset).toBe(5);
    g.setFreq(1e6);
    expect(g.freq).toBe(20e3);
  });

  it("la perilla de frecuencia mueve la segunda cifra sin saltear valores", () => {
    const g = new FunctionGenerator();
    g.freq = 1000;
    g.nudge(1);
    expect(g.freq).toBe(1100);
    g.freq = 1000;
    g.nudge(-1);
    expect(g.freq).toBe(990);
    g.nudge(1);
    expect(g.freq).toBe(1000);
    expect(formatFreq(1591.6)).toBe("1,592 kHz");
    expect(formatFreq(50)).toBe("50,00 Hz");
  });
});

describe("Capacitores", () => {
  it("código de los cerámicos y tipo según el valor", () => {
    expect(ceramicCode(100e-9)).toBe("104");
    expect(ceramicCode(4.7e-9)).toBe("472");
    expect(ceramicCode(1e-9)).toBe("102");
    expect(kindOf(470e-9)).toBe("ceramico");
    expect(kindOf(1e-6)).toBe("electrolitico");
    expect(formatCap(100e-9)).toBe("100 nF");
    expect(formatCap(4.7e-6)).toBe("4,7 µF");
    expect(CAP_VALUES.length).toBe(19);
  });

  it("la ESR de un electrolítico baja con la capacidad (tan δ / ωC)", () => {
    expect(capModel(10e-6).esr).toBeCloseTo(2.23, 2);
    expect(capModel(100e-6).esr).toBeCloseTo(0.223, 3);
    expect(capModel(1000e-6).esr).toBe(0.03);
    expect(capModel(1000e-6).vMax).toBe(16);
  });
});

describe("Osciloscopio (adquisición, disparo y mediciones)", () => {
  /** Alimenta una senoidal muestreada cada h durante `seconds`. */
  function feed(s: Oscilloscope, f: number, amp: number, offset: number, seconds: number, h = 2e-6, t0 = 0): number {
    let t = t0;
    for (; t < t0 + seconds; t += h) s.push(t, offset + amp * Math.sin(2 * Math.PI * f * t), offset - amp * Math.cos(2 * Math.PI * f * t));
    s.update();
    return t;
  }

  it("mide Vpp, frecuencia, promedio, eficaz y el desfasaje entre canales", () => {
    const s = new Oscilloscope();
    s.setTdiv(0.5e-3);
    s.ch[0].vdiv = 1;
    s.ch[1].vdiv = 1;
    s.trig.level = 1;
    feed(s, 1000, 2, 1, 0.05);
    expect(s.status).toBe("TRIG'D");
    const m = s.measures[0]!;
    expect(m.vpp).toBeGreaterThan(3.9);
    expect(m.vpp).toBeLessThan(4.15); // cuantización y ruido de 8 bits
    expect(m.freq!).toBeCloseTo(1000, -1);
    expect(m.mean).toBeCloseTo(1, 1);
    expect(m.rms).toBeCloseTo(Math.sqrt(1 + 2), 1); // DC² + (A/√2)²
    expect(s.phase!).toBeCloseTo(-90, -1); // −cos atrasa 90° respecto de sen
  });

  it("el disparo deja la traza quieta: dos adquisiciones seguidas empiezan en el mismo nivel", () => {
    const s = new Oscilloscope();
    s.setTdiv(0.2e-3);
    s.trig.level = 0.5;
    let t = feed(s, 1234, 2, 0, 0.03);
    const first = s.record.volts[0][Math.round(POINTS / 2)];
    t = feed(s, 1234, 2, 0, 0.0371, 2e-6, t);
    const second = s.record.volts[0][Math.round(POINTS / 2)];
    expect(Math.abs(first - 0.5)).toBeLessThan(0.15);
    expect(Math.abs(second - 0.5)).toBeLessThan(0.15);
  });

  it("acoplamiento AC: saca la continua", () => {
    const s = new Oscilloscope();
    s.setTdiv(1e-3);
    s.ch[0].coupling = "AC";
    s.ch[0].vdiv = 0.5;
    s.trig.level = 0;
    feed(s, 500, 1, 5, 1.5, 5e-6);
    expect(Math.abs(s.measures[0]!.mean)).toBeLessThan(0.05);
    expect(s.measures[0]!.vpp).toBeCloseTo(2, 0);
  });

  it("si la señal no entra en pantalla, las mediciones se marcan como no válidas", () => {
    const s = new Oscilloscope();
    s.ch[0].vdiv = 0.1;
    feed(s, 1000, 2, 0, 0.03);
    expect(s.measures[0]!.clipped).toBe(true);
  });

  it("NORMAL sin disparo espera; SINGLE adquiere una vez y para", () => {
    const s = new Oscilloscope();
    s.trig.mode = "NORMAL";
    s.trig.level = 5; // fuera de la señal
    feed(s, 1000, 1, 0, 0.1);
    expect(s.status).toBe("WAIT");
    s.trig.level = 0;
    s.single();
    feed(s, 1000, 1, 0, 0.05, 2e-6, 0.1);
    expect(s.status).toBe("STOP");
    expect(s.running).toBe(false);
  });

  it("AUTOSET encuentra escalas y base de tiempo para ver 2 o 3 períodos", () => {
    const s = new Oscilloscope();
    s.setTdiv(1e-6);
    s.ch[0].vdiv = 10;
    feed(s, 1000, 3, 0, 0.25, 5e-6);
    s.autoset();
    expect(s.ch[0].vdiv).toBe(1); // 6 Vpp en ≈ 6 div
    expect(s.tdiv).toBe(0.5e-3); // 10 div × 0,5 ms = 5 ms ≈ 5 períodos (≥ 2,5)
    expect(s.trig.src).toBe(0);
  });

  it("cursores de tiempo: ΔT y la tensión de la traza en cada cursor", () => {
    const s = new Oscilloscope();
    s.setTdiv(0.1e-3);
    s.trig.level = 0;
    feed(s, 1000, 2, 0, 0.03);
    s.cursor.mode = "time";
    s.cursor.a = 0.5; // el disparo, en el centro: la senoidal cruza el 0 subiendo
    s.cursor.b = 0.75; // 250 µs después: un cuarto de período, el pico
    const c = s.cursorValues();
    expect(c.dt).toBeCloseTo(250e-6, 9);
    expect(Math.abs(c.va!)).toBeLessThan(0.15);
    expect(c.vb!).toBeCloseTo(2, 0);
  });
});

describe("Circuitos con capacitores en el banco", () => {
  it("las definiciones nuevas usan agujeros válidos y empiezan con el generador apagado", () => {
    for (const c of CIRCUITS.filter((x) => x.capacitors || x.gen)) {
      for (const k of c.capacitors ?? []) expect(isValidHole(k.a) && isValidHole(k.b)).toBe(true);
      expect(isValidHole(c.gen!.pos) && isValidHole(c.gen!.neg)).toBe(true);
      for (const h of [c.scope?.ch1, c.scope?.ch2, c.scope?.gnd]) if (h) expect(isValidHole(h)).toBe(true);
      const b = new Bench();
      b.loadCircuit(c.id);
      expect(b.gen.output).toBe(false);
      expect(b.transient).toBe(true);
    }
  });

  it("RC: con los cursores en 0 y en el 63,2 % se mide τ = (R + 50 Ω)·C", () => {
    const b = new Bench();
    b.loadCircuit("rc");
    b.gen.setOutput(true);
    run(b, 0.3);
    const s = b.scope;
    expect(s.status).toBe("TRIG'D");
    const tau = (b.parts.get("R1")!.ohms + 50) * b.caps.get("C1")!.farads;
    // instante en que CH2 cruza el 63,2 % después del flanco (el disparo está a 1 div del borde)
    const r = s.record;
    const v = r.volts[1];
    const iEdge = Math.round(-r.t0 / r.dt);
    const target = 0.632 * 5;
    let iCross = iEdge;
    while (iCross < POINTS && v[iCross] < target) iCross++;
    const measured = (iCross - iEdge) * r.dt;
    expect(Math.abs(measured - tau) / tau).toBeLessThan(0.05); // ruido del conversor de 8 bits
    expect(b.speed).toBeCloseTo(1, 6); // en tiempo real
  });

  it("pasabajos: en la fc real la salida es el 70,7 % de la entrada y atrasa 45°", () => {
    const b = new Bench();
    b.loadCircuit("pasabajos");
    const fc = 1 / (2 * Math.PI * (b.parts.get("R1")!.ohms + 50) * b.caps.get("C1")!.farads);
    b.gen.setFreq(fc);
    b.gen.setOutput(true);
    b.scope.setTdiv(0.2e-3);
    b.scope.ch[0].vdiv = 0.5;
    b.scope.ch[1].vdiv = 0.5;
    run(b, 0.2);
    const [m1, m2] = b.scope.measures;
    expect(m2!.vpp / m1!.vpp).toBeCloseTo(Math.SQRT1_2, 1);
    expect(b.scope.phase!).toBeGreaterThan(-49);
    expect(b.scope.phase!).toBeLessThan(-41);
  });

  it("multímetro en V~: valor eficaz verdadero dentro de su ancho de banda, y menos por encima", () => {
    const b = new Bench();
    b.loadCircuit("pasabajos");
    b.gen.setOutput(true);
    b.dmm.setDial("VAC");
    b.probes.red = { kind: "hole", hole: "8c" };
    b.probes.black = { kind: "hole", hole: "RB-:10" };
    const vin = 2 / Math.SQRT2; // 4 Vpp; a 200 Hz el filtro casi no carga al generador
    b.refreshDmm();
    run(b, 0.8);
    expect(b.dmm.display.value!).toBeGreaterThan(vin * 0.96);
    expect(b.dmm.display.value!).toBeLessThan(vin * 1.01);
    // cuadrada: el valor eficaz de una cuadrada simétrica es su amplitud
    b.gen.setWave("square");
    b.refreshDmm();
    run(b, 0.8);
    expect(b.dmm.display.value!).toBeGreaterThan(1.85);
    expect(b.dmm.display.value!).toBeLessThan(2.02);
    // a 10 kHz el convertidor ya no llega (y además el filtro carga más la entrada)
    b.gen.setWave("sine");
    b.gen.setFreq(10000);
    b.refreshDmm();
    run(b, 0.8);
    expect(b.dmm.display.value!).toBeLessThan(vin * 0.8);
  });

  it("rectificador: ripple ≈ I/(f·C); sin el capacitor, promedio ≈ Vpico/π; el multímetro integra", () => {
    const b = new Bench();
    b.loadCircuit("rectificador");
    b.gen.setOutput(true);
    b.dmm.setDial("VDC");
    b.probes.red = { kind: "hole", hole: "12j" };
    b.probes.black = { kind: "hole", hole: "RB-:16" };
    b.scope.ch[1].coupling = "AC";
    b.scope.ch[1].vdiv = 0.5;
    run(b, 1.5);
    const m2 = b.scope.measures[1]!;
    const C = b.caps.get("C1")!.farads;
    const vmax = 10 - 0.7;
    const ripple = vmax / b.parts.get("R1")!.ohms / (50 * C);
    // la fórmula es una cota: el ripple real da ≈ 20 % menos
    expect(m2.vpp).toBeGreaterThan(ripple * 0.65);
    expect(m2.vpp).toBeLessThan(ripple * 0.95);
    expect(b.dmm.display.value!).toBeGreaterThan(vmax - ripple - 0.5); // los 50 Ω bajan un poco el pico
    expect(b.dmm.display.value!).toBeLessThan(vmax);
    // sin el capacitor (J1 afuera): media onda
    b.jumperPresent.set("J1", false);
    b.scope.ch[1].coupling = "DC";
    b.scope.ch[1].vdiv = 5;
    b.refreshDmm();
    run(b, 1);
    const avg = b.dmm.display.value!;
    expect(avg).toBeGreaterThan(2.7);
    expect(avg).toBeLessThan(3.1); // ≈ (Vp − Vd)/π
    expect(b.scope.measures[1]!.vmin).toBeGreaterThan(-0.3);
  });

  it("lazo de masa: la pinza del osciloscopio en la salida la cortocircuita a tierra", () => {
    const b = new Bench();
    b.loadCircuit("rectificador");
    b.gen.setOutput(true);
    run(b, 0.5);
    expect(b.groundLoop()).toBe(false);
    expect(b.scope.measures[1]!.vmax).toBeGreaterThan(7);
    b.probes.sgnd = { kind: "hole", hole: "12j" };
    expect(b.groundLoop()).toBe(true);
    run(b, 0.5);
    expect(Math.abs(b.scope.measures[1]!.vmax)).toBeLessThan(0.3);
  });

  it("un electrolítico al revés conduce como un diodo: el filtro no funciona y se calienta", () => {
    const b = new Bench();
    b.loadCircuit("rectificador");
    b.flipCapacitor("C1");
    b.gen.setOutput(true);
    run(b, 30);
    const c = b.caps.get("C1")!;
    expect(b.scope.measures[1]!.vmax).toBeLessThan(4); // recorta en la conducción inversa
    expect(c.tempC).toBeGreaterThan(40);
    expect(c.state).toBe("ok"); // con los 200 mA máximos del generador, no llega a inflarse
  });

  it("con 0,6 W de fuga inversa un electrolítico chico se infla y queda abierto", () => {
    const b = new Bench();
    b.loadCircuit("rectificador");
    const c = b.caps.get("C1")!;
    let burst = false;
    for (let t = 0; t < 60 && !burst; t += 0.1) burst = c.step(0.6, 0.1);
    expect(burst).toBe(true);
    expect(c.state).toBe("inflado");
  });

  it("la simulación sigue en tiempo real con una señal de 5 kHz (presupuesto de pasos)", () => {
    const b = new Bench();
    b.loadCircuit("pasabajos");
    b.gen.setFreq(5000);
    b.gen.setOutput(true);
    b.scope.setTdiv(0.1e-3);
    run(b, 0.1);
    expect(b.speed).toBeCloseTo(1, 6);
    expect(b.lastH).toBeLessThanOrEqual(1 / 5000 / 64 + 1e-12); // ≥ 64 puntos por período
  });
});
