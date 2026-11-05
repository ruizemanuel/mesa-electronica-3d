import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { PsuPost } from "../sim/bench";
import type { BenchSupply } from "../sim/psu";
import { drawSevenSeg } from "./sevenseg";
import { MM, canvasTexture, mmMapper, roundRect, shadows, std, tag, text, type CanvasTex } from "./util";

export const PSU_W = 130;
export const PSU_H = 150;
export const PSU_D = 250;
const PANEL_W = 124;
const PANEL_H = 144;
const DISP = { y: 42, w: 46, h: 21 };
const DISP_X = { V: -29, A: 29 };
const KNOB_Y = -12;
const KNOB_X = { V: -29, A: 29 };
const POST_Y = -50;
const POST_X: Record<PsuPost, number> = { "psu-": -24, psuGnd: 0, "psu+": 24 };
const OUT = { x: 33, y: 17 };

export class Psu3D {
  readonly group = new THREE.Group();
  private readonly disp: Record<"V" | "A", CanvasTex>;
  private readonly knobs: Record<"V" | "A", THREE.Group> = { V: new THREE.Group(), A: new THREE.Group() };
  private readonly ledCV: THREE.MeshStandardMaterial;
  private readonly ledCC: THREE.MeshStandardMaterial;
  private readonly ledOut: THREE.MeshStandardMaterial;
  private readonly outBtn: THREE.Mesh;
  private lastKey = "";
  readonly front = PSU_D / 2;

