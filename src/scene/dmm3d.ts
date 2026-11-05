import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { DIAL_LABEL, DIAL_POSITIONS, type Dial, type DmmDisplay, type Jack } from "../sim/dmm";
import { drawSevenSeg } from "./sevenseg";
import { MM, canvasTexture, mmMapper, roundRect, shadows, std, tag, text, type CanvasTex } from "./util";

const FACE_W = 78;
const FACE_H = 170;
const LCD = { x: 0, y: 50, w: 64, h: 34 };
const DIAL = { x: 0, y: -17, r: 17 };
export const DMM_BUTTONS = ["RANGE", "HOLD", "REL"] as const;
export type DmmButton = (typeof DMM_BUTTONS)[number];
const BTN_Y = 24;
const BTN_X: Record<DmmButton, number> = { RANGE: -22, HOLD: 0, REL: 22 };
export type JackId = Jack | "COM";
const JACK_Y = -66;
const JACK_X: Record<JackId, number> = { A: -27, mA: -9, COM: 9, VOhm: 27 };
const DEPTH = 52;

export const dialAngle = (d: Dial): number => THREE.MathUtils.degToRad(126 - 36 * DIAL_POSITIONS.indexOf(d));

export class Dmm3D {
  readonly group = new THREE.Group();
  /** Cuerpo inclinado (el grupo externo se apoya en la mesa). */
  readonly body = new THREE.Group();
  private readonly knob = new THREE.Group();
  private readonly lcd: CanvasTex;
  private readonly lcdMat: THREE.MeshStandardMaterial;
  private readonly buttons = new Map<DmmButton, THREE.Mesh>();
  private readonly plugs: Record<"red" | "black", THREE.Group>;
  private lastLcdKey = "";
  private knobTarget = 0;
  readonly tilt = 0.42;

