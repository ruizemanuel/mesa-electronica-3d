import * as THREE from "three";
import { MM, shadows, std, tag } from "./util";

/** Punta de prueba: el origen local es la punta metálica; +Y apunta hacia el mango. */
export class Probe3D {
  readonly group = new THREE.Group();
  readonly length = 140 * MM;
  private readonly pose = { tip: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0) };
  private readonly target = { tip: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0) };
  private first = true;

  constructor(
    readonly color: "red" | "black",
    hex: string,
  ) {
    const metal = std("#d5d8dc", 0.22, 1.0);
    const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * MM, 1.0 * MM, 16 * MM, 12), metal);
    tip.position.y = 8 * MM;
    const point = new THREE.Mesh(new THREE.ConeGeometry(0.5 * MM, 1.6 * MM, 12), metal);
    point.rotation.x = Math.PI;
    point.position.y = -0.8 * MM + 0 * MM;
    point.position.y = 0.8 * MM;
    tip.position.y = 1.6 * MM + 8 * MM;
    const mat = std(hex, 0.5);
    const prof = [
      [0, 17.6],
      [2.6, 17.6],
      [3.4, 22],
      [3.4, 38],
      [6.4, 39],
      [6.4, 42],
      [4.6, 43],
      [4.4, 120],
      [3.8, 132],
      [2.4, 140],
      [0, 140],
    ].map(([r, y]) => new THREE.Vector2(r * MM, y * MM));
    const handle = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), mat);
    this.group.add(tip, point, handle);
    tag(this.group, `probe:${color}`);
    shadows(this.group, true, false);
  }

  /** Coloca la punta en `tip` con el mango hacia `dir` (unitario). */
  setTarget(tip: THREE.Vector3, dir: THREE.Vector3, immediate = false): void {
    this.target.tip.copy(tip);
    this.target.dir.copy(dir).normalize();
    if (immediate || this.first) {
      this.pose.tip.copy(tip);
      this.pose.dir.copy(this.target.dir);
      this.first = false;
      this.apply();
    }
  }

  tick(dt: number): void {
    const k = Math.min(1, dt * 16);
    this.pose.tip.lerp(this.target.tip, k);
    this.pose.dir.lerp(this.target.dir, k).normalize();
    this.apply();
  }

  private apply(): void {
    this.group.position.copy(this.pose.tip);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.pose.dir);
  }

  /** Extremo trasero del mango, donde entra el cable. */
  tail(): THREE.Vector3 {
    return this.pose.tip.clone().addScaledVector(this.pose.dir, this.length);
  }
  get dir(): THREE.Vector3 {
    return this.pose.dir.clone();
  }
}

/** Cable flexible con caída: se apoya sobre la mesa (y >= floorY). */
export class Cable {
  readonly mesh: THREE.Mesh;
  private lastKey = "";
  constructor(
    color: string,
    private readonly radius: number,
    private readonly floorY: number,
  ) {
    this.mesh = new THREE.Mesh(new THREE.BufferGeometry(), std(color, 0.55));
    this.mesh.castShadow = true;
    this.mesh.receiveShadow = true;
  }

  /**
   * start/startDir: salida del conector; end/endDir: entrada al otro extremo (dir apunta
   * hacia afuera del extremo). slack: cuánto cable sobra (≥ 1).
   */
  update(start: THREE.Vector3, startDir: THREE.Vector3, end: THREE.Vector3, endDir: THREE.Vector3, slack = 1.25, endLen?: number): void {
    const key = [start, startDir, end, endDir].map((v) => v.toArray().map((n) => n.toFixed(4)).join(",")).join("|");
    if (key === this.lastKey) return;
    this.lastKey = key;
    const d = start.distanceTo(end);
    const lift = Math.max(0.02, d * 0.12);
    const a1 = start.clone().addScaledVector(startDir, Math.max(0.025, d * 0.12));
    const b1 = end.clone().addScaledVector(endDir, endLen ?? Math.max(0.025, d * 0.12));
    const floor = this.floorY + this.radius;
    const sag = (p: THREE.Vector3, amount: number) => {
      p.y = Math.max(floor, p.y - amount);
      return p;
    };
    const mid = a1.clone().lerp(b1, 0.5);
    const droop = d * 0.35 * slack + lift;
    const pts = [
      start,
      a1,
      sag(a1.clone().lerp(mid, 0.6), droop * 0.6),
      sag(mid.clone(), droop),
      sag(b1.clone().lerp(mid, 0.6), droop * 0.6),
      b1,
      end,
    ];
    const curve = new THREE.CatmullRomCurve3(pts, false, "centripetal");
    this.mesh.geometry.dispose();
    this.mesh.geometry = new THREE.TubeGeometry(curve, 96, this.radius, 10, false);
  }
}

