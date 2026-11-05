"""Convierte assets SimReady (OpenUSD) a GLB livianos para three.js.

- Compone el stage completo con usd-core (referencias, payloads, variantes, instancias).
- Toma solo mallas visibles con purpose default/render (descarta colisiones y guías).
- Triangula, aplica la transformación de mundo, pasa de Z-up a Y-up y a metros.
- Lee materiales UsdPreviewSurface (albedo / ORM / normal + UsdTransform2d) y hornea
  el tiling de cada material en las UV de sus triángulos.
- Reduce texturas (8K PNG -> 512/1024 JPG) y las embebe en el GLB.
- Escribe en .cache/glb; después `pnpm assets:optimize` comprime (meshopt + WebP) a public/models.

Uso:  .venv/Scripts/python.exe -I tools/usd_to_glb.py [asset_id ...]
"""
from __future__ import annotations

import io
import json
import math
import struct
import sys
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
from PIL import Image
from pxr import Gf, Sdf, Usd, UsdGeom, UsdShade

Image.MAX_IMAGE_PIXELS = None

ROOT = Path(__file__).resolve().parent.parent
CACHE = ROOT / ".cache" / "simready"
OUT = ROOT / ".cache" / "glb"  # crudos; tools/optimize_models.mjs los comprime a public/models
CONFIG = json.loads((ROOT / "tools" / "assets.json").read_text(encoding="utf-8"))


# ---------------------------------------------------------------- materiales
@dataclass
class TexRef:
    path: str
    channel: str  # rgb | r | g | b | a
    uv_xform: tuple  # (sx, sy, rot_deg, tx, ty)


@dataclass
class Mat:
    name: str
    base_color: tuple = (0.8, 0.8, 0.8)
    metallic: float = 0.0
    roughness: float = 0.5
    opacity: float = 1.0
    emissive: tuple = (0.0, 0.0, 0.0)
    base_tex: TexRef | None = None
    rough_tex: TexRef | None = None
    metal_tex: TexRef | None = None
    occl_tex: TexRef | None = None
    normal_tex: TexRef | None = None

    @property
    def uv_xform(self) -> tuple:
        for t in (self.base_tex, self.rough_tex, self.metal_tex, self.normal_tex, self.occl_tex):
            if t is not None:
                return t.uv_xform
        return (1.0, 1.0, 0.0, 0.0, 0.0)


def _follow(inp: UsdShade.Input):
    """Devuelve (shader, output_name) si la entrada está conectada."""
    if not inp or not inp.HasConnectedSource():
        return None
    srcs = inp.GetConnectedSources()[0]
    if not srcs:
        return None
    s = srcs[0]
    return UsdShade.Shader(s.source.GetPrim()), s.sourceName


def _uv_xform_of(tex_shader: UsdShade.Shader) -> tuple:
    st = tex_shader.GetInput("st")
    con = _follow(st)
    if con is None:
        return (1.0, 1.0, 0.0, 0.0, 0.0)
    sh, _ = con
    if sh.GetIdAttr().Get() != "UsdTransform2d":
        return (1.0, 1.0, 0.0, 0.0, 0.0)

    def val(name, default):
        i = sh.GetInput(name)
        v = i.Get() if i else None
        return default if v is None else v

    sc = val("scale", Gf.Vec2f(1, 1))
    tr = val("translation", Gf.Vec2f(0, 0))
    rot = val("rotation", 0.0)
    return (float(sc[0]), float(sc[1]), float(rot), float(tr[0]), float(tr[1]))


def _tex_from_input(inp) -> TexRef | None:
    con = _follow(inp)
    if con is None:
        return None
    sh, out_name = con
    if sh.GetIdAttr().Get() != "UsdUVTexture":
        return None
    f = sh.GetInput("file")
    asset = f.Get() if f else None
    if asset is None:
        return None
    path = asset.resolvedPath or ""
    if not path or not Path(path).exists():
        return None
    return TexRef(path=path, channel=str(out_name), uv_xform=_uv_xform_of(sh))


def _const(inp, default):
    if not inp:
        return default
    v = inp.Get()
    return default if v is None else v