  constructor() {
    this.group.add(this.body);
    // funda de goma
    const holster = new THREE.Mesh(new RoundedBoxGeometry(92 * MM, 186 * MM, DEPTH * MM, 5, 9 * MM), std("#e3a51b", 0.82));
    tag(holster, "dmm:body");
    this.body.add(holster);
    // frente
    const face = this.makeFaceTexture();
    const faceMesh = new THREE.Mesh(new THREE.PlaneGeometry(FACE_W * MM, FACE_H * MM), new THREE.MeshStandardMaterial({ map: face, roughness: 0.6 }));
    faceMesh.position.z = (DEPTH / 2 + 0.15) * MM;
    tag(faceMesh, "dmm:body");
    this.body.add(faceMesh);

    // LCD
    this.lcd = canvasTexture(512, 272);
    this.lcdMat = new THREE.MeshStandardMaterial({
      map: this.lcd.tex,
      emissiveMap: this.lcd.tex,
      emissive: new THREE.Color("#ffffff"),
      emissiveIntensity: 0.32,
      roughness: 0.25,
    });
    const lcdMesh = new THREE.Mesh(new THREE.PlaneGeometry(LCD.w * MM, LCD.h * MM), this.lcdMat);
    lcdMesh.position.set(LCD.x * MM, LCD.y * MM, (DEPTH / 2 + 0.4) * MM);
    tag(lcdMesh, "dmm:lcd");
    this.body.add(lcdMesh);
    // vidrio
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry((LCD.w + 4) * MM, (LCD.h + 4) * MM),
      new THREE.MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.05, transmission: 0, transparent: true, opacity: 0.08, metalness: 0 }),
    );
    glass.position.set(LCD.x * MM, LCD.y * MM, (DEPTH / 2 + 0.9) * MM);
    tag(glass, "dmm:lcd");
    this.body.add(glass);

    // botones
    for (const b of DMM_BUTTONS) {
      const m = new THREE.Mesh(new RoundedBoxGeometry(15 * MM, 7 * MM, 3 * MM, 3, 1.2 * MM), std(b === "REL" ? "#3c6fd1" : "#4a4e55", 0.5));
      m.position.set(BTN_X[b] * MM, BTN_Y * MM, (DEPTH / 2 + 1.2) * MM);
      tag(m, `dmm:btn:${b}`);
      this.buttons.set(b, m);
      this.body.add(m);
    }

    // llave selectora
    const base = new THREE.Mesh(new THREE.CylinderGeometry(DIAL.r * MM, DIAL.r * MM, 3 * MM, 48), std("#26282c", 0.5));
    base.rotation.x = Math.PI / 2;
    this.knob.add(base);
    const grip = new THREE.Mesh(new RoundedBoxGeometry(32 * MM, 9 * MM, 8 * MM, 3, 2.5 * MM), std("#2f3237", 0.45));
    grip.rotation.z = Math.PI / 2;
    grip.position.z = 4 * MM;
    this.knob.add(grip);
    const pointer = new THREE.Mesh(new THREE.BoxGeometry(1.6 * MM, 11 * MM, 0.6 * MM), new THREE.MeshBasicMaterial({ color: "#f3f3f3" }));
    pointer.position.set(0, 9.5 * MM, 8.2 * MM);
    this.knob.add(pointer);
    this.knob.position.set(DIAL.x * MM, DIAL.y * MM, (DEPTH / 2 + 1.5) * MM);
    tag(this.knob, "dmm:dial");
    this.body.add(this.knob);

    // bornas
    for (const j of Object.keys(JACK_X) as JackId[]) {
      const color = j === "COM" ? "#1b1b1b" : "#c62a22";
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(4.6 * MM, 4.6 * MM, 2.5 * MM, 32), std(color, 0.5));
      ring.rotation.x = Math.PI / 2;
      ring.position.set(JACK_X[j] * MM, JACK_Y * MM, (DEPTH / 2 + 1.2) * MM);
      const hole = new THREE.Mesh(new THREE.CircleGeometry(2.2 * MM, 24), new THREE.MeshBasicMaterial({ color: "#050505" }));
      hole.position.set(JACK_X[j] * MM, JACK_Y * MM, (DEPTH / 2 + 2.5) * MM);
      const g = new THREE.Group();
      g.add(ring, hole);
      tag(g, j === "COM" ? "dmm:body" : `dmm:jack:${j}`);
      this.body.add(g);
    }
    // fichas banana
    this.plugs = { red: this.makePlug("#c8261f"), black: this.makePlug("#161616") };
    this.body.add(this.plugs.red, this.plugs.black);
    this.setPlug("black", "COM");
    this.setPlug("red", "VOhm");

    // apoyo trasero (pie rebatible)
    const stand = new THREE.Mesh(new THREE.BoxGeometry(60 * MM, 112 * MM, 3 * MM), std("#d39616", 0.8));
    stand.position.set(0, -10 * MM, (-DEPTH / 2 - 26) * MM);
    stand.rotation.x = 0.55;
    this.body.add(stand);

    this.body.rotation.x = -this.tilt;
    this.body.position.y = 95.5 * MM;
    shadows(this.group, true, true);
    this.drawLcd({ on: false } as DmmDisplay, true);
  }

  private makePlug(color: string): THREE.Group {
    const g = new THREE.Group();
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(3.6 * MM, 4.4 * MM, 22 * MM, 20), std(color, 0.55));
    boot.rotation.x = Math.PI / 2;
    boot.position.z = 13 * MM;
    g.add(boot);
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(4.0 * MM, 4.0 * MM, 2 * MM, 20), std(color, 0.4));
    ring.rotation.x = Math.PI / 2;
    ring.position.z = 3 * MM;
    g.add(ring);
    tag(g, color === "#161616" ? "dmm:plug:black" : "dmm:plug:red");
    return g;
  }

  setPlug(which: "red" | "black", jack: JackId): void {
    this.plugs[which].position.set(JACK_X[jack] * MM, JACK_Y * MM, (DEPTH / 2 + 1.5) * MM);
  }

  /** Extremo trasero de la ficha banana (donde nace el cable) y dirección de salida. */
  plugExit(which: "red" | "black"): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    this.group.updateMatrixWorld(true);
    const p = this.plugs[which];
    const pos = p.localToWorld(new THREE.Vector3(0, 0, 24 * MM));
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(this.body.matrixWorld);
    return { pos, dir };
  }

  /** ¿El clic sobre la perilla fue a la derecha (horario) o a la izquierda? */
  dialSide(world: THREE.Vector3): 1 | -1 {
    // en el marco del frente (no gira con la perilla)
    const p = this.body.worldToLocal(world.clone());
    return p.x >= DIAL.x * MM ? 1 : -1;
  }

  pressButton(b: DmmButton): void {
    const m = this.buttons.get(b)!;
    m.position.z = (DEPTH / 2 + 0.4) * MM;
    setTimeout(() => (m.position.z = (DEPTH / 2 + 1.2) * MM), 140);
  }

  update(display: DmmDisplay, dial: Dial, red: Jack, dt: number, time: number): void {
    this.knobTarget = dialAngle(dial) - Math.PI / 2;
    const cur = this.knob.rotation.z;
    this.knob.rotation.z = cur + (this.knobTarget - cur) * Math.min(1, dt * 18);
    this.setPlug("red", red);
    this.drawLcd(display, false, time);
  }

  private makeFaceTexture(): THREE.CanvasTexture {
    const { canvas, ctx, tex } = canvasTexture(780, 1700);
    const M = mmMapper(canvas, FACE_W, FACE_H);
    ctx.fillStyle = "#2a2c30";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // marco LCD
    ctx.fillStyle = "#16171a";
    roundRect(ctx, M.x(LCD.x - LCD.w / 2 - 3), M.y(LCD.y + LCD.h / 2 + 3), M.s(LCD.w + 6), M.s(LCD.h + 6), M.s(2.5));
    ctx.fill();
    text(ctx, "DM-6000", M.x(-36), M.y(74), M.s(4.2), "#f0b429", "left", 800);
    text(ctx, "TRUE RMS · 6000 CUENTAS", M.x(36), M.y(74), M.s(2.6), "#c9ccd1", "right", 600);
    // etiquetas de botones
    for (const b of DMM_BUTTONS) text(ctx, b === "REL" ? "REL Δ" : b, M.x(BTN_X[b]), M.y(BTN_Y + 7), M.s(2.8), "#d7dade");
    // escala de la llave
    ctx.strokeStyle = "#5a5f67";
    ctx.lineWidth = M.s(0.8);
    ctx.beginPath();
    ctx.arc(M.x(DIAL.x), M.y(DIAL.y), M.s(DIAL.r + 2.2), 0, Math.PI * 2);
    ctx.stroke();
    for (const d of DIAL_POSITIONS) {
      const a = dialAngle(d);
      const r0 = DIAL.r + 2.2;
      const r1 = DIAL.r + 4.2;
      ctx.strokeStyle = "#e6e8eb";
      ctx.lineWidth = M.s(0.7);
      ctx.beginPath();
      ctx.moveTo(M.x(DIAL.x + Math.cos(a) * r0), M.y(DIAL.y + Math.sin(a) * r0));
      ctx.lineTo(M.x(DIAL.x + Math.cos(a) * r1), M.y(DIAL.y + Math.sin(a) * r1));
      ctx.stroke();
      const rl = DIAL.r + 9.5;
      const color = d === "OFF" ? "#f0b429" : d === "mA" || d === "A" ? "#ff6b5e" : "#ffffff";
      text(ctx, DIAL_LABEL[d], M.x(DIAL.x + Math.cos(a) * rl), M.y(DIAL.y + Math.sin(a) * rl), M.s(3.4), color, "center", 700);
    }
    // bornas
    const jl: Record<JackId, [string, string]> = {
      A: ["10A", "MAX · FUSED"],
      mA: ["mA", "440mA FUSED"],
      COM: ["COM", ""],
      VOhm: ["VΩ·)))", "1000V MAX"],
    };
    for (const j of Object.keys(JACK_X) as JackId[]) {
      const [t1, t2] = jl[j];
      text(ctx, t1, M.x(JACK_X[j]), M.y(JACK_Y + 9.2), M.s(3.0), j === "COM" ? "#ffffff" : "#ff6b5e", "center", 800);
      if (t2) text(ctx, t2, M.x(JACK_X[j]), M.y(JACK_Y - 8.4), M.s(1.7), "#b8bcc2", "center", 600);
    }
    text(ctx, "CAT III 600V · CAT II 1000V", M.x(0), M.y(-80), M.s(2.2), "#8e939b", "center", 600);
    tex.anisotropy = 16;
    return tex;
  }

  private drawLcd(d: DmmDisplay, force = false, time = 0): void {
    const blink = d.leadAlert ? Math.floor(time * 3) % 2 === 0 : true;
    const key = JSON.stringify([d.on, d.text, d.unit, d.acdc, d.auto, d.hold, d.rel, d.continuity, Math.round(d.bar * 60), blink]);
    if (!force && key === this.lastLcdKey) return;
    this.lastLcdKey = key;
    const { ctx, canvas, tex } = this.lcd;
    const W = canvas.width;
    const H = canvas.height;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#a9b59a");
    bg.addColorStop(1, "#9aa78b");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    const on = "#131611";
    const off = "rgba(20,30,15,0.06)";
    if (!d.on) {
      tex.needsUpdate = true;
      return;
    }
    const ann = (s: string, x: number, lit: boolean, size = 26) => text(ctx, s, x, 26, size, lit ? on : off, "left", 800);
    ann("AUTO", 18, d.auto);
    ann("DC", 110, d.acdc === "DC");
    ann("AC", 160, d.acdc === "AC");
    ann("HOLD", 230, d.hold);
    ann("Δ", 330, d.rel, 30);
    ann("·)))", 380, d.continuity);
    // signo
    let txt = d.text;
    const neg = txt.startsWith("-");
    if (neg) txt = txt.slice(1);
    ctx.fillStyle = neg ? on : off;
    ctx.fillRect(18, 128, 34, 11);
    if (blink || !d.leadAlert) {
      const shown = txt === "OL" ? " OL " : txt === "LEAd" ? "LEAd" : txt;
      drawSevenSeg(ctx, shown, 4, 64, 54, 66, 128, 20, { on, off, slant: 0.1, thickness: 12 });
    }
    // unidad
    const unit = d.unit;
    text(ctx, unit, W - 18, 118, unit.length > 1 ? 46 : 54, on, "right", 800);
    // barra analógica
    const n = 60;
    const bx = 18;
    const bw = (W - 36) / n;
    for (let i = 0; i < n; i++) {
      const lit = i < Math.round(d.bar * n);
      ctx.fillStyle = lit ? on : off;
      const tall = i % 10 === 0 ? 16 : 10;
      ctx.fillRect(bx + i * bw, 234 - tall, bw * 0.6, tall);
    }
    text(ctx, "0", bx, 254, 15, on, "left", 700);
    text(ctx, d.range ? String(Math.round((d.range.maxCounts * d.range.res) / d.range.mult)) : "", W - 18, 254, 15, on, "right", 700);
    tex.needsUpdate = true;
  }
}
