import { describe, expect, it } from "vitest";
import type * as THREE from "three";
import { AdaptiveResolution, detectQuality, isLowEnd } from "./quality";

describe("detección de calidad", () => {
  const pc = { touch: false, cores: 8, memoryGB: 8 };

  it("una PC normal arranca en calidad alta y un celular en baja", () => {
    expect(detectQuality("", pc).tier).toBe("alta");
    expect(detectQuality("", { ...pc, touch: true }).tier).toBe("baja");
  });

  it("un equipo de gama baja arranca en calidad baja aunque no sea táctil", () => {
    expect(isLowEnd({ touch: false, memoryGB: 4, cores: 8 })).toBe(true);
    expect(isLowEnd({ touch: false, memoryGB: 8, cores: 2 })).toBe(true);
    expect(isLowEnd({ touch: false, memoryGB: 8, cores: 4 })).toBe(false);
    // Firefox y Safari no informan la memoria: sin dato no se asume nada
    expect(isLowEnd({ touch: false, cores: 4 })).toBe(false);
    expect(detectQuality("", { ...pc, memoryGB: 4 }).lite).toBe(true);
  });

  it("?calidad= manda sobre la detección", () => {
    expect(detectQuality("?calidad=alta", { touch: true, memoryGB: 2, cores: 2 }).tier).toBe("alta");
    expect(detectQuality("?calidad=baja", pc).tier).toBe("baja");
  });

  it("devuelve una copia (la app la modifica al pasar a liviana)", () => {
    const a = detectQuality("", pc);
    a.lite = true;
    expect(detectQuality("", pc).lite).toBe(false);
  });
});

describe("resolución adaptativa", () => {
  function setup(max = 2) {
    const r = { pr: max, getPixelRatio: () => r.pr, setPixelRatio: (v: number) => (r.pr = v), setSize: () => {} };
    const a = new AdaptiveResolution(r as unknown as THREE.WebGLRenderer, () => ({ w: 800, h: 600 }), 1, max);
    let calls = 0;
    a.onStruggle = () => calls++;
    const run = (fps: number, seconds: number) => {
      for (let t = 0; t < seconds; t += 1 / fps) a.tick(1 / fps);
    };
    return { a, run, calls: () => calls };
  }

  it("con un equipo que no llega a 28 FPS ni en la resolución mínima, avisa una sola vez", () => {
    const { a, run, calls } = setup();
    run(20, 30);
    expect(a.pixelRatio).toBe(1);
    expect(calls()).toBe(1);
  });

  it("si bajar la resolución alcanza, no avisa", () => {
    const { run, calls } = setup();
    run(40, 30); // baja de a 0,25 hasta el mínimo pero queda por encima de 28 FPS
    expect(calls()).toBe(0);
  });

  it("a 60 FPS no toca nada", () => {
    const { a, run, calls } = setup();
    run(60, 20);
    expect(a.pixelRatio).toBe(2);
    expect(calls()).toBe(0);
  });

  it("setMax baja el tope y la resolución actual si lo superaba", () => {
    const { a } = setup(2);
    a.setMax(1.5);
    expect(a.pixelRatio).toBe(1.5);
  });
});
