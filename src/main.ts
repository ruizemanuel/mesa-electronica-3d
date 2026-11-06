import "./style.css";
import * as THREE from "three";
import { BenchAudio } from "./audio";
import { Breadboard3D } from "./scene/breadboard3d";
import { Dmm3D, type DmmButton } from "./scene/dmm3d";
import { Fgen3D, type GenButton } from "./scene/fgen3d";
import { Cable, GroundClip3D, Probe3D, ScopeProbe3D, type Holdable } from "./scene/leads";
import { Picker, type PickHit } from "./scene/picker";
import { Psu3D } from "./scene/psu3d";
import { Scope3D, type ScopeButton, type ScopeKnob } from "./scene/scope3d";
import { MM, shadows, std } from "./scene/util";
import { BENCH_TOP, VIEWS, createWorld, loadSimReady, swapToLiteModels } from "./scene/world";
import { Bench, PROBE_IDS, type ProbeId, type ProbeTarget, type PsuPost } from "./sim/bench";
import { formatCap } from "./sim/capacitor";
import { netOfHole } from "./sim/circuits";
import { DIAL_LABEL, type Jack } from "./sim/dmm";
import { WAVE_LABEL, formatFreq } from "./sim/fgen";
import type { Oscilloscope } from "./sim/scope";
import { DIODE_LABEL } from "./ui/ivcurve";
import { colorBands, formatSI } from "./sim/resistor";
import { Panel } from "./ui/panel";
import { installCapture } from "./capture";
import { IS_TOUCH, TAP } from "./input";
import { AdaptiveResolution, QUALITY, ShadowInvalidator, detectQuality } from "./quality";

const V3 = THREE.Vector3;
const CAPTURE = new URLSearchParams(location.search).has("capture");
if (CAPTURE) document.body.classList.add("capture");
// el video se graba siempre en calidad alta
const quality = CAPTURE ? detectQuality("?calidad=alta") : detectQuality();
const bench = new Bench();
// pasos de simulación por cuadro: si no alcanzan, la simulación va en cámara lenta (solo se nota en señales rápidas)
bench.budget = CAPTURE ? { maxSteps: 40000 } : quality.lite ? { maxSteps: 8000, maxMs: 5 } : { maxSteps: 30000, maxMs: 9 };
const audio = new BenchAudio();
const viewportEl = document.getElementById("viewport")!;
const world = createWorld(viewportEl, quality, { preserveDrawingBuffer: CAPTURE });
const { scene, camera } = world;

// ------------------------------------------------------------------ instrumentos
const dmm3d = new Dmm3D();
dmm3d.group.position.set(0.255, BENCH_TOP, 0.025);
dmm3d.group.rotation.y = -0.38;
scene.add(dmm3d.group);

const psu3d = new Psu3D();
psu3d.group.position.set(-0.36, BENCH_TOP, -0.075);
psu3d.group.rotation.y = 0.3;
scene.add(psu3d.group);

const scope3d = new Scope3D();
// pantalla del osciloscopio: subir una textura de 800×480 cuesta, sobre todo en los celulares, así que
// se redibuja según cuánto se ve (fuera de cuadro, nada; chiquita, pocas veces por segundo)
const SCOPE_FPS = quality.lite ? 15 : 25;
let scopePanelVisible = false;
if (typeof IntersectionObserver === "function")
  new IntersectionObserver((entries) => (scopePanelVisible = entries.some((e) => e.isIntersecting))).observe(scope3d.screen);
const scopeCenter = new THREE.Vector3();
const frustum = new THREE.Frustum();
const projM = new THREE.Matrix4();
function scopeRedrawRate(): number {
  if (CAPTURE || scopePanelVisible) return SCOPE_FPS;
  scope3d.group.getWorldPosition(scopeCenter);
  scopeCenter.y += 0.1;
  projM.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  frustum.setFromProjectionMatrix(projM);
  if (!frustum.containsPoint(scopeCenter)) return 0;
  const d = camera.position.distanceTo(scopeCenter);
  const px = (0.152 * viewportEl.clientHeight) / (2 * d * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2)));
  return px < 260 ? 6 : px < 520 ? Math.min(12, SCOPE_FPS) : SCOPE_FPS;
}
scope3d.group.position.set(-0.035, BENCH_TOP, -0.165);
scope3d.group.rotation.y = 0.05;
scene.add(scope3d.group);

const fgen3d = new Fgen3D();
fgen3d.group.position.set(0.5, BENCH_TOP, -0.13);
fgen3d.group.rotation.y = -0.5;
scene.add(fgen3d.group);

const bb = new Breadboard3D();
bb.group.position.set(-0.02, BENCH_TOP, 0.1);
scene.add(bb.group);
bb.build(bench.circuit, bench.parts, bench.diodes, bench.caps);

const probes: Record<ProbeId, Holdable> = {
  red: new Probe3D("red", "#c8261f"),
  black: new Probe3D("black", "#1b1b1b"),
  ch1: new ScopeProbe3D("ch1", "#f2d21b"),
  ch2: new ScopeProbe3D("ch2", "#27d3f5"),
  sgnd: new GroundClip3D(),
};
for (const p of PROBE_IDS) scene.add(probes[p].group);
const cables = {
  red: new Cable("#c8261f", 1.8 * MM, BENCH_TOP),
  black: new Cable("#1b1b1b", 1.8 * MM, BENCH_TOP),
  psuRed: new Cable("#c62a22", 1.6 * MM, BENCH_TOP),
  psuBlack: new Cable("#1b1b1b", 1.6 * MM, BENCH_TOP),
  ch1: new Cable("#2c2f34", 2.1 * MM, BENCH_TOP),
  ch2: new Cable("#2c2f34", 2.1 * MM, BENCH_TOP),
  sgnd: new Cable("#161616", 0.7 * MM, BENCH_TOP),
  genRed: new Cable("#c62a22", 1.4 * MM, BENCH_TOP),
  genBlack: new Cable("#1b1b1b", 1.4 * MM, BENCH_TOP),
};
for (const c of Object.values(cables)) scene.add(c.mesh);

// cables de la fuente al protoboard (terminan en un pin en los rieles)
const PSU_PIN: Record<"psu+" | "psu-", string> = { "psu+": "RT+:2", "psu-": "RB-:2" };
function makePin(color: string, hole: string, parent: THREE.Object3D = scene): THREE.Vector3 {
  const g = new THREE.Group();
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.32 * MM, 0.32 * MM, 9 * MM, 8), std("#cfd2d6", 0.3, 0.9));
  pin.position.y = -1 * MM;
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(1.6 * MM, 2.0 * MM, 13 * MM, 16), std(color, 0.5));
  boot.position.y = 10 * MM;
  g.add(pin, boot);
  g.position.copy(bb.holeWorld(hole));
  shadows(g, true, false);
  parent.add(g);
  return g.position.clone().add(new V3(0, 16.5 * MM, 0));
}
const pinTop = { "psu+": makePin("#c62a22", PSU_PIN["psu+"]), "psu-": makePin("#1b1b1b", PSU_PIN["psu-"]) };

