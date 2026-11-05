import * as THREE from "three";
import type { DiodeModel } from "../sim/diode";
import { MM, canvasTexture, roundedPath, std } from "./util";

/**
 * LED de 5 mm (T-1¾) y diodo axial DO-41 (1N4007), a escala real.
 * Todas las medidas en mm salvo que se indique; la escena trabaja en metros (MM).
 */

/** Separación de las patas del LED (mm) y altura de la base sobre la placa. */
export const LED_PITCH = 2.54;
export const LED_BASE = 4.0;
const FLANGE_R = 2.9;
const FLANGE_H = 1.0;
const BODY_R = 2.5;
const BODY_TOP = 6.1; // donde empieza la cúpula
const DOME_TOP = 8.6;

type P3 = [number, number, number];

/**
 * Recorrido de las patas en el marco local del LED (mm): origen entre los dos agujeros sobre la
 * superficie de la placa, +X del ánodo hacia el cátodo, +Y hacia arriba. La pata del ánodo es más
 * larga: al calzar las dos a la misma profundidad, lo que sobra queda como un codo, como en los
 * LED reales (muchos traen ese codo de fábrica como tope).
 */
export function ledLegPoints(depth = 3): { anode: P3[]; cathode: P3[] } {
  const xa = -LED_PITCH / 2;
  const xk = LED_PITCH / 2;
  const top = LED_BASE + 0.2;
  return {
    anode: [
      [xa, -depth, 0],
      [xa, 0.4, 0],
      [xa - 1.5, 1.4, 0],
      [xa - 1.5, 2.6, 0],
      [xa, 3.6, 0],
      [xa, top, 0],
    ],
    cathode: [
      [xk, -depth, 0],
      [xk, top, 0],
    ],
  };
}

export const polylineLength = (pts: P3[]): number =>
  pts.slice(1).reduce((s, p, i) => s + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1], p[2] - pts[i][2]), 0);

