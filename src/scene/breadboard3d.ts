import * as THREE from "three";
import { BB_COLS, BOTTOM_ROWS, RAILS, TOP_ROWS, railHasCol, type CircuitDef, type JumperDef, type ResistorDef } from "../sim/circuits";
import { colorBands, techOf, type ResistorPart, type ResistorSpec } from "../sim/resistor";
import { MM, canvasTexture, roundedPath, shadows, std, tag, text } from "./util";

const P = 2.54; // mm
export const BB_W = 82.5;
export const BB_D = 54.8;
export const BB_H = 8.5;

const ROW_Z: Record<string, number> = {
  a: -13.97,
  b: -11.43,
  c: -8.89,
  d: -6.35,
  e: -3.81,
  f: 3.81,
  g: 6.35,
  h: 8.89,
  i: 11.43,
  j: 13.97,
};
const RAIL_Z: Record<string, number> = { "RT-": -22.86, "RT+": -20.32, "RB-": 20.32, "RB+": 22.86 };

export const colX = (col: number): number => (col - (BB_COLS + 1) / 2) * P;

/** Posición local (mm) de un agujero, sobre la superficie del protoboard. */
export function holeMM(hole: string): { x: number; z: number } {
  const m = /^(\d+)([a-j])$/.exec(hole);
  if (m) return { x: colX(Number(m[1])), z: ROW_Z[m[2]] };
  const r = /^(R[TB][+-]):(\d+)$/.exec(hole)!;
  return { x: colX(Number(r[2])), z: RAIL_Z[r[1]] };
}

export function allHoles(): string[] {
  const out: string[] = [];
  for (let c = 1; c <= BB_COLS; c++) {
    for (const r of [...TOP_ROWS, ...BOTTOM_ROWS]) out.push(`${c}${r}`);
    for (const rail of RAILS) if (railHasCol(c)) out.push(`${rail}:${c}`);
  }
  return out;
}

/** Dimensiones reales de cuerpo según potencia (mm). */
function bodyDims(spec: ResistorSpec): { len: number; dia: number; lead: number } {
  const metal = techOf(spec) === "metal";
  switch (spec.power) {
    case 0.25:
      return { len: metal ? 6.3 : 6.0, dia: metal ? 2.4 : 2.3, lead: 0.6 };
    case 0.5:
      return { len: 9.0, dia: 3.2, lead: 0.6 };
    case 1:
      return { len: 11.0, dia: 4.5, lead: 0.8 };
    case 2:
      return { len: 15.0, dia: 5.0, lead: 0.8 };
  }
}

/**
 * Ubicación de las bandas como fracción del largo del cuerpo (0 = un extremo, 1 = el otro):
 * la primera cifra sobre el extremo abultado, las cifras y el multiplicador juntos, y la
 * tolerancia separada cerca del otro extremo. Todas del mismo ancho.
 */
export const BAND_LAYOUT = {
  4: { pos: [0.2, 0.33, 0.46, 0.8], width: 0.075 },
  5: { pos: [0.18, 0.29, 0.4, 0.51, 0.81], width: 0.065 },
} as const;

/**
 * Perfil "hueso" del cuerpo (extremos abultados), con UV.y proporcional a la posición axial.
 * LatheGeometry reparte la V según el índice de cada punto del perfil; como los puntos no están
 * equiespaciados, eso estiraba las bandas del centro. Acá se recalcula por largo real.
 */
export function resistorBodyGeometry(rMM: number, lenMM: number): THREE.LatheGeometry {
  const r = rMM;
  const L = lenMM;
  const pts = [
    [0, 0],
    [r * 0.55, 0],
    [r * 0.95, 0.06 * L],
    [r, 0.16 * L],
    [r * 0.86, 0.26 * L],
    [r * 0.86, 0.74 * L],
    [r, 0.84 * L],
    [r * 0.95, 0.94 * L],
    [r * 0.55, L],
    [0, L],
  ];
  const prof = pts.map(([x, y]) => new THREE.Vector2(x * MM, (y - L / 2) * MM));
  const geo = new THREE.LatheGeometry(prof, 32);
  const pos = geo.getAttribute("position");
  const uv = geo.getAttribute("uv");
  for (let i = 0; i < pos.count; i++) uv.setY(i, (pos.getY(i) / MM + L / 2) / L);
  uv.needsUpdate = true;
  return geo;
}