// cable del generador: del BNC a dos pines en el protoboard (según el circuito)
const genPins = new THREE.Group();
scene.add(genPins);
let genPinTop: { pos: THREE.Vector3; neg: THREE.Vector3 } | null = null;
function buildGenPins(): void {
  genPins.clear();
  const g = bench.circuit.gen;
  genPinTop = g ? { pos: makePin("#c62a22", g.pos, genPins), neg: makePin("#1b1b1b", g.neg, genPins) } : null;
  cables.genRed.mesh.visible = cables.genBlack.mesh.visible = !!g;
}
buildGenPins();

// posición de reposo de las puntas sobre la mesa
const REST: Record<ProbeId, { tip: THREE.Vector3; dir: THREE.Vector3 }> = {
  red: { tip: new V3(0.125, BENCH_TOP + 0.0035, 0.228), dir: new V3(0.62, 0.06, -0.36).normalize() },
  black: { tip: new V3(0.14, BENCH_TOP + 0.0035, 0.206), dir: new V3(0.66, 0.06, -0.3).normalize() },
  ch1: { tip: new V3(-0.16, BENCH_TOP + 0.0045, 0.2), dir: new V3(0.25, 0.05, -0.97).normalize() },
  ch2: { tip: new V3(-0.125, BENCH_TOP + 0.0045, 0.212), dir: new V3(0.3, 0.05, -0.95).normalize() },
  sgnd: { tip: new V3(-0.185, BENCH_TOP + 0.003, 0.17), dir: new V3(0.2, 0.08, -0.97).normalize() },
};

function probePose(c: ProbeId, t: ProbeTarget, hover = false): { tip: THREE.Vector3; dir: THREE.Vector3 } {
  if (!t) return REST[c];
  const side = c === "red" || c === "ch2" ? 1 : -1;
  if (t.kind === "hole") {
    const tip = bb.holeWorld(t.hole, hover ? -3 : c === "sgnd" ? 0.5 : 1.5);
    // mangos inclinados hacia atrás y hacia afuera para no tapar el protoboard; los del osciloscopio, hacia él
    // las del osciloscopio, acostadas hacia los costados (paradas taparían la pantalla)
    if (c === "ch1" || c === "ch2") return { tip, dir: new V3(0.55 * side, 0.62, -0.58).normalize() };
    if (c === "sgnd") return { tip, dir: new V3(0, 1, -0.25).normalize() };
    return { tip, dir: new V3(0.5 * side, 1, -0.6).normalize() };
  }
  const { pos, dir } = psu3d.postWorld(t.post);
  if (hover) pos.addScaledVector(dir, 3 * MM);
  return { tip: pos, dir: dir.clone().add(new V3(0.12 * side, 0.55, 0)).normalize() };
}

// ------------------------------------------------------------------ UI
const toasts = document.getElementById("toasts")!;
function toast(html: string, kind: "info" | "bad" | "ok" = "info"): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.innerHTML = html;
  toasts.appendChild(el);
  setTimeout(() => el.classList.add("out"), 4200);
  setTimeout(() => el.remove(), 4800);
}

let holding: ProbeId | null = null;
let preview: ProbeTarget = null;
const HOLD_NAME: Record<ProbeId, string> = { red: "la punta roja", black: "la punta negra", ch1: "la punta CH1", ch2: "la punta CH2", sgnd: "la pinza de masa" };

function setHolding(c: ProbeId | null): void {
  holding = c;
  preview = null;
  bb.showMarker(null);
  document.body.classList.toggle("holding", !!c);
}

function placeProbe(c: ProbeId, t: ProbeTarget): void {
  bench.probes[c] = t;
  bench.refreshDmm();
  audio.click();
}

/** Ajuste del osciloscopio desde el panel, las perillas o los botones. */
function scopeDo(fn: (s: Oscilloscope) => void): void {
  fn(bench.scope);
  audio.click();
}

const panel = new Panel(
  bench,
  {
  loadCircuit(id) {
    bench.loadCircuit(id);
    bb.build(bench.circuit, bench.parts, bench.diodes, bench.caps);
    buildGenPins();
    setHolding(null);
    panel.render();
  },
  view(name) {
    world.goTo(VIEWS[name]);
  },
  toggleJumper(id) {
    toggleJumper(id);
  },
  setResistor(id, spec) {
    bench.setResistor(id, spec);
  },
  replaceResistor(id) {
    const p = bench.parts.get(id)!;
    bench.setResistor(id, { ...p.spec });
    toast(`${id} reemplazado por otro del mismo valor (otra muestra del lote).`, "ok");
  },
  setDiode(id, type) {
    bench.setDiode(id, type);
    bench.refreshDmm();
  },
  flipDiode(id) {
    bench.flipDiode(id);
    bench.refreshDmm();
    audio.click();
    const d = bench.diodes.get(id)!;
    toast(`${id} dado vuelta: ahora está ${d.reversed ? "en <b>inversa</b> (el cátodo hacia el +)" : "en <b>directa</b> (como estaba)"}.`, "info");
  },
  replaceDiode(id) {
    bench.setDiode(id);
    bench.refreshDmm();
    toast(`${id} reemplazado por uno nuevo (otra muestra del lote).`, "ok");
  },
  dmmButton(b) {
    pressDmm(b);
  },
  setDial(d) {
    bench.dmm.setDial(d);
    bench.refreshDmm();
  },
  setJack(j) {
    bench.dmm.red = j;
    bench.refreshDmm();
  },
  setPsu(v, i) {
    if (v !== null && isFinite(v)) bench.psu.setVoltage(v, bench.time);
    if (i !== null && isFinite(i)) bench.psu.setCurrent(i, bench.time);
    panel.syncPsuInputs();
  },
  toggleOutput() {
    toggleOutput();
  },
  replaceFuse(which) {
    (which === "mA" ? bench.dmm.fuseMa : bench.dmm.fuseA).replace();
    toast(`Fusible de ${which === "mA" ? "mA (440 mA)" : "10 A (11 A)"} reemplazado.`, "ok");
  },
  stowProbes() {
    bench.probes.red = null;
    bench.probes.black = null;
    setHolding(null);
  },
  setGen(p) {
    const g = bench.gen;
    if (p.wave) {
      g.setWave(p.wave);
      fgen3d.pressButton(p.wave === "sine" ? "SINE" : p.wave === "square" ? "SQUARE" : "TRI");
    }
    if (p.freq !== undefined) g.setFreq(p.freq);
    if (p.vpp !== undefined) g.setVpp(p.vpp);
    if (p.offset !== undefined) g.setOffset(p.offset);
    if (p.output !== undefined) {
      g.setOutput(p.output);
      fgen3d.pressButton("OUTPUT");
    }
    bench.refreshDmm();
    audio.click();
  },
  scope(fn) {
    scopeDo(fn);
  },
  setCap(id, nominal) {
    bench.setCapacitor(id, nominal);
    bench.refreshDmm();
  },
  flipCap(id) {
    bench.flipCapacitor(id);
    bench.refreshDmm();
    audio.click();
    const c = bench.caps.get(id)!;
    toast(c.reversed ? `${id} dado vuelta: la pata <b>−</b> quedó del lado positivo. Un electrolítico al revés conduce y se calienta.` : `${id} otra vez con la polaridad correcta.`, c.reversed ? "bad" : "info");
  },
  dischargeCap(id) {
    bench.dischargeCapacitor(id);
    audio.click();
    toast(`${id} descargado (un corto entre las patas con el destornillador).`, "ok");
  },
  replaceCap(id) {
    bench.setCapacitor(id);
    bench.refreshDmm();
    toast(`${id} reemplazado por uno nuevo (descargado, otra muestra del lote).`, "ok");
  },
  pickProbe(c) {
    audio.unlock();
    setHolding(c);
  },
  toggleMute() {
    audio.muted = !audio.muted;
    return audio.muted;
  },
  },
  scope3d.screen,
);