/** Textura radial compartida para los halos de luz. */
let haloTex: THREE.Texture | null = null;
function haloTexture(): THREE.Texture {
  if (haloTex) return haloTex;
  const { ctx, tex } = canvasTexture(128, 128);
  const g = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
  g.addColorStop(0, "rgba(255,255,255,1)");
  g.addColorStop(0.18, "rgba(255,255,255,0.55)");
  g.addColorStop(0.45, "rgba(255,255,255,0.14)");
  g.addColorStop(1, "rgba(255,255,255,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 128, 128);
  haloTex = tex;
  return tex;
}

export interface Led3D {
  /** Grupo en el marco local del LED (ya ubicado sobre la placa). */
  group: THREE.Group;
  /** Centro de la cúpula, en el marco del grupo padre (para la luz). */
  glowPoint: THREE.Vector3;
  light: THREE.Color;
  setGlow(glow: number): void;
}

/** Brillo visual (0 … ~1,5) a partir del brillo relativo (1 = 20 mA): el ojo responde de forma logarítmica. */
export function glowOf(brightness: number): number {
  if (!(brightness > 0)) return 0;
  return Math.min(1.5, Math.log10(1 + 30 * brightness) / Math.log10(31));
}

/**
 * LED de 5 mm. `anode` y `cathode` son las bocas de los agujeros (marco del protoboard, en m)
 * donde están sus patas.
 */
export function buildLed(model: DiodeModel, anode: THREE.Vector3, cathode: THREE.Vector3, burned: boolean): Led3D {
  const group = new THREE.Group();
  const lightColor = new THREE.Color(model.light ?? "#ffffff");
  const tint = new THREE.Color(model.tint ?? "#eeeeee");
  const clear = !!model.clear;
  if (burned) tint.lerp(new THREE.Color("#2a1a12"), 0.55);

  const epoxy = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: clear ? 0.08 : 0.32,
    transparent: true,
    opacity: clear ? 0.42 : 0.9,
    emissive: lightColor,
    emissiveIntensity: 0,
  });
  // cuerpo + cúpula
  const prof: THREE.Vector2[] = [new THREE.Vector2(0, FLANGE_H), new THREE.Vector2(BODY_R, FLANGE_H), new THREE.Vector2(BODY_R, BODY_TOP)];
  const domeH = DOME_TOP - BODY_TOP;
  for (let i = 1; i <= 10; i++) {
    const a = (i / 10) * (Math.PI / 2);
    prof.push(new THREE.Vector2(BODY_R * Math.cos(a), BODY_TOP + domeH * Math.sin(a)));
  }
  const body = new THREE.Mesh(
    new THREE.LatheGeometry(
      prof.map((p) => new THREE.Vector2(p.x * MM, (p.y + LED_BASE) * MM)),
      40,
    ),
    epoxy,
  );
  body.renderOrder = 2;
  group.add(body);
  // pestaña de la base con el lado plano del cátodo (+X)
  const flat = 2.45;
  const c = Math.acos(flat / FLANGE_R);
  const shape = new THREE.Shape();
  shape.absarc(0, 0, FLANGE_R * MM, c, 2 * Math.PI - c, false);
  shape.lineTo(flat * MM, Math.sin(c) * FLANGE_R * MM);
  const flange = new THREE.Mesh(new THREE.ExtrudeGeometry(shape, { depth: FLANGE_H * MM, bevelEnabled: false, curveSegments: 32 }), epoxy);
  flange.rotation.x = -Math.PI / 2;
  flange.position.y = LED_BASE * MM;
  flange.renderOrder = 2;
  group.add(flange);

  // marco interno: el cátodo es el "yunque" grande con la copa reflectora, el ánodo el poste chico
  const metal = std("#c3c7cc", 0.3, 0.9);
  const post = (x: number, w: number, top: number) => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w * MM, (top - LED_BASE) * MM, 0.5 * MM), metal);
    m.position.set(x * MM, ((top + LED_BASE) / 2) * MM, 0);
    return m;
  };
  group.add(post(-LED_PITCH / 2, 0.5, LED_BASE + 4.6));
  const anvil = post(LED_PITCH / 2 - 0.25, 1.4, LED_BASE + 3.9);
  group.add(anvil);
  const cup = new THREE.Mesh(new THREE.CylinderGeometry(0.75 * MM, 0.45 * MM, 0.6 * MM, 16, 1, true), metal);
  cup.position.set((LED_PITCH / 2 - 0.25) * MM, (LED_BASE + 4.2) * MM, 0);
  group.add(cup);
  const dieMat = new THREE.MeshStandardMaterial({ color: burned ? "#120c08" : "#3a3a3a", roughness: 0.4, emissive: lightColor, emissiveIntensity: 0 });
  const die = new THREE.Mesh(new THREE.BoxGeometry(0.35 * MM, 0.2 * MM, 0.35 * MM), dieMat);
  die.position.set((LED_PITCH / 2 - 0.25) * MM, (LED_BASE + 4.05) * MM, 0);
  group.add(die);
  // hilo de oro del chip al poste del ánodo
  const bond = new THREE.Mesh(
    new THREE.TubeGeometry(
      new THREE.QuadraticBezierCurve3(
        new THREE.Vector3((LED_PITCH / 2 - 0.25) * MM, (LED_BASE + 4.15) * MM, 0),
        new THREE.Vector3(0, (LED_BASE + 5.4) * MM, 0),
        new THREE.Vector3(-LED_PITCH / 2 * MM, (LED_BASE + 4.6) * MM, 0),
      ),
      12,
      0.05 * MM,
      4,
    ),
    std(burned ? "#3a2a1a" : "#e2b04a", 0.3, 1),
  );
  group.add(bond);

  // patas
  const legMat = std("#c9ccd1", 0.32, 0.9);
  const legs = ledLegPoints();
  for (const pts of [legs.anode, legs.cathode]) {
    const path = roundedPath(
      pts.map((p) => new THREE.Vector3(p[0] * MM, p[1] * MM, p[2] * MM)),
      0.45 * MM,
    );
    group.add(new THREE.Mesh(new THREE.TubeGeometry(path, 32, 0.25 * MM, 6), legMat));
  }

  // halo (sprite aditivo) para el brillo
  const halo = new THREE.Sprite(
    // mezcla normal (no aditiva): sobre la placa blanca, que ya está saturada, una suma no se vería
    new THREE.SpriteMaterial({ map: haloTexture(), color: lightColor, transparent: true, depthWrite: false, opacity: 0, toneMapped: false }),
  );
  const dome = new THREE.Vector3(0, (LED_BASE + 6.2) * MM, 0);
  halo.position.copy(dome);
  halo.renderOrder = 3;
  halo.visible = false;
  group.add(halo);

  // zona de selección
  const hit = new THREE.Mesh(new THREE.BoxGeometry(7 * MM, (DOME_TOP + LED_BASE + 0.6) * MM, 7 * MM), new THREE.MeshBasicMaterial({ visible: false }));
  hit.position.y = ((DOME_TOP + LED_BASE + 0.6) / 2) * MM;
  group.add(hit);

  // ubicar: origen entre los agujeros, +X del ánodo al cátodo
  const mid = anode.clone().add(cathode).multiplyScalar(0.5);
  const dir = cathode.clone().sub(anode).setY(0).normalize();
  group.position.copy(mid);
  group.quaternion.setFromUnitVectors(new THREE.Vector3(1, 0, 0), dir);
  for (const o of [body, flange]) o.castShadow = true;

  const glowPoint = dome.clone().applyQuaternion(group.quaternion).add(mid);
  return {
    group,
    glowPoint,
    light: lightColor,
    setGlow(glow: number) {
      const g = burned ? 0 : glow;
      // encendido, el epoxi se dibuja sin tone mapping: con ACES un rojo emisivo intenso vira a naranja
      const lit = g > 0.03;
      if (epoxy.toneMapped === lit) {
        epoxy.toneMapped = !lit;
        epoxy.needsUpdate = true;
      }
      epoxy.emissiveIntensity = 0.9 * g;
      dieMat.emissiveIntensity = 6 * g;
      halo.visible = g > 0.01;
      halo.material.opacity = Math.min(0.75, 0.2 + 0.45 * g);
      const s = (8 + 14 * g) * MM;
      halo.scale.set(s, s, s);
    },
  };
}