/** Interfaz común de todo lo que se apoya en el circuito (puntas y pinzas). */
export interface Holdable {
  readonly group: THREE.Group;
  setTarget(tip: THREE.Vector3, dir: THREE.Vector3, immediate?: boolean): void;
  tick(dt: number): void;
  tail(): THREE.Vector3;
  readonly dir: THREE.Vector3;
}

/** Movimiento suave hacia la pose pedida (compartido por las puntas del osciloscopio y la pinza). */
class Posed {
  readonly group = new THREE.Group();
  protected readonly pose = { tip: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0) };
  private readonly target = { tip: new THREE.Vector3(), dir: new THREE.Vector3(0, 1, 0) };
  private first = true;
  constructor(readonly length: number) {}
  setTarget(tip: THREE.Vector3, dir: THREE.Vector3, immediate = false): void {
    this.target.tip.copy(tip);
    this.target.dir.copy(dir).normalize();
    if (immediate || this.first) {
      this.pose.tip.copy(tip);
      this.pose.dir.copy(this.target.dir);
      this.first = false;
      this.apply();
    }
  }
  tick(dt: number): void {
    const k = Math.min(1, dt * 16);
    this.pose.tip.lerp(this.target.tip, k);
    this.pose.dir.lerp(this.target.dir, k).normalize();
    this.apply();
  }
  private apply(): void {
    this.group.position.copy(this.pose.tip);
    this.group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), this.pose.dir);
  }
  tail(): THREE.Vector3 {
    return this.pose.tip.clone().addScaledVector(this.pose.dir, this.length);
  }
  /** Punto del cuerpo a `mm` de la punta (de ahí sale el cablecito de masa). */
  along(mm: number): THREE.Vector3 {
    return this.pose.tip.clone().addScaledVector(this.pose.dir, mm * MM);
  }
  get dir(): THREE.Vector3 {
    return this.pose.dir.clone();
  }
}

/**
 * Punta ×10 del osciloscopio: gancho retráctil, cuerpo gris con el aro del color del canal, el
 * resalto para los dedos y el pasacable. El origen local es la punta; +Y va hacia el cable.
 */
export class ScopeProbe3D extends Posed implements Holdable {
  constructor(id: "ch1" | "ch2", ring: string) {
    super(118 * MM);
    const metal = std("#d5d8dc", 0.22, 1.0);
    // gancho: una aguja fina con la uña curva (como un mini-grabber cerrado)
    const needle = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * MM, 0.45 * MM, 9 * MM, 10), metal);
    needle.position.y = 4.5 * MM;
    const hook = new THREE.Mesh(new THREE.TorusGeometry(0.9 * MM, 0.22 * MM, 6, 14, Math.PI * 1.3), metal);
    hook.rotation.z = Math.PI * 0.55;
    hook.position.set(0.6 * MM, 2.2 * MM, 0);
    const body = std("#3b3f45", 0.55);
    const prof = [
      [0, 9],
      [1.6, 9],
      [2.6, 14],
      [3.1, 16],
      [6.2, 18],
      [6.2, 20.5],
      [3.6, 22],
      [4.2, 96],
      [3.4, 104],
      [2.4, 118],
      [0, 118],
    ].map(([r, y]) => new THREE.Vector2(r * MM, y * MM));
    const handle = new THREE.Mesh(new THREE.LatheGeometry(prof, 28), body);
    const ringMesh = new THREE.Mesh(new THREE.CylinderGeometry(4.3 * MM, 4.3 * MM, 3.5 * MM, 24), std(ring, 0.45));
    ringMesh.position.y = 90 * MM;
    // la llavecita ×1/×10 (fija en ×10)
    const sw = new THREE.Mesh(new THREE.BoxGeometry(2.2 * MM, 6 * MM, 1.6 * MM), std("#1d1f22", 0.5));
    sw.position.set(0, 60 * MM, 4.1 * MM);
    this.group.add(needle, hook, handle, ringMesh, sw);
    tag(this.group, `probe:${id}`);
    shadows(this.group, true, false);
  }
}

/** Pinza cocodrilo chica del cablecito de masa de la punta del osciloscopio. */
export class GroundClip3D extends Posed implements Holdable {
  constructor() {
    super(30 * MM);
    const metal = std("#c9ccd1", 0.3, 0.9);
    const jawGeo = new THREE.BoxGeometry(1.6 * MM, 11 * MM, 1.1 * MM);
    for (const s of [-1, 1]) {
      const jaw = new THREE.Mesh(jawGeo, metal);
      jaw.position.set(s * 0.75 * MM, 6 * MM, 0);
      jaw.rotation.z = s * 0.06;
      this.group.add(jaw);
    }
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(2.4 * MM, 3.4 * MM, 18 * MM, 16), std("#161616", 0.6));
    boot.position.y = 20 * MM;
    this.group.add(boot);
    tag(this.group, "probe:sgnd");
    shadows(this.group, true, false);
  }
}
