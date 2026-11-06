import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { FunctionGenerator, WAVE_LABEL, formatFreq, type GenParam, type Wave } from "../sim/fgen";
import { MM, canvasTexture, mmMapper, roundRect, shadows, std, tag, text, type CanvasTex } from "./util";

/**
 * Generador de funciones DDS compacto a escala real (200 × 85 × 200 mm): pantalla TFT a color,
 * botones de forma de onda y de parámetro, perilla codificadora, OUTPUT con LED y BNC de 50 Ω.
 * Origen abajo al centro; el frente mira a +Z. Medidas en mm salvo indicación.
 */
export const FGEN_W = 200;
export const FGEN_H = 85;
export const FGEN_D = 200;
const FEET = 4;
const YC = FEET + FGEN_H / 2;
const PANEL_W = 194;
const PANEL_H = 79;
const TFT = { x: -50, y: 8, w: 64, h: 36.3 };
const TFT_PX = { w: 480, h: 272 };

export type GenButton = "SINE" | "SQUARE" | "TRI" | "FREQ" | "AMPL" | "OFFSET" | "OUTPUT";

const BTN: Record<GenButton, { x: number; y: number; w: number; h: number }> = {
  SINE: { x: -76, y: -22, w: 16, h: 8 },
  SQUARE: { x: -52, y: -22, w: 16, h: 8 },
  TRI: { x: -28, y: -22, w: 16, h: 8 },
  FREQ: { x: -4, y: 21, w: 14, h: 7 },
  AMPL: { x: -4, y: 8, w: 14, h: 7 },
  OFFSET: { x: -4, y: -5, w: 14, h: 7 },
  OUTPUT: { x: 76, y: 14, w: 17, h: 8 },
};
const KNOB = { x: 38, y: 6, r: 12 };
const LED = { x: 76, y: 23 };
const BNC = { x: 76, y: -16 };
/** Largo de la ficha macho enchufada + su manguito desde el frente (mm): ahí nace el cable. */
const PLUG_END = 31;

const WAVE_OF: Partial<Record<GenButton, Wave>> = { SINE: "sine", SQUARE: "square", TRI: "triangle" };
const PARAM_OF: Partial<Record<GenButton, GenParam>> = { FREQ: "freq", AMPL: "vpp", OFFSET: "offset" };

/** Dibuja `periods` períodos de la forma de onda en el rectángulo dado. */
function waveIcon(ctx: CanvasRenderingContext2D, w: Wave, x: number, y: number, wd: number, ht: number, periods: number, color: string, lw: number): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.lineWidth = lw;
  ctx.lineJoin = "round";
  ctx.lineCap = "round";
  ctx.beginPath();
  const n = 120;
  let prev = NaN;
  for (let i = 0; i <= n; i++) {
    const ph = (i / n) * periods;
    const v = FunctionGenerator.shape(w, ph);
    const px = x + (i / n) * wd;
    const py = y + ht / 2 - (v * ht) / 2;
    if (i === 0) ctx.moveTo(px, py);
    else {
      // flancos verticales de la cuadrada
      if (w === "square" && v !== prev) ctx.lineTo(px, y + ht / 2 - (prev * ht) / 2);
      ctx.lineTo(px, py);
    }
    prev = v;
  }
  ctx.stroke();
  ctx.restore();
}

const num = (v: number, dec: number, signed = false) => `${v < 0 ? "−" : signed ? "+" : ""}${Math.abs(v).toFixed(dec).replace(".", ",")}`;

export class Fgen3D {
  readonly group = new THREE.Group();
  private readonly tft: CanvasTex;
  private readonly knob = new THREE.Group();
  private readonly buttons = new Map<GenButton, { mesh: THREE.Mesh; mat: THREE.MeshStandardMaterial }>();
  private readonly ledMat: THREE.MeshStandardMaterial;
  private readonly panelZ = (FGEN_D / 2 + 0.2) * MM;
  private lastKey = "";

  constructor() {
    const body = new THREE.Mesh(new RoundedBoxGeometry(FGEN_W * MM, FGEN_H * MM, FGEN_D * MM, 4, 4 * MM), std("#c5c9ce", 0.55, 0.1));
    body.position.y = YC * MM;
    tag(body, "fgen:body");
    this.group.add(body);
    const footMat = std("#151515", 0.9);
    const footGeo = new THREE.CylinderGeometry(6 * MM, 6 * MM, FEET * MM, 16);
    for (const [x, z] of [
      [-80, -78],
      [80, -78],
      [-80, 78],
      [80, 78],
    ]) {
      const f = new THREE.Mesh(footGeo, footMat);
      f.position.set(x * MM, (FEET / 2) * MM, z * MM);
      this.group.add(f);
    }
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(PANEL_W * MM, PANEL_H * MM), new THREE.MeshStandardMaterial({ map: this.makePanelTexture(), roughness: 0.5 }));
    panel.position.set(0, YC * MM, this.panelZ);
    tag(panel, "fgen:body");
    this.group.add(panel);

