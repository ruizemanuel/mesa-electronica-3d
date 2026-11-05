import "./style.css";
import * as THREE from "three";
import { BenchAudio } from "./audio";
import { Breadboard3D } from "./scene/breadboard3d";
import { Dmm3D, type DmmButton } from "./scene/dmm3d";
import { Cable, Probe3D } from "./scene/leads";
import { Picker, type PickHit } from "./scene/picker";
import { Psu3D } from "./scene/psu3d";
import { MM, shadows, std } from "./scene/util";
import { BENCH_TOP, VIEWS, createWorld, loadSimReady, swapToLiteModels } from "./scene/world";
import { Bench, type ProbeColor, type ProbeTarget, type PsuPost } from "./sim/bench";
import { netOfHole } from "./sim/circuits";
import { DIAL_LABEL, type Jack } from "./sim/dmm";
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

const bb = new Breadboard3D();
bb.group.position.set(-0.02, BENCH_TOP, 0.1);
scene.add(bb.group);
bb.build(bench.circuit, bench.parts, bench.diodes);

const probes: Record<ProbeColor, Probe3D> = { red: new Probe3D("red", "#c8261f"), black: new Probe3D("black", "#1b1b1b") };
scene.add(probes.red.group, probes.black.group);
const cables = {
  red: new Cable("#c8261f", 1.8 * MM, BENCH_TOP),
  black: new Cable("#1b1b1b", 1.8 * MM, BENCH_TOP),
  psuRed: new Cable("#c62a22", 1.6 * MM, BENCH_TOP),
  psuBlack: new Cable("#1b1b1b", 1.6 * MM, BENCH_TOP),
};
for (const c of Object.values(cables)) scene.add(c.mesh);

// cables de la fuente al protoboard (terminan en un pin en los rieles)
const PSU_PIN: Record<"psu+" | "psu-", string> = { "psu+": "RT+:2", "psu-": "RB-:2" };
function makePin(color: string, hole: string): THREE.Vector3 {
  const g = new THREE.Group();
  const pin = new THREE.Mesh(new THREE.CylinderGeometry(0.32 * MM, 0.32 * MM, 9 * MM, 8), std("#cfd2d6", 0.3, 0.9));
  pin.position.y = -1 * MM;
  const boot = new THREE.Mesh(new THREE.CylinderGeometry(1.6 * MM, 2.0 * MM, 13 * MM, 16), std(color, 0.5));
  boot.position.y = 10 * MM;
  g.add(pin, boot);
  g.position.copy(bb.holeWorld(hole));
  shadows(g, true, false);
  scene.add(g);
  return g.position.clone().add(new V3(0, 16.5 * MM, 0));
}
const pinTop = { "psu+": makePin("#c62a22", PSU_PIN["psu+"]), "psu-": makePin("#1b1b1b", PSU_PIN["psu-"]) };

// posición de reposo de las puntas sobre la mesa
const REST: Record<ProbeColor, { tip: THREE.Vector3; dir: THREE.Vector3 }> = {
  red: { tip: new V3(0.125, BENCH_TOP + 0.0035, 0.228), dir: new V3(0.62, 0.06, -0.36).normalize() },
  black: { tip: new V3(0.14, BENCH_TOP + 0.0035, 0.206), dir: new V3(0.66, 0.06, -0.3).normalize() },
};

