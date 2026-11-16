"""External CAD/mesh solid source loader, validator, and canonical transform cache."""
from __future__ import annotations

from collections import OrderedDict
import hashlib
import math
from pathlib import Path
from typing import Callable

import numpy as np
import trimesh


SUPPORTED_EXTENSIONS = {".step", ".stp", ".stl", ".obj", ".ply"}
ALIGN_MODES = {"none", "center", "ground"}
MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_FACES = 2_000_000
DEFAULT_OPTIONS = {
    "source": "",
    "sha256": "",
    "align": "none",
    "deflection": 0.05,
    "angular_deflection": 15.0,
}

_RAW_CACHE: OrderedDict[tuple, tuple[trimesh.Trimesh, dict]] = OrderedDict()
_MAX_CACHED_SOURCES = 16


def _apply_alignment(mesh: trimesh.Trimesh, align: str) -> None:
    if align == "none":
        return
    lo, hi = mesh.bounds
    if align == "center":
        mesh.apply_translation(-0.5 * (lo + hi))
    elif align == "ground":
        mesh.apply_translation([-0.5 * (lo[0] + hi[0]), -0.5 * (lo[1] + hi[1]), -lo[2]])


def validate_imported_node(node) -> dict:
    """Validate imported_solid dimensions and operation metadata (raises ValueError on invalid setup)."""
    d = node.dimensions
    if len(d) != 1 or isinstance(d[0], bool) or not math.isfinite(d[0]) or not 0.001 <= float(d[0]) <= 1000.0:
        raise ValueError(f"节点 {node.name}：缩放比例须在 0.001–1000 之间")
    options = node.operation
    if not isinstance(options, dict) or set(options) - set(DEFAULT_OPTIONS):
        raise ValueError(f"节点 {node.name}：外部实体配置格式无效")
    merged = {key: options.get(key, default) for key, default in DEFAULT_OPTIONS.items()}
    source = merged["source"]
    if not isinstance(source, str) or not source.strip():
        raise ValueError(f"节点 {node.name}：请先选择 STEP / STL / OBJ / PLY 实体文件")
    if len(source) > 4096:
        raise ValueError(f"节点 {node.name}：文件路径过长")
    suffix = Path(source).suffix.lower()
    if suffix not in SUPPORTED_EXTENSIONS:
        raise ValueError(f"节点 {node.name}：仅支持 STEP、STP、STL、OBJ 或 PLY 文件")
    digest = merged["sha256"]
    if not isinstance(digest, str) or (digest and (len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest))):
        raise ValueError(f"节点 {node.name}：源文件校验摘要无效")
    if merged["align"] not in ALIGN_MODES:
        raise ValueError(f"节点 {node.name}：对齐方式须为 none、center 或 ground")
    for key, low, high in (("deflection", 0.001, 10.0), ("angular_deflection", 1.0, 60.0)):
        value = merged[key]
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError(f"节点 {node.name}：STEP 曲面偏差须为 0.001–10 mm，角度偏差须为 1–60°")
    return merged


