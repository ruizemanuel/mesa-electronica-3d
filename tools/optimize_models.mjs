/**
 * Comprime los GLB crudos de .cache/glb (salida de usd_to_glb.py) hacia public/models:
 *  - geometría: meshopt + cuantización (EXT_meshopt_compression, KHR_mesh_quantization)
 *  - texturas: WebP (EXT_texture_webp), máx. 1024 px
 *  - weld, dedup, join; SIN simplificación (rompía el sombreado del panel perforado)
 *  - sin "palette": se conservan los nombres de material (la app busca el emisivo de la lámpara)
 *
 * three.js decodifica todo con GLTFLoader + MeshoptDecoder, sin archivos wasm aparte.
 *
 *   node tools/optimize_models.mjs [asset_id ...]
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

const RAW = ".cache/glb";
const OUT = "public/models";
if (!existsSync(RAW)) {
  console.error(`No existe ${RAW}. Corré antes: pnpm assets:fetch && pnpm assets:convert`);
  process.exit(1);
}
mkdirSync(OUT, { recursive: true });

const wanted = process.argv.slice(2);
const files = readdirSync(RAW)
  .filter((f) => f.endsWith(".glb"))
  .filter((f) => !wanted.length || wanted.includes(basename(f, ".glb")));

const cli = join("node_modules", "@gltf-transform", "cli", "bin", "cli.js");
let before = 0;
let after = 0;
const sizes = {};
for (const f of files) {
  const src = join(RAW, f);
  const dst = join(OUT, f);
  const r = spawnSync(
    process.execPath,
    [
      cli, "optimize", src, dst,
      "--compress", "meshopt",
      "--texture-compress", "webp",
      "--texture-size", "1024",
      "--palette", "false",
      // sin simplificar: en el panel perforado de la mesa y en la lámpara deja un sombreado
      // en estrella alrededor de cada agujero (probado también con --simplify-lock-border)
      "--simplify", "false",
    ],
    { encoding: "utf8" },
  );
  if (r.status !== 0) {
    console.error(r.stdout, r.stderr);
    process.exit(r.status ?? 1);
  }
  const a = statSync(src).size;
  const b = statSync(dst).size;
  before += a;
  after += b;
  sizes[basename(f, ".glb")] = b;
  console.log(`${f.padEnd(44)} ${(a / 1e6).toFixed(2).padStart(6)} MB → ${(b / 1e6).toFixed(2).padStart(5)} MB`);
}
console.log(`${"TOTAL".padEnd(44)} ${(before / 1e6).toFixed(2).padStart(6)} MB → ${(after / 1e6).toFixed(2).padStart(5)} MB`);

// manifest: el del conversor (bbox, triángulos) + el tamaño final
const manifestSrc = join(RAW, "manifest.json");
if (existsSync(manifestSrc)) {
  const prev = existsSync(join(OUT, "manifest.json")) ? JSON.parse(readFileSync(join(OUT, "manifest.json"), "utf8")) : {};
  const m = { ...prev, ...JSON.parse(readFileSync(manifestSrc, "utf8")) };
  for (const [id, bytes] of Object.entries(sizes)) if (m[id]) m[id].bytes = bytes;
  writeFileSync(join(OUT, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
}
