/**
 * Comprime los GLB crudos de .cache/glb (salida de usd_to_glb.py) hacia public/models:
 *  - geometría: meshopt + cuantización (EXT_meshopt_compression, KHR_mesh_quantization)
 *  - texturas: WebP (EXT_texture_webp), máx. 1024 px
 *  - dedup, instancing, join, weld
 *  - chapa perforada de la mesa: simplificada + normales planas (ver FLAT_SIMPLIFY)
 *  - sin "palette": se conservan los nombres de material (la app busca el emisivo de la lámpara)
 *
 * three.js decodifica todo con GLTFLoader + MeshoptDecoder, sin archivos wasm aparte.
 *
 *   node tools/optimize_models.mjs [asset_id ...]
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join as joinPath } from "node:path";
import { NodeIO } from "@gltf-transform/core";
import { ALL_EXTENSIONS } from "@gltf-transform/extensions";
import { dedup, flatten, instance, join, meshopt, prune, simplifyPrimitive, sparse, textureCompress, unweldPrimitive, weld } from "@gltf-transform/functions";
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from "meshoptimizer";
import sharp from "sharp";

const RAW = ".cache/glb";
const OUT = "public/models";

/**
 * Versiones livianas ("<id>.lite.glb") para celulares y GPUs modestas, por asset y material.
 *
 * La chapa perforada de la mesa (371 mil triángulos por los agujeros modelados uno a uno) es lo
 * que más cuesta dibujar: en un Moto G32 (Adreno 610) ocultarla sube de 19 a 30 FPS. El USD trae
 * normales suavizadas en el borde de cada agujero: si solo se simplifica, ese suavizado se
 * estira sobre triángulos grandes y aparece un sombreado en estrella. Como es chapa plana,
 * después de simplificar se recalculan normales planas.
 *
 * Aun así, de muy cerca y en pantallas de escritorio quedan líneas de un píxel en las sombras
 * de la chapa, por eso la versión completa se sigue generando y es la que usa la PC.
 */
const LITE = {
  furniture_workbench_standard_e01: [{ material: /painted_black/, error: 0.0001 }],
};

const SNAP_COS = Math.cos((4 * Math.PI) / 180);

const triangleCount = (prim) => {
  const idx = prim.getIndices();
  return (idx ? idx.getCount() : prim.getAttribute("POSITION").getCount()) / 3;
};

/** Simplifica las primitivas indicadas y les pone normales planas (por cara). */
function flatSimplify(rules) {
  return (doc) => {
    if (!rules?.length) return;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const name = prim.getMaterial()?.getName() ?? "";
        const rule = rules.find((r) => r.material.test(name));
        if (!rule) continue;
        const before = triangleCount(prim);
        simplifyPrimitive(prim, { simplifier: MeshoptSimplifier, ratio: 0, error: rule.error, lockBorder: true });
        // cada triángulo con sus 3 vértices propios; el weld() siguiente une los coplanares
        unweldPrimitive(prim);
        const pos = prim.getAttribute("POSITION").getArray();
        const nrm = new Float32Array(pos.length);
        for (let t = 0; t < pos.length; t += 9) {
          const ax = pos[t + 3] - pos[t], ay = pos[t + 4] - pos[t + 1], az = pos[t + 5] - pos[t + 2];
          const bx = pos[t + 6] - pos[t], by = pos[t + 7] - pos[t + 1], bz = pos[t + 8] - pos[t + 2];
          let nx = ay * bz - az * by;
          let ny = az * bx - ax * bz;
          let nz = ax * by - ay * bx;
          const l = Math.hypot(nx, ny, nz) || 1;
          nx /= l;
          ny /= l;
          nz /= l;
          // la simplificación mueve vértices unas centésimas de mm: caras casi planas quedan
          // apenas inclinadas y el brillo marca líneas entre ellas. Se enderezan las que están
          // a menos de 4° de un eje (la chapa está alineada con los ejes del modelo).
          const ax2 = Math.abs(nx), ay2 = Math.abs(ny), az2 = Math.abs(nz);
          const m = Math.max(ax2, ay2, az2);
          if (m > SNAP_COS) {
            if (m === ax2) [nx, ny, nz] = [Math.sign(nx), 0, 0];
            else if (m === ay2) [nx, ny, nz] = [0, Math.sign(ny), 0];
            else [nx, ny, nz] = [0, 0, Math.sign(nz)];
          }
          for (let k = 0; k < 9; k += 3) {
            nrm[t + k] = nx;
            nrm[t + k + 1] = ny;
            nrm[t + k + 2] = nz;
          }
        }
        prim.getAttribute("NORMAL").setArray(nrm);
        console.log(`   ${name}: ${Math.round(before / 1000)}k → ${Math.round(triangleCount(prim) / 1000)}k triángulos, normales planas`);
      }
    }
  };
}

