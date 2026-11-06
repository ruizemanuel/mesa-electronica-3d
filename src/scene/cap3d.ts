import * as THREE from "three";
import type { CapModel } from "../sim/capacitor";
import { MM, canvasTexture, roundedPath, std } from "./util";

/**
 * Capacitores a escala real sobre el protoboard. Medidas en mm salvo que se indique.
 * - Electrolítico radial: lata de aluminio con la funda impresa (franja con signos − del lado del
 *   negativo), tapón de goma abajo y la válvula de seguridad (las ranuras en cruz) en el techo.
 *   Inflado, el techo se abomba y se abre.
 * - Cerámico de disco: gota de epoxi naranja con el código de 3 cifras ("104").
 */

const LIFT = 1.2; // separación entre la placa y la base del componente
const leadMat = std("#c9ccd1", 0.32, 0.9);

/** Funda del electrolítico: azul con la franja clara del negativo centrada en u = 0,25 (que mira a +X). */
function sleeveTexture(marking: string, burst: boolean): THREE.CanvasTexture {
  const W = 512;
  const H = 256;
  const { ctx, tex } = canvasTexture(W, H);
  ctx.fillStyle = burst ? "#1b2747" : "#1f3f8f";
  ctx.fillRect(0, 0, W, H);
  // franja del negativo
  const sx = 0.25 * W;
  const sw = 0.16 * W;
  ctx.fillStyle = burst ? "#8b8f99" : "#c7ccd6";
  ctx.fillRect(sx - sw / 2, 0, sw, H);
  ctx.fillStyle = burst ? "#2a3350" : "#1f3f8f";
  for (let y = 26; y < H - 10; y += 44) ctx.fillRect(sx - 9, y, 18, 6); // signos "−"
  // leyenda, del lado opuesto a la franja (mira a −X) y también al frente
  ctx.save();
  ctx.fillStyle = burst ? "#9aa0ad" : "#e8ecf4";
  ctx.font = "700 30px Inter, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (const u of [0.5, 0.75, 1.0]) {
    ctx.save();
    ctx.translate(u * W - (u === 1 ? 40 : 0), H / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText(marking, 0, 0);
    ctx.font = "600 20px Inter, Arial, sans-serif";
    ctx.fillText("105°C", 0, 34);
    ctx.restore();
  }
  ctx.restore();
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}

/** Techo de aluminio con las ranuras de la válvula. */
function topTexture(burst: boolean): THREE.CanvasTexture {
  const { ctx, tex } = canvasTexture(128, 128);
  const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 64);
  g.addColorStop(0, burst ? "#7d7a74" : "#d9dce0");
  g.addColorStop(1, burst ? "#5a5650" : "#a9adb3");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  ctx.strokeStyle = burst ? "#2b2620" : "#7d8188";
  ctx.lineWidth = burst ? 7 : 4;
  ctx.beginPath();
  ctx.moveTo(64, 14);
  ctx.lineTo(64, 114);
  ctx.moveTo(14, 64);
  ctx.lineTo(114, 64);
  ctx.stroke();
  return tex;
}

/** Pata que baja del componente al agujero, con un codo si hay que abrirla o cerrarla. */
function lead(from: THREE.Vector3, hole: THREE.Vector3, r: number): THREE.Mesh {
  const below = hole.clone();
  below.y -= 3 * MM;
  const knee = new THREE.Vector3(hole.x, from.y - 1.2 * MM, hole.z);
  const pts = from.distanceTo(new THREE.Vector3(hole.x, from.y, hole.z)) < 0.05 * MM ? [from, below] : [from, from.clone().setY(from.y - 0.6 * MM), knee, below];
  return new THREE.Mesh(new THREE.TubeGeometry(roundedPath(pts, 0.5 * MM), 20, r * MM, 6), leadMat);
}

export interface Cap3D {
  group: THREE.Group;
}

/**
 * Electrolítico parado entre `pos` y `neg` (bocas de los agujeros, en el marco del protoboard, en m).
 * El grupo queda con +X de la pata + hacia la −, así la franja mira al negativo.
 */