def read_material(material: UsdShade.Material | None) -> Mat:
    if material is None or not material.GetPrim().IsValid():
        return Mat(name="default")
    m = Mat(name=material.GetPrim().GetName())
    surf = material.ComputeSurfaceSource()
    shader = surf[0] if isinstance(surf, tuple) else surf
    if not shader or shader.GetIdAttr().Get() != "UsdPreviewSurface":
        return m
    gi = shader.GetInput
    m.base_tex = _tex_from_input(gi("diffuseColor"))
    if m.base_tex is None:
        c = _const(gi("diffuseColor"), Gf.Vec3f(0.8, 0.8, 0.8))
        m.base_color = (float(c[0]), float(c[1]), float(c[2]))
    m.rough_tex = _tex_from_input(gi("roughness"))
    m.roughness = float(_const(gi("roughness"), 0.5)) if m.rough_tex is None else 1.0
    m.metal_tex = _tex_from_input(gi("metallic"))
    m.metallic = float(_const(gi("metallic"), 0.0)) if m.metal_tex is None else 1.0
    m.occl_tex = _tex_from_input(gi("occlusion"))
    m.normal_tex = _tex_from_input(gi("normal"))
    m.opacity = float(_const(gi("opacity"), 1.0))
    e = _const(gi("emissiveColor"), Gf.Vec3f(0, 0, 0))
    m.emissive = (float(e[0]), float(e[1]), float(e[2]))
    return m


# ---------------------------------------------------------------- geometría
@dataclass
class Bucket:
    mat: Mat
    pos: list = field(default_factory=list)
    nrm: list = field(default_factory=list)
    uv: list = field(default_factory=list)


def _corner_attr(values, interp, face_vertex_indices, tri_corners, tri_faces):
    if values is None:
        return None
    a = np.asarray(values, dtype=np.float64)
    if interp == UsdGeom.Tokens.faceVarying:
        return a[tri_corners]
    if interp in (UsdGeom.Tokens.vertex, UsdGeom.Tokens.varying):
        return a[face_vertex_indices[tri_corners]]
    if interp == UsdGeom.Tokens.uniform:
        return a[tri_faces]
    if interp == UsdGeom.Tokens.constant:
        return np.repeat(a.reshape(1, -1), len(tri_corners), axis=0)
    return None


def _primvar(mesh: UsdGeom.Mesh, names):
    api = UsdGeom.PrimvarsAPI(mesh)
    for n in names:
        pv = api.GetPrimvar(n)
        if pv and pv.HasValue():
            return pv.ComputeFlattened(), pv.GetInterpolation()
    return None, None


def triangulate(counts: np.ndarray):
    """Abanico por cara. Devuelve (corner_idx[T*3], face_idx[T])."""
    counts = counts.astype(np.int64)
    starts = np.concatenate([[0], np.cumsum(counts)[:-1]])
    ntri = np.clip(counts - 2, 0, None)
    faces = np.repeat(np.arange(len(counts)), ntri)
    # k = 1..c-2 dentro de cada cara
    offs = np.concatenate([[0], np.cumsum(ntri)[:-1]])
    k = np.arange(ntri.sum()) - np.repeat(offs, ntri) + 1
    s = starts[faces]
    corners = np.stack([s, s + k, s + k + 1], axis=1).reshape(-1)
    return corners, faces


# Z-up (USD SimReady) -> Y-up (three.js), vector fila: (x, y, z) -> (x, z, -y)
ZUP_TO_YUP = np.array([[1, 0, 0], [0, 0, -1], [0, 1, 0]], dtype=np.float64)


