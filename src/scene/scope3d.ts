import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import type { Oscilloscope } from "../sim/scope";
import { CH_COLOR, drawScope, graticuleRect } from "../ui/scopescreen";
import { MM, canvasTexture, mmMapper, roundRect, shadows, std, tag, text, type CanvasTex } from "./util";

/**
 * Osciloscopio digital de 2 canales a escala real (320 × 160 × 130 mm), al estilo de los de banco
 * actuales: pantalla de 7" a la izquierda y los controles agrupados a la derecha (horizontal,
 * vertical, disparo). Origen abajo al centro; el frente mira a +Z. Medidas en mm salvo indicación.
 */
export const SCOPE_W = 320;
export const SCOPE_H = 160;
export const SCOPE_D = 130;
const FEET = 4;
/** Altura del centro del frente sobre el origen (mm). */
const YC = FEET + SCOPE_H / 2;
const PANEL_W = 312;
const PANEL_H = 152;
/** Pantalla de 7" (5:3, 800×480): centro y tamaño en el frente. */
const SCREEN = { x: -70, y: 15, w: 152.4, h: 91.4 };
export const SCREEN_PX = { w: 800, h: 480 };

export type ScopeButton = "RUN" | "SINGLE" | "AUTO" | "CH1" | "CH2" | "CPL1" | "CPL2" | "MEASURE" | "CURSOR" | "CURSEL" | "TSRC" | "SLOPE" | "TMODE";
export type ScopeKnob = "tdiv" | "hpos" | "vdiv1" | "vdiv2" | "pos1" | "pos2" | "level" | "cursor";

const BTN: Record<ScopeButton, { x: number; y: number; w: number; label: string }> = {
  MEASURE: { x: 30, y: 66, w: 16, label: "MEASURE" },
  CURSOR: { x: 50, y: 66, w: 16, label: "CURSOR" },
  CURSEL: { x: 70, y: 66, w: 16, label: "A / B" },
  AUTO: { x: 104, y: 66, w: 16, label: "AUTOSET" },
  RUN: { x: 124, y: 66, w: 16, label: "RUN/STOP" },
  SINGLE: { x: 144, y: 66, w: 16, label: "SINGLE" },
  CH1: { x: 38, y: 12, w: 15, label: "CH1" },
  CH2: { x: 74, y: 12, w: 15, label: "CH2" },
  CPL1: { x: 38, y: -41, w: 15, label: "AC/DC" },
  CPL2: { x: 74, y: -41, w: 15, label: "AC/DC" },
  TSRC: { x: 108, y: -20, w: 15, label: "FUENTE" },
  SLOPE: { x: 126, y: -20, w: 15, label: "FLANCO" },
  TMODE: { x: 144, y: -20, w: 15, label: "MODO" },
};
const BTN_H = 7;

const KNOB: Record<ScopeKnob, { x: number; y: number; r: number; ring?: string; label: string; ly: number }> = {
  cursor: { x: 40, y: 40, r: 6.5, label: "MOVER CURSOR", ly: 30.5 },
  hpos: { x: 100, y: 40, r: 5.5, label: "POSICIÓN", ly: 31.5 },
  tdiv: { x: 130, y: 40, r: 9.5, label: "TIEMPO/DIV", ly: 27 },
  vdiv1: { x: 38, y: -8, r: 8, ring: CH_COLOR[0], label: "", ly: 0 },
  vdiv2: { x: 74, y: -8, r: 8, ring: CH_COLOR[1], label: "", ly: 0 },
  pos1: { x: 38, y: -27, r: 5, label: "", ly: 0 },
  pos2: { x: 74, y: -27, r: 5, label: "", ly: 0 },
  level: { x: 126, y: 6, r: 7, label: "NIVEL", ly: -4 },
};
const BNC_Y = -64;
const BNC_X = { 1: 38, 2: 74 } as const;
/** Largo del conector macho enchufado + su manguito, desde el frente (mm): ahí nace el cable. */
const PLUG_END = 31;