    this.tft = canvasTexture(TFT_PX.w, TFT_PX.h);
    const disp = new THREE.Mesh(new THREE.PlaneGeometry(TFT.w * MM, TFT.h * MM), new THREE.MeshBasicMaterial({ map: this.tft.tex, toneMapped: false }));
    disp.position.set(TFT.x * MM, (YC + TFT.y) * MM, this.panelZ + 0.3 * MM);
    tag(disp, "fgen:display");
    this.group.add(disp);

    for (const [b, d] of Object.entries(BTN) as [GenButton, (typeof BTN)[GenButton]][]) {
      const base = b === "OUTPUT" ? "#5a3030" : WAVE_OF[b] ? "#3c4250" : "#454a52";
      const mat = new THREE.MeshStandardMaterial({ color: base, roughness: 0.45, emissive: b === "OUTPUT" ? "#ff5040" : "#cfe0ff", emissiveIntensity: 0 });
      const mesh = new THREE.Mesh(new RoundedBoxGeometry(d.w * MM, d.h * MM, 3 * MM, 2, 1.2 * MM), mat);
      mesh.position.set(d.x * MM, (YC + d.y) * MM, this.panelZ + 1.4 * MM);
      tag(mesh, `fgen:btn:${b}`);
      this.buttons.set(b, { mesh, mat });
      this.group.add(mesh);
    }

    this.ledMat = new THREE.MeshStandardMaterial({ color: "#2a2a2a", emissive: "#3cff5a", emissiveIntensity: 0, roughness: 0.3 });
    const led = new THREE.Mesh(new THREE.SphereGeometry(1.6 * MM, 16, 8), this.ledMat);
    led.scale.z = 0.5;
    led.position.set(LED.x * MM, (YC + LED.y) * MM, this.panelZ + 0.5 * MM);
    tag(led, "fgen:body");
    this.group.add(led);

    // perilla codificadora (con el hueco para el dedo)
    const skirt = new THREE.Mesh(new THREE.CylinderGeometry(KNOB.r * 1.12 * MM, KNOB.r * 1.12 * MM, 2 * MM, 40), std("#1d1f22", 0.55));
    skirt.rotation.x = Math.PI / 2;
    skirt.position.z = 1 * MM;
    const cap = new THREE.Mesh(new THREE.CylinderGeometry(KNOB.r * 0.96 * MM, KNOB.r * MM, 12 * MM, 48), std("#2b2e33", 0.36));
    cap.rotation.x = Math.PI / 2;
    cap.position.z = 8 * MM;
    const top = new THREE.Mesh(new THREE.CircleGeometry(KNOB.r * 0.9 * MM, 40), std("#9aa1aa", 0.3, 0.8));
    top.position.z = 14.05 * MM;
    const dimple = new THREE.Mesh(new THREE.CircleGeometry(2.2 * MM, 20), std("#5d636b", 0.4, 0.6));
    dimple.position.set(0, KNOB.r * 0.55 * MM, 14.15 * MM);
    this.knob.add(skirt, cap, top, dimple);
    this.knob.position.set(KNOB.x * MM, (YC + KNOB.y) * MM, this.panelZ);
    tag(this.knob, "fgen:knob");
    this.group.add(this.knob);