function toggleJumper(id: string): void {
  const now = !bench.jumperPresent.get(id);
  bench.jumperPresent.set(id, now);
  bench.refreshDmm();
  audio.click();
}
function toggleOutput(): void {
  bench.psu.output = !bench.psu.output;
  psu3d.pressOutput();
  audio.click();
}
function pressDmm(b: DmmButton): void {
  if (b === "SELECT") bench.dmm.pressSelect();
  else if (b === "RANGE") bench.dmm.pressRange();
  else if (b === "HOLD") bench.dmm.pressHold();
  else bench.dmm.pressRel();
  dmm3d.pressButton(b);
  bench.refreshDmm();
  audio.click();
}

bench.on((e) => {
  if (e.kind === "fuse") {
    audio.pop(1);
    toast(`<b>¡Se quemó el fusible de ${e.which === "mA" ? "mA" : "10 A"}!</b> Pasó demasiada corriente por la borna ${e.which === "mA" ? "mA" : "10A"}. Cambialo en el panel.`, "bad");
  } else if (e.kind === "burn") {
    audio.pop(0.7);
    toast(`<b>${e.id} se quemó</b> (circuito abierto). Superó largamente su potencia nominal.`, "bad");
  } else if (e.kind === "diodeBurn") {
    audio.pop(e.led ? 0.5 : 0.8);
    const part = bench.diodes.get(e.id)!;
    toast(
      e.led
        ? `<b>${e.id} se quemó</b> (circuito abierto): llegó a ${formatSI(e.peak, "A", 2)} y aguanta ${formatSI(part.model.ifMax, "A")}. Sin resistencia en serie, la corriente la limita solo la fuente. Reemplazalo en el panel.`
        : `<b>${e.id} se quemó</b> (circuito abierto): la juntura pasó su temperatura máxima con ${formatSI(e.peak, "A", 2)}.`,
      "bad",
    );
  } else if (e.kind === "capBurst") {
    audio.pop(0.9);
    toast(`<b>${e.id} se infló</b>: la fuga con la polaridad invertida lo calentó hasta abrir la válvula de seguridad. Quedó abierto: reemplazalo en el panel.`, "bad");
  } else if (e.kind === "smoke") {
    toast(`<b>${e.id} está humeando</b>: disipa más potencia de la que soporta.`, "bad");
  } else if (e.kind === "cc" && e.on) {
    toast("La fuente entró en <b>CC</b> (limitación de corriente).", "info");
  }
});

// ------------------------------------------------------------------ picking
function nearestOf(holes: string[], point: THREE.Vector3): string {
  let best = holes[0];
  let bd = Infinity;
  for (const h of holes) {
    const d = bb.holeWorld(h).distanceTo(point);
    if (d < bd) {
      bd = d;
      best = h;
    }
  }
  return best;
}

const boardPlane = new THREE.Plane();
function holeUnderRay(): string | null {
  const top = bb.holeWorld("1a");
  boardPlane.setFromNormalAndCoplanarPoint(new V3(0, 1, 0), top);
  const hit = picker.lastRay.intersectPlane(boardPlane, new V3());
  return hit ? bb.nearestHole(hit, 1.3) : null;
}

function targetFromPick(p: PickHit | null): ProbeTarget {
  if (!p) return null;
  if (p.id === "breadboard") {
    const hole = bb.nearestHole(p.hit.point, 1.6);
    return hole ? { kind: "hole", hole } : null;
  }
  if (p.id.startsWith("resistor:") || p.id.startsWith("jumper:") || p.id.startsWith("diode:") || p.id.startsWith("cap:")) {
    // primero el agujero que está realmente bajo el cursor (el rayo cortando la superficie)
    const onBoard = holeUnderRay();
    if (onBoard) return { kind: "hole", hole: onBoard };
    const holes = p.id.startsWith("resistor:")
      ? bb.resistorHoles(p.id.slice(9))
      : p.id.startsWith("diode:")
        ? bb.diodeHoles(p.id.slice(6))
        : p.id.startsWith("cap:")
          ? bb.capHoles(p.id.slice(4))
          : (() => {
            const o = bb.jumperObjs.get(p.id.slice(7));
            return o ? [o.def.a, o.def.b] : null;
          })();
    return holes ? { kind: "hole", hole: nearestOf(holes, p.hit.point) } : null;
  }
  if (p.id.startsWith("psu:post:")) return { kind: "post", post: p.id.slice(9) as PsuPost };
  return null;
}

function holeLabel(hole: string): string {
  const net = netOfHole(hole);
  if (net.startsWith("R")) {
    const pos = net.endsWith("+") ? "+" : "−";
    return `Riel <b>${pos}</b> ${net[1] === "T" ? "superior" : "inferior"}`;
  }
  return `Agujero <b>${hole}</b> · tira ${net[0] === "T" ? `${hole.replace(/\D/g, "")}a–e` : `${hole.replace(/\D/g, "")}f–j`}`;
}

const KNOB_HELP = IS_TOUCH ? "Arrastrá hacia arriba o abajo" : "Rueda o arrastrar · Shift ×10 · Alt ×0,1";
const POST_LABEL: Record<PsuPost, string> = { "psu+": "Borne + (rojo)", "psu-": "Borne − (negro)", psuGnd: "Borne GND (tierra, aislado de la salida)" };
const JACK_INFO: Record<Jack, string> = {
  VOhm: "Borna VΩ·))) — tensión, resistencia y continuidad",
  mA: "Borna mA — corriente hasta 600 mA (fusible 440 mA)",
  A: "Borna 10A — corriente hasta 10 A (fusible 11 A)",
};

