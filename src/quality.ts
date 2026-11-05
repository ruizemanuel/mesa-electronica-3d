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

/** Lo que el navegador informa del equipo. */
export interface DeviceHints {
  /** Pantalla táctil como puntero principal (celulares, tablets). */
  touch: boolean;
  /** Núcleos lógicos (navigator.hardwareConcurrency). */
  cores?: number;
  /** Memoria en GB (navigator.deviceMemory: solo Chromium, redondeada y con tope en 8). */
  memoryGB?: number;
}

export function deviceHints(): DeviceHints {
  const nav = typeof navigator === "object" ? (navigator as Navigator & { deviceMemory?: number }) : undefined;
  return {
    touch: typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches,
    cores: nav?.hardwareConcurrency || undefined,
    memoryGB: nav?.deviceMemory || undefined,
  };
}

/** Equipo de gama baja según el navegador: 4 GB de memoria o menos, o 2 núcleos o menos. */
export const isLowEnd = (h: DeviceHints): boolean => (h.memoryGB !== undefined && h.memoryGB <= 4) || (h.cores !== undefined && h.cores <= 2);

export const QUALITY: Record<Tier, Quality> = {
  baja: { tier: "baja", maxPixelRatio: 1.5, minPixelRatio: 1, shadowMapSize: 2048, lite: true },
  alta: { tier: "alta", maxPixelRatio: 2, minPixelRatio: 1, shadowMapSize: 4096, lite: false },
};

/**
 * Calidad según el dispositivo: pantallas táctiles (celulares, tablets) y equipos de gama baja
 * usan la versión liviana. Se puede forzar con ?calidad=alta o ?calidad=baja. Si igual no anda
 * fluido, la resolución adaptativa avisa y la app pasa a la versión liviana en marcha.
 */
export function detectQuality(search = location.search, hints: DeviceHints = deviceHints()): Quality {
  const p = new URLSearchParams(search).get("calidad");
  const tier: Tier = p === "alta" || p === "baja" ? p : hints.touch || isLowEnd(hints) ? "baja" : "alta";
  return { ...QUALITY[tier] };
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
  private badWindows = 0;
  private struggled = false;
  pixelRatio: number;
  /**
   * Se llama una sola vez si, ya en la resolución mínima, sigue por debajo de `strugglingFps`
   * durante dos ventanas seguidas: bajar la resolución no alcanza y hay que aliviar la escena.
   */
  onStruggle?: () => void;
  strugglingFps = 28;

  constructor(
    private readonly renderer: THREE.WebGLRenderer,
    private readonly getSize: () => { w: number; h: number },
    private readonly min: number,
    private max: number,
    private readonly targetLow = 42,
    private readonly targetHigh = 57,
  ) {
    this.pixelRatio = renderer.getPixelRatio();
  }

  /** Cambia el tope de densidad de píxeles (al pasar a la versión liviana). */
  setMax(max: number): void {
    this.max = max;
    if (this.pixelRatio > max) {
      this.pixelRatio = max;
      const { w, h } = this.getSize();
      this.renderer.setPixelRatio(max);
      this.renderer.setSize(w, h);
    }
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
    if (this.pixelRatio <= this.min && fps < this.strugglingFps) {
      if (++this.badWindows >= 2 && !this.struggled) {
        this.struggled = true;
        this.onStruggle?.();
      }
    } else this.badWindows = 0;
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
