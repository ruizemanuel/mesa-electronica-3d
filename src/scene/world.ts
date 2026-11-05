import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { MeshoptDecoder } from "three/examples/jsm/libs/meshopt_decoder.module.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { LITE_MODELS, type Quality } from "../quality";
import { canvasTexture, shadows } from "./util";

/** Altura del tablero de furniture_workbench_standard_e01 (medida sobre la geometría convertida). */
export const BENCH_TOP = 0.668;

export interface Placement {
  id: string;
  pos: [number, number, number];
  rotY: number;
}

/** Assets SimReady y dónde van. La mesa se gira para que su frente (+X en el USD) mire a +Z. */
export const SIMREADY_LAYOUT: Placement[] = [
  { id: "furniture_workbench_standard_e01", pos: [0, 0, 0], rotY: -Math.PI / 2 },
  { id: "lamp_table_bedside_a01", pos: [0.6, BENCH_TOP, -0.16], rotY: 0.4 },
  { id: "handTool_pliers_long_nose_a01", pos: [-0.6, BENCH_TOP, 0.13], rotY: 1.25 },
  { id: "handTool_pliers_diagonal_cutting_a01", pos: [-0.52, BENCH_TOP, 0.2], rotY: -2.3 },
  { id: "handTool_screwdriver_slotted_4mm_a01", pos: [0.43, BENCH_TOP, 0.215], rotY: 2.7 },
  { id: "dishware_mug_coffee_a01", pos: [0.5, BENCH_TOP, 0.06], rotY: -0.6 },
  { id: "chair_office_amf_black_a01", pos: [0.08, 0, 0.62], rotY: Math.PI + 0.25 },
];

export interface CameraView {
  name: string;
  pos: [number, number, number];
  target: [number, number, number];
}
export const VIEWS: Record<string, CameraView> = {
  general: { name: "General", pos: [0.0, 1.16, 0.98], target: [-0.03, 0.7, 0.0] },
  protoboard: { name: "Protoboard", pos: [-0.02, 0.79, 0.215], target: [-0.02, 0.676, 0.098] },
  multimetro: { name: "Multímetro", pos: [0.37, 0.88, 0.38], target: [0.255, 0.765, 0.04] },
  fuente: { name: "Fuente", pos: [-0.28, 0.84, 0.31], target: [-0.35, 0.74, 0.04] },
};

/** Proporción de pantalla con la que se diseñaron las vistas (zona 3D de un monitor 16:9). */
const DESIGN_ASPECT = 1.55;

export interface World {
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  lampLight: THREE.PointLight;
  goTo(view: CameraView): void;
  /** La vista ajustada a la proporción actual de la pantalla. */
  fit(view: CameraView): CameraView;
  tick(dt: number): void;
}