async function main() {
  if (!existsSync(RAW)) {
    console.error(`No existe ${RAW}. Corré antes: pnpm assets:fetch && pnpm assets:convert`);
    process.exit(1);
  }
  mkdirSync(OUT, { recursive: true });
  await Promise.all([MeshoptEncoder.ready, MeshoptDecoder.ready, MeshoptSimplifier.ready]);
  const io = new NodeIO()
    .registerExtensions(ALL_EXTENSIONS)
    .registerDependencies({ "meshopt.encoder": MeshoptEncoder, "meshopt.decoder": MeshoptDecoder });

  const wanted = process.argv.slice(2);
  const files = readdirSync(RAW)
    .filter((f) => f.endsWith(".glb"))
    .filter((f) => !wanted.length || wanted.includes(basename(f, ".glb")));

  let before = 0;
  let after = 0;
  const sizes = {};
  const build = async (src, dst, rules) => {
    const doc = await io.read(src);
    await doc.transform(
      dedup(),
      instance({ min: 5 }),
      flatten(),
      join(),
      weld(),
      flatSimplify(rules),
      weld(),
      prune(),
      sparse(),
      textureCompress({ encoder: sharp, targetFormat: "webp", resize: [1024, 1024] }),
      meshopt({ encoder: MeshoptEncoder, level: "high" }),
    );
    await io.write(dst, doc);
    return statSync(dst).size;
  };

  for (const f of files) {
    const id = basename(f, ".glb");
    const src = joinPath(RAW, f);
    const a = statSync(src).size;
    const b = await build(src, joinPath(OUT, f), null);
    before += a;
    after += b;
    sizes[id] = b;
    console.log(`${f.padEnd(44)} ${(a / 1e6).toFixed(2).padStart(6)} MB → ${(b / 1e6).toFixed(2).padStart(5)} MB`);
    if (LITE[id]) {
      const c = await build(src, joinPath(OUT, `${id}.lite.glb`), LITE[id]);
      console.log(`${`${id}.lite.glb`.padEnd(44)} ${"".padStart(9)} → ${(c / 1e6).toFixed(2).padStart(5)} MB (celulares)`);
    }
  }
  console.log(`${"TOTAL".padEnd(44)} ${(before / 1e6).toFixed(2).padStart(6)} MB → ${(after / 1e6).toFixed(2).padStart(5)} MB`);

  // manifest: el del conversor (bbox, triángulos) + el tamaño final
  const manifestSrc = joinPath(RAW, "manifest.json");
  if (existsSync(manifestSrc)) {
    const outPath = joinPath(OUT, "manifest.json");
    const prev = existsSync(outPath) ? JSON.parse(readFileSync(outPath, "utf8")) : {};
    const m = { ...prev, ...JSON.parse(readFileSync(manifestSrc, "utf8")) };
    for (const [id, bytes] of Object.entries(sizes)) if (m[id]) m[id].bytes = bytes;
    writeFileSync(outPath, JSON.stringify(m, null, 2) + "\n");
  }
}

await main();