def collect(stage: Usd.Stage):
    up = UsdGeom.GetStageUpAxis(stage)
    mpu = UsdGeom.GetStageMetersPerUnit(stage) or 1.0
    axis = ZUP_TO_YUP if up == UsdGeom.Tokens.z else np.eye(3)
    cache = UsdGeom.XformCache(Usd.TimeCode.Default())
    bind_cache = {}
    buckets: dict[str, Bucket] = {}
    stats = {"meshes": 0, "skipped": 0, "tris": 0}

    def mat_for(prim) -> Mat:
        mat, _rel = UsdShade.MaterialBindingAPI(prim).ComputeBoundMaterial()
        key = str(mat.GetPath()) if mat else "default"
        if key not in bind_cache:
            bind_cache[key] = read_material(mat if mat else None)
        return bind_cache[key]

    it = iter(Usd.PrimRange.Stage(stage, Usd.TraverseInstanceProxies()))
    for prim in it:
        if not prim.IsA(UsdGeom.Mesh):
            continue
        img = UsdGeom.Imageable(prim)
        if img.ComputeVisibility() == UsdGeom.Tokens.invisible or img.ComputePurpose() in (UsdGeom.Tokens.guide, UsdGeom.Tokens.proxy):
            stats["skipped"] += 1
            continue
        path_s = str(prim.GetPath()).lower()
        if "collision" in path_s or "/grasp" in path_s:
            stats["skipped"] += 1
            continue
        mesh = UsdGeom.Mesh(prim)
        pts = mesh.GetPointsAttr().Get()
        counts = mesh.GetFaceVertexCountsAttr().Get()
        fvi = mesh.GetFaceVertexIndicesAttr().Get()
        if not pts or not counts or not fvi:
            continue
        stats["meshes"] += 1
        pts = np.asarray(pts, dtype=np.float64)
        counts = np.asarray(counts, dtype=np.int64)
        fvi = np.asarray(fvi, dtype=np.int64)
        corners, faces = triangulate(counts)
        if mesh.GetOrientationAttr().Get() == UsdGeom.Tokens.leftHanded:
            corners = corners.reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)

        M = np.array(cache.GetLocalToWorldTransform(prim), dtype=np.float64)  # vector fila
        R = M[:3, :3]
        T = M[3, :3]
        P = (pts @ R + T) @ axis * mpu
        flip = np.linalg.det(R) < 0
        Ninv = np.linalg.inv(R).T @ axis

        pos = P[fvi[corners]]

        nv, ni = _primvar(mesh, ["normals"])
        if nv is None:
            nv = mesh.GetNormalsAttr().Get()
            ni = mesh.GetNormalsInterpolation() if nv is not None else None
        nrm = _corner_attr(nv, ni, fvi, corners, faces)
        if nrm is not None:
            nrm = nrm @ Ninv
            ln = np.linalg.norm(nrm, axis=1, keepdims=True)
            nrm = nrm / np.where(ln == 0, 1, ln)

        sv, si = _primvar(mesh, ["st", "st0", "UVMap", "uv", "map1"])
        uv = _corner_attr(sv, si, fvi, corners, faces)
        if uv is None:
            uv = np.zeros((len(corners), 2))

        if flip:
            order = np.arange(len(corners)).reshape(-1, 3)[:, [0, 2, 1]].reshape(-1)
            pos, uv = pos[order], uv[order]
            nrm = nrm[order] if nrm is not None else None

        # material por cara (GeomSubsets) o por malla
        tri_count = len(faces)
        tri_mat = [mat_for(prim)] * 1
        face_to_mat = None
        subsets = UsdShade.MaterialBindingAPI(prim).GetMaterialBindSubsets()
        if subsets:
            face_to_mat = np.full(len(counts), -1, dtype=np.int64)
            mats = []
            for i, sub in enumerate(subsets):
                idx = sub.GetIndicesAttr().Get()
                if idx is None:
                    continue
                face_to_mat[np.asarray(idx, dtype=np.int64)] = len(mats)
                mats.append(mat_for(sub.GetPrim()))
            base = mat_for(prim)
            mats.append(base)
            face_to_mat[face_to_mat < 0] = len(mats) - 1
            tri_mat = mats
            tri_sel = face_to_mat[faces]
        else:
            tri_sel = np.zeros(tri_count, dtype=np.int64)

        for mi, mat in enumerate(tri_mat):
            sel_t = np.nonzero(tri_sel == mi)[0]
            if len(sel_t) == 0:
                continue
            sel_c = (sel_t[:, None] * 3 + np.arange(3)).reshape(-1)
            key = mat.name
            b = buckets.setdefault(key, Bucket(mat=mat))
            b.pos.append(pos[sel_c])
            b.nrm.append(nrm[sel_c] if nrm is not None else None)
            b.uv.append(uv[sel_c])
            stats["tris"] += len(sel_t)
    return buckets, stats


def bake_uv(uv: np.ndarray, xf: tuple) -> np.ndarray:
    sx, sy, rot, tx, ty = xf
    u, v = uv[:, 0] * sx, uv[:, 1] * sy
    if rot:
        r = math.radians(rot)
        c, s = math.cos(r), math.sin(r)
        u, v = u * c - v * s, u * s + v * c
    u, v = u + tx, v + ty
    return np.stack([u, 1.0 - v], axis=1)  # origen glTF arriba-izquierda


def flat_normals(pos: np.ndarray) -> np.ndarray:
    tri = pos.reshape(-1, 3, 3)
    n = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
    ln = np.linalg.norm(n, axis=1, keepdims=True)
    n = n / np.where(ln == 0, 1, ln)
    return np.repeat(n, 3, axis=0)


def build_primitive(b: Bucket):
    pos = np.concatenate(b.pos)
    uv = bake_uv(np.concatenate(b.uv), b.mat.uv_xform)
    nrm_parts = [n if n is not None else flat_normals(p) for n, p in zip(b.nrm, b.pos)]
    nrm = np.concatenate(nrm_parts)
    verts = np.concatenate([pos, nrm, uv], axis=1).astype(np.float32)
    uniq, inv = np.unique(verts, axis=0, return_inverse=True)
    return uniq, inv.reshape(-1).astype(np.uint32)