function bandTexture(spec: ResistorSpec, burned: boolean): THREE.CanvasTexture {
  const { canvas, ctx, tex } = canvasTexture(64, 256);
  const metal = techOf(spec) === "metal";
  ctx.fillStyle = burned ? "#2a2018" : metal ? "#79a9d6" : "#d8bf8f";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  if (!burned) {
    const bands = colorBands(spec.nominal, spec.tolerance);
    const { pos, width } = BAND_LAYOUT[bands.length as 4 | 5];
    bands.forEach((b, i) => {
      ctx.fillStyle = b.hex;
      // flipY: la fila 0 del canvas es V = 1, así que la fracción axial p va en 1 − p
      const y0 = (1 - pos[i] - width / 2) * canvas.height;
      ctx.fillRect(0, y0, canvas.width, width * canvas.height);
    });
  } else {
    ctx.fillStyle = "rgba(0,0,0,0.6)";
    for (let i = 0; i < 40; i++) ctx.fillRect(Math.random() * 64, Math.random() * 256, 6, 10);
  }
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

export interface PickHole {
  hole: string;
  world: THREE.Vector3;
}

export class Breadboard3D {
  readonly group = new THREE.Group();
  readonly board: THREE.Mesh;
  private readonly parts = new THREE.Group();
  private readonly resistorObjs = new Map<string, { group: THREE.Group; key: string; def: ResistorDef }>();
  readonly jumperObjs = new Map<string, { wire: THREE.Group; ghost: THREE.Mesh; hit: THREE.Mesh; def: JumperDef }>();
  readonly marker: THREE.Mesh;
  private smoke: THREE.Points;
  private smokeData: { pos: THREE.Vector3; vel: THREE.Vector3; life: number }[] = [];
  private smokeSources: THREE.Vector3[] = [];

  constructor() {
    const top = this.makeTopTexture();
    const side = std("#efece3", 0.75);
    const topMat = new THREE.MeshStandardMaterial({ map: top, roughness: 0.7 });
    this.board = new THREE.Mesh(new THREE.BoxGeometry(BB_W * MM, BB_H * MM, BB_D * MM), [side, side, topMat, side, side, side]);
    this.board.position.y = (BB_H / 2) * MM;
    tag(this.board, "breadboard");
    this.group.add(this.board);
    shadows(this.board, true, true);
    this.group.add(this.parts);

    this.marker = new THREE.Mesh(
      new THREE.RingGeometry(1.0 * MM, 1.6 * MM, 24),
      new THREE.MeshBasicMaterial({ color: "#2ef2ff", transparent: true, opacity: 0.95, depthTest: false }),
    );
    this.marker.rotation.x = -Math.PI / 2;
    this.marker.renderOrder = 10;
    this.marker.visible = false;
    this.group.add(this.marker);

    const g = new THREE.BufferGeometry();
    g.setAttribute("position", new THREE.BufferAttribute(new Float32Array(300 * 3), 3));
    const puff = canvasTexture(64, 64);
    const grd = puff.ctx.createRadialGradient(32, 32, 0, 32, 32, 32);
    grd.addColorStop(0, "rgba(255,255,255,0.9)");
    grd.addColorStop(0.5, "rgba(255,255,255,0.35)");
    grd.addColorStop(1, "rgba(255,255,255,0)");
    puff.ctx.fillStyle = grd;
    puff.ctx.fillRect(0, 0, 64, 64);
    this.smoke = new THREE.Points(
      g,
      new THREE.PointsMaterial({ color: "#d9d9d9", map: puff.tex, size: 13 * MM, transparent: true, opacity: 0.6, depthWrite: false }),
    );
    this.smoke.frustumCulled = false;
    this.group.add(this.smoke);
  }

  private makeTopTexture(): THREE.CanvasTexture {
    const pxmm = 24;
    const { canvas, ctx, tex } = canvasTexture(Math.round(BB_W * pxmm), Math.round(BB_D * pxmm));
    const X = (mm: number) => (mm + BB_W / 2) * pxmm;
    const Z = (mm: number) => (mm + BB_D / 2) * pxmm;
    ctx.fillStyle = "#f4f2ea";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // canal central
    ctx.fillStyle = "#d9d5c9";
    ctx.fillRect(0, Z(-1.3), canvas.width, 2.6 * pxmm);
    ctx.fillStyle = "#c8c3b5";
    ctx.fillRect(0, Z(-0.5), canvas.width, 1.0 * pxmm);
    // líneas de rieles
    const line = (z: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(X(colX(1) - 2), Z(z) - 0.25 * pxmm, (colX(BB_COLS) - colX(1) + 4) * pxmm, 0.5 * pxmm);
    };
    line(-25.0, "#2b5fc9");
    line(-18.2, "#d23b2b");
    line(18.2, "#2b5fc9");
    line(25.0, "#d23b2b");
    text(ctx, "−", X(-BB_W / 2 + 2), Z(-22.86), 3 * pxmm, "#2b5fc9");
    text(ctx, "+", X(-BB_W / 2 + 2), Z(-20.32), 3 * pxmm, "#d23b2b");
    text(ctx, "−", X(-BB_W / 2 + 2), Z(20.32), 3 * pxmm, "#2b5fc9");
    text(ctx, "+", X(-BB_W / 2 + 2), Z(22.86), 3 * pxmm, "#d23b2b");
    // agujeros
    const hole = (x: number, z: number) => {
      const s = 1.05 * pxmm;
      ctx.fillStyle = "#3b3a36";
      ctx.fillRect(X(x) - s / 2, Z(z) - s / 2, s, s);
      ctx.fillStyle = "#8f8a7d";
      ctx.fillRect(X(x) - s / 2, Z(z) - s / 2, s, s * 0.22);
    };
    for (let c = 1; c <= BB_COLS; c++) {
      for (const r of [...TOP_ROWS, ...BOTTOM_ROWS]) hole(colX(c), ROW_Z[r]);
      if (railHasCol(c)) for (const rail of RAILS) hole(colX(c), RAIL_Z[rail]);
      if (c === 1 || c % 5 === 0) {
        text(ctx, String(c), X(colX(c)), Z(-16.4), 1.6 * pxmm, "#5c5a52", "center", 500);
        text(ctx, String(c), X(colX(c)), Z(16.4), 1.6 * pxmm, "#5c5a52", "center", 500);
      }
    }
    for (const r of [...TOP_ROWS, ...BOTTOM_ROWS]) {
      text(ctx, r, X(colX(1) - 2.6), Z(ROW_Z[r]), 1.5 * pxmm, "#5c5a52", "center", 500);
      text(ctx, r, X(colX(BB_COLS) + 2.6), Z(ROW_Z[r]), 1.5 * pxmm, "#5c5a52", "center", 500);
    }
    tex.anisotropy = 16;
    return tex;
  }

  /** Posición local (m) de la boca del agujero. */
  holeLocal(hole: string, depthMM = 0): THREE.Vector3 {
    const h = holeMM(hole);
    return new THREE.Vector3(h.x * MM, (BB_H - depthMM) * MM, h.z * MM);
  }
  holeWorld(hole: string, depthMM = 0): THREE.Vector3 {
    return this.group.localToWorld(this.holeLocal(hole, depthMM));
  }

  /** Agujero más cercano a un punto del mundo (o null si está lejos). */
  nearestHole(world: THREE.Vector3, maxMM = 1.8): string | null {
    const p = this.group.worldToLocal(world.clone());
    let best: string | null = null;
    let bd = maxMM;
    for (const h of allHoles()) {
      const m = holeMM(h);
      const d = Math.hypot(m.x - p.x / MM, m.z - p.z / MM);
      if (d < bd) {
        bd = d;
        best = h;
      }
    }
    return best;
  }

  showMarker(hole: string | null): void {
    if (!hole) {
      this.marker.visible = false;
      return;
    }
    this.marker.visible = true;
    this.marker.position.copy(this.holeLocal(hole)).add(new THREE.Vector3(0, 0.05 * MM, 0));
  }

  build(circuit: CircuitDef, parts: Map<string, ResistorPart>): void {
    this.parts.clear();
    this.resistorObjs.clear();
    this.jumperObjs.clear();
    for (const r of circuit.resistors) this.addResistor(r, parts.get(r.id)!);
    for (const j of circuit.jumpers) this.addJumper(j);
  }

  private addResistor(def: ResistorDef, part: ResistorPart): void {
    const group = new THREE.Group();
    this.makeResistorMeshes(group, def, part.spec, part.state === "quemado");
    tag(group, `resistor:${def.id}`);
    this.parts.add(group);
    this.resistorObjs.set(def.id, { group, key: this.keyOf(part), def });
  }

  private keyOf(part: ResistorPart): string {
    return `${part.spec.nominal}|${part.spec.tolerance}|${part.spec.power}|${part.state === "quemado"}`;
  }

  private makeResistorMeshes(group: THREE.Group, def: ResistorDef, spec: ResistorSpec, burned: boolean): void {
    const a = this.holeLocal(def.a, 0);
    const b = this.holeLocal(def.b, 0);
    const dims = bodyDims(spec);
    const span = a.distanceTo(b) / MM;
    const r = dims.dia / 2;
    const h = (BB_H + r + 0.8) * MM; // altura del eje (la placa mide BB_H)
    const dir = b.clone().sub(a).normalize();
    const mid = a.clone().add(b).multiplyScalar(0.5);
    const bodyLen = Math.min(dims.len, span - 2.4);

    const L = bodyLen;
    const bodyGeo = resistorBodyGeometry(r, L);
    const mat = new THREE.MeshStandardMaterial({ map: bandTexture(spec, burned), roughness: 0.55 });
    const body = new THREE.Mesh(bodyGeo, mat);
    body.position.copy(mid).setY(h);
    body.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir);
    group.add(body);

    // patas de cobre estañado
    const leadMat = std("#c9ccd1", 0.32, 0.9);
    const endA = mid.clone().addScaledVector(dir, (-L / 2) * MM).setY(h);
    const endB = mid.clone().addScaledVector(dir, (L / 2) * MM).setY(h);
    const below = (BB_H - 3) * MM;
    for (const [hole, end] of [
      [a, endA],
      [b, endB],
    ] as const) {
      const path = roundedPath([hole.clone().setY(below), hole.clone().setY(h), end], 0.9 * MM);
      const tube = new THREE.Mesh(new THREE.TubeGeometry(path, 24, (dims.lead / 2) * MM, 8), leadMat);
      group.add(tube);
    }
    // zona de selección más gruesa e invisible
    const hitPath = roundedPath([a.clone().setY((BB_H + 1) * MM), a.clone().setY(h), b.clone().setY(h), b.clone().setY((BB_H + 1) * MM)], 0.5 * MM);
    const hit = new THREE.Mesh(new THREE.TubeGeometry(hitPath, 24, (r + 1.2) * MM, 8), new THREE.MeshBasicMaterial({ visible: false }));
    group.add(hit);
    shadows(group, true, false);
  }

  /** Reconstruye un resistor si cambió su valor, potencia o estado. */
  syncResistor(part: ResistorPart): void {
    const o = this.resistorObjs.get(part.id);
    if (!o) return;
    const key = this.keyOf(part);
    if (key === o.key) return;
    o.group.clear();
    this.makeResistorMeshes(o.group, o.def, part.spec, part.state === "quemado");
    tag(o.group, `resistor:${part.id}`);
    o.key = key;
  }

  resistorCenterWorld(id: string): THREE.Vector3 | null {
    const o = this.resistorObjs.get(id);
    if (!o) return null;
    const a = this.holeLocal(o.def.a);
    const b = this.holeLocal(o.def.b);
    return this.group.localToWorld(a.add(b).multiplyScalar(0.5).setY((BB_H + 4) * MM));
  }
  resistorHoles(id: string): [string, string] | null {
    const o = this.resistorObjs.get(id);
    return o ? [o.def.a, o.def.b] : null;
  }

  private addJumper(def: JumperDef): void {
    const a = this.holeLocal(def.a);
    const b = this.holeLocal(def.b);
    const arc = (def.arc ?? 1.6) * MM;
    const below = (BB_H - 3) * MM;
    const lift = 1.5 * MM;
    const pts = [a.clone().setY(below), a.clone().setY(BB_H * MM + lift + arc), b.clone().setY(BB_H * MM + lift + arc), b.clone().setY(below)];
    const path = roundedPath(pts, 1.6 * MM + arc * 0.4);
    const wire = new THREE.Group();
    const ins = new THREE.Mesh(new THREE.TubeGeometry(path, 64, 0.6 * MM, 10), std(def.color, 0.45));
    wire.add(ins);
    // puntas peladas
    const tinMat = std("#cfd2d6", 0.3, 0.9);
    for (const h of [a, b]) {
      const tip = new THREE.Mesh(new THREE.CylinderGeometry(0.33 * MM, 0.33 * MM, 5.5 * MM, 8), tinMat);
      tip.position.copy(h).setY(BB_H * MM - 0.5 * MM);
      wire.add(tip);
    }
    shadows(wire, true, false);
    const ghost = new THREE.Mesh(
      ins.geometry,
      new THREE.MeshBasicMaterial({ color: def.color, transparent: true, opacity: 0.22, depthWrite: false }),
    );
    ghost.visible = false;
    const hit = new THREE.Mesh(new THREE.TubeGeometry(path, 32, 1.8 * MM, 6), new THREE.MeshBasicMaterial({ visible: false }));
    const g = new THREE.Group();
    g.add(wire, ghost, hit);
    tag(g, `jumper:${def.id}`);
    this.parts.add(g);
    this.jumperObjs.set(def.id, { wire, ghost, hit, def });
  }

  setJumper(id: string, present: boolean): void {
    const o = this.jumperObjs.get(id);
    if (!o) return;
    o.wire.visible = present;
    o.ghost.visible = !present;
  }

  jumperMidWorld(id: string): THREE.Vector3 | null {
    const o = this.jumperObjs.get(id);
    if (!o) return null;
    const a = this.holeLocal(o.def.a);
    const b = this.holeLocal(o.def.b);
    // punto más alto del arco del cable (donde conviene hacer clic)
    return this.group.localToWorld(a.add(b).multiplyScalar(0.5).setY((BB_H + 1.5 + (o.def.arc ?? 1.6)) * MM));
  }

  /** Humo para resistores sobrecalentados. */
  setSmoke(sources: THREE.Vector3[]): void {
    this.smokeSources = sources.map((s) => this.group.worldToLocal(s.clone()));
  }

  tick(dt: number): void {
    for (const s of this.smokeSources) {
      if (this.smokeData.length < 300 && Math.random() < dt * 70) {
        this.smokeData.push({
          pos: s.clone(),
          vel: new THREE.Vector3((Math.random() - 0.5) * 0.006, 0.018 + Math.random() * 0.012, (Math.random() - 0.5) * 0.006),
          life: 1.6 + Math.random(),
        });
      }
    }
    this.smokeData = this.smokeData.filter((p) => (p.life -= dt) > 0);
    const arr = this.smoke.geometry.getAttribute("position") as THREE.BufferAttribute;
    for (let i = 0; i < 300; i++) {
      const p = this.smokeData[i];
      if (p) {
        p.pos.addScaledVector(p.vel, dt);
        p.vel.x += (Math.random() - 0.5) * 0.004 * dt;
        arr.setXYZ(i, p.pos.x, p.pos.y, p.pos.z);
      } else arr.setXYZ(i, 0, -10, 0);
    }
    arr.needsUpdate = true;
  }
}