/** Textura del 1N4007: cuerpo negro, banda gris del cátodo y la leyenda a lo largo. */
export function diodeBodyTexture(burned: boolean, lenMM: number, rMM: number): THREE.CanvasTexture {
  const W = 256;
  const H = 512;
  const { ctx, tex } = canvasTexture(W, H);
  ctx.fillStyle = burned ? "#120d0a" : "#1b1b1d";
  ctx.fillRect(0, 0, W, H);
  // banda del cátodo: la fracción axial p = 1 es el extremo del cátodo (y = 0 en el canvas)
  ctx.fillStyle = burned ? "#4a4440" : "#c9ccd1";
  ctx.fillRect(0, 0.06 * H, W, 0.15 * H);
  if (!burned) {
    // leyenda impresa a lo largo del eje, cuatro veces alrededor: según cómo quede montado el
    // cuerpo, siempre hay una mirando hacia arriba o hacia adelante
    const pxAround = W / (2 * Math.PI * rMM);
    const pxAlong = H / lenMM;
    for (const u of [0, 0.25, 0.5, 0.75, 1]) { // 0 y 1 son la misma, partida por la costura
      ctx.save();
      ctx.translate(u * W, 0.6 * H);
      ctx.rotate(-Math.PI / 2);
      ctx.scale(pxAlong / 10, pxAround / 10);
      ctx.font = "600 9px Inter, Arial, sans-serif";
      ctx.fillStyle = "#9a9ea6";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("1N4007", 0, 0);
      ctx.restore();
    }
  }
  tex.wrapS = THREE.RepeatWrapping;
  return tex;
}