    // BNC de salida con la ficha del cable enchufada
    const bnc = new THREE.Group();
    const metal = std("#c3c7cc", 0.25, 0.95);
    const ring = new THREE.Mesh(new THREE.RingGeometry(6.6 * MM, 8.4 * MM, 40), new THREE.MeshBasicMaterial({ color: "#c62a22" }));
    ring.position.z = 0.1 * MM;
    const nut = new THREE.Mesh(new THREE.CylinderGeometry(6.2 * MM, 6.2 * MM, 3 * MM, 6), metal);
    nut.rotation.x = Math.PI / 2;
    nut.position.z = 1.5 * MM;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(4.7 * MM, 4.7 * MM, 9 * MM, 24), metal);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.z = 7.5 * MM;
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(5.8 * MM, 5.8 * MM, 10 * MM, 24), std("#9aa0a8", 0.35, 0.85));
    sleeve.rotation.x = Math.PI / 2;
    sleeve.position.z = 9 * MM;
    const boot = new THREE.Mesh(new THREE.CylinderGeometry(4.2 * MM, 2.4 * MM, 17 * MM, 20), std("#2b2d31", 0.7));
    boot.rotation.x = Math.PI / 2;
    boot.position.z = 22.5 * MM;
    bnc.add(ring, nut, barrel, sleeve, boot);
    bnc.position.set(BNC.x * MM, (YC + BNC.y) * MM, this.panelZ);
    tag(bnc, "fgen:bnc");
    this.group.add(bnc);

    // encendido (decorativo)
    const power = new THREE.Mesh(new RoundedBoxGeometry(9 * MM, 9 * MM, 3 * MM, 2, 1.5 * MM), std("#1b1b1b", 0.5));
    power.position.set(12 * MM, (YC - 27) * MM, this.panelZ + 1.4 * MM);
    tag(power, "fgen:body");
    this.group.add(power);

    shadows(this.group, true, true);
    disp.castShadow = false;
    this.drawTft(null);
  }

  private makePanelTexture(): THREE.CanvasTexture {
    const { canvas, ctx, tex } = canvasTexture(1164, 474);
    const M = mmMapper(canvas, PANEL_W, PANEL_H);
    const grd = ctx.createLinearGradient(0, 0, 0, canvas.height);
    grd.addColorStop(0, "#2b2f35");
    grd.addColorStop(1, "#202328");
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // marco de la pantalla
    ctx.fillStyle = "#0a0b0d";
    roundRect(ctx, M.x(TFT.x - TFT.w / 2 - 3), M.y(TFT.y + TFT.h / 2 + 3), M.s(TFT.w + 6), M.s(TFT.h + 6), M.s(2));
    ctx.fill();
    text(ctx, "GEN-2010", M.x(-93), M.y(34.5), M.s(3.6), "#f2f4f7", "left", 800);
    text(ctx, "GENERADOR DE FUNCIONES · 0,1 Hz – 20 kHz", M.x(-70), M.y(34.5), M.s(2.1), "#aab1ba", "left", 600);
    // íconos de forma de onda debajo de sus botones
    for (const [b, w] of [
      ["SINE", "sine"],
      ["SQUARE", "square"],
      ["TRI", "triangle"],
    ] as const) {
      const d = BTN[b];
      waveIcon(ctx, w, M.x(d.x - 5.5), M.y(d.y - d.h / 2 - 2.6), M.s(11), M.s(4), 1, "#d9dde2", M.s(0.5));
    }
    // etiquetas de los parámetros, a la derecha de cada botón
    for (const [b, s] of [
      ["FREQ", "FREC"],
      ["AMPL", "AMPL"],
      ["OFFSET", "OFFSET"],
    ] as const) {
      const d = BTN[b];
      text(ctx, s, M.x(d.x + d.w / 2 + 2.2), M.y(d.y), M.s(2.4), "#d9dde2", "left", 700);
    }
    text(ctx, "AJUSTE", M.x(KNOB.x), M.y(KNOB.y - KNOB.r - 4), M.s(2.2), "#aab1ba", "center", 700);
    // escala alrededor de la perilla
    for (let i = 0; i < 24; i++) {
      const a = (i / 24) * Math.PI * 2;
      const r0 = KNOB.r * 1.2;
      const r1 = r0 + (i % 6 === 0 ? 1.6 : 0.9);
      ctx.strokeStyle = "#6f767f";
      ctx.lineWidth = M.s(0.3);
      ctx.beginPath();
      ctx.moveTo(M.x(KNOB.x + Math.cos(a) * r0), M.y(KNOB.y + Math.sin(a) * r0));
      ctx.lineTo(M.x(KNOB.x + Math.cos(a) * r1), M.y(KNOB.y + Math.sin(a) * r1));
      ctx.stroke();
    }
    text(ctx, "OUTPUT", M.x(LED.x), M.y(LED.y + 5.5), M.s(2.6), "#e8eaed", "center", 800);
    text(ctx, "50 Ω", M.x(BNC.x), M.y(BNC.y - 11.5), M.s(2.4), "#e8eaed", "center", 800);
    text(ctx, "±10 V MÁX", M.x(BNC.x), M.y(BNC.y - 15), M.s(1.8), "#aab1ba", "center", 600);
    text(ctx, "POWER", M.x(12), M.y(-34), M.s(1.9), "#aab1ba", "center", 600);
    tex.anisotropy = 16;
    return tex;
  }

  private drawTft(g: FunctionGenerator | null): void {
    const { ctx, tex } = this.tft;
    const W = TFT_PX.w;
    const H = TFT_PX.h;
    const bg = ctx.createLinearGradient(0, 0, 0, H);
    bg.addColorStop(0, "#0c1a36");
    bg.addColorStop(1, "#050b18");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, W, H);
    if (!g) {
      tex.needsUpdate = true;
      return;
    }
    const accent = "#ffd84a";
    // barra superior: canal, forma de onda y estado de la salida
    ctx.fillStyle = "#13264a";
    ctx.fillRect(0, 0, W, 42);
    ctx.fillStyle = accent;
    roundRect(ctx, 10, 8, 54, 26, 5);
    ctx.fill();
    text(ctx, "CH1", 37, 21.5, 17, "#1a1400", "center", 800);
    text(ctx, WAVE_LABEL[g.wave], 76, 21.5, 22, "#eef3ff", "left", 700);
    ctx.fillStyle = g.output ? "#2fbf5b" : "#3a4458";
    roundRect(ctx, W - 118, 8, 108, 26, 5);
    ctx.fill();
    text(ctx, g.output ? "OUT  ON" : "OUT  OFF", W - 64, 21.5, 17, g.output ? "#04140a" : "#b9c3d4", "center", 800);
    // ícono grande de la forma de onda
    ctx.strokeStyle = "rgba(120,150,200,0.35)";
    ctx.lineWidth = 1.5;
    roundRect(ctx, 12, 56, 160, 132, 8);
    ctx.stroke();
    ctx.strokeStyle = "rgba(120,150,200,0.25)";
    ctx.beginPath();
    ctx.moveTo(20, 122);
    ctx.lineTo(164, 122);
    ctx.stroke();
    waveIcon(ctx, g.wave, 24, 76, 136, 92, 1.5, g.output ? accent : "#8a96ab", 4);
    text(ctx, "Carga: Hi-Z", 14, 214, 17, "#8a96ab", "left", 600);
    text(ctx, "Salida 50 Ω", 14, 240, 17, "#8a96ab", "left", 600);
    // parámetros
    const rows: [GenParam, string, string][] = [
      ["freq", "FREC", formatFreq(g.freq)],
      ["vpp", "AMPL", `${num(g.vpp, 3)} Vpp`],
      ["offset", "OFFSET", `${num(g.offset, 3, true)} V`],
    ];
    rows.forEach(([p, name, value], i) => {
      const y = 52 + i * 72;
      const active = g.param === p;
      if (active) {
        ctx.fillStyle = "rgba(255,216,74,0.12)";
        roundRect(ctx, 186, y, W - 196, 64, 7);
        ctx.fill();
        ctx.strokeStyle = accent;
        ctx.lineWidth = 2;
        ctx.stroke();
        // marcador del parámetro que edita la perilla
        ctx.fillStyle = accent;
        ctx.beginPath();
        ctx.moveTo(192, y + 26);
        ctx.lineTo(202, y + 32);
        ctx.lineTo(192, y + 38);
        ctx.closePath();
        ctx.fill();
      }
      text(ctx, name, 210, y + 17, 17, active ? accent : "#8a96ab", "left", 700);
      text(ctx, value, W - 22, y + 43, 32, active ? "#ffffff" : "#d6deeb", "right", 700);
    });
    tex.needsUpdate = true;
  }

  // ------------------------------------------------------------------ interacción

  turnKnob(dir: number): void {
    this.knob.rotation.z -= dir * 0.3;
  }

  pressButton(b: GenButton): void {
    const o = this.buttons.get(b);
    if (!o) return;
    o.mesh.position.z = this.panelZ + 0.4 * MM;
    setTimeout(() => (o.mesh.position.z = this.panelZ + 1.4 * MM), 140);
  }

  bncWorld(): { pos: THREE.Vector3; dir: THREE.Vector3 } {
    this.group.updateMatrixWorld(true);
    const pos = this.group.localToWorld(new THREE.Vector3(BNC.x * MM, (YC + BNC.y) * MM, this.panelZ + PLUG_END * MM));
    const dir = new THREE.Vector3(0, 0, 1).transformDirection(this.group.matrixWorld);
    return { pos, dir };
  }

  update(g: FunctionGenerator, now: number): void {
    void now;
    for (const [b, o] of this.buttons) {
      const w = WAVE_OF[b];
      const p = PARAM_OF[b];
      o.mat.emissiveIntensity = b === "OUTPUT" ? (g.output ? 1.2 : 0) : w ? (g.wave === w ? 0.7 : 0) : p ? (g.param === p ? 0.7 : 0) : 0;
    }
    this.ledMat.emissiveIntensity = g.output ? 2.2 : 0;
    const key = `${g.wave}|${g.freq}|${g.vpp}|${g.offset}|${g.output}|${g.param}`;
    if (key === this.lastKey) return;
    this.lastKey = key;
    this.drawTft(g);
  }
}
