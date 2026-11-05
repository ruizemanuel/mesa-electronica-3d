/**
 * Graba el video showcase de la mesa de electrónica, cuadro a cuadro (60 fps exactos).
 *
 *   pnpm dev                                  # en otra terminal
 *   node tools/record-showcase.mjs            # -> media/showcase.mp4 (1920x1080, H.264)
 *   node tools/record-showcase.mjs --preview  # cuadros sueltos en media/preview/ para revisar encuadres
 *   node tools/record-showcase.mjs --url github.com/usuario/repo   # texto de la placa final
 *
 * La app corre con ?capture: el tiempo solo avanza cuando este script pide un cuadro, y los
 * timers (toasts, animaciones de botones) usan el reloj falso de Playwright.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { once } from "node:events";
import { join } from "node:path";
import { chromium } from "playwright";

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n, d) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 ? args[i + 1] : d;
};
const PREVIEW = flag("preview");
const URL = opt("app", "http://localhost:5173/?capture");
const LINK = opt("url", "");
const OUT = opt("out", "media/showcase.mp4");
const FPS = Number(opt("fps", 60));
const CHROME = opt(
  "chrome",
  ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p)),
);
// 1600x900 CSS a 1.2x -> 1920x1080: la interfaz se ve un poco más grande (mejor en celular)
const VIEW = { width: 1600, height: 900 };
const DSF = 1920 / VIEW.width;

// ------------------------------------------------------------------ navegador
const browser = await chromium.launch({
  executablePath: CHROME,
  headless: true,
  args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist", "--enable-gpu-rasterization", "--hide-scrollbars"],
});
const page = await browser.newPage({ viewport: VIEW, deviceScaleFactor: DSF });
page.on("pageerror", (e) => console.error("[page]", e.message));
await page.clock.install({ time: 0 });
await page.goto(URL, { waitUntil: "load" });
await page.waitForFunction(() => window.__capture?.loaded, null, { timeout: 180_000 });
await page.evaluate(() => document.fonts.ready);
const gpu = await page.evaluate(() => {
  const gl = document.createElement("canvas").getContext("webgl2");
  return gl.getParameter(gl.getExtension("WEBGL_debug_renderer_info").UNMASKED_RENDERER_WEBGL);
});
console.log("GPU:", gpu);

// ------------------------------------------------------------------ salida
let ff = null;
const PREVIEW_DIR = "media/preview";
if (PREVIEW) {
  rmSync(PREVIEW_DIR, { recursive: true, force: true });
  mkdirSync(PREVIEW_DIR, { recursive: true });
} else {
  mkdirSync("media", { recursive: true });
  ff = spawn(
    "ffmpeg",
    [
      "-y", "-hide_banner", "-loglevel", "error",
      "-f", "image2pipe", "-framerate", String(FPS), "-c:v", "mjpeg", "-i", "-",
      "-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
      "-map", "0:v", "-map", "1:a", "-shortest",
      "-c:v", "libx264", "-preset", "slow", "-crf", "18", "-maxrate", "25M", "-bufsize", "50M",
      // las capturas JPEG son BT.601 rango completo: se pasan a BT.709 rango TV (lo que esperan X y los reproductores)
      "-vf", "scale=in_range=pc:out_range=tv:in_color_matrix=bt601:out_color_matrix=bt709,format=yuv420p",
      "-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv",
      "-profile:v", "high", "-level", "4.2", "-r", String(FPS),
      "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart",
      OUT,
    ],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
}

// ------------------------------------------------------------------ primitivas de tiempo
let frame = 0;
const marks = [];
const t0 = Date.now();
async function renderFrame() {
  const ms = Math.round(((frame + 1) * 1000) / FPS) - Math.round((frame * 1000) / FPS);
  await page.clock.runFor(ms);
  await page.evaluate((dt) => window.__capture.frame(dt), 1 / FPS);
  if (!PREVIEW) {
    const buf = await page.screenshot({ type: "jpeg", quality: 94 });
    if (!ff.stdin.write(buf)) await once(ff.stdin, "drain");
  } else if (frame % 20 === 0) {
    await page.screenshot({ path: join(PREVIEW_DIR, `f${String(frame).padStart(5, "0")}.jpg`), type: "jpeg", quality: 80, scale: "css" });
  }
  frame++;
  if (frame % 120 === 0) {
    const el = (Date.now() - t0) / 1000;
    console.log(`  ${(frame / FPS).toFixed(1)} s de video · ${el.toFixed(0)} s reales`);
  }
}
async function hold(sec, perFrame) {
  const n = Math.max(1, Math.round(sec * FPS));
  for (let i = 0; i < n; i++) {
    if (perFrame) await perFrame((i + 1) / n);
    await renderFrame();
  }
}
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const easeOut = (t) => 1 - (1 - t) ** 3;
const lerp = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t);
const ev = (fn, arg) => page.evaluate(fn, arg);
function mark(name) {
  marks.push({ name, t: +(frame / FPS).toFixed(2) });
  console.log(`▶ ${name} @ ${(frame / FPS).toFixed(1)} s`);
}

// ------------------------------------------------------------------ cámara, mouse, teclado
const cam = (pos, target) => ev(([p, q]) => window.__capture.cam(p, q), [pos, target]);
const getCam = () => ev(() => window.__capture.getCam());
let mouse = [VIEW.width * 0.42, VIEW.height * 0.55];

/** Mueve cámara (y opcionalmente el mouse hacia un objetivo) en `sec` s. */
async function camTo(shot, sec, { mouseTo = null, curve = ease } = {}) {
  const from = await getCam();
  const m0 = mouse;
  await hold(sec, async (t) => {
    const e = curve(t);
    await cam(lerp(from.pos, shot.pos, e), lerp(from.target, shot.target, e));
    if (mouseTo) {
      const goal = typeof mouseTo === "string" ? await screen(mouseTo) : mouseTo;
      if (goal) await moveMouseRaw(lerp(m0, goal, ease(Math.min(1, t * 1.15))));
    }
  });
}
async function moveMouseRaw(xy) {
  mouse = xy;
  await page.mouse.move(xy[0], xy[1]);
}
const screen = (target) => ev((t) => window.__capture.screen(t), target);
const elXY = (sel) => ev((s) => window.__capture.el(s), sel);