export function buildElectrolytic(m: CapModel, pos: THREE.Vector3, neg: THREE.Vector3, burst: boolean): Cap3D {
  const group = new THREE.Group();
  const r = m.dia / 2;
  const base = LIFT;
  const bodyH = m.len;
  const sleeve = new THREE.MeshStandardMaterial({ map: sleeveTexture(m.marking, burst), roughness: 0.42 });
  // lata con el borde superior redondeado (la funda se dobla sobre el techo)
  const prof: THREE.Vector2[] = [new THREE.Vector2(r * 0.86, 0), new THREE.Vector2(r, 0.5), new THREE.Vector2(r, bodyH - 0.9)];
  for (let i = 1; i <= 6; i++) {
    const a = (i / 6) * (Math.PI / 2);
    prof.push(new THREE.Vector2(r - 0.7 + 0.7 * Math.cos(a), bodyH - 0.9 + 0.7 * Math.sin(a)));
  }
  prof.push(new THREE.Vector2(r - 0.75, bodyH - 0.2));
  const can = new THREE.Mesh(
    new THREE.LatheGeometry(
      prof.map((p) => new THREE.Vector2(p.x * MM, (p.y + base) * MM)),
      40,
    ),
    sleeve,
  );
  group.add(can);
  // techo (abombado si se infló)
  const topR = (r - 0.75) * MM;
  const topGeo = burst ? new THREE.SphereGeometry(topR, 28, 10, 0, Math.PI * 2, 0, 0.75) : new THREE.CircleGeometry(topR, 32);
  const top = new THREE.Mesh(topGeo, new THREE.MeshStandardMaterial({ map: topTexture(burst), roughness: 0.3, metalness: 0.75 }));
  if (burst) {
    top.scale.y = 0.55;
    top.position.y = (base + bodyH - 0.2 - topR / MM / 2.4) * MM;
  } else {
    top.rotation.x = -Math.PI / 2;
    top.position.y = (base + bodyH - 0.2) * MM;
  }
  group.add(top);
  // tapón de goma
  const bung = new THREE.Mesh(new THREE.CylinderGeometry(r * 0.84 * MM, r * 0.84 * MM, 0.5 * MM, 24), std("#2b2b2e", 0.85));
  bung.position.y = (base + 0.15) * MM;
  group.add(bung);

  // ubicar: origen entre los agujeros, +X de la pata + a la −
  const mid = pos.clone().add(neg).multiplyScalar(0.5);
  const dir = neg.clone().sub(pos).setY(0).normalize();
  group.position.copy(mid);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  // patas en el marco local
  const half = pos.distanceTo(neg) / 2;
  const legX = (m.pitch / 2) * MM;
  for (const [sx, hx] of [
    [-legX, -half],
    [legX, half],
  ]) {
    group.add(lead(new THREE.Vector3(sx, (base + 0.1) * MM, 0), new THREE.Vector3(hx, 0, 0), 0.25));
  }
  // zona de selección
  const hit = new THREE.Mesh(new THREE.CylinderGeometry((r + 1) * MM, (r + 1) * MM, (bodyH + base + 1) * MM, 10), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = ((bodyH + base + 1) / 2) * MM;
  group.add(hit);
  return { group };
}

/** Código impreso del cerámico. */
function codeTexture(code: string): THREE.CanvasTexture {
  const { ctx, tex } = canvasTexture(128, 128);
  ctx.clearRect(0, 0, 128, 128);
  ctx.fillStyle = "rgba(40,22,8,0.92)";
  ctx.font = "800 44px Inter, Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(code, 64, 58);
  ctx.font = "700 22px Inter, Arial, sans-serif";
  ctx.fillText("K 50V", 64, 94);
  return tex;
}

/** Cerámico de disco entre dos agujeros (las patas se abren o se cierran hasta la separación de los agujeros). */
export function buildCeramic(m: CapModel, a: THREE.Vector3, b: THREE.Vector3): Cap3D {
  const group = new THREE.Group();
  const r = m.dia / 2;
  const t = m.len;
  const discY = LIFT + 3 + r; // centro del disco
  const body = new THREE.Mesh(new THREE.SphereGeometry(1, 32, 20), std("#d9822b", 0.5));
  body.scale.set(r * MM, r * MM * 1.04, (t / 2) * MM);
  body.position.y = discY * MM;
  group.add(body);
  // el código en las dos caras
  const codeMat = new THREE.MeshBasicMaterial({ map: codeTexture(m.marking), transparent: true, depthWrite: false });
  for (const s of [1, -1]) {
    const decal = new THREE.Mesh(new THREE.PlaneGeometry(r * 1.4 * MM, r * 1.4 * MM), codeMat);
    decal.position.set(0, discY * MM, s * (t / 2 + 0.02) * MM);
    if (s < 0) decal.rotation.y = Math.PI;
    group.add(decal);
  }
  // patas: salen del borde inferior del disco con la separación de fábrica (5,08 mm) y bajan a los agujeros
  const mid = a.clone().add(b).multiplyScalar(0.5);
  const dir = b.clone().sub(a).setY(0).normalize();
  group.position.copy(mid);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  const half = a.distanceTo(b) / 2;
  const legX = (m.pitch / 2) * MM;
  for (const [sx, hx] of [
    [-legX, -half],
    [legX, half],
  ]) {
    const from = new THREE.Vector3(sx * 0.7, (discY - r * 0.75) * MM, 0);
    group.add(lead(from, new THREE.Vector3(hx, 0, 0), 0.25));
  }
  const hit = new THREE.Mesh(new THREE.BoxGeometry(half * 2 + 2 * MM, (discY + r + 1) * MM, (t + 2) * MM), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = ((discY + r + 1) / 2) * MM;
  group.add(hit);
  return { group };
}
