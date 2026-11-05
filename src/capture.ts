/**
 * Modo captura (?capture): el grabador (tools/record-showcase.mjs) avanza el tiempo cuadro a
 * cuadro con `__capture.frame(dt)` y saca una captura por cuadro. Así el video sale a 60 fps
 * exactos aunque el render de cada cuadro tarde más que 16 ms.
 *
 * Agrega overlays solo para el video: subtítulos, placas de título, un cursor visible y el
 * "ripple" de los clics (los navegadores headless no dibujan el cursor).
 */
import * as THREE from "three";
import type { Bench } from "./sim/bench";
import type { Breadboard3D } from "./scene/breadboard3d";
import type { World } from "./scene/world";

interface CaptureCtx {
  world: World;
  bench: Bench;
  bb: Breadboard3D;
  stepFrame(dt: number): void;
  ready: Promise<unknown>;
}

type Vec3 = [number, number, number];

const CURSOR_ARROW = `<svg width="26" height="26" viewBox="0 0 26 26"><path d="M3 2 L3 21 L8 16.5 L11.6 24 L15 22.4 L11.5 15 L18 15 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
const CURSOR_HAND = `<svg width="26" height="28" viewBox="0 0 26 28"><path d="M9 13 V4.5 a2 2 0 0 1 4 0 V12 V10 a2 2 0 0 1 4 0 V12.5 a2 2 0 0 1 4 0 V18 c0 5 -3 8 -7.5 8 h-1.5 c-3 0 -4.6 -1.4 -6.3 -4 L3.2 17 a2 2 0 0 1 3.2 -2.3 L9 17.5 Z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>`;