export function createWorld(container: HTMLElement, quality: Quality, opts: { preserveDrawingBuffer?: boolean } = {}): World {
  const renderer = new THREE.WebGLRenderer({
    antialias: true,
    powerPreference: "high-performance",
    preserveDrawingBuffer: opts.preserveDrawingBuffer ?? false,
  });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, quality.maxPixelRatio));
  renderer.setSize(container.clientWidth, container.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.0;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  container.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color("#c9ccd0");
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.55;

  const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.01, 30);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minDistance = 0.06;
  controls.maxDistance = 3.0;
  controls.maxPolarAngle = Math.PI * 0.49;
  controls.zoomToCursor = true;
  controls.screenSpacePanning = true;
  /**
   * En pantallas más angostas que el diseño (celular vertical, notebooks) la cámara se aleja en
   * proporción, para que entre el mismo ancho de mesa.
   */
  const fit = (view: CameraView): CameraView => {
    if (camera.aspect >= DESIGN_ASPECT) return view;
    // 0 = pantalla de diseño, 1 = celular vertical (aspecto ≈ 0,85)
    const narrow = Math.min(1, (DESIGN_ASPECT / camera.aspect - 1) / 0.85);
    const t0 = new THREE.Vector3(...view.target);
    const s = new THREE.Spherical().setFromVector3(new THREE.Vector3(...view.pos).sub(t0));
    // alejarse lo justo para que entren fuente, protoboard y multímetro (las vistas cercanas, menos)
    s.radius *= 1 + 0.35 * narrow * Math.min(1, s.radius / 0.6);
    s.phi *= 1 - 0.4 * narrow; // mirar más desde arriba: usa el alto de la pantalla y saltea la silla
    const t = t0;
    const p = new THREE.Vector3().setFromSpherical(s).add(t);
    return { ...view, pos: p.toArray() as [number, number, number], target: t.toArray() as [number, number, number] };
  };
  const v0 = fit(VIEWS.general);
  camera.position.set(...v0.pos);
  controls.target.set(...v0.target);

  // luces
  scene.add(new THREE.HemisphereLight("#f3f5f8", "#6d6a64", 0.55));
  const sun = new THREE.DirectionalLight("#fffaf0", 2.0);
  sun.position.set(-1.2, 2.6, 1.6);
  sun.target.position.set(0, BENCH_TOP, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(quality.shadowMapSize, quality.shadowMapSize);
  sun.shadow.camera.left = -1.1;
  sun.shadow.camera.right = 1.1;
  sun.shadow.camera.top = 1.1;
  sun.shadow.camera.bottom = -1.1;
  sun.shadow.camera.near = 0.5;
  sun.shadow.camera.far = 6;
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.002;
  scene.add(sun, sun.target);
  const fill = new THREE.DirectionalLight("#dfe8ff", 0.6);
  fill.position.set(1.5, 1.4, 2.0);
  scene.add(fill);
  const lampLight = new THREE.PointLight("#ffd9a8", 0.9, 1.6, 2);
  lampLight.position.set(0.6, BENCH_TOP + 0.28, -0.16);
  scene.add(lampLight);

  // piso y paredes
  const floorTex = canvasTexture(512, 512);
  {
    const { ctx } = floorTex;
    ctx.fillStyle = "#8c8a86";
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 9000; i++) {
      const g = 120 + Math.random() * 40;
      ctx.fillStyle = `rgba(${g},${g - 2},${g - 6},0.18)`;
      ctx.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
    }
    ctx.strokeStyle = "rgba(60,60,60,0.25)";
    ctx.lineWidth = 2;
    ctx.strokeRect(0, 0, 512, 512);
    floorTex.tex.wrapS = floorTex.tex.wrapT = THREE.RepeatWrapping;
    floorTex.tex.repeat.set(10, 10);
  }
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ map: floorTex.tex, roughness: 0.92 }));
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);
  const wallMat = new THREE.MeshStandardMaterial({ color: "#d9dcd6", roughness: 0.95 });
  const wall = new THREE.Mesh(new THREE.PlaneGeometry(10, 4), wallMat);
  wall.position.set(0, 2, -0.31);
  wall.receiveShadow = true;
  scene.add(wall);
  const side = new THREE.Mesh(new THREE.PlaneGeometry(6, 4), wallMat);
  side.rotation.y = Math.PI / 2;
  side.position.set(-1.6, 2, 2.6);
  side.receiveShadow = true;
  scene.add(side);

  const onResize = () => {
    renderer.setSize(container.clientWidth, container.clientHeight);
    camera.aspect = container.clientWidth / container.clientHeight;
    camera.updateProjectionMatrix();
  };
  window.addEventListener("resize", onResize);

  let tween: { from: CameraView; to: CameraView; t: number } | null = null;
  const goTo = (view: CameraView) => {
    tween = {
      from: { name: "", pos: camera.position.toArray() as [number, number, number], target: controls.target.toArray() as [number, number, number] },
      to: fit(view),
      t: 0,
    };
  };

  return {
    renderer,
    scene,
    camera,
    controls,
    lampLight,
    goTo,
    fit,
    tick(dt: number) {
      if (tween) {
        tween.t = Math.min(1, tween.t + dt / 0.9);
        const e = tween.t < 0.5 ? 4 * tween.t ** 3 : 1 - (-2 * tween.t + 2) ** 3 / 2;
        camera.position.lerpVectors(new THREE.Vector3(...tween.from.pos), new THREE.Vector3(...tween.to.pos), e);
        controls.target.lerpVectors(new THREE.Vector3(...tween.from.target), new THREE.Vector3(...tween.to.target), e);
        if (tween.t >= 1) tween = null;
      }
      controls.update();
    },
  };
}

export async function loadSimReady(
  scene: THREE.Scene,
  quality: Quality,
  onProgress: (loaded: number, total: number, label: string) => void,
): Promise<Map<string, THREE.Object3D>> {
  // los modelos van comprimidos con meshopt + WebP (tools/optimize_models.mjs)
  const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);
  const out = new Map<string, THREE.Object3D>();
  let done = 0;
  onProgress(0, SIMREADY_LAYOUT.length, "Cargando assets SimReady…");
  await Promise.all(
    SIMREADY_LAYOUT.map(async (pl) => {
      try {
        const file = quality.lite && LITE_MODELS.has(pl.id) ? `${pl.id}.lite.glb` : `${pl.id}.glb`;
        const gltf = await loader.loadAsync(`${import.meta.env.BASE_URL}models/${file}`);
        const obj = gltf.scene;
        obj.name = pl.id;
        obj.position.set(...pl.pos);
        obj.rotation.y = pl.rotY;
        shadows(obj, true, true);
        obj.traverse((o) => {
          const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
          if (m && m.map) m.map.anisotropy = 8;
        });
        scene.add(obj);
        out.set(pl.id, obj);
      } catch (e) {
        console.warn(`[simready] no se pudo cargar ${pl.id}`, e);
      } finally {
        done++;
        onProgress(done, SIMREADY_LAYOUT.length, pl.id);
      }
    }),
  );
  return out;
}