# ---------------------------------------------------------------- texturas
_tex_cache: dict[tuple, bytes] = {}


def encode_texture(path: str, max_size: int, kind: str) -> bytes:
    key = (path, max_size, kind)
    if key in _tex_cache:
        return _tex_cache[key]
    im = Image.open(path)
    im = im.convert("RGB")
    w, h = im.size
    s = min(1.0, max_size / max(w, h))
    if s < 1.0:
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
    buf = io.BytesIO()
    im.save(buf, format="JPEG", quality=90 if kind == "normal" else 85, optimize=True)
    _tex_cache[key] = buf.getvalue()
    return _tex_cache[key]


def combine_mr(rough: TexRef | None, metal: TexRef | None, occl: TexRef | None, max_size: int, rough_c: float, metal_c: float) -> bytes:
    """Arma una textura glTF metallicRoughness (R=AO, G=rough, B=metal)."""
    if rough and metal and rough.path == metal.path and rough.channel == "g" and metal.channel == "b":
        return encode_texture(rough.path, max_size, "orm")
    size = None
    chans = []
    for ref, const in ((occl, 1.0), (rough, rough_c), (metal, metal_c)):
        if ref is None:
            chans.append(const)
            continue
        im = Image.open(ref.path).convert("RGBA")
        w, h = im.size
        s = min(1.0, max_size / max(w, h))
        im = im.resize((max(1, round(w * s)), max(1, round(h * s))), Image.LANCZOS)
        size = size or im.size
        band = {"r": 0, "g": 1, "b": 2, "a": 3}.get(ref.channel, 0)
        chans.append(im.split()[band].resize(size))
    size = size or (4, 4)
    bands = [c if isinstance(c, Image.Image) else Image.new("L", size, int(round(c * 255))) for c in chans]
    out = Image.merge("RGB", [b.resize(size) for b in bands])
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=88)
    return buf.getvalue()


# ---------------------------------------------------------------- GLB
class GLB:
    def __init__(self):
        self.bin = bytearray()
        self.j = {
            "asset": {"version": "2.0", "generator": "simready usd_to_glb.py"},
            "scene": 0,
            "scenes": [{"nodes": [0]}],
            "nodes": [{"mesh": 0, "name": "root"}],
            "meshes": [{"primitives": []}],
            "accessors": [],
            "bufferViews": [],
            "buffers": [{"byteLength": 0}],
            "materials": [],
            "textures": [],
            "images": [],
            "samplers": [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}],
        }

    def _view(self, data: bytes, target: int | None = None) -> int:
        while len(self.bin) % 4:
            self.bin.append(0)
        off = len(self.bin)
        self.bin += data
        v = {"buffer": 0, "byteOffset": off, "byteLength": len(data)}
        if target:
            v["target"] = target
        self.j["bufferViews"].append(v)
        return len(self.j["bufferViews"]) - 1

    def accessor(self, arr: np.ndarray, ctype: int, typ: str, target: int, minmax=False) -> int:
        view = self._view(arr.tobytes(), target)
        a = {"bufferView": view, "componentType": ctype, "count": int(arr.shape[0]), "type": typ}
        if minmax:
            a["min"] = arr.min(axis=0).tolist()
            a["max"] = arr.max(axis=0).tolist()
        self.j["accessors"].append(a)
        return len(self.j["accessors"]) - 1

    def image(self, data: bytes) -> int:
        view = self._view(data)
        self.j["images"].append({"bufferView": view, "mimeType": "image/jpeg"})
        self.j["textures"].append({"source": len(self.j["images"]) - 1, "sampler": 0})
        return len(self.j["textures"]) - 1

    def write(self, path: Path):
        if not self.j["textures"]:
            for k in ("textures", "images", "samplers"):
                self.j.pop(k)
        while len(self.bin) % 4:
            self.bin.append(0)
        self.j["buffers"][0]["byteLength"] = len(self.bin)
        js = json.dumps(self.j, separators=(",", ":")).encode("utf-8")
        js += b" " * ((4 - len(js) % 4) % 4)
        total = 12 + 8 + len(js) + 8 + len(self.bin)
        with open(path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total))
            f.write(struct.pack("<II", len(js), 0x4E4F534A) + js)
            f.write(struct.pack("<II", len(self.bin), 0x004E4942) + bytes(self.bin))


