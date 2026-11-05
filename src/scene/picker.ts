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
}

export class Picker {
  private readonly ray = new THREE.Raycaster();
  private readonly ndc = new THREE.Vector2();
  private hovered: PickHit | null = null;
  private down: { x: number; y: number; p: PickHit | null; dragging: boolean; lastY: number } | null = null;
  private readonly tip: HTMLDivElement;

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
    dom.addEventListener("pointermove", (e) => this.onMove(e));
    dom.addEventListener("pointerdown", (e) => this.onDown(e));
    window.addEventListener("pointerup", (e) => this.onUp(e));
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
      if (id) return { id, hit };
    }
    return null;
  }

  private onMove(e: PointerEvent): void {
    if (this.down?.dragging && this.down.p) {
      const dy = this.down.lastY - e.clientY;
      this.down.lastY = e.clientY;
      this.h.drag?.(this.down.p, dy, e);
      this.showTip(this.down.p, e);
      return;
    }
    if (this.down && !this.down.dragging && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4 && this.down.p && this.h.canDrag?.(this.down.p)) {
      this.down.dragging = true;
      this.controls.enabled = false;
    }
    if (this.down && Math.hypot(e.clientX - this.down.x, e.clientY - this.down.y) > 4) {
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

  private showTip(p: PickHit | null, e: PointerEvent): void {
    const label = p ? this.h.label(p) : null;
    if (!label) {
      this.tip.style.opacity = "0";
      return;
    }
    this.tip.innerHTML = label;
    this.tip.style.opacity = "1";
    const x = Math.min(window.innerWidth - this.tip.offsetWidth - 8, e.clientX + 16);
    this.tip.style.transform = `translate(${x}px, ${e.clientY + 18}px)`;
  }

  private onDown(e: PointerEvent): void {
    if (e.button !== 0) return;
    const p = this.pick(e);
    this.down = { x: e.clientX, y: e.clientY, p, dragging: false, lastY: e.clientY };
    if (p && this.h.canDrag?.(p)) this.controls.enableRotate = false;
  }

  private onUp(e: PointerEvent): void {
    if (e.button !== 0 || !this.down) return;
    const d = this.down;
    this.down = null;
    this.controls.enabled = true;
    this.controls.enableRotate = true;
    if (d.dragging) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) return;
    if (e.target !== this.dom) return;
    this.h.click(this.pick(e), e);
    this.onMove(e);
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