const SCOPE_BTN: Record<ScopeButton, string> = {
  RUN: "RUN/STOP: congela la pantalla o vuelve a adquirir",
  SINGLE: "SINGLE: espera un disparo, lo muestra y para",
  AUTO: "AUTOSET: busca escalas y base de tiempo para la señal",
  CH1: "CH1: encender/apagar el canal 1",
  CH2: "CH2: encender/apagar el canal 2",
  CPL1: "Acoplamiento de CH1: DC → AC → GND",
  CPL2: "Acoplamiento de CH2: DC → AC → GND",
  MEASURE: "MEASURE: mostrar u ocultar las mediciones automáticas",
  CURSOR: "CURSOR: cursores de tiempo → de tensión → apagados",
  CURSEL: "A/B: elige qué cursor mueve la perilla multifunción",
  TSRC: "Fuente del disparo: CH1 / CH2",
  SLOPE: "Flanco del disparo: subida / bajada",
  TMODE: "Modo de disparo: AUTO → NORMAL → SINGLE",
};
const SCOPE_KNOB: Record<ScopeKnob, (s: Oscilloscope) => string> = {
  tdiv: (s) => `Base de tiempo: <b>${formatSI(s.tdiv, "s")}/div</b>`,
  hpos: (s) => `Posición horizontal: disparo a <b>${formatSI(s.hpos, "s")}</b> del centro`,
  vdiv1: (s) => `CH1: <b>${formatSI(s.ch[0].vdiv, "V")}/div</b>`,
  vdiv2: (s) => `CH2: <b>${formatSI(s.ch[1].vdiv, "V")}/div</b>`,
  pos1: (s) => `Posición vertical CH1: <b>${s.ch[0].pos.toFixed(1).replace(".", ",")} div</b>`,
  pos2: (s) => `Posición vertical CH2: <b>${s.ch[1].pos.toFixed(1).replace(".", ",")} div</b>`,
  level: (s) => `Nivel de disparo: <b>${formatSI(s.trig.level, "V")}</b>`,
  cursor: (s) => (s.cursor.mode === "off" ? "Perilla multifunción (mueve los cursores; encendelos con CURSOR)" : `Mueve el cursor <b>${s.cursor.sel === 0 ? "A" : "B"}</b> (A/B para cambiar)`),
};
const GEN_BTN: Record<GenButton, string> = {
  SINE: "Senoidal",
  SQUARE: "Cuadrada",
  TRI: "Triangular",
  FREQ: "La perilla ajusta la frecuencia",
  AMPL: "La perilla ajusta la amplitud (Vpp a circuito abierto)",
  OFFSET: "La perilla ajusta el offset (nivel de continua)",
  OUTPUT: "OUTPUT: conecta o desconecta la salida",
};

/** Un paso de perilla del osciloscopio (dir > 0: sentido horario). */
function turnScopeKnob(k: ScopeKnob, dir: number): void {
  const s = bench.scope;
  if (k === "tdiv") s.stepTdiv(-dir);
  else if (k === "vdiv1") s.stepVdiv(0, -dir);
  else if (k === "vdiv2") s.stepVdiv(1, -dir);
  else if (k === "pos1" || k === "pos2") {
    const c = s.ch[k === "pos1" ? 0 : 1];
    c.pos = Math.max(-4, Math.min(4, Math.round((c.pos + 0.2 * dir) * 10) / 10));
  } else if (k === "hpos") s.hpos = Math.max(-5 * s.tdiv, Math.min(5 * s.tdiv, s.hpos - 0.2 * s.tdiv * dir));
  else if (k === "level") s.trig.level = Math.round((s.trig.level + 0.1 * s.ch[s.trig.src].vdiv * dir) * 1e4) / 1e4;
  else if (s.cursor.mode !== "off") {
    const key = s.cursor.sel === 0 ? "a" : "b";
    s.cursor[key] = Math.max(0, Math.min(1, s.cursor[key] + 0.004 * dir));
  }
  scope3d.turnKnob(k, dir);
}
function pressScopeButton(b: ScopeButton): void {
  const s = bench.scope;
  const cycle = <T,>(list: T[], v: T): T => list[(list.indexOf(v) + 1) % list.length];
  if (b === "RUN") s.toggleRun();
  else if (b === "SINGLE") s.single();
  else if (b === "AUTO") s.autoset();
  else if (b === "CH1") s.ch[0].on = !s.ch[0].on;
  else if (b === "CH2") s.ch[1].on = !s.ch[1].on;
  else if (b === "CPL1") s.ch[0].coupling = cycle(["DC", "AC", "GND"] as const as unknown as ("DC" | "AC" | "GND")[], s.ch[0].coupling);
  else if (b === "CPL2") s.ch[1].coupling = cycle(["DC", "AC", "GND"] as const as unknown as ("DC" | "AC" | "GND")[], s.ch[1].coupling);
  else if (b === "MEASURE") s.measure = !s.measure;
  else if (b === "CURSOR") s.cursor.mode = cycle(["off", "time", "volt"] as ("off" | "time" | "volt")[], s.cursor.mode);
  else if (b === "CURSEL") s.cursor.sel = s.cursor.sel === 0 ? 1 : 0;
  else if (b === "TSRC") s.trig.src = s.trig.src === 0 ? 1 : 0;
  else if (b === "SLOPE") s.trig.slope = s.trig.slope === "rise" ? "fall" : "rise";
  else if (b === "TMODE") {
    if (s.trig.mode === "NORMAL") s.single();
    else {
      s.trig.mode = s.trig.mode === "AUTO" ? "NORMAL" : "AUTO";
      if (!s.running) s.toggleRun();
    }
  }
  scope3d.pressButton(b);
  audio.click();
}
function pressGenButton(b: GenButton): void {
  const g = bench.gen;
  if (b === "SINE") g.setWave("sine");
  else if (b === "SQUARE") g.setWave("square");
  else if (b === "TRI") g.setWave("triangle");
  else if (b === "FREQ") g.param = "freq";
  else if (b === "AMPL") g.param = "vpp";
  else if (b === "OFFSET") g.param = "offset";
  else g.setOutput(!g.output);
  fgen3d.pressButton(b);
  bench.refreshDmm();
  audio.click();
}
/** Acumulador del arrastre de perillas de paso (osciloscopio y generador): un paso cada 12 px. */
let knobDrag = 0;

