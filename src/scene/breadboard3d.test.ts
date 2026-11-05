import { describe, expect, it } from "vitest";
import { BAND_LAYOUT, resistorBodyGeometry } from "./breadboard3d";
import { glowOf, ledLegPoints, polylineLength } from "./diode3d";
import { MM } from "./util";

describe("cuerpo del resistor", () => {
  it("mapea la textura de bandas en proporción al largo real (no por índice del perfil)", () => {
    const L = 6.0;
    const geo = resistorBodyGeometry(1.15, L);
    const pos = geo.getAttribute("position");
    const uv = geo.getAttribute("uv");
    let maxErr = 0;
    for (let i = 0; i < pos.count; i++) {
      const axial = (pos.getY(i) / MM + L / 2) / L; // 0 en un extremo, 1 en el otro
      maxErr = Math.max(maxErr, Math.abs(uv.getY(i) - axial));
    }
    expect(maxErr).toBeLessThan(1e-6);
  });

  it("todas las bandas tienen el mismo ancho y no se pisan", () => {
    for (const n of [4, 5] as const) {
      const { pos, width } = BAND_LAYOUT[n];
      expect(pos).toHaveLength(n);
      for (let i = 1; i < n; i++) expect(pos[i] - pos[i - 1]).toBeGreaterThan(width * 1.3);
      // la banda de tolerancia queda separada del grupo de cifras
      expect(pos[n - 1] - pos[n - 2]).toBeGreaterThan(1.8 * (pos[1] - pos[0]));
      expect(pos[0] - width / 2).toBeGreaterThan(0.1);
      expect(pos[n - 1] + width / 2).toBeLessThan(0.9);
    }
  });
});

describe("LED de 5 mm", () => {
  it("la pata del ánodo es más larga que la del cátodo y las dos entran a la misma profundidad", () => {
    const { anode, cathode } = ledLegPoints();
    expect(polylineLength(anode)).toBeGreaterThan(polylineLength(cathode) + 1);
    expect(anode[0][1]).toBe(cathode[0][1]);
    expect(anode[anode.length - 1][1]).toBe(cathode[cathode.length - 1][1]);
    // ánodo a la izquierda (−X), cátodo a la derecha, separadas 2,54 mm
    expect(cathode[0][0] - anode[0][0]).toBeCloseTo(2.54, 6);
  });

  it("el brillo visual crece con la corriente y satura", () => {
    expect(glowOf(0)).toBe(0);
    expect(glowOf(-1)).toBe(0);
    expect(glowOf(0.05)).toBeGreaterThan(0.15); // 1 mA de la prueba de diodos: se ve
    expect(glowOf(1)).toBeCloseTo(1, 6);
    expect(glowOf(100)).toBe(1.5);
  });
});
