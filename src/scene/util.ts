import * as THREE from "three";

export const MM = 0.001;

export interface CanvasTex {
  canvas: HTMLCanvasElement;
  ctx: CanvasRenderingContext2D;
  tex: THREE.CanvasTexture;
}

export function canvasTexture(w: number, h: number, srgb = true): CanvasTex {
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d")!;
  const tex = new THREE.CanvasTexture(canvas);
  if (srgb) tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 8;
  return { canvas, ctx, tex };
}

/** Mapea coordenadas en mm (origen en el centro, y hacia arriba) a píxeles de un canvas. */
export function mmMapper(canvas: HTMLCanvasElement, wMM: number, hMM: number) {
  const sx = canvas.width / wMM;
  const sy = canvas.height / hMM;
  return {
    x: (mm: number) => (mm + wMM / 2) * sx,
    y: (mm: number) => (hMM / 2 - mm) * sy,
    s: (mm: number) => mm * sx,
  };
}

export function text(
  ctx: CanvasRenderingContext2D,
  str: string,
  x: number,
  y: number,
  size: number,
  color = "#e9ecef",
  align: CanvasTextAlign = "center",
  weight = 600,
): void {
  ctx.font = `${weight} ${size}px "Inter", "Segoe UI", Arial, sans-serif`;
  ctx.fillStyle = color;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  ctx.fillText(str, x, y);
}

export function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

export function std(color: THREE.ColorRepresentation, roughness = 0.5, metalness = 0): THREE.MeshStandardMaterial {
  return new THREE.MeshStandardMaterial({ color, roughness, metalness });
}

/** Tubo que sigue una polilínea con esquinas redondeadas (radio r en m). */
export function roundedPath(points: THREE.Vector3[], r: number): THREE.CurvePath<THREE.Vector3> {
  const path = new THREE.CurvePath<THREE.Vector3>();
  if (points.length < 2) return path;
  let prev = points[0].clone();
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i];
    const a = points[i - 1];
    const b = points[i + 1];
    const da = a.clone().sub(p);
    const db = b.clone().sub(p);
    const ra = Math.min(r, da.length() / 2);
    const rb = Math.min(r, db.length() / 2);
    const p0 = p.clone().add(da.normalize().multiplyScalar(ra));
    const p1 = p.clone().add(db.normalize().multiplyScalar(rb));
    if (prev.distanceTo(p0) > 1e-7) path.add(new THREE.LineCurve3(prev, p0));
    path.add(new THREE.QuadraticBezierCurve3(p0, p.clone(), p1));
    prev = p1;
  }
  const last = points[points.length - 1];
  if (prev.distanceTo(last) > 1e-7) path.add(new THREE.LineCurve3(prev, last.clone()));
  return path;
}

/** Marca un objeto y sus hijos como interactivos con un id lógico. */
export function tag(obj: THREE.Object3D, id: string): void {
  obj.traverse((o) => {
    o.userData.pick = id;
  });
}

export function shadows(obj: THREE.Object3D, cast = true, receive = true): void {
  obj.traverse((o) => {
    if ((o as THREE.Mesh).isMesh) {
      o.castShadow = cast;
      o.receiveShadow = receive;
    }
  });
}