const picker = new Picker(camera, world.renderer.domElement, world.controls, [dmm3d.group, psu3d.group, scope3d.group, fgen3d.group, bb.group, ...PROBE_IDS.map((p) => probes[p].group)], {
  label(p) {
    const id = p.id;
    if (holding) {
      const t = targetFromPick(p);
      if (t) return `${t.kind === "hole" ? holeLabel(t.hole) : POST_LABEL[t.post]}<br><span class="k">${IS_TOUCH ? "Soltá" : "Clic"}: apoyar ${HOLD_NAME[holding]}</span>`;
      return IS_TOUCH ? `<span class="k">Mové la mira sobre un agujero, una pata o un borne</span>` : `<span class="k">Clic en un agujero, una pata o un borne · Esc cancela</span>`;
    }
    if (id === "breadboard") {
      const h = bb.nearestHole(p.hit.point, 1.6);
      return h ? holeLabel(h) : "Protoboard 400 puntos";
    }
    if (id.startsWith("resistor:")) {
      const part = bench.parts.get(id.slice(9))!;
      const s = part.spec;
      const bands = colorBands(s.nominal, s.tolerance)
        .map((b) => b.name)
        .join(" · ");
      return `<b>${part.id}</b> ${formatSI(s.nominal, "Ω")} ±${s.tolerance * 100} % · ${s.power} W<br><span class="k">${bands}</span><br>${part.tempC.toFixed(0)} °C${part.state !== "ok" ? ` · <b>${part.state.toUpperCase()}</b>` : ""}`;
    }
    if (id.startsWith("diode:")) {
      const part = bench.diodes.get(id.slice(6))!;
      const [ha, hk] = bb.diodeHoles(part.id) ?? ["", ""];
      const m = part.model;
      const legs = m.led ? `Ánodo (pata larga) en ${ha} · cátodo (lado plano) en ${hk}` : `Ánodo en ${ha} · cátodo (banda) en ${hk}`;
      const state = part.state === "quemado" ? " · <b>QUEMADO</b>" : part.reversed ? " · <b>al revés</b>" : "";
      return `<b>${part.id}</b> ${DIODE_LABEL[part.type]}${m.led ? " 5 mm" : " · 1 A / 1000 V"}${state}<br><span class="k">${legs}</span><br>${part.tempC.toFixed(0)} °C · máx. ${formatSI(m.ifMax, "A")}`;
    }
    if (id.startsWith("cap:")) {
      const part = bench.caps.get(id.slice(4))!;
      const [hp, hn] = bb.capHoles(part.id) ?? ["", ""];
      const kind = part.polarized ? `electrolítico ${part.model.vMax} V · + en ${hp}, − (franja) en ${hn}` : `cerámico «${part.model.marking}» · 50 V`;
      const state = part.state === "inflado" ? " · <b>INFLADO</b>" : part.reversed ? " · <b>al revés</b>" : "";
      return `<b>${part.id}</b> ${formatCap(part.nominal)} ±${part.model.tolerance * 100} %${state}<br><span class="k">${kind}</span><br>${part.tempC.toFixed(0)} °C`;
    }
    if (id.startsWith("scope:btn:")) return SCOPE_BTN[id.slice(10) as ScopeButton];
    if (id.startsWith("scope:knob:")) return `${SCOPE_KNOB[id.slice(11) as ScopeKnob](bench.scope)}<br><span class="k">${KNOB_HELP.split(" · ")[0]}</span>`;
    if (id === "scope:screen")
      return bench.scope.cursor.mode === "off"
        ? `Osciloscopio · ${formatSI(bench.scope.tdiv, "s")}/div<br><span class="k">CURSOR enciende los cursores; después se arrastran sobre la pantalla</span>`
        : `<span class="k">Arrastrá sobre la pantalla para mover el cursor más cercano</span>`;
    if (id.startsWith("scope:bnc:")) return `Entrada CH${id.slice(10)} · 1 MΩ (10 MΩ con la punta ×10)`;
    if (id === "scope:body") return "Osciloscopio digital de 2 canales · 8 bits · disparo por flanco";
    if (id.startsWith("fgen:btn:")) return GEN_BTN[id.slice(9) as GenButton];
    if (id === "fgen:knob") {
      const g = bench.gen;
      const what = g.param === "freq" ? `Frecuencia: <b>${formatFreq(g.freq)}</b>` : g.param === "vpp" ? `Amplitud: <b>${formatSI(g.vpp, "Vpp")}</b>` : `Offset: <b>${formatSI(g.offset, "V")}</b>`;
      return `${what}<br><span class="k">${KNOB_HELP}</span>`;
    }
    if (id === "fgen:display" || id === "fgen:body" || id === "fgen:bnc") {
      const g = bench.gen;
      return `Generador de funciones · ${WAVE_LABEL[g.wave]} ${formatFreq(g.freq)} · ${formatSI(g.vpp, "Vpp")}<br><span class="k">Salida de 50 Ω · OUTPUT ${g.output ? "encendida" : "apagada"}</span>`;
    }
    if (id.startsWith("jumper:")) {
      const j = id.slice(7);
      return bench.jumperPresent.get(j) ? `Puente <b>${j}</b><br><span class="k">${TAP}: quitarlo (abre el circuito)</span>` : `Puente <b>${j}</b> (quitado)<br><span class="k">${TAP}: volver a ponerlo</span>`;
    }
    if (id === "dmm:dial") return `Llave: <b>${DIAL_LABEL[bench.dmm.dial]}</b><br><span class="k">${IS_TOUCH ? "Tocá a la izquierda o a la derecha para girarla" : "Clic izq./der. o rueda para girar"}</span>`;
    if (id.startsWith("dmm:btn:")) {
      const b = id.slice(8);
      const d: Record<string, string> = {
        RANGE: "RANGE: rango manual (cada pulsación sube un rango; al final vuelve a AUTO)",
        HOLD: "HOLD: congela la lectura",
        REL: "REL Δ: medición relativa (resta la lectura actual, útil para anular la resistencia de las puntas)",
        SELECT: "SELECT: en la posición Ω alterna Ω → ▶︎| prueba de diodos → ·))) continuidad",
      };
      return d[b];
    }
    if (id.startsWith("dmm:jack:")) return `${JACK_INFO[id.slice(9) as Jack]}<br><span class="k">${TAP}: pasar la punta roja aquí</span>`;
    if (id === "dmm:plug:red") return `Ficha roja en <b>${bench.dmm.red === "VOhm" ? "VΩ" : bench.dmm.red === "mA" ? "mA" : "10A"}</b><br><span class="k">${TAP}: cambiar de borna</span>`;
    if (id === "dmm:plug:black") return "Ficha negra en COM";
    if (id === "dmm:lcd" || id === "dmm:body") return "Multímetro digital DM-6000 · 6000 cuentas";
    if (id === "psu:knob:V") return `Tensión programada: <b>${bench.psu.vset.toFixed(2)} V</b><br><span class="k">${KNOB_HELP}</span>`;
    if (id === "psu:knob:A") return `Límite de corriente: <b>${bench.psu.iset.toFixed(3)} A</b><br><span class="k">${KNOB_HELP}</span>`;
    if (id === "psu:output") return `OUTPUT ${bench.psu.output ? "<b>encendida</b>" : "apagada"}<br><span class="k">${TAP} para ${bench.psu.output ? "apagar" : "encender"} la salida</span>`;
    if (id.startsWith("psu:post:")) return POST_LABEL[id.slice(9) as PsuPost];
    if (id === "psu:display" || id === "psu:body") return "Fuente de laboratorio 0–30 V / 0–3 A";
    if (id.startsWith("probe:")) {
      const which = id.slice(6) as ProbeId;
      const name = which === "red" ? "Punta roja" : which === "black" ? "Punta negra" : which === "sgnd" ? "Pinza de masa del osciloscopio (va a la tierra del enchufe)" : `Punta ×10 del ${which.toUpperCase()}`;
      return `${name}<br><span class="k">${TAP} para tomarla</span>`;
    }
    return null;
  },
  click(p, ev) {
    audio.unlock();
    if (holding) {
      const t = targetFromPick(p);
      if (p?.id === `probe:${holding}`) return; // clic sobre la misma punta: seguir sosteniendo
      placeProbe(holding, t);
      setHolding(null);
      return;
    }
    if (!p) return;
    const id = p.id;
    if (id.startsWith("probe:")) setHolding(id.slice(6) as ProbeId);
    else if (id.startsWith("scope:btn:")) pressScopeButton(id.slice(10) as ScopeButton);
    else if (id.startsWith("fgen:btn:")) pressGenButton(id.slice(9) as GenButton);
    else if (id.startsWith("scope:") && id !== "scope:screen") panel.scrollTo("scope");
    else if (id.startsWith("fgen:") && id !== "fgen:knob") panel.scrollTo("gen");
    else if (id.startsWith("cap:")) panel.selectPart(id.slice(4));
    else if (id === "dmm:dial") {
      bench.dmm.rotate(dmm3d.dialSide(p.hit.point));
      bench.refreshDmm();
      audio.click();
    } else if (id.startsWith("dmm:btn:")) pressDmm(id.slice(8) as DmmButton);
    else if (id.startsWith("dmm:jack:")) {
      bench.dmm.red = id.slice(9) as Jack;
      bench.refreshDmm();
      audio.click();
    } else if (id === "dmm:plug:red") {
      const order: Jack[] = ["VOhm", "mA", "A"];
      bench.dmm.red = order[(order.indexOf(bench.dmm.red) + 1) % 3];
      bench.refreshDmm();
      audio.click();
    } else if (id === "psu:output") toggleOutput();
    else if (id.startsWith("jumper:")) toggleJumper(id.slice(7));
    else if (id.startsWith("resistor:")) panel.selectPart(id.slice(9));
    else if (id.startsWith("diode:")) panel.selectPart(id.slice(6));
    void ev;
  },
  wantsWheel(p) {
    return p.id === "dmm:dial" || p.id.startsWith("psu:knob:") || p.id.startsWith("scope:knob:") || p.id === "fgen:knob";
  },
  wheel(p, delta, ev) {
    if (p.id === "dmm:dial") {
      bench.dmm.rotate(delta > 0 ? 1 : -1);
      bench.refreshDmm();
      audio.click();
      return true;
    }
    if (p.id === "psu:knob:V") {
      const step = ev.shiftKey ? 1 : ev.altKey ? 0.01 : 0.1;
      bench.psu.setVoltage(bench.psu.vset - delta * step, bench.time);
      panel.syncPsuInputs();
      return true;
    }
    if (p.id === "psu:knob:A") {
      const step = ev.shiftKey ? 0.1 : ev.altKey ? 0.001 : 0.01;
      bench.psu.setCurrent(bench.psu.iset - delta * step, bench.time);
      panel.syncPsuInputs();
      return true;
    }
    if (p.id.startsWith("scope:knob:")) {
      turnScopeKnob(p.id.slice(11) as ScopeKnob, -delta * (ev.shiftKey ? 5 : 1));
      audio.click();
      return true;
    }
    if (p.id === "fgen:knob") {
      bench.gen.nudge(-delta, ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
      fgen3d.turnKnob(-delta);
      audio.click();
      return true;
    }
    return false;
  },
  canDrag(p) {
    knobDrag = 0;
    if (p.id === "scope:screen") {
      const s = bench.scope;
      if (s.cursor.mode === "off") return false;
      const f = scope3d.screenFraction(p.hit.point);
      if (f) {
        const v = s.cursor.mode === "time" ? f.x : f.y;
        s.cursor.sel = Math.abs(v - s.cursor.a) <= Math.abs(v - s.cursor.b) ? 0 : 1;
        panel.moveCursor(f, s.cursor.sel);
      }
      return true;
    }
    return p.id.startsWith("psu:knob:") || p.id.startsWith("scope:knob:") || p.id === "fgen:knob";
  },
  drag(p, dy, ev) {
    if (p.id === "scope:screen") {
      const hit = picker.pick(ev);
      const f = hit && hit.id === "scope:screen" ? scope3d.screenFraction(hit.hit.point) : null;
      if (f) panel.moveCursor(f, bench.scope.cursor.sel);
      return;
    }
    if (p.id.startsWith("scope:knob:") || p.id === "fgen:knob") {
      knobDrag += dy;
      while (Math.abs(knobDrag) >= 12) {
        const d = Math.sign(knobDrag);
        knobDrag -= d * 12;
        if (p.id === "fgen:knob") {
          bench.gen.nudge(d, ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1);
          fgen3d.turnKnob(d);
        } else turnScopeKnob(p.id.slice(11) as ScopeKnob, d);
        audio.click();
      }
      return;
    }
    const mult = ev.shiftKey ? 10 : ev.altKey ? 0.1 : 1;
    if (p.id === "psu:knob:V") bench.psu.setVoltage(bench.psu.vset + dy * 0.02 * mult, bench.time);
    else bench.psu.setCurrent(bench.psu.iset + dy * 0.002 * mult, bench.time);
    panel.syncPsuInputs();
  },
  move(p) {
    if (!holding) return;
    preview = targetFromPick(p);
    bb.showMarker(preview?.kind === "hole" ? preview.hole : null);
  },
  contextMenu() {
    if (holding) setHolding(null);
  },
  aiming() {
    return holding !== null;
  },
  skip(id) {
    // con una punta en la mano, las puntas no se pueden tocar y taparían el agujero apuntado
    return holding !== null && id.startsWith("probe:");
  },
  aimEmptyLabel() {
    return `<span class="k">Soltar acá devuelve la punta a la mesa</span>`;
  },
});

// los desplegables del panel sueltan el foco al cambiar, así los atajos de teclado siguen andando
document.addEventListener("change", (e) => {
  if (e.target instanceof HTMLSelectElement) e.target.blur();
});

window.addEventListener("keydown", (e) => {
  if ((e.target as HTMLElement).closest("input, select, textarea")) return;
  audio.unlock();
  if (e.key === "Escape") setHolding(null);
  else if (e.key === "r" || e.key === "R") setHolding("red");
  else if (e.key === "n" || e.key === "N") setHolding("black");
  else if (e.key === " ") {
    e.preventDefault();
    panel.noteReading();
  } else if (e.key === "o" || e.key === "O") toggleOutput();
  else if (/^[1-6]$/.test(e.key)) world.goTo(Object.values(VIEWS)[Number(e.key) - 1]);
});

// ------------------------------------------------------------------ pistas contextuales
function computeHint(): string {
  const b = bench;
  const d = b.dmm;
  const t = (s: string) => `<span class="i">💡</span> ${s}`;
  const w = (s: string) => `<span class="i">⚠️</span> ${s}`;
  if (holding)
    return t(
      IS_TOUCH
        ? `Sosteniendo <b>${HOLD_NAME[holding]}</b>: apoyá el dedo sobre la mesa y arrastrá. La mira va un poco más arriba del dedo; al soltar, se apoya donde está la mira. Soltar en un lugar vacío la devuelve a la mesa.`
        : `Sosteniendo <b>${HOLD_NAME[holding]}</b>: hacé clic en un agujero del protoboard, en la pata de un componente o en un borne de la fuente. <kbd>Esc</kbd> cancela.`,
    );
  if (b.groundLoop())
    return w(
      "<b>Lazo de masa</b>: la pinza de masa del osciloscopio y la del generador van las dos a la tierra del enchufe. Al apoyarla en otro nodo, ese nodo queda en corto con la masa del generador. Usá un solo punto de masa (el riel −) y medí las diferencias con dos canales.",
    );
  const swollen = [...b.caps.values()].find((c) => c.state === "inflado");
  if (swollen) return w(`<b>${swollen.id}</b> está inflado (abierto). Reemplazalo en el panel de componentes.`);
  const hotCap = [...b.caps.values()].find((c) => c.reversed && c.tempC > 40);
  if (hotCap) return w(`<b>${hotCap.id}</b> está al revés y se calienta (${hotCap.tempC.toFixed(0)} °C): la fuga inversa lo hace conducir como un diodo. Dalo vuelta.`);
  if (b.circuit.gen && !b.gen.output) return t(`La salida del generador está apagada: presioná <b>OUTPUT</b> en el generador (o en el panel).`);
  if (d.leadAlert) return w("<b>LEAd</b>: la punta roja está en una borna de corriente pero la llave no está en ese modo. Así el multímetro es un <b>cortocircuito</b> entre las puntas.");
  if ((d.dial === "mA" && d.fuseMa.blown) || (d.dial === "A" && d.fuseA.blown)) return w("El fusible de esa borna está quemado: el multímetro va a marcar 0. Cambialo en el panel.");
  const hot = [...b.diodes.values()].find((p) => p.state === "ok" && p.model.led && p.current > p.model.ifMax);
  if (hot) return w(`<b>${hot.id}</b> conduce ${formatSI(hot.current, "A", 2)} y su máximo es ${formatSI(hot.model.ifMax, "A")}: se está calentando (${hot.tempC.toFixed(0)} °C).`);
  const burnt = [...b.diodes.values()].find((p) => p.state === "quemado");
  if (burnt) return w(`<b>${burnt.id}</b> está quemado (abierto). Reemplazalo en el panel de componentes.`);
  if ((d.dial === "mA" || d.dial === "A") && d.red === "VOhm") return t(`Para medir corriente pasá la punta roja a la borna <b>${d.dial === "A" ? "10A" : "mA"}</b>.`);
  if ((d.dial === "mA" || d.dial === "A") && !b.jumperRemoved())
    return t(`El amperímetro va en <b>serie</b>: quitá un puente (${TAP.toLowerCase()} sobre él) y apoyá las puntas en los dos agujeros que quedaron sueltos.`);
  if ((d.dial === "OHM" || d.dial === "CONT") && b.psu.output) return w("Estás midiendo resistencia con la fuente encendida: la lectura no es válida. Apagá la salida (OUTPUT).");
  if (d.dial === "DIODE" && b.psu.output) return w("La prueba de diodos se hace con el circuito <b>sin alimentar</b>: apagá la salida (OUTPUT).");
  if (d.dial === "DIODE")
    return t(
      "<b>▶︎| Prueba de diodos</b>: el multímetro inyecta 1 mA. Punta roja en el ánodo y negra en el cátodo: marca la caída en directa (≈ 0,55 V un diodo de silicio, 1,6–2,7 V un LED, que además se prende apenas). Al revés marca <b>OL</b>.",
    );
  if (d.dial === "OHM" && b.probes.red && b.probes.black && b.jumpersAsBuilt())
    return t("Medir un resistor <b>en el circuito</b> incluye los caminos en paralelo. Para medirlo solo, abrí los puentes que lo conectan al resto.");
  if (d.dial === "VAC" && !b.transient) return t("En V~ (alterna) una tensión continua se lee ≈ 0: el instrumento bloquea la componente DC.");
  if (d.dial === "VAC") return t("En V~ el multímetro mide el valor eficaz verdadero (TRUE RMS) de la parte alterna, con un ancho de banda de unos pocos kHz: a frecuencias altas lee de menos.");
  if (d.dial === "VDC" && b.transient && b.circuit.gen) return t("Con una señal que varía, en V⎓ el multímetro muestra el <b>promedio</b>: integra durante ≈ 0,3 s. Para ver la forma de onda está el osciloscopio.");
  if (b.circuit.gen && d.dial === "OFF") {
    const sc = b.scope;
    if (b.speed < 0.95) return t(`La señal es rápida para este equipo: la simulación va en cámara lenta (×${b.speed.toFixed(2).replace(".", ",")}). En el osciloscopio no se nota: la traza es la misma.`);
    if (sc.measures.every((m) => m?.clipped)) return t("La señal no entra en la pantalla: girá VOLTS/DIV (o usá <b>AUTOSET</b>) hasta que ocupe unas 6 divisiones.");
    if (sc.cursor.mode === "off")
      return t(`Para medir tiempos y tensiones encendé los cursores con <b>CURSOR</b> y arrastralos sobre la pantalla${IS_TOUCH ? " del panel" : " (la del osciloscopio o la del panel)"}. <b>AUTOSET</b> acomoda las escalas solo.`);
    return t(`Cursores de ${sc.cursor.mode === "time" ? "tiempo: ΔT es el tiempo entre A y B, y 1/ΔT la frecuencia si abarcan un período" : "tensión: ΔV es la diferencia entre A y B"}. El cursor que se mueve es el más cercano a donde ${IS_TOUCH ? "apoyás el dedo" : "hacés clic"}.`);
  }
  if (d.dial === "OFF") return t(IS_TOUCH ? "Encendé el multímetro: tocá la llave del lado derecho para girarla (o elegí la función en el panel)." : "Encendé el multímetro girando la llave (clic o rueda sobre ella).");
  if (!b.psu.output && !b.circuit.gen && (d.dial === "VDC" || d.dial === "mA" || d.dial === "A")) return t(`La salida de la fuente está apagada: presioná <b>OUTPUT</b>${IS_TOUCH ? "" : " (o la tecla <kbd>O</kbd>)"}.`);
  if (!b.probes.red || !b.probes.black) return t(IS_TOUCH ? "Tomá una punta (botones del panel o tocándola en la mesa) y apoyala en el circuito." : "Tomá las puntas (clic en ellas, o teclas <kbd>R</kbd> y <kbd>N</kbd>) y apoyalas en el circuito.");
  if (b.psu.output && b.psu.mode === "CC") return t("La fuente está en <b>CC</b>: limita la corriente y baja la tensión. Subí el límite de corriente si querés que vuelva a CV.");
  return t(`Anotá las lecturas en el cuaderno${IS_TOUCH ? "" : " (<kbd>Espacio</kbd>)"} para calcular la potencia.`);
}

// ------------------------------------------------------------------ carga de assets
let simready: Map<string, THREE.Object3D> | null = null;
const loading = document.getElementById("loading")!;
const bar = loading.querySelector<HTMLElement>(".bar i")!;
const label = loading.querySelector<HTMLElement>(".label")!;
const assetsReady = loadSimReady(scene, quality, (n, total, id) => {
  bar.style.width = `${(n / total) * 100}%`;
  label.textContent = n < total ? `Cargando SimReady · ${id}` : "Listo";
}).then((objs) => {
  simready = objs;
  const lamp = objs.get("lamp_table_bedside_a01");
  lamp?.traverse((o) => {
    const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
    if (m && /emissive/i.test(m.name)) {
      m.emissive = new THREE.Color("#ffe2b8");
      m.emissiveIntensity = 1.4;
    }
  });
  shadowInvalidator.invalidate();
  if (CAPTURE) loading.classList.add("done");
  else setTimeout(() => loading.classList.add("done"), 300);
});

// ------------------------------------------------------------------ loop
// sombras: solo se recalculan si se movió o cambió algo que proyecta sombra
const shadowInvalidator = new ShadowInvalidator(world.renderer, [dmm3d.group, psu3d.group, scope3d.group, fgen3d.group, bb.group, genPins, ...PROBE_IDS.map((p) => probes[p].group), ...Object.values(cables).map((c) => c.mesh)]);
let acc = 0;
let uiTimer = 0;
const SIM_DT = 0.02;
function stepFrame(dt: number): void {
  acc = Math.min(0.25, acc + dt);
  while (acc >= SIM_DT) {
    bench.step(SIM_DT);
    acc -= SIM_DT;
  }

  dmm3d.update(bench.dmm.display, bench.dmm.dial, bench.dmm.red, dt, bench.time);
  psu3d.update(bench.psu, bench.time);
  scope3d.maxFps = scopeRedrawRate();
  scope3d.update(bench.scope, CAPTURE ? bench.time : performance.now() / 1000, bench.speed);
  fgen3d.update(bench.gen, bench.time);
  for (const part of bench.parts.values()) bb.syncResistor(part);
  for (const part of bench.diodes.values()) bb.syncDiode(part);
  for (const part of bench.caps.values()) bb.syncCap(part);
  bb.updateLeds(bench.diodes);
  for (const [id, present] of bench.jumperPresent) bb.setJumper(id, present);
  bb.setSmoke([
    ...[...bench.parts.values()].filter((p) => p.state === "humo" || (p.state === "quemado" && p.tempC > 120)).map((p) => bb.resistorCenterWorld(p.id)!),
    ...[...bench.diodes.values()].filter((p) => p.state === "quemado" && p.tempC > 90).map((p) => bb.diodeCenterWorld(p.id)!),
    ...[...bench.caps.values()].filter((p) => p.state === "inflado" && p.tempC > 90).map((p) => bb.capCenterWorld(p.id)!),
  ]);
  bb.tick(dt);

  for (const c of PROBE_IDS) {
    const pose = holding === c && preview ? probePose(c, preview, true) : probePose(c, bench.probes[c]);
    probes[c].setTarget(pose.tip, pose.dir);
    probes[c].tick(dt);
  }
  for (const c of ["red", "black"] as const) {
    const exit = dmm3d.plugExit(c);
    cables[c].update(exit.pos, exit.dir, probes[c].tail(), probes[c].dir, 1.1);
  }
  for (const [c, n] of [
    ["ch1", 1],
    ["ch2", 2],
  ] as const) {
    const bnc = scope3d.bncWorld(n);
    cables[c].update(bnc.pos, bnc.dir, probes[c].tail(), probes[c].dir, 1.0);
  }
  // el cablecito de masa sale del cuerpo de la punta CH1, a unos centímetros de la punta
  const gndFrom = (probes.ch1 as ScopeProbe3D).along(26);
  cables.sgnd.update(gndFrom, probes.ch1.dir, probes.sgnd.tail(), probes.sgnd.dir, 0.6, 0.008);
  if (genPinTop) {
    const bnc = fgen3d.bncWorld();
    cables.genRed.update(bnc.pos, bnc.dir, genPinTop.pos, new V3(0, 1, 0), 0.9, 0.012);
    cables.genBlack.update(bnc.pos, bnc.dir, genPinTop.neg, new V3(0, 1, 0), 0.9, 0.012);
  }
  for (const [post, cable] of [
    ["psu+", cables.psuRed],
    ["psu-", cables.psuBlack],
  ] as const) {
    const s = psu3d.postCableStart(post);
    const fwd = psu3d.postWorld(post).dir;
    cable.update(s, fwd.clone().add(new V3(0, -0.4, 0)).normalize(), pinTop[post], new V3(0, 1, 0), 0.9, 0.012);
  }

  const d = bench.dmm.display;
  audio.setBeep(d.leadAlert ? Math.floor(bench.time * 4) % 2 === 0 : d.beep);

  uiTimer -= dt;
  if (uiTimer <= 0) {
    uiTimer = 0.2;
    panel.update();
    panel.setHint(computeHint());
  }
  world.tick(dt);
  shadowInvalidator.check();
  world.renderer.render(scene, camera);
}

if (CAPTURE) {
  // modo captura: el tiempo avanza solo cuando el grabador pide un cuadro (ver tools/record-showcase.mjs)
  installCapture({ world, bench, bb, stepFrame, ready: assetsReady });
} else {
  const adaptive = new AdaptiveResolution(
    world.renderer,
    () => ({ w: viewportEl.clientWidth, h: viewportEl.clientHeight }),
    quality.minPixelRatio,
    Math.min(window.devicePixelRatio, quality.maxPixelRatio),
  );
  // si ni en la resolución mínima anda fluido (equipo de gama baja que no se detectó al arrancar),
  // pasa a la versión liviana sin recargar: mesa simplificada y sombras de 2048
  adaptive.onStruggle = () => {
    if (quality.lite || !simready || new URLSearchParams(location.search).get("calidad") === "alta") return;
    Object.assign(quality, QUALITY.baja);
    world.setShadowMapSize(quality.shadowMapSize);
    adaptive.setMax(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
    void swapToLiteModels(scene, simready).then(() => shadowInvalidator.invalidate());
    toast("El equipo iba lento: pasé a la <b>calidad liviana</b> (mesa simplificada y sombras más chicas). Para volver, entrá con <code>?calidad=alta</code>.", "info");
  };
  if (import.meta.env.DEV) Object.assign(window, { adaptive });
  let last = performance.now();
  const loop = (now: number) => {
    const raw = (now - last) / 1000;
    last = now;
    adaptive.tick(raw);
    stepFrame(Math.min(0.1, raw));
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

// para depurar desde la consola
if (import.meta.env.DEV || CAPTURE) Object.assign(window, { bench, world, bb, dmm3d, psu3d, scope3d, fgen3d, THREE, quality });