export function installCapture(ctx: CaptureCtx): void {
  const { world, bench } = ctx;
  const canvas = world.renderer.domElement;
  const viewport = document.getElementById("viewport")!;

  // ---------------------------------------------------------------- overlays
  const cap = document.createElement("div");
  cap.className = "cap-caption";
  cap.innerHTML = `<b></b><span></span>`;
  viewport.appendChild(cap);

  const card = document.createElement("div");
  card.className = "cap-card";
  card.innerHTML = `<div class="in"><small></small><h1></h1><p></p></div>`;
  document.body.appendChild(card);

  const cursor = document.createElement("div");
  cursor.className = "cap-cursor";
  cursor.innerHTML = CURSOR_ARROW;
  document.body.appendChild(cursor);
  let cursorKind: "arrow" | "hand" | "cross" = "arrow";

  const ripples: { el: HTMLDivElement; t: number }[] = [];
  let mouse = { x: -100, y: -100 };
  window.addEventListener("pointermove", (e) => (mouse = { x: e.clientX, y: e.clientY }), true);
  window.addEventListener(
    "pointerdown",
    (e) => {
      const el = document.createElement("div");
      el.className = "cap-ripple";
      el.style.left = `${e.clientX}px`;
      el.style.top = `${e.clientY}px`;
      document.body.appendChild(el);
      ripples.push({ el, t: 0 });
    },
    true,
  );

  const fade = { cap: 0, capTarget: 0, card: 0, cardTarget: 0 };
  let lastCamKey = "";

  // ---------------------------------------------------------------- proyección
  const findTagged = (id: string): THREE.Object3D | null => {
    let found: THREE.Object3D | null = null;
    world.scene.traverse((o) => {
      if (found || o.userData.pick !== id) return;
      // raíz del subárbol etiquetado
      let r = o;
      while (r.parent && r.parent.userData.pick === id) r = r.parent;
      found = r;
    });
    return found;
  };

  const toScreen = (w: THREE.Vector3): [number, number] => {
    const v = w.clone().project(world.camera);
    const r = canvas.getBoundingClientRect();
    return [r.left + ((v.x + 1) / 2) * r.width, r.top + ((1 - v.y) / 2) * r.height];
  };

  const bb = () => ctx.bb;

  /** Punto 3D (mundo) de un objeto interactivo. Admite "hole:14b", "jumper:J1", "resistor:R1", "dial+", "dial-" o cualquier id de pick. */
  const worldOf = (target: string): THREE.Vector3 | null => {
    if (target.startsWith("hole:")) return bb().holeWorld(target.slice(5));
    if (target.startsWith("jumper:")) return bb().jumperMidWorld(target.slice(7));
    if (target.startsWith("resistor:")) return bb().resistorCenterWorld(target.slice(9));
    if (target.startsWith("diode:")) return bb().diodeCenterWorld(target.slice(6));
    if (target === "dial+" || target === "dial-") {
      const knob = findTagged("dmm:dial");
      if (!knob) return null;
      const body = knob.parent!;
      const p = knob.position.clone().add(new THREE.Vector3(target === "dial+" ? 0.011 : -0.011, 0, 0.008));
      return body.localToWorld(p);
    }
    const o = findTagged(target);
    if (!o) return null;
    return new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
  };

  // ---------------------------------------------------------------- API
  const api = {
    loaded: false,
    bench,
    /** Avanza la simulación y dibuja un cuadro. */
    frame(dt: number) {
      ctx.stepFrame(dt);
      // con la cámara en movimiento el tooltip queda desubicado: se oculta hasta el próximo movimiento del mouse
      const camKey = world.camera.matrixWorld.elements.map((v) => v.toFixed(5)).join(",");
      if (camKey !== lastCamKey) {
        const tip = document.querySelector<HTMLElement>(".tooltip");
        if (tip && lastCamKey) tip.style.opacity = "0";
        lastCamKey = camKey;
      }
      // overlays animados en tiempo virtual
      const k = Math.min(1, dt / 0.35);
      fade.cap += (fade.capTarget - fade.cap) * k;
      fade.card += (fade.cardTarget - fade.card) * Math.min(1, dt / 0.45);
      cap.style.opacity = fade.cap.toFixed(3);
      cap.style.transform = `translateY(${((1 - fade.cap) * 14).toFixed(1)}px)`;
      card.style.opacity = fade.card.toFixed(3);
      card.style.pointerEvents = "none";
      // cursor
      const holding = document.body.classList.contains("holding");
      const kind = holding ? "cross" : canvas.style.cursor === "pointer" || (document.elementFromPoint(mouse.x, mouse.y) as HTMLElement | null)?.closest("button, select, a") ? "hand" : "arrow";
      if (kind !== cursorKind) {
        cursorKind = kind;
        cursor.innerHTML = kind === "hand" ? CURSOR_HAND : kind === "cross" ? `<svg width="30" height="30" viewBox="0 0 30 30"><circle cx="15" cy="15" r="6" fill="none" stroke="#2ef2ff" stroke-width="2.2"/><path d="M15 2v8M15 20v8M2 15h8M20 15h8" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/><path d="M15 2v8M15 20v8M2 15h8M20 15h8" stroke="#111" stroke-width="0.8" stroke-linecap="round"/></svg>` : CURSOR_ARROW;
      }
      const off = kind === "cross" ? [-15, -15] : kind === "hand" ? [-9, -2] : [-3, -2];
      cursor.style.transform = `translate(${mouse.x + off[0]}px, ${mouse.y + off[1]}px)`;
      for (const r of ripples) {
        r.t += dt;
        const p = r.t / 0.45;
        r.el.style.opacity = String(Math.max(0, 0.85 * (1 - p)));
        r.el.style.transform = `translate(-50%, -50%) scale(${0.4 + p * 1.4})`;
      }
      while (ripples.length && ripples[0].t > 0.45) ripples.shift()!.el.remove();
    },
    cam(pos: Vec3, target: Vec3) {
      world.camera.position.set(...pos);
      world.controls.target.set(...target);
      world.controls.update();
    },
    getCam(): { pos: Vec3; target: Vec3 } {
      return { pos: world.camera.position.toArray() as Vec3, target: world.controls.target.toArray() as Vec3 };
    },
    caption(title: string | null, sub = "") {
      if (title === null) {
        fade.capTarget = 0;
        return;
      }
      cap.querySelector("b")!.innerHTML = title;
      cap.querySelector("span")!.innerHTML = sub;
      fade.capTarget = 1;
    },
    card(title: string | null, sub = "", kicker = "") {
      if (title === null) {
        fade.cardTarget = 0;
        return;
      }
      card.querySelector("h1")!.innerHTML = title;
      card.querySelector("p")!.innerHTML = sub;
      card.querySelector("small")!.innerHTML = kicker;
      fade.cardTarget = 1;
    },
    /** Coordenadas de pantalla (px CSS) de un objetivo 3D. */
    screen(target: string): [number, number] | null {
      const w = worldOf(target);
      return w ? toScreen(w) : null;
    },
    /**
     * Pose de cámara mirando de frente un objeto plano etiquetado (su +Z local), a `dist` m,
     * con `lift` m hacia arriba y `side` m hacia el costado.
     */
    facing(target: string, dist: number, lift = 0, side = 0): { pos: Vec3; target: Vec3 } | null {
      const o = findTagged(target);
      if (!o) return null;
      o.updateWorldMatrix(true, true);
      const c = new THREE.Box3().setFromObject(o).getCenter(new THREE.Vector3());
      const n = new THREE.Vector3(0, 0, 1).transformDirection(o.matrixWorld);
      const right = new THREE.Vector3().crossVectors(n, new THREE.Vector3(0, 1, 0)).normalize().negate();
      const pos = c.clone().addScaledVector(n, dist).add(new THREE.Vector3(0, lift, 0)).addScaledVector(right, side);
      return { pos: pos.toArray() as Vec3, target: c.toArray() as Vec3 };
    },
    /** Centro (px CSS) de un elemento del panel. */
    el(selector: string): [number, number] | null {
      const e = document.querySelector(selector);
      if (!e) return null;
      const r = e.getBoundingClientRect();
      return [r.left + r.width / 2, r.top + r.height / 2];
    },
    panelScroll(top: number | null) {
      const p = document.getElementById("panel")!;
      if (top === null) return p.scrollTop;
      p.scrollTop = top;
      return top;
    },
    /** scrollTop necesario para que `selector` quede cerca del borde superior del panel. */
    panelOffset(selector: string, margin = 12): number {
      const p = document.getElementById("panel")!;
      const e = p.querySelector(selector) as HTMLElement | null;
      if (!e) return 0;
      return e.getBoundingClientRect().top - p.getBoundingClientRect().top + p.scrollTop - margin;
    },
  };
  (window as unknown as { __capture: typeof api }).__capture = api;
  ctx.ready.then(() => {
    api.loaded = true;
  });
}
