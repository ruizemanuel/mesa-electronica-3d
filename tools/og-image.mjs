/**
 * Genera public/og.jpg (1200×630), la imagen de vista previa del link en X y otras redes.
 * Se renderiza desde la escena real en modo ?capture, con una medición en curso.
 *
 *   pnpm dev                       # en otra terminal
 *   node tools/og-image.mjs        # -> public/og.jpg
 */
import { spawnSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { chromium } from "playwright";

const APP = process.argv[2] ?? "http://localhost:5173/?capture";
const OUT = "public/og.jpg";
const TMP = ".cache/og.png";
const W = 1200;
const H = 630;
const exe = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe"].find((p) => existsSync(p));

const browser = await chromium.launch({ executablePath: exe, headless: true, args: ["--use-angle=d3d11", "--enable-gpu", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
await page.clock.install({ time: 0 });
await page.goto(APP, { waitUntil: "load" });
await page.waitForFunction(() => window.__capture?.loaded, null, { timeout: 120000 });
await page.evaluate(() => document.fonts.ready);

// escena: medición de tensión sobre R1, panel lateral oculto
await page.evaluate(() => {
  const s = document.createElement("style");
  s.textContent = `#panel{display:none!important} .cap-cursor{display:none!important}`;
  document.head.appendChild(s);
  window.dispatchEvent(new Event("resize"));
  const b = window.__capture.bench;
  b.psu.output = true;
  b.dmm.setDial("VDC");
  b.probes.red = { kind: "hole", hole: "14b" };
  b.probes.black = { kind: "hole", hole: "14i" };
  window.__capture.cam([-0.05, 0.9, 0.64], [-0.05, 0.738, -0.01]);
});
for (let i = 0; i < 90; i++) {
  await page.clock.runFor(17);
  await page.evaluate(() => window.__capture.frame(1 / 60));
}

// título
await page.evaluate(() => {
  const o = document.createElement("div");
  o.innerHTML = `
    <div style="position:fixed;inset:0;pointer-events:none;z-index:80;
      background:linear-gradient(180deg,rgba(12,13,16,.86) 0%,rgba(12,13,16,.55) 26%,rgba(12,13,16,0) 46%);"></div>
    <div style="position:fixed;left:48px;top:34px;z-index:81;font-family:Inter,'Segoe UI',sans-serif;color:#fff">
      <div style="font-size:17px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#f0b429">three.js · OpenUSD · NVIDIA SimReady</div>
      <div style="font-size:58px;font-weight:800;letter-spacing:-.025em;line-height:1.05;margin-top:8px">Mesa de electrónica 3D</div>
      <div style="font-size:24px;color:#d5d9df;margin-top:10px">Multímetro, fuente y protoboard con física real · gratis en el navegador</div>
    </div>`;
  document.body.appendChild(o);
});
await page.clock.runFor(17);
await page.evaluate(() => window.__capture.frame(1 / 60));
await page.screenshot({ path: TMP });
await browser.close();

// 2400×1260 -> 1200×630 (supermuestreo para bordes nítidos)
const r = spawnSync("ffmpeg", ["-y", "-hide_banner", "-loglevel", "error", "-i", TMP, "-vf", `scale=${W}:${H}:flags=lanczos`, "-q:v", "3", OUT], { stdio: "inherit" });
rmSync(TMP, { force: true });
if (r.status !== 0) process.exit(r.status ?? 1);
console.log(`Listo: ${OUT}`);