export class Scope3D {
  readonly group = new THREE.Group();
  readonly screen: HTMLCanvasElement;
  /** Tope de redibujos de la pantalla por segundo (bajarlo en equipos lentos). */
  maxFps = 25;
  private readonly scr: CanvasTex;
  private readonly knobs = new Map<ScopeKnob, THREE.Group>();
  private readonly buttons = new Map<ScopeButton, { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial; color: string }>();
  private readonly panelZ = (SCOPE_D / 2 + 0.2) * MM;
  private lastKey = "";
  private lastDraw = -Infinity;

  constructor() {
    // carcasa antracita con el frente un poco más claro
    const body = new THREE.Mesh(new RoundedBoxGeometry(SCOPE_W * MM, SCOPE_H * MM, SCOPE_D * MM, 4, 6 * MM), std("#34373c", 0.62, 0.15));
    body.position.y = YC * MM;
    tag(body, "scope:body");
    this.group.add(body);
    // tapa trasera más angosta (la fuente y los ventiladores)
    const back = new THREE.Mesh(new RoundedBoxGeometry((SCOPE_W - 50) * MM, (SCOPE_H - 30) * MM, 40 * MM, 3, 8 * MM), std("#2a2c30", 0.7, 0.1));
    back.position.set(0, (YC - 2) * MM, (-SCOPE_D / 2 - 14) * MM);
    tag(back, "scope:body");
    this.group.add(back);
    const footMat = std("#151515", 0.9);
    const footGeo = new THREE.CylinderGeometry(7 * MM, 7 * MM, FEET * MM, 16);
    for (const [x, z] of [
      [-130, -48],
      [130, -48],
      [-130, 50],
      [130, 50],
    ]) {
      const f = new THREE.Mesh(footGeo, footMat);
      f.position.set(x * MM, (FEET / 2) * MM, z * MM);
      this.group.add(f);
    }

    const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W * MM, PANEL_H * MM), new THREE.MeshStandardMaterial({ map: this.makePanelTexture(), roughness: 0.55 }));
    panel.position.set(0, YC * MM, this.panelZ);
    tag(panel, "scope:body");
    this.group.add(panel);

    // pantalla: el canvas es la textura (y se puede mostrar también en el panel de la página)
    this.scr = canvasTexture(SCREEN_PX.w, SCREEN_PX.h);
    this.screen = this.scr.canvas;
    this.scr.tex.anisotropy = 8;
    const screenMesh = new THREE.Mesh(new THREE.PlaneGeometry(SCREEN.w * MM, SCREEN.h * MM), new THREE.MeshBasicMaterial({ map: this.scr.tex, toneMapped: false }));
    screenMesh.position.set(SCREEN.x * MM, (YC + SCREEN.y) * MM, this.panelZ + 0.3 * MM);
    tag(screenMesh, "scope:screen");
    this.group.add(screenMesh);
    const glass = new THREE.Mesh(
      new THREE.PlaneGeometry((SCREEN.w + 3) * MM, (SCREEN.h + 3) * MM),
      new THREE.MeshPhysicalMaterial({ color: "#ffffff", roughness: 0.05, transparent: true, opacity: 0.06, metalness: 0 }),
    );
    glass.position.set(SCREEN.x * MM, (YC + SCREEN.y) * MM, this.panelZ + 0.8 * MM);
    tag(glass, "scope:screen");
    this.group.add(glass);

    // botones (cada uno con su material, para iluminarlo)
    for (const [b, d] of Object.entries(BTN) as [ScopeButton, (typeof BTN)[ScopeButton]][]) {
      const base = b === "CH1" ? "#6e6324" : b === "CH2" ? "#1f5966" : b === "RUN" ? "#3b4a3c" : b === "SINGLE" ? "#5a4a2e" : b === "AUTO" ? "#3c4a66" : "#4a4e55";
      const mat = new THREE.MeshStandardMaterial({ color: base, roughness: 0.45, emissive: "#000000", emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(d.w * MM, BTN_H * MM, 3 * MM, 2, 1.2 * MM), mat);
      mesh.position.set(d.x * MM, (YC + d.y) * MM, this.panelZ + 1.4 * MM);
      tag(mesh, `scope:btn:${b}`);
      this.buttons.set(b, { mesh, mat, color: "" });
      this.group.add(mesh);
    }
    // botones decorativos debajo de la pantalla (menú)
    const softMat = std("#3e4248", 0.5);
    const softGeo = new RoundedBoxGeometry(18 * MM, 6 * MM, 2.4 * MM, 2, 1 * MM);
    for (let i = 0; i < 5; i++) {
      const m = new THREE.Mesh(softGeo, softMat);
      m.position.set((-130 + i * 30) * MM, (YC - 40) * MM, this.panelZ + 1.1 * MM);
      tag(m, "scope:body");
      this.group.add(m);
    }

    // perillas
    const skirtMat = std("#1d1f22", 0.55);
    const capMat = std("#2b2e33", 0.38);
    const topMat = std("#8f969f", 0.3, 0.8);
    const markMat = new THREE.MeshBasicMaterial({ color: "#f2f2f2" });
    for (const [k, d] of Object.entries(KNOB) as [ScopeKnob, (typeof KNOB)[ScopeKnob]][]) {
      const g = new THREE.Group();
      const hgt = Math.min(11, 4 + d.r * 0.8);
      const skirt = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 1.18 * MM, d.r * 1.18 * MM, 2 * MM, 32), skirtMat);
      skirt.rotation.x = Math.PI / 2;
      skirt.position.z = 1 * MM;
      const cap = new THREE.Mesh(new THREE.CylinderGeometry(d.r * 0.95 * MM, d.r * MM, hgt * MM, 32), capMat);
      cap.rotation.x = Math.PI / 2;
      cap.position.z = (2 + hgt / 2) * MM;
      const top = new THREE.Mesh(new THREE.CircleGeometry(d.r * 0.88 * MM, 32), topMat);
      top.position.z = (2 + hgt + 0.05) * MM;
      const mark = new THREE.Mesh(new THREE.BoxGeometry(Math.max(0.8, d.r * 0.13) * MM, d.r * 0.55 * MM, 0.4 * MM), markMat);
      mark.position.set(0, d.r * 0.5 * MM, (2 + hgt + 0.2) * MM);
      g.add(skirt, cap, top, mark);
      if (d.ring) {
        const ring = new THREE.Mesh(new THREE.RingGeometry(d.r * 1.22 * MM, d.r * 1.42 * MM, 40), new THREE.MeshBasicMaterial({ color: d.ring }));
        ring.position.z = 0.15 * MM;
        g.add(ring);
      }
      g.position.set(d.x * MM, (YC + d.y) * MM, this.panelZ);
      tag(g, `scope:knob:${k}`);
      this.knobs.set(k, g);
      this.group.add(g);
    }

    // BNC de los canales (con la ficha de la punta enchufada), uno decorativo de disparo externo
    for (const ch of [1, 2] as const) {
      const g = this.makeBnc(CH_COLOR[ch - 1], true);
      g.position.set(BNC_X[ch] * MM, (YC + BNC_Y) * MM, this.panelZ);
      tag(g, `scope:bnc:${ch}`);
      this.group.add(g);
    }
    const ext = this.makeBnc(null, false);
    ext.position.set(112 * MM, (YC + BNC_Y) * MM, this.panelZ);
    tag(ext, "scope:body");
    this.group.add(ext);
    // terminales de compensación de la punta
    const metal = std("#c9ccd1", 0.3, 0.9);
    for (const [x, h] of [
      [134, 7],
      [146, 5],
    ]) {
      const t = new THREE.Mesh(new THREE.BoxGeometry(1.2 * MM, h * MM, 6 * MM), metal);
      t.position.set(x * MM, (YC + BNC_Y + h / 2 - 2) * MM, this.panelZ + 3 * MM);
      tag(t, "scope:body");
      this.group.add(t);
    }
    // encendido y USB (decorativos)
    const power = new THREE.Mesh(new THREE.CylinderGeometry(5 * MM, 5 * MM, 3 * MM, 24), std("#1b1b1b", 0.5));
    power.rotation.x = Math.PI / 2;
    power.position.set(-140 * MM, (YC + BNC_Y) * MM, this.panelZ + 1.5 * MM);
    const powerRing = new THREE.Mesh(new THREE.RingGeometry(5.2 * MM, 6.2 * MM, 24), new THREE.MeshBasicMaterial({ color: "#3cff5a" }));
    powerRing.position.set(-140 * MM, (YC + BNC_Y) * MM, this.panelZ + 0.1 * MM);
    const usb = new THREE.Mesh(new THREE.BoxGeometry(12 * MM, 4.5 * MM, 1 * MM), std("#0d0d0d", 0.8));
    usb.position.set(-114 * MM, (YC + BNC_Y) * MM, this.panelZ + 0.3 * MM);
    for (const m of [power, powerRing, usb]) {
      tag(m, "scope:body");
      this.group.add(m);
    }

    shadows(this.group, true, true);
    screenMesh.castShadow = false;
    glass.castShadow = false;
  }

  /** Conector BNC hembra del panel; con `plugged`, además la ficha macho de la punta con su manguito. */
  private makeBnc(ring: string | null, plugged: boolean): THREE.Group {
    const g = new THREE.Group();
    const metal = std("#c3c7cc", 0.25, 0.95);
    if (ring) {
      const r = new THREE.Mesh(new THREE.RingGeometry(6.6 * MM, 8.6 * MM, 40), new THREE.MeshBasicMaterial({ color: ring }));
      r.position.z = 0.1 * MM;
      g.add(r);
    }
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(6.2 * MM, 6.2 * MM, 3 * MM, 6), metal);
    nut.rotation.x = Math.PI / 2;
    nut.position.z = 1.5 * MM;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(4.7 * MM, 4.7 * MM, 9 * MM, 24), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 7.5 * MM;
    g.add(nut, barrel);
    if (plugged) {
      const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(5.8 * MM, 5.8 * MM, 10 * MM, 24), std("#9aa0a8", 0.35, 0.85));
      sleeve.rotation.x = Math.PI / 2;
      sleeve.position.z = 9 * MM;
      const boot = new THREE.Mesh(new THREE.CylinderGeometry(4.2 * MM, 2.4 * MM, 17 * MM, 20), std("#2b2d31", 0.7));
      boot.rotation.x = Math.PI / 2;
      boot.position.z = (14 + 8.5) * MM;
      g.add(sleeve, boot);
    } else {
      const ins = new THREE.Mesh(new THREE.CircleGeometry(3 * MM, 20), std("#e8e4da", 0.6));
      ins.position.z = 12.05 * MM;
      const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.5 * MM, 0.5 * MM, 1 * MM, 8), std("#d8b25a", 0.3, 1));
      pin.rotation.x = Math.PI / 2;
      pin.position.z = 12.4 * MM;
      for (const s of [-1, 1]) {
        const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.7 * MM, 0.7 * MM, 1.6 * MM, 8), metal);
        stud.position.set(s * 5.2 * MM, 0, 9 * MM);
        g.add(stud);
      }
      g.add(ins, pin);
    }
    return g;
  }

  private makePanelTexture(): THREE.CanvasTexture {
    const { canvas, ctx, tex } = canvasTexture(1536, 748);
    const M = mmMapper(canvas, PANEL_W, PANEL_H);
    const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grd.addColorStop(0, "#3b3f45");
    grd.addColorStop(1, "#2c2f34");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // zona de controles, apenas más oscura
    ctx.fillStyle = "rgba(0,0,0,0.14)";
    roundRect(ctx, M.x(14), M.y(75), M.s(142), M.s(150), M.s(3));
    ctx.fill();
    // marco de la pantalla
    ctx.fillStyle = "#0b0c0e";
    roundRect(ctx, M.x(SCREEN.x - SCREEN.w / 2 - 4), M.y(SCREEN.y + SCREEN.h / 2 + 4), M.s(SCREEN.w + 8), M.s(SCREEN.h + 8), M.s(3));
    ctx.fill();
    ctx.strokeStyle = "#50555c";
    ctx.lineWidth = M.s(0.5);
    ctx.stroke();
    text(ctx, "OSC-2072", M.x(-146), M.y(70.5), M.s(4.4), "#f2f4f7", "left", 800);
    text(ctx, "OSCILOSCOPIO DIGITAL · 2 CANALES", M.x(-118), M.y(70.5), M.s(2.6), "#aab1ba", "left", 600);
    // títulos de sección y separadores
    const title = (s: string, x: number, y: number) => text(ctx, s, M.x(x), M.y(y), M.s(2.7), "#e3e6ea", "center", 800);
    title("HORIZONTAL", 115, 52.5);
    title("VERTICAL", 56, 22.5);
    title("DISPARO", 126, 22.5);
    ctx.strokeStyle = "#5d636b";
    ctx.lineWidth = M.s(0.35);
    const hline = (x0: number, x1: number, y: number) => {
      ctx.beginPath();
      ctx.moveTo(M.x(x0), M.y(y));
      ctx.lineTo(M.x(x1), M.y(y));
      ctx.stroke();
    };
    const vline = (x: number, y0: number, y1: number) => {
      ctx.beginPath();
      ctx.moveTo(M.x(x), M.y(y0));
      ctx.lineTo(M.x(x), M.y(y1));
      ctx.stroke();
    };
    hline(18, 152, 57);
    hline(18, 152, 26);
    vline(92, 24, -48);
    hline(18, 152, -48.5);
    // etiquetas de botones (debajo de cada uno)
    for (const d of Object.values(BTN)) {
      const isCh = d.label === "CH1" || d.label === "CH2";
      text(ctx, d.label, M.x(d.x), M.y(d.y - BTN_H / 2 - 2.3), M.s(2.3), isCh ? (d.label === "CH1" ? CH_COLOR[0] : CH_COLOR[1]) : "#c9ced5", "center", 700);
    }
    // etiquetas de perillas
    for (const d of Object.values(KNOB)) if (d.label) text(ctx, d.label, M.x(d.x), M.y(d.ly), M.s(2.2), "#c9ced5", "center", 700);
    text(ctx, "VOLTS/DIV", M.x(56), M.y(-8), M.s(2.2), "#c9ced5", "center", 700);
    text(ctx, "POSICIÓN", M.x(56), M.y(-27), M.s(2.2), "#c9ced5", "center", 700);
    // marcas alrededor de la perilla de base de tiempo
    for (let i = 0; i <= 18; i++) {
      const a = THREE.MathUtils.degToRad(225 - i * 15);
      const r0 = KNOB.tdiv.r * 1.3;
      const r1 = r0 + (i % 3 === 0 ? 1.8 : 1.0);
      ctx.strokeStyle = "#8a9099";
      ctx.lineWidth = M.s(0.35);
      ctx.beginPath();
      ctx.moveTo(M.x(KNOB.tdiv.x + Math.cos(a) * r0), M.y(KNOB.tdiv.y + Math.sin(a) * r0));
      ctx.lineTo(M.x(KNOB.tdiv.x + Math.cos(a) * r1), M.y(KNOB.tdiv.y + Math.sin(a) * r1));
      ctx.stroke();
    }
    // BNC y conexiones
    text(ctx, "CH1", M.x(BNC_X[1]), M.y(BNC_Y + 11), M.s(2.6), CH_COLOR[0], "center", 800);
    text(ctx, "CH2", M.x(BNC_X[2]), M.y(BNC_Y + 11), M.s(2.6), CH_COLOR[1], "center", 800);
    text(ctx, "1 MΩ · 15 pF · 300 Vpk", M.x(56), M.y(-75), M.s(1.9), "#9aa1aa", "center", 600);
    text(ctx, "EXT TRIG", M.x(112), M.y(BNC_Y + 11), M.s(2.2), "#c9ced5", "center", 700);
    text(ctx, "COMP · 1 kHz", M.x(140), M.y(BNC_Y + 11), M.s(2.2), "#c9ced5", "center", 700);
    text(ctx, "POWER", M.x(-140), M.y(BNC_Y - 9), M.s(2), "#9aa1aa", "center", 700);
    text(ctx, "USB", M.x(-114), M.y(BNC_Y - 6), M.s(2), "#9aa1aa", "center", 700);
    text(ctx, "MENÚ", M.x(-70), M.y(-45.5), M.s(2), "#7d848d", "center", 700);
    tex.anisotropy = 16;
    return tex;
  }

  // ------------------------------------------------------------------ interacción

  turnKnob(k: ScopeKnob, dir: number): void {
    const g = this.knobs.get(k);
    if (g) g.rotation.z -= dir * 0.35;
  }

  pressButton(b: ScopeButton): void {
    const o = this.buttons.get(b);
    if (!o) return;
    o.mesh.position.z = this.panelZ + 0.4 * MM;
    setTimeout(() => (o.mesh.position.z = this.panelZ + 1.4 * MM), 140);
  }

  bncWorld(ch: 1 | 2): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    this.group.updateMatrixWorld(true);
    const pos = this.group.localToWorld(new THREE.Vector3(BNC_X[ch] * MM, (YC + BNC_Y) * MM, this.panelZ + PLUG_END * MM));
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(this.group.matrixWorld);
    return { pos, dir };
  }

  screenFraction(world: THREE.Vector3): { x: number; y: number } | null {
    this.group.updateMatrixWorld(true);
    const p = this.group.worldToLocal(world.clone());
    const u = (p.x / MM - SCREEN.x) / SCREEN.w + 0.5;
    const v = (p.y / MM - YC - SCREEN.y) / SCREEN.h + 0.5;
    const gr = graticuleRect(SCREEN_PX.w, SCREEN_PX.h);
    const x = (u * SCREEN_PX.w - gr.x) / gr.w;
    const y = 1 - ((1 - v) * SCREEN_PX.h - gr.y) / gr.h;
    if (x < 0 || x > 1 || y < 0 || y > 1) return null;
    return { x, y };
  }

  // ------------------------------------------------------------------ estado

  update(s: Oscilloscope, now: number, speed = 1): void {
    this.light("RUN", s.running ? "#3cff5a" : "#ff3a2a", 1.6);
    this.light("SINGLE", "#ffa020", s.trig.mode === "SINGLE" && s.running ? 1.6 : 0);
    this.light("CH1", CH_COLOR[0], s.ch[0].on ? 1.3 : 0);
    this.light("CH2", CH_COLOR[1], s.ch[1].on ? 1.3 : 0);
    this.light("MEASURE", "#e8f0ff", s.measure ? 0.9 : 0);
    this.light("CURSOR", "#e8f0ff", s.cursor.mode !== "off" ? 0.9 : 0);
    this.light("CURSEL", s.cursor.sel === 0 ? "#ffffff" : "#ff9a3c", s.cursor.mode !== "off" ? 0.9 : 0);
    this.light("TSRC", CH_COLOR[s.trig.src], 0.7);
    if (now - this.lastDraw < 1 / this.maxFps) return;
    const c = s.ch;
    const t = s.trig;
    const cu = s.cursor;
    const key = `${s.record.stamp}|${s.status}|${s.running}|${c[0].on}${c[0].vdiv}${c[0].pos}${c[0].coupling}|${c[1].on}${c[1].vdiv}${c[1].pos}${c[1].coupling}|${s.tdiv}|${s.hpos}|${t.src}${t.slope}${t.level}${t.mode}|${cu.mode}${cu.a}${cu.b}${cu.sel}${cu.chan}|${s.measure}|${speed < 0.98 ? speed.toFixed(2) : 1}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.lastDraw = now;
    drawScope(this.scr.ctx, SCREEN_PX.w, SCREEN_PX.h, s, { speed });
    this.scr.tex.needsUpdate = true;
  }

  private light(b: ScopeButton, color: string, intensity: number): void {
    const o = this.buttons.get(b);
    if (!o) return;
    if (intensity > 0 && color !== o.color) {
      o.mat.emissive.set(color);
      o.color = color;
    }
    o.mat.emissiveIntensity = intensity;
  }
}
