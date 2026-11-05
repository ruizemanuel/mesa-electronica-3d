import type * as THREE from "three";

export type Tier = "alta" | "baja";

export interface Quality {
  tier: Tier;
  /** Tope de densidad de píxeles del render (la resolución adaptativa nunca lo supera). */
  maxPixelRatio: number;
  minPixelRatio: number;
  shadowMapSize: number;
  /** Usar los modelos "<id>.lite.glb" cuando existan. */
  lite: boolean;
}

/** Modelos con versión liviana (ver tools/optimize_models.mjs). */
export const LITE_MODELS = new Set(["furniture_workbench_standard_e01"]);

/**
 * Calidad según el dispositivo: pantallas táctiles (celulares, tablets) usan la versión liviana.
 * Se puede forzar con ?calidad=alta o ?calidad=baja.
 */
export function detectQuality(search = location.search): Quality {
  const p = new URLSearchParams(search).get("calidad");
  const touch = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;
  const tier: Tier = p === "alta" || p === "baja" ? p : touch ? "baja" : "alta";
  return tier === "baja"
    ? { tier, maxPixelRatio: 1.5, minPixelRatio: 1, shadowMapSize: 2048, lite: true }
    : { tier, maxPixelRatio: 2, minPixelRatio: 1, shadowMapSize: 4096, lite: false };
}

/**
 * Resolución adaptativa: mide los FPS en ventanas de 1,5 s y baja o sube la densidad de
 * píxeles de a 0,25 para mantener la fluidez. Ignora los primeros segundos (compilación de
 * shaders) y sube con más cautela de lo que baja, para no oscilar.
 */
export class AdaptiveResolution {
  private frames = 0;
  private elapsed = 0;
  private warmup = 2.5;
  private goodWindows = 0;
  pixelRatio: number;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly getSize: () => { w: number; h: number },
    private readonly min: number,
    private readonly max: number,
    private readonly targetLow = 42,
    private readonly targetHigh = 57,
  ) {
    this.pixelRatio = renderer.getPixelRatio();
  }

  /** Llamar una vez por cuadro con el dt real (s). Devuelve true si cambió la resolución. */
  tick(dt: number): boolean {
    if (dt <= 0 || dt > 0.5) return false; // pestaña en segundo plano, pausas
    if (this.warmup > 0) {
      this.warmup -= dt;
      return false;
    }
    this.frames++;
    this.elapsed += dt;
    if (this.elapsed < 1.5) return false;
    const fps = this.frames / this.elapsed;
    this.frames = 0;
    this.elapsed = 0;
    let next = this.pixelRatio;
    if (fps < this.targetLow && this.pixelRatio > this.min) {
      next = Math.max(this.min, this.pixelRatio - 0.25);
      this.goodWindows = 0;
    } else if (fps > this.targetHigh && this.pixelRatio < this.max) {
      if (++this.goodWindows >= 3) {
        next = Math.min(this.max, this.pixelRatio + 0.25);
        this.goodWindows = 0;
      }
    } else {
      this.goodWindows = 0;
    }
    if (next === this.pixelRatio) return false;
    this.pixelRatio = next;
    const { w, h } = this.getSize();
    this.renderer.setPixelRatio(next);
    this.renderer.setSize(w, h);
    this.warmup = 0.5;
    return true;
  }
}

/**
 * Las sombras solo se recalculan cuando algo que proyecta sombra cambió (posición, geometría o
 * visibilidad). Mover la cámara no cambia el mapa de sombras: así se ahorra dibujar la escena
 * dos veces por cuadro.
 */
export class ShadowInvalidator {
  private last = NaN;
  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly roots: THREE.Object3D[],
  ) {
    renderer.shadowMap.autoUpdate = false;
    renderer.shadowMap.needsUpdate = true;
  }

  invalidate(): void {
    this.renderer.shadowMap.needsUpdate = true;
  }

  /** Llamar antes de renderizar (con las matrices del mundo actualizadas). */
  check(): void {
    let h = 0;
    let i = 1;
    for (const root of this.roots) {
      root.updateMatrixWorld();
      root.traverse((o) => {
        const m = o as THREE.Mesh;
        if (!m.isMesh || !m.castShadow) return;
        i++;
        if (!m.visible) {
          h += i * 7.7;
          return;
        }
        const e = m.matrixWorld.elements;
        h += i * (e[12] * 1.3 + e[13] * 1.7 + e[14] * 1.9 + e[0] * 0.31 + e[1] * 0.37 + e[2] * 0.41 + e[4] * 0.43 + e[8] * 0.47);
        h += m.geometry.id * 0.013;
      });
    }
    if (h !== this.last) {
      this.last = h;
      this.renderer.shadowMap.needsUpdate = true;
    }
  }
}