def _load_raw_mesh(source_path: Path, options: dict, progress: Callable[[str], None] | None = None) -> tuple[trimesh.Trimesh, dict]:
    if not source_path.is_file() and not source_path.is_absolute():
        repo_relative = Path(__file__).resolve().parent / source_path
        if repo_relative.is_file():
            source_path = repo_relative
    if not source_path.is_file():
        raise ValueError(f"外部模型文件不存在，请重新选择：{source_path.name}")
    size = source_path.stat().st_size
    if not 0 < size <= MAX_FILE_BYTES:
        raise ValueError("外部模型文件为空或超过 128 MiB")
    data = source_path.read_bytes()
    if len(data) > MAX_FILE_BYTES:
        raise ValueError("外部模型文件超过 128 MiB")
    digest = hashlib.sha256(data).hexdigest()
    expected = options.get("sha256", "")
    if expected and expected != digest:
        raise ValueError(f"外部模型文件已被修改，请重新导入：{source_path.name}")

    suffix = source_path.suffix.lower()
    deflection = float(options["deflection"])
    angular = float(options["angular_deflection"])
    key = (str(source_path.resolve()), digest, deflection if suffix in {".step", ".stp"} else 0.0,
           angular if suffix in {".step", ".stp"} else 0.0)
    if key in _RAW_CACHE:
        _RAW_CACHE.move_to_end(key)
        raw, meta = _RAW_CACHE[key]
        return raw.copy(), dict(meta)

    if progress:
        progress(f"正在读取外部实体 {source_path.name}…")
    if suffix in {".step", ".stp"}:
        from cad_import import StepImporter
        importer = StepImporter()
        imported = importer.load({
            "source": str(source_path),
            "sha256": digest,
            "deflection": deflection,
            "angular_deflection": angular,
            "position": [0.0, 0.0, 0.0],
            "rotation": [0.0, 0.0, 0.0],
        }, progress or (lambda _msg: None))
        if imported.metadata.get("solids", 0) <= 0 and not imported.mesh.is_watertight:
            raise ValueError("导入的 STEP 文件仅包含开放曲面而非封闭实体，无法用于 TPMS 填充或体布尔")
        mesh = imported.mesh.copy()
        if not mesh.is_watertight:
            mesh.merge_vertices(digits_vertex=6)
            mesh.remove_unreferenced_vertices()
        extra_meta = {"solids": imported.metadata.get("solids", 0), "format": "STEP"}
    else:
        loaded = trimesh.load(str(source_path), force="mesh", process=False)
        if isinstance(loaded, trimesh.Scene):
            geometries = [g for g in loaded.geometry.values() if isinstance(g, trimesh.Trimesh) and len(g.faces)]
            if not geometries:
                raise ValueError("网格文件不包含有效三角面片")
            mesh = trimesh.util.concatenate(geometries)
        elif isinstance(loaded, trimesh.Trimesh):
            mesh = loaded.copy()
        else:
            raise ValueError("无法识别为三角网格模型")
        if not len(mesh.faces) or not np.isfinite(mesh.vertices).all():
            raise ValueError("网格数据无效或包含非有限坐标")
        if len(mesh.faces) > MAX_FACES:
            raise ValueError("导入网格超过 200 万面，请先简化模型后再导入")
        mesh.merge_vertices(digits_vertex=6)
        valid_faces = mesh.nondegenerate_faces()
        if not np.all(valid_faces):
            mesh.update_faces(valid_faces)
        mesh.remove_unreferenced_vertices()
        if not mesh.is_watertight:
            mesh.merge_vertices(digits_vertex=5)
            mesh.remove_unreferenced_vertices()
        extra_meta = {"solids": len(mesh.split(only_watertight=False)) if mesh.is_watertight else 0,
                      "format": suffix.lstrip(".").upper()}

    if not len(mesh.faces) or not mesh.is_watertight:
        raise ValueError(f"外部模型 {source_path.name} 不是封闭水密实体（存在开放孔洞或破面），请修复封闭后再导入")
    if not mesh.is_winding_consistent:
        mesh.fix_normals(multibody=False)
    if mesh.volume < 0:
        mesh.invert()
    if abs(float(mesh.volume)) <= 1e-9:
        raise ValueError(f"外部模型 {source_path.name} 体积为零，无法生成有效实体")

    meta = {
        "source": str(source_path.resolve()),
        "name": source_path.name,
        "sha256": digest,
        "faces": int(len(mesh.faces)),
        "vertices": int(len(mesh.vertices)),
        "bytes": int(len(data)),
        **extra_meta,
    }
    _RAW_CACHE[key] = (mesh.copy(), dict(meta))
    while len(_RAW_CACHE) > _MAX_CACHED_SOURCES:
        _RAW_CACHE.popitem(last=False)
    return mesh.copy(), meta


def canonical_imported_mesh(node, progress: Callable[[str], None] | None = None) -> tuple[trimesh.Trimesh, dict, tuple]:
    """Load the scaled + aligned mesh before node rotation/position, plus its canonical cache key."""
    options = validate_imported_node(node)
    mesh, meta = _load_raw_mesh(Path(options["source"]), options, progress)
    scale = float(node.dimensions[0])
    if scale != 1.0:
        mesh.apply_scale(scale)
    _apply_alignment(mesh, options["align"])
    cache_key = (meta["sha256"], options["align"], round(scale, 6),
                 round(float(options["deflection"]), 6) if meta["format"] == "STEP" else 0.0,
                 round(float(options["angular_deflection"]), 6) if meta["format"] == "STEP" else 0.0)
    return mesh, meta, cache_key


def imported_local_bounds(node) -> np.ndarray:
    mesh, _meta, _key = canonical_imported_mesh(node)
    return np.array(mesh.bounds, dtype=float)


def inspect_source_file(file_path: str | Path, options: dict | None = None,
                        progress: Callable[[str], None] | None = None) -> dict:
    """Validate and inspect a CAD/mesh file selected in the UI before inserting an imported_solid node."""
    raw = {**DEFAULT_OPTIONS, **(options or {}), "source": str(file_path), "sha256": ""}
    class _Shim:
        name = "外部实体"
        dimensions = (1.0,)
        operation = raw
    validated = validate_imported_node(_Shim())
    mesh, meta = _load_raw_mesh(Path(validated["source"]), validated, progress)
    bounds = mesh.bounds.tolist()
    return {
        **meta,
        "align": validated["align"],
        "deflection": validated["deflection"],
        "angular_deflection": validated["angular_deflection"],
        "bounds": bounds,
    }
