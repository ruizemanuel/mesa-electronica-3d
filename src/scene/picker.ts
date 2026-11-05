import * as THREE from "three";
import type { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

export interface PickHit {
  id: string;
  hit: THREE.Intersection;
}

export interface PickHandlers {
  label(p: PickHit): string | null;
  click(p: PickHit | null, ev: PointerEvent): void;
  /** Devuelve true si consume la rueda (para que no haga zoom). */
  wheel?(p: PickHit, delta: number, ev: WheelEvent): boolean;
  wantsWheel?(p: PickHit): boolean;
  /** Arrastre vertical sobre un control (perillas). */
  canDrag?(p: PickHit): boolean;
  drag?(p: PickHit, dy: number, ev: PointerEvent): void;
  move?(p: PickHit | null, ev: PointerEvent): void;
  contextMenu?(): void;
  /**
   * Con el dedo, mientras devuelva true (p. ej. sosteniendo una punta) se apunta con una mira
   * desplazada por encima del dedo: apoyar, arrastrar y soltar dispara click() en la mira.
   */
  aiming?(): boolean;
  /** Texto del cartel mientras se apunta y la mira no está sobre nada. */
  aimEmptyLabel?(): string | null;
  /** Objetos a ignorar en el pick (p. ej. la punta que se está sosteniendo, que tapa el agujero). */
  skip?(id: string): boolean;
}

/** Distancia (px) entre el dedo y la mira: el dedo tapa justo lo que se quiere tocar. */
const AIM_OFFSET = 64;
const AIM_SVG = `<svg viewBox="0 0 34 34" width="34" height="34"><circle cx="17" cy="17" r="7" fill="none" stroke="#2ef2ff" stroke-width="2.4"/><path d="M17 1v9M17 24v9M1 17h9M24 17h9" stroke="#fff" stroke-width="2.6" stroke-linecap="round"/><path d="M17 1v9M17 24v9M1 17h9M24 17h9" stroke="#111" stroke-width="1" stroke-linecap="round"/></svg>`;

export class Picker {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private hovered: PickHit | null = null;
  private down: { x: number; y: number; p: PickHit | null; dragging: boolean; lastY: number; touch: boolean } | null = null;
  private aim: { id: number } | null = null;
  private readonly tip: HTMLDivElement;
  private readonly aimEl: HTMLDivElement;
  private tipTimer = 0;

  constructor(
    private readonly camera: THREE.Camera,
    private readonly dom: HTMLElement,
    private readonly controls: OrbitControls,
    private readonly roots: THREE.Object3D[],
    private readonly h: PickHandlers,
  ) {
    this.ray.params.Points = { threshold: 0.0005 };
    this.tip = document.createElement("div");
    this.tip.className = "tooltip";
    document.body.appendChild(this.tip);
    this.aimEl = document.createElement("div");
    this.aimEl.className = "aim";
    this.aimEl.innerHTML = AIM_SVG;
    document.body.appendChild(this.aimEl);
    dom.addEventListener("pointermove", (e) => this.onMove(e));
    dom.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
    window.addEventListener("pointercancel", (e) => this.onCancel(e));
    dom.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });
    dom.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      this.h.contextMenu?.();
    });
    dom.addEventListener("pointerleave", () => {
      this.tip.style.opacity = "0";
    });
  }

  /** Rayo del último pick (útil para intersectar planos). */
  get lastRay(): THREE.Ray {
    return this.ray.ray;
  }

  pick(ev: { clientX: number; clientY: number }): PickHit | null {
    const r = this.dom.getBoundingClientRect();
    this.ndc.set(((ev.clientX - r.left) / r.width) * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
    this.ray.setFromCamera(this.ndc, this.camera);
    const hits = this.ray.intersectObjects(this.roots, true);
    for (const hit of hits) {
      const id = hit.object.userData.pick as string | undefined;
      if (id && !this.h.skip?.(id)) return { id, hit };
    }
    return null;
  }

  private aimPoint(e: PointerEvent): { clientX: number; clientY: number } {
    return { clientX: e.clientX, clientY: e.clientY - AIM_OFFSET };
  }

  private aimUpdate(e: PointerEvent): void {
    const pt = this.aimPoint(e);
    const p = this.pick(pt);
    this.h.move?.(p, e);
    this.aimEl.classList.add("on");
    this.aimEl.style.transform = `translate(${pt.clientX}px, ${pt.clientY}px)`;
    const label = p ? this.h.label(p) : (this.h.aimEmptyLabel?.() ?? null);
    this.placeTip(label, pt, "top");
  }

  private endAim(): void {
    this.aim = null;
    this.controls.enabled = true;
    this.aimEl.classList.remove("on");
    this.tip.style.opacity = "0";
  }

  private onCancel(e: PointerEvent): void {
    if (this.aim && e.pointerId === this.aim.id) {
      this.endAim();
      this.h.move?.(null, e);
    }
    this.down = null;
    this.controls.enabled = true;
    this.controls.enableRotate = true;
  }

  private onMove(e: PointerEvent): void {
    if (this.aim) {
      if (e.pointerId === this.aim.id) this.aimUpdate(e);
      return;
    }
    if (this.down?.dragging && this.down.p) {
      const dy = this.down.lastY - e.clientY;
      this.down.lastY = e.clientY;
      this.h.drag?.(this.down.p, dy, e);
      this.showTip(this.down.p, e);
      return;
    }
    const tol = this.down?.touch ? 10 : 4;
    if (this.down && !this.down.dragging && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > tol && this.down.p && this.h.canDrag?.(this.down.p)) {
      this.down.dragging = true;
      this.controls.enabled = false;
    }
    if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > tol) {
      this.tip.style.opacity = "0";
      return; // orbitando
    }
    const p = this.pick(e);
    this.hovered = p;
    this.controls.enableZoom = !(p && this.h.wantsWheel?.(p));
    this.dom.style.cursor = p ? "pointer" : "default";
    this.h.move?.(p, e);
    this.showTip(p, e);
  }

  private showTip(p: PickHit | null, e: { clientX: number; clientY: number }): void {
    this.placeTip(p ? this.h.label(p) : null, e, "below");
  }

  private placeTip(label: string | null, e: { clientX: number; clientY: number }, place: "below" | "above" | "top"): void {
    if (!label) {
      this.tip.style.opacity = "0";
      return;
    }
    this.tip.innerHTML = label;
    this.tip.style.opacity = "1";
    const w = this.tip.offsetWidth;
    const h = this.tip.offsetHeight;
    let x = place === "below" ? e.clientX + 16 : e.clientX - w / 2;
    let y = place === "above" ? e.clientY - 26 - h : e.clientY + 18;
    if (place === "top") {
      // arriba de la vista 3D, centrado: no tapa lo que se está apuntando
      const r = this.dom.getBoundingClientRect();
      x = r.left + (r.width - w) / 2;
      y = r.top + 8;
    }
    x = Math.max(8, Math.min(window.innerWidth - w - 8, x));
    y = Math.max(8, Math.min(window.innerHeight - h - 8, y));
    this.tip.style.transform = `translate(${x}px, ${y}px)`;
  }

  /** En pantallas táctiles no hay "sacar el mouse": el cartel se va solo. */
  private autoHideTip(): void {
    clearTimeout(this.tipTimer);
    this.tipTimer = window.setTimeout(() => (this.tip.style.opacity = "0"), 2600);
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0 || this.aim) return;
    if (e.pointerType === "touch" && this.h.aiming?.()) {
      this.aim = { id: e.pointerId };
      this.controls.enabled = false;
      clearTimeout(this.tipTimer);
      this.aimUpdate(e);
      return;
    }
    const p = this.pick(e);
    this.down = { x: e.clientX, y: e.clientY, p, dragging: false, lastY: e.clientY, touch: e.pointerType === "touch" };
    if (p && this.h.canDrag?.(p)) this.controls.enableRotate = false;
  }

  private onUp(e: PointerEvent): void {
    if (this.aim) {
      if (e.pointerId !== this.aim.id) return;
      const pt = this.aimPoint(e);
      this.endAim();
      this.h.click(this.pick(pt), e);
      return;
    }
    if (e.button !== 0 || !this.down) return;
    const d = this.down;
    this.down = null;
    this.controls.enabled = true;
    this.controls.enableRotate = true;
    if (d.dragging) {
      if (d.touch) this.autoHideTip();
      return;
    }
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > (d.touch ? 10 : 4)) return;
    if (e.target !== this.dom) return;
    this.h.click(this.pick(e), e);
    this.onMove(e);
    if (d.touch) this.autoHideTip();
  }

  private onWheel(e: WheelEvent): void {
    const p = this.hovered ?? this.pick(e);
    if (p && this.h.wheel?.(p, Math.sign(e.deltaY), e)) {
      e.preventDefault();
      e.stopPropagation();
      this.showTip(p, e as unknown as PointerEvent);
    }
  }

  refreshTip(e: PointerEvent): void {
    this.onMove(e);
  }
}