function probePose(c: ProbeColor, t: ProbeTarget, hover = false): { tip: THREE.Vector3; dir: THREE.Vector3 } {
  if (!t) return REST[c];
  const side = c === "red" ? 1 : -1;
  if (t.kind === "hole") {
    const tip = bb.holeWorld(t.hole, hover ? -3 : 1.5);
    // mangos inclinados hacia atrás y hacia afuera para no tapar el protoboard
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

let holding: ProbeColor | null = null;
let preview: ProbeTarget = null;

function setHolding(c: ProbeColor | null): void {
  holding = c;
  preview = null;
  bb.showMarker(null);
  document.body.classList.toggle("holding", !!c);
}

function placeProbe(c: ProbeColor, t: ProbeTarget): void {
  bench.probes[c] = t;
  bench.refreshDmm();
  audio.click();
}

const panel = new Panel(bench, {
  loadCircuit(id) {
    bench.loadCircuit(id);
    bb.build(bench.circuit, bench.parts, bench.diodes);
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
  pickProbe(c) {
    audio.unlock();
    setHolding(c);
  },
  toggleMute() {
    audio.muted = !audio.muted;
    return audio.muted;
  },
});

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
  if (p.id.startsWith("resistor:") || p.id.startsWith("jumper:") || p.id.startsWith("diode:")) {
    // primero el agujero que está realmente bajo el cursor (el rayo cortando la superficie)
    const onBoard = holeUnderRay();
    if (onBoard) return { kind: "hole", hole: onBoard };
    const holes = p.id.startsWith("resistor:")
      ? bb.resistorHoles(p.id.slice(9))
      : p.id.startsWith("diode:")
        ? bb.diodeHoles(p.id.slice(6))
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

const picker = new Picker(camera, world.renderer.domElement, world.controls, [dmm3d.group, psu3d.group, bb.group, probes.red.group, probes.black.group], {
  label(p) {
    const id = p.id;
    if (holding) {
      const t = targetFromPick(p);
      const who = holding === "red" ? "roja" : "negra";
      if (t) return `${t.kind === "hole" ? holeLabel(t.hole) : POST_LABEL[t.post]}<br><span class="k">${IS_TOUCH ? "Soltá" : "Clic"}: apoyar la punta ${who}</span>`;
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
    if (id.startsWith("probe:")) return `Punta ${id.endsWith("red") ? "roja" : "negra"}<br><span class="k">${TAP} para tomarla</span>`;
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
    if (id.startsWith("probe:")) setHolding(id.slice(6) as ProbeColor);
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
    return p.id === "dmm:dial" || p.id.startsWith("psu:knob:");
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
    return false;
  },
  canDrag(p) {
    return p.id.startsWith("psu:knob:");
  },
  drag(p, dy, ev) {
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
  else if (/^[1-4]$/.test(e.key)) world.goTo(Object.values(VIEWS)[Number(e.key) - 1]);
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
        ? `Sosteniendo la punta <b>${holding === "red" ? "roja" : "negra"}</b>: apoyá el dedo sobre la mesa y arrastrá. La mira va un poco más arriba del dedo; al soltar, la punta se apoya donde está la mira. Soltar en un lugar vacío la devuelve a la mesa.`
        : `Sosteniendo la punta <b>${holding === "red" ? "roja" : "negra"}</b>: hacé clic en un agujero del protoboard, en la pata de un componente o en un borne de la fuente. <kbd>Esc</kbd> cancela.`,
    );
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
  if (d.dial === "VAC") return t("En V~ (alterna) una tensión continua se lee ≈ 0: el instrumento bloquea la componente DC.");
  if (d.dial === "OFF") return t(IS_TOUCH ? "Encendé el multímetro: tocá la llave del lado derecho para girarla (o elegí la función en el panel)." : "Encendé el multímetro girando la llave (clic o rueda sobre ella).");
  if (!b.psu.output && (d.dial === "VDC" || d.dial === "mA" || d.dial === "A")) return t(`La salida de la fuente está apagada: presioná <b>OUTPUT</b>${IS_TOUCH ? "" : " (o la tecla <kbd>O</kbd>)"}.`);
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
const shadowInvalidator = new ShadowInvalidator(world.renderer, [dmm3d.group, psu3d.group, bb.group, probes.red.group, probes.black.group, ...Object.values(cables).map((c) => c.mesh)]);
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
  for (const part of bench.parts.values()) bb.syncResistor(part);
  for (const part of bench.diodes.values()) bb.syncDiode(part);
  bb.updateLeds(bench.diodes);
  for (const [id, present] of bench.jumperPresent) bb.setJumper(id, present);
  bb.setSmoke([
    ...[...bench.parts.values()].filter((p) => p.state === "humo" || (p.state === "quemado" && p.tempC > 120)).map((p) => bb.resistorCenterWorld(p.id)!),
    ...[...bench.diodes.values()].filter((p) => p.state === "quemado" && p.tempC > 90).map((p) => bb.diodeCenterWorld(p.id)!),
  ]);
  bb.tick(dt);

  for (const c of ["red", "black"] as ProbeColor[]) {
    const pose = holding === c && preview ? probePose(c, preview, true) : probePose(c, bench.probes[c]);
    probes[c].setTarget(pose.tip, pose.dir);
    probes[c].tick(dt);
    const exit = dmm3d.plugExit(c);
    cables[c].update(exit.pos, exit.dir, probes[c].tail(), probes[c].dir, 1.1);
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
if (import.meta.env.DEV || CAPTURE) Object.assign(window, { bench, world, bb, dmm3d, psu3d, THREE, quality });