/** Desplazamiento del mouse con una curva leve (movimiento humano). */
async function moveTo(target, sec = 0.6) {
  const goal = Array.isArray(target) ? target : typeof target === "string" && target.startsWith("#") ? await elXY(target) : typeof target === "string" && target.startsWith(".") ? await elXY(target) : await screen(target);
  if (!goal) throw new Error(`Objetivo no encontrado: ${target}`);
  const a = mouse;
  const dx = goal[0] - a[0];
  const dy = goal[1] - a[1];
  const bend = Math.min(60, Math.hypot(dx, dy) * 0.12);
  const ctrl = [a[0] + dx * 0.5 - (dy / (Math.hypot(dx, dy) || 1)) * bend, a[1] + dy * 0.5 + (dx / (Math.hypot(dx, dy) || 1)) * bend];
  await hold(sec, async (t) => {
    const e = ease(t);
    const u = 1 - e;
    await moveMouseRaw([u * u * a[0] + 2 * u * e * ctrl[0] + e * e * goal[0], u * u * a[1] + 2 * u * e * ctrl[1] + e * e * goal[1]]);
  });
}
async function click(after = 0.2) {
  await page.mouse.down();
  await renderFrame();
  await renderFrame();
  await page.mouse.up();
  await hold(after);
}
async function clickOn(target, move = 0.55, after = 0.25) {
  await moveTo(target, move);
  await hold(0.08);
  await click(after);
}
async function key(k, after = 0.15) {
  await page.keyboard.press(k);
  await hold(after);
}
async function wheel(target, ticks, { shift = false, every = 4 } = {}) {
  await moveTo(target, 0.5);
  if (shift) await page.keyboard.down("Shift");
  for (let i = 0; i < Math.abs(ticks); i++) {
    await page.mouse.wheel(0, ticks > 0 ? -100 : 100);
    await hold(every / FPS);
  }
  if (shift) await page.keyboard.up("Shift");
}
const caption = (title, sub = "") => ev(([a, b]) => window.__capture.caption(a, b), [title, sub]);
const card = (title, sub = "", kicker = "") => ev(([a, b, c]) => window.__capture.card(a, b, c), [title, sub, kicker]);
async function panelScrollTo(selector, sec = 0.8) {
  const from = await ev(() => window.__capture.panelScroll(null));
  const to = await ev((s) => window.__capture.panelOffset(s), selector);
  await hold(sec, (t) => ev((v) => window.__capture.panelScroll(v), from + (to - from) * ease(t)));
}
async function selectIn(selector, value, move = 0.6) {
  await moveTo(selector, move);
  await hold(0.1);
  // solo el efecto visual del clic: el desplegable nativo no se abre en headless
  await ev(([x, y]) => window.dispatchEvent(new PointerEvent("pointerdown", { clientX: x, clientY: y })), mouse);
  await renderFrame();
  await page.selectOption(selector, String(value));
  await hold(0.25);
}

