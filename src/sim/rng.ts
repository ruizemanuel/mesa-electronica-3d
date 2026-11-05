/** PRNG determinista (mulberry32) para que cada instrumento/componente tenga "personalidad" estable. */
export class Rng {
  private s: number;
  constructor(seed: number) {
    this.s = seed >>> 0;
  }
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(a: number, b: number): number {
    return a + (b - a) * this.next();
  }
  /** Normal estándar (Box-Muller). */
  gauss(): number {
    let u = 0;
    while (u === 0) u = this.next();
    const v = this.next();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  /** Normal truncada en ±limit (en unidades de sigma). */
  gaussTrunc(sigma: number, limit: number): number {
    for (let i = 0; i < 64; i++) {
      const g = this.gauss();
      if (Math.abs(g) <= limit) return g * sigma;
    }
    return 0;
  }
}

export function hashSeed(text: string, base = 0x9e3779b9): number {
  let h = base >>> 0;
  for (let i = 0; i < text.length; i++) {
    h = Math.imul(h ^ text.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h;
}
