"""Descarga los assets SimReady listados en tools/assets.json desde Hugging Face.

Solo baja lo necesario para renderizar: capas USD y la carpeta Textures/.
Omite miniaturas (.thumbs) y source_assets (duplicados de texturas + MDL).

Uso:  .venv/Scripts/python.exe -I tools/fetch_assets.py [asset_id ...]
"""
from __future__ import annotations

import json
import sys
import urllib.parse
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "simready"
CONFIG = json.loads((ROOT / "tools" / "assets.json").read_text(encoding="utf-8"))
DATASET = CONFIG["dataset"]
REV = CONFIG["revision"]
UA = {"User-Agent": "simready-workbench-fetch/1.0"}


def list_files(asset_id: str) -> list[dict]:
    url = f"https://huggingface.co/api/datasets/{DATASET}/tree/{REV}/{urllib.parse.quote(asset_id)}?recursive=true"
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=60) as r:
        entries = json.load(r)
    keep = []
    for e in entries:
        if e["type"] != "file":
            continue
        p = e["path"]
        if "/.thumbs/" in p or "/source_assets/" in p or "/.metadata/" in p:
            continue
        if "/simready_usd/" not in p:
            continue
        keep.append(e)
    return keep


def download(entry: dict) -> str:
    rel = entry["path"]
    dest = CACHE / rel
    if dest.exists() and dest.stat().st_size == entry["size"]:
        return f"skip {rel}"
    dest.parent.mkdir(parents=True, exist_ok=True)
    url = f"https://huggingface.co/datasets/{DATASET}/resolve/{REV}/{urllib.parse.quote(rel)}"
    tmp = dest.with_suffix(dest.suffix + ".part")
    with urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=600) as r, open(tmp, "wb") as f:
        while chunk := r.read(1 << 20):
            f.write(chunk)
    tmp.replace(dest)
    return f"ok   {rel} ({entry['size'] / 1e6:.1f} MB)"


def main() -> None:
    wanted = sys.argv[1:] or [a["id"] for a in CONFIG["assets"]]
    for asset_id in wanted:
        files = list_files(asset_id)
        total = sum(e["size"] for e in files) / 1e6
        print(f"== {asset_id}: {len(files)} archivos, {total:.1f} MB", flush=True)
        with ThreadPoolExecutor(max_workers=6) as pool:
            for msg in pool.map(download, files):
                print("  ", msg, flush=True)
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