// ------------------------------------------------------------------ planos de cámara
const SHOT = {
  open: { pos: [-0.62, 1.32, 1.18], target: [0.02, 0.72, 0.0] },
  wide: { pos: [0.02, 1.09, 0.92], target: [-0.02, 0.71, 0.02] },
  envL: { pos: [-0.56, 0.93, 0.58], target: [-0.47, 0.73, 0.0] },
  envR: { pos: [0.6, 0.95, 0.6], target: [0.5, 0.75, -0.04] },
  bb: { pos: [-0.02, 0.785, 0.205], target: [-0.02, 0.676, 0.096] },
  bbLow: { pos: [0.016, 0.713, 0.138], target: [-0.018, 0.686, 0.1] },
  psu: { pos: [-0.27, 0.835, 0.3], target: [-0.355, 0.745, 0.04] },
  dmm: { pos: [0.355, 0.86, 0.33], target: [0.257, 0.765, 0.045] },
  mid: { pos: [0.13, 0.9, 0.44], target: [0.12, 0.705, 0.075] },
  end: { pos: [-0.35, 1.2, 1.05], target: [0.0, 0.71, 0.0] },
};
const lcd = await ev(() => window.__capture.facing("dmm:lcd", 0.17, 0.005, 0.0));

// estado inicial + calentamiento (compila shaders, no se graba)
await cam(SHOT.open.pos, SHOT.open.target);
await page.mouse.move(mouse[0], mouse[1]);
for (let i = 0; i < 20; i++) {
  await page.clock.runFor(16);
  await ev(() => window.__capture.frame(1 / 60));
}

// ================================================================== GUION
mark("título");
await card("Mesa de electrónica 3D", "Mediciones reales de tensión, corriente y potencia<br>con assets <b>OpenUSD</b> de <b>NVIDIA SimReady</b>", "three.js · física real");
await hold(0.35);
await camTo(SHOT.wide, 3.3, { curve: easeOut });
await card(null);
await hold(0.5);

mark("entorno SimReady");
await caption("Entorno 100 % SimReady", "Mesa, lámpara, herramientas y taza: OpenUSD de NVIDIA → glTF");
await camTo(SHOT.envL, 1.6);
await camTo(SHOT.envR, 3.0, { curve: (t) => t });
await caption(null);

mark("protoboard");
await camTo(SHOT.bb, 1.5, { mouseTo: "resistor:R1" });
await caption("Protoboard de 400 puntos, a escala real", "Cada resistor tiene su valor REAL dentro de la tolerancia (±5 %)");
await moveTo("resistor:R1", 0.4);
await hold(2.2);

mark("fuente");
await caption("Fuente de laboratorio 0–30 V / 0–3 A", "Regulación CV/CC con límite de corriente");
await camTo(SHOT.psu, 1.3, { mouseTo: "psu:output" });
await clickOn("psu:output", 0.3, 1.0);