  constructor() {
    const caseMesh = new THREE.Mesh(new RoundedBoxGeometry(PSU_W * MM, PSU_H * MM, PSU_D * MM, 4, 5 * MM), std("#8d949c", 0.42, 0.55));
    caseMesh.position.y = (PSU_H / 2) * MM;
    tag(caseMesh, "psu:body");
    this.group.add(caseMesh);
    // patas de goma
    for (const [x, z] of [
      [-50, -100],
      [50, -100],
      [-50, 100],
      [50, 100],
    ]) {
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(6 * MM, 6 * MM, 4 * MM, 16), std("#151515", 0.9));
      foot.position.set(x * MM, 2 * MM, z * MM);
      this.group.add(foot);
    }
    this.group.children[0].position.y += 3 * MM;
    const panelZ = (PSU_D / 2 + 0.2) * MM;
    const yc = (PSU_H / 2 + 3) * MM;
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W * MM, PANEL_H * MM), new THREE.MeshStandardMaterial({ map: this.makePanelTexture(), roughness: 0.55 }));
    panel.position.set(0, yc, panelZ);
    tag(panel, "psu:body");
    this.group.add(panel);

    this.disp = { V: canvasTexture(368, 168), A: canvasTexture(368, 168) };
    for (const k of ["V", "A"] as const) {
      const m = new THREE.Mesh(new THREE.PlaneGeometry(DISP.w * MM, DISP.h * MM), new THREE.MeshBasicMaterial({ map: this.disp[k].tex, toneMapped: false }));
      m.position.set(DISP_X[k] * MM, yc + DISP.y * MM, panelZ + 0.3 * MM);
      tag(m, "psu:display");
      this.group.add(m);
    }

    const led = (color: string, x: number, y: number) => {
      const mat = new THREE.MeshStandardMaterial({ color: "#2a2a2a", emissive: color, emissiveIntensity: 0, roughness: 0.3 });
      const m = new THREE.Mesh(new THREE.SphereGeometry(1.8 * MM, 16, 8), mat);
      m.scale.z = 0.5;
      m.position.set(x * MM, yc + y * MM, panelZ + 0.6 * MM);
      this.group.add(m);
      return mat;
    };
    this.ledCV = led("#3cff5a", -42, 17);
    this.ledCC = led("#ff3a2a", -22, 17);
    this.ledOut = led("#3cff5a", 19, 17);

    this.outBtn = new THREE.Mesh(new RoundedBoxGeometry(18 * MM, 9 * MM, 5 * MM, 3, 1.5 * MM), std("#d6d9dd", 0.45));
    this.outBtn.position.set(OUT.x * MM, yc + OUT.y * MM, panelZ + 2 * MM);
    tag(this.outBtn, "psu:output");
    this.group.add(this.outBtn);

    for (const k of ["V", "A"] as const) {
      const g = this.knobs[k];
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(13 * MM, 13 * MM, 3 * MM, 40), std("#1d1f22", 0.5));
      skirt.rotation.x = Math.PI / 2;
      skirt.position.z = 1.5 * MM;
      const capGeo = new THREE.CylinderGeometry(10 * MM, 11 * MM, 13 * MM, 40);
      const cap = new THREE.Mesh(capGeo, std("#2b2e33", 0.38));
      cap.rotation.x = Math.PI / 2;
      cap.position.z = 9 * MM;
      const top = new THREE.Mesh(new THREE.CircleGeometry(9.6 * MM, 40), std("#9aa1aa", 0.3, 0.8));
      top.position.z = 15.6 * MM;
      const mark = new THREE.Mesh(new THREE.BoxGeometry(1.4 * MM, 7 * MM, 0.5 * MM), new THREE.MeshBasicMaterial({ color: "#ffffff" }));
      mark.position.set(0, 5.5 * MM, 15.8 * MM);
      g.add(skirt, cap, top, mark);
      g.position.set(KNOB_X[k] * MM, yc + KNOB_Y * MM, panelZ);
      tag(g, `psu:knob:${k}`);
      this.group.add(g);
    }

    for (const p of Object.keys(POST_X) as PsuPost[]) {
      const color = p === "psu+" ? "#c62a22" : p === "psu-" ? "#1a1a1a" : "#2c8a3c";
      const g = new THREE.Group();
      const nut = new THREE.Mesh(new THREE.CylinderGeometry(6.5 * MM, 6.5 * MM, 3 * MM, 6), std("#b9bdc2", 0.3, 0.9));
      nut.rotation.x = Math.PI / 2;
      nut.position.z = 1.5 * MM;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(5.5 * MM, 6 * MM, 13 * MM, 24), std(color, 0.45));
      cap.rotation.x = Math.PI / 2;
      cap.position.z = 9.5 * MM;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(2 * MM, 16), new THREE.MeshBasicMaterial({ color: "#0a0a0a" }));
      hole.position.z = 16.05 * MM;
      g.add(nut, cap, hole);
      g.position.set(POST_X[p] * MM, yc + POST_Y * MM, panelZ);
      tag(g, `psu:post:${p}`);
      this.group.add(g);
    }
    // interruptor de encendido (decorativo)
    const sw = new THREE.Mesh(new RoundedBoxGeometry(10 * MM, 14 * MM, 6 * MM, 2, 1.5 * MM), std("#1b1b1b", 0.6));
    sw.position.set(-50 * MM, yc + POST_Y * MM, panelZ + 2 * MM);
    sw.rotation.x = -0.15;
    this.group.add(sw);
    shadows(this.group, true, true);
  }

  private makePanelTexture(): THREE.CanvasTexture {
    const { canvas, ctx, tex } = canvasTexture(992, 1152);
    const M = mmMapper(canvas, PANEL_W, PANEL_H);
    ctx.fillStyle = "#1f2226";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#121315";
    roundRect(ctx, M.x(-PANEL_W / 2 + 4), M.y(DISP.y + DISP.h / 2 + 4), M.s(PANEL_W - 8), M.s(DISP.h + 8), M.s(2));
    ctx.fill();
    text(ctx, "FUENTE DC REGULADA", M.x(-56), M.y(64), M.s(3.6), "#e8eaed", "left", 800);
    text(ctx, "0–30 V · 0–3 A", M.x(56), M.y(64), M.s(3.4), "#f0b429", "right", 700);
    text(ctx, "V", M.x(DISP_X.V + DISP.w / 2 + 2.2), M.y(DISP.y - 5), M.s(4), "#ff5a4a", "center", 800);
    text(ctx, "A", M.x(DISP_X.A + DISP.w / 2 + 2.2), M.y(DISP.y - 5), M.s(4), "#4cff6a", "center", 800);
    text(ctx, "CV", M.x(-42), M.y(10.5), M.s(3), "#c9ccd1");
    text(ctx, "CC", M.x(-22), M.y(10.5), M.s(3), "#c9ccd1");
    text(ctx, "OUTPUT", M.x(OUT.x), M.y(OUT.y - 8), M.s(2.8), "#c9ccd1");
    text(ctx, "VOLTAGE", M.x(KNOB_X.V), M.y(KNOB_Y - 17), M.s(3), "#e8eaed", "center", 700);
    text(ctx, "CURRENT", M.x(KNOB_X.A), M.y(KNOB_Y - 17), M.s(3), "#e8eaed", "center", 700);
    // escala alrededor de las perillas
    for (const k of ["V", "A"] as const) {
      for (let i = 0; i <= 10; i++) {
        const a = THREE.MathUtils.degToRad(225 - i * 27);
        const r0 = 14.2;
        const r1 = i % 5 === 0 ? 16.4 : 15.4;
        ctx.strokeStyle = "#8e939b";
        ctx.lineWidth = M.s(0.5);
        ctx.beginPath();
        ctx.moveTo(M.x(KNOB_X[k] + Math.cos(a) * r0), M.y(KNOB_Y + Math.sin(a) * r0));
        ctx.lineTo(M.x(KNOB_X[k] + Math.cos(a) * r1), M.y(KNOB_Y + Math.sin(a) * r1));
        ctx.stroke();
      }
    }
    text(ctx, "+", M.x(POST_X["psu+"]), M.y(POST_Y + 10), M.s(5), "#ff5a4a", "center", 800);
    text(ctx, "GND", M.x(POST_X.psuGnd), M.y(POST_Y + 10), M.s(3), "#4cd964", "center", 800);
    text(ctx, "−", M.x(POST_X["psu-"]), M.y(POST_Y + 10), M.s(5), "#e8eaed", "center", 800);
    text(ctx, "POWER", M.x(-50), M.y(POST_Y + 11), M.s(2.4), "#c9ccd1");
    return tex;
  }

  /** Punto de contacto para una punta de prueba (centro del borne) y su normal hacia afuera. */
  postWorld(p: PsuPost): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    this.group.updateMatrixWorld(true);
    const yc = (PSU_H / 2 + 3) * MM;
    const pos = this.group.localToWorld(new THREE.Vector3(POST_X[p] * MM, yc + POST_Y * MM, (PSU_D / 2 + 16) * MM));
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(this.group.matrixWorld);
    return { pos, dir };
  }
  /** Punto donde nace el cable de la fuente al protoboard (atrás del borne). */
  postCableStart(p: PsuPost): THREE.Vector3 {
    const yc = (PSU_H / 2 + 3) * MM;
    return this.group.localToWorld(new THREE.Vector3(POST_X[p] * MM, yc + POST_Y * MM - 3 * MM, (PSU_D / 2 + 12) * MM));
  }

  pressOutput(): void {
    this.outBtn.position.z -= 1.5 * MM;
    setTimeout(() => (this.outBtn.position.z += 1.5 * MM), 150);
  }

  update(psu: BenchSupply, now: number): void {
    const vTurns = (psu.vset / psu.vMax) * Math.PI * 2 * 5; // perilla multivuelta
    const aTurns = (psu.iset / psu.iMax) * Math.PI * 2 * 5;
    this.knobs.V.rotation.z = -vTurns;
    this.knobs.A.rotation.z = -aTurns;
    const on = psu.output;
    this.ledCV.emissiveIntensity = on && psu.mode === "CV" ? 2.2 : 0;
    this.ledCC.emissiveIntensity = on && psu.mode === "CC" ? 2.2 : 0;
    this.ledOut.emissiveIntensity = on ? 2.2 : 0;
    const d = psu.display(now);
    const blink = d.showingSet && on ? Math.floor(now * 4) % 2 === 0 : true;
    const key = `${d.v}|${d.a}|${blink}|${on}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.drawDisplay("V", blink ? d.v : "", "#ff3b2b", "rgba(255,60,40,0.07)");
    this.drawDisplay("A", blink ? d.a : "", "#3cff5a", "rgba(60,255,90,0.07)");
  }

  private drawDisplay(k: "V" | "A", value: string, on: string, off: string): void {
    const { ctx, canvas, tex } = this.disp[k];
    ctx.fillStyle = "#0b0b0c";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.shadowColor = on;
    ctx.shadowBlur = 10;
    drawSevenSeg(ctx, value, 4, 22, 22, 64, 124, 20, { on, off, slant: 0.06, thickness: 12 });
    ctx.shadowBlur = 0;
    tex.needsUpdate = true;
  }
}