def convert(asset_id: str, max_tex: int) -> dict:
    usd_dir = CACHE / asset_id / "simready_usd"
    roots = sorted(usd_dir.glob("sm_*.usd")) or sorted(usd_dir.glob("*.usd*"))
    if not roots:
        raise FileNotFoundError(f"No hay USD raíz en {usd_dir} (¿corriste fetch_assets.py?)")
    stage = Usd.Stage.Open(str(roots[0]), Usd.Stage.LoadAll)
    buckets, stats = collect(stage)

    g = GLB()
    tex_ids: dict[tuple, int] = {}

    def tex(key, fn):
        if key not in tex_ids:
            tex_ids[key] = g.image(fn())
        return tex_ids[key]

    lo = np.full(3, np.inf)
    hi = np.full(3, -np.inf)
    for b in buckets.values():
        verts, idx = build_primitive(b)
        lo = np.minimum(lo, verts[:, :3].min(axis=0))
        hi = np.maximum(hi, verts[:, :3].max(axis=0))
        m = b.mat
        pbr = {
            "baseColorFactor": [*([1.0, 1.0, 1.0] if m.base_tex else list(m.base_color)), m.opacity],
            "metallicFactor": m.metallic,
            "roughnessFactor": m.roughness,
        }
        gm: dict = {"name": m.name, "pbrMetallicRoughness": pbr, "doubleSided": False}
        if m.base_tex:
            pbr["baseColorTexture"] = {"index": tex(("base", m.base_tex.path), lambda: encode_texture(m.base_tex.path, max_tex, "albedo"))}
        if m.rough_tex or m.metal_tex:
            key = ("mr", m.rough_tex and m.rough_tex.path, m.metal_tex and m.metal_tex.path)
            ti = tex(key, lambda: combine_mr(m.rough_tex, m.metal_tex, m.occl_tex, max_tex, m.roughness, m.metallic))
            pbr["metallicRoughnessTexture"] = {"index": ti}
            pbr["metallicFactor"] = 1.0 if m.metal_tex else m.metallic
            pbr["roughnessFactor"] = 1.0 if m.rough_tex else m.roughness
            same_orm = m.rough_tex and m.metal_tex and m.rough_tex.path == m.metal_tex.path and m.rough_tex.channel == "g"
            if same_orm:
                gm["occlusionTexture"] = {"index": ti, "strength": 1.0}
        if m.normal_tex:
            gm["normalTexture"] = {"index": tex(("nrm", m.normal_tex.path), lambda: encode_texture(m.normal_tex.path, max_tex, "normal")), "scale": 1.0}
        if any(m.emissive):
            gm["emissiveFactor"] = list(m.emissive)
        if m.opacity < 0.999:
            gm["alphaMode"] = "BLEND"
            gm["doubleSided"] = True
        g.j["materials"].append(gm)
        prim = {
            "attributes": {
                "POSITION": g.accessor(np.ascontiguousarray(verts[:, 0:3]), 5126, "VEC3", 34962, minmax=True),
                "NORMAL": g.accessor(np.ascontiguousarray(verts[:, 3:6]), 5126, "VEC3", 34962),
                "TEXCOORD_0": g.accessor(np.ascontiguousarray(verts[:, 6:8]), 5126, "VEC2", 34962),
            },
            "indices": g.accessor(idx, 5125, "SCALAR", 34963),
            "material": len(g.j["materials"]) - 1,
        }
        g.j["meshes"][0]["primitives"].append(prim)

    OUT.mkdir(parents=True, exist_ok=True)
    out = OUT / f"{asset_id}.glb"
    g.write(out)
    info = {
        "id": asset_id,
        "file": f"models/{asset_id}.glb",
        "bboxMin": [round(float(x), 5) for x in lo],
        "bboxMax": [round(float(x), 5) for x in hi],
        "triangles": stats["tris"],
        "materials": len(buckets),
        "bytes": out.stat().st_size,
    }
    print(f"   {asset_id}: {stats['meshes']} mallas ({stats['skipped']} omitidas), {stats['tris']} tris, "
          f"{len(buckets)} materiales -> {out.stat().st_size / 1e6:.2f} MB  bbox {info['bboxMin']} .. {info['bboxMax']}", flush=True)
    return info


def main():
    default_max = CONFIG.get("textureMaxSize", 1024)
    entries = {a["id"]: a for a in CONFIG["assets"]}
    wanted = sys.argv[1:] or list(entries)
    manifest_path = OUT / "manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    for asset_id in wanted:
        cfg = entries.get(asset_id, {"id": asset_id})
        print(f"== {asset_id}", flush=True)
        manifest[asset_id] = convert(asset_id, cfg.get("textureMaxSize", default_max))
    manifest_path.write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