mark("multímetro");
await caption("Multímetro de 6000 cuentas", "Autorango, 10 MΩ de entrada y fusibles que se queman");
await camTo(SHOT.dmm, 1.3, { mouseTo: "dial+" });
await clickOn("dial+", 0.25, 0.35);
await clickOn("dial+", 0.1, 0.6);

mark("tensión");
await caption("Medir tensión: en paralelo", "Punta roja en 14b, negra en 14i");
await camTo(SHOT.bb, 1.3);
await key("r", 0.1);
await moveTo("hole:14b", 0.7);
await hold(0.25);
await click(0.3);
await key("n", 0.1);
await moveTo("hole:14i", 0.6);
await hold(0.25);
await click(0.4);
await camTo(lcd, 1.3);
await hold(1.6);
await key(" ", 0.2); // anotar lectura

mark("corriente");
await caption("Medir corriente: en serie", "Se quita el puente J1 y el multímetro cierra el circuito");
await camTo(SHOT.bb, 1.2, { mouseTo: "jumper:J1" });
await moveTo("jumper:J1", 0.15);
await click(0.45);
await key("r", 0.1);
await moveTo("hole:RT+:14", 0.5);
await hold(0.2);
await click(0.3);
await key("n", 0.1);
await moveTo("hole:14a", 0.5);
await hold(0.2);
await click(0.3);
await caption("Llave en mA y punta roja a la borna mA", "El shunt interno (1,8 Ω) y el fusible de 440 mA están modelados");
await camTo(SHOT.dmm, 1.1, { mouseTo: "dial+" });
for (let i = 0; i < 4; i++) await clickOn("dial+", i === 0 ? 0.2 : 0.08, 0.18);
await clickOn("dmm:jack:mA", 0.45, 0.4);
await camTo(lcd, 1.0);
await hold(1.5);
await key(" ", 0.2);

mark("potencia");
await caption("Potencia: P = V · I", "El cuaderno la calcula con la incertidumbre de los instrumentos");
await camTo(SHOT.mid, 1.4, { mouseTo: [VIEW.width - 230, 300] });
await panelScrollTo("#note", 1.0);
await moveTo("#calcP", 0.6);
await hold(2.2);

mark("sobrecarga");
await caption("¿Y si te pasás de potencia?", "12 V sobre 47 Ω de ¼ W: el modelo térmico lo hace humear… y quemarse");
await panelScrollTo("#resistors", 0.8);
await camTo(SHOT.psu, 1.2, { mouseTo: "psu:knob:V" });
await wheel("psu:knob:V", 7, { shift: true, every: 5 });
await wheel("psu:knob:A", 9, { shift: true, every: 4 });
await hold(0.3);
await camTo(SHOT.bbLow, 1.3, { mouseTo: '.resistor[data-id="R1"] select[data-k="nominal"]' });
await selectIn('.resistor[data-id="R1"] select[data-k="nominal"]', 47, 0.2);
await moveTo([VIEW.width * 0.06, VIEW.height * 0.07], 0.6); // esquina libre: sin tooltips
await hold(3.6);

mark("final");
await caption(null);
await card("Mesa de electrónica 3D", `Física con análisis nodal · three.js · OpenUSD → glTF<br>${LINK ? `<code>${LINK}</code>` : "Código abierto"}`, "Assets: NVIDIA SimReady · CC-BY-4.0");
await camTo(SHOT.end, 4.2, { curve: (t) => t });
await hold(0.6);

// ------------------------------------------------------------------ fin
console.log(`Total: ${(frame / FPS).toFixed(1)} s (${frame} cuadros) en ${((Date.now() - t0) / 1000).toFixed(0)} s`);
writeFileSync(PREVIEW ? join(PREVIEW_DIR, "marks.json") : OUT.replace(/\.mp4$/, ".marks.json"), JSON.stringify(marks, null, 2));
await browser.close();
if (ff) {
  ff.stdin.end();
  await once(ff, "close");
  console.log(`Listo: ${OUT}`);
}
