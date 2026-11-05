// Ejecuta un script de Python con el intérprete del venv del proyecto (.venv), en modo aislado (-I).
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const candidates = [join(root, ".venv", "Scripts", "python.exe"), join(root, ".venv", "bin", "python")];
const python = candidates.find((p) => existsSync(p));
if (!python) {
  console.error("No se encontró .venv. Creá uno con: python -m venv .venv && .venv/Scripts/python -m pip install usd-core pillow numpy");
  process.exit(1);
}
const [script, ...args] = process.argv.slice(2);
const r = spawnSync(python, ["-I", join(root, script), ...args], { stdio: "inherit" });
process.exit(r.status ?? 1);
