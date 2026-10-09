"""Parametric implicit solids and an editable acyclic CSG object graph."""
from __future__ import annotations

import json
import math
import os
import tempfile
from dataclasses import asdict, dataclass, field, replace
from pathlib import Path

import numpy as np
import trimesh

from libfive_backend import (NativeKernel, _TreeArena, _field_tree, _Region,
                            _Interval, render_tree_mesh, validate_libfive_parameters)
from tpms_core import TPMSParameters, _material_scalar_field

KINDS = {"sphere": "球", "box": "盒", "cylinder": "圆柱", "torus": "圆环",
         "tpms": "TPMS", "union": "并集", "intersection": "交集",
         "difference": "差集 A−B", "smooth_union": "平滑融合"}
OPERATIONS = {"union", "intersection", "difference", "smooth_union"}


@dataclass(frozen=True)
class SolidNode:
    id: str
    name: str
    kind: str
    dimensions: tuple[float, ...] = (8.0,)
    position: tuple[float, float, float] = (0.0, 0.0, 0.0)
    rotation: tuple[float, float, float] = (0.0, 0.0, 0.0)
    inputs: tuple[str, ...] = ()
    blend: float = 2.0
    tpms: TPMSParameters | None = None


def rotation_matrix(angles) -> np.ndarray:
    x, y, z = np.radians(angles)
    cx, cy, cz, sx, sy, sz = math.cos(x), math.cos(y), math.cos(z), math.sin(x), math.sin(y), math.sin(z)
    return np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]]) @ np.array([
        [cy, 0, sy], [0, 1, 0], [-sy, 0, cy]]) @ np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])


@dataclass
class SolidScene:
    nodes: list[SolidNode] = field(default_factory=list)
    root: str = ""
    cell_size: float = 0.6

    def by_id(self, identifier: str) -> SolidNode:
        for node in self.nodes:
            if node.id == identifier:
                return node
        raise ValueError(f"对象不存在：{identifier}")

    def add(self, kind: str, **kwargs) -> SolidNode:
        if len(self.nodes) >= 64:
            raise ValueError("当前最多支持 64 个对象")
        index = 1
        identifiers = {node.id for node in self.nodes}
        while f"n{index}" in identifiers:
            index += 1
        node = SolidNode(id=f"n{index}", name=f"{KINDS[kind]} {index}", kind=kind, **kwargs)
        self.nodes.append(node)
        self.root = node.id
        return node

    def remove(self, identifier: str) -> None:
        dependents = [node.name for node in self.nodes if identifier in node.inputs]
        if dependents:
            raise ValueError("对象被以下组合引用，请先删除组合：" + "、".join(dependents))
        self.nodes = [node for node in self.nodes if node.id != identifier]
        if self.root == identifier:
            self.root = self.nodes[-1].id if self.nodes else ""

    def validate(self) -> None:
        if not self.nodes or len(self.nodes) > 64:
            raise ValueError("请添加 1–64 个建模对象")
        if not math.isfinite(self.cell_size) or not 0.001 <= self.cell_size <= 100:
            raise ValueError("网格尺寸须在 0.001–100 mm 之间")
        ids = [node.id for node in self.nodes]
        if len(ids) != len(set(ids)):
            raise ValueError("对象 ID 重复")
        self.by_id(self.root)
        for node in self.nodes:
            if node.kind not in KINDS or not node.name.strip():
                raise ValueError("对象类型或名称无效")
            if len(node.position) != 3 or len(node.rotation) != 3:
                raise ValueError("位置和旋转需要 XYZ 三个值")
            if not all(math.isfinite(value) and abs(value) <= 10000 for value in (*node.position, *node.rotation)):
                raise ValueError("位置/旋转必须是有限值，绝对值不超过 10000")
            if node.kind in OPERATIONS:
                if len(node.inputs) != 2 or node.inputs[0] == node.inputs[1]:
                    raise ValueError("组合需要两个不同对象")
                for child in node.inputs:
                    self.by_id(child)
                if node.kind == "smooth_union" and (not math.isfinite(node.blend) or not 0.001 <= node.blend <= 100):
                    raise ValueError("融合宽度须在 0.001–100 mm 之间")
            elif node.inputs:
                raise ValueError("基本实体不能引用其他对象")
            if node.kind == "tpms":
                if node.tpms is None:
                    raise ValueError("TPMS 对象缺少参数")
                node.tpms.validate()
                if node.tpms.tubular_enabled:
                    raise ValueError("实体组合暂不支持管状卷绕 TPMS")
            elif node.kind not in OPERATIONS:
                counts = {"sphere": 1, "box": 3, "cylinder": 2, "torus": 2}
                if len(node.dimensions) != counts[node.kind] or not all(
                    math.isfinite(value) and 0 < value <= 2000 for value in node.dimensions):
                    raise ValueError(f"{node.name} 的尺寸必须为 0–2000 mm 内的正数")
                if node.kind == "torus" and node.dimensions[0] <= node.dimensions[1]:
                    raise ValueError("圆环主半径必须大于管半径")
        visiting, visited = set(), set()
        def visit(identifier):
            if identifier in visiting:
                raise ValueError("组合存在循环引用")
            if identifier in visited:
                return
            visiting.add(identifier)
            for child in self.by_id(identifier).inputs:
                visit(child)
            visiting.remove(identifier)
            visited.add(identifier)
        for identifier in ids:
            visit(identifier)
        for node in self.nodes:
            if node.kind == "smooth_union" and self.contains_tpms(node.id):
                raise ValueError("TPMS 场不是精确距离场；平滑融合目前仅支持基本实体组合")

    def contains_tpms(self, identifier: str) -> bool:
        node = self.by_id(identifier)
        return node.kind == "tpms" or any(self.contains_tpms(child) for child in node.inputs)

    def bounds(self, identifier: str | None = None) -> np.ndarray:
        node = self.by_id(identifier or self.root)
        if node.kind in OPERATIONS:
            a, b = [self.bounds(child) for child in node.inputs]
            if node.kind == "difference":
                bounds = a
            elif node.kind == "intersection":
                bounds = np.array([np.maximum(a[0], b[0]), np.minimum(a[1], b[1])])
                if np.any(bounds[1] <= bounds[0]):
                    raise ValueError("交集为空：两个对象包围盒没有重叠")
            else:
                bounds = np.array([np.minimum(a[0], b[0]), np.maximum(a[1], b[1])])
                if node.kind == "smooth_union":
                    bounds += np.array([[-node.blend / 4] * 3, [node.blend / 4] * 3])
        else:
            d = node.dimensions
            half = {"sphere": lambda: [d[0]] * 3,
                    "box": lambda: np.array(d) / 2,
                    "cylinder": lambda: [d[0], d[0], d[1] / 2],
                    "torus": lambda: [d[0] + d[1], d[0] + d[1], d[1]],
                    "tpms": lambda: np.array([node.tpms.size_x, node.tpms.size_y, node.tpms.size_z]) / 2}[node.kind]()
            bounds = np.array([-np.array(half), half])
        corners = np.array([[bounds[(mask >> axis) & 1, axis] for axis in range(3)] for mask in range(8)])
        transformed = corners @ rotation_matrix(node.rotation).T + node.position
        return np.array([transformed.min(axis=0), transformed.max(axis=0)])

    def to_dict(self) -> dict:
        return {"version": 1, "root": self.root, "cell_size": self.cell_size,
                "nodes": [asdict(node) for node in self.nodes]}

    @classmethod
    def from_dict(cls, data: dict) -> SolidScene:
        try:
            if not isinstance(data, dict) or not isinstance(data.get("nodes"), list):
                raise ValueError("建模项目必须包含对象列表")
            if data["version"] != 1 or len(data["nodes"]) > 64:
                raise ValueError("不支持的项目版本或对象数量")
            nodes = []
            for raw in data["nodes"]:
                args = dict(raw)
                for key in ("dimensions", "position", "rotation", "inputs"):
                    args[key] = tuple(args[key])
                if args.get("tpms") is not None:
                    args["tpms"] = TPMSParameters(**args["tpms"])
                nodes.append(SolidNode(**args))
            scene = cls(nodes=nodes, root=data["root"], cell_size=float(data["cell_size"]))
            scene.validate()
            return scene
        except (KeyError, TypeError, OverflowError, RecursionError) as exc:
            raise ValueError(f"建模项目格式无效：{exc}") from exc

    def save(self, path: Path) -> None:
        self.validate()
        descriptor, temporary = tempfile.mkstemp(dir=path.parent, suffix=".json")
        try:
            with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
                json.dump(self.to_dict(), stream, ensure_ascii=False, indent=2)
            Path(temporary).replace(path)
        finally:
            Path(temporary).unlink(missing_ok=True)

    @classmethod
    def load(cls, path: Path) -> SolidScene:
        if path.stat().st_size > 2_000_000:
            raise ValueError("建模项目超过 2 MB，拒绝读取")
        try:
            return cls.from_dict(json.loads(path.read_text(encoding="utf-8")))
        except (json.JSONDecodeError, AttributeError) as exc:
            raise ValueError("建模项目不是有效 JSON") from exc


def _scene_tree(arena, scene: SolidScene, identifier: str, cache: dict):
    if identifier in cache:
        return cache[identifier]
    node = scene.by_id(identifier)
    coords = [arena.op(f"var-{axis}") for axis in "xyz"]
    x, y, z = coords
    op = arena.op
    length = lambda *values: op("sqrt", sum(value ** 2 for value in values))
    d = node.dimensions
    if node.kind == "sphere":
        tree = length(x, y, z) - d[0]
    elif node.kind == "box":
        q = [op("abs", coord) - size / 2 for coord, size in zip(coords, d)]
        tree = length(*(op("max", value, 0) for value in q)) + op("min", op("max", q[0], op("max", q[1], q[2])), 0)
    elif node.kind == "cylinder":
        radial, axial = length(x, y) - d[0], op("abs", z) - d[1] / 2
        tree = length(op("max", radial, 0), op("max", axial, 0)) + op("min", op("max", radial, axial), 0)
    elif node.kind == "torus":
        tree = length(length(x, y) - d[0], z) - d[1]
    elif node.kind == "tpms":
        p = node.tpms
        if p.target_porosity is not None:
            p = _material_scalar_field(p)[0]
        validate_libfive_parameters(p, scene.cell_size)
        tree = _field_tree(arena, p)
    else:
        a, b = [_scene_tree(arena, scene, child, cache) for child in node.inputs]
        if node.kind == "union":
            tree = op("min", a, b)
        elif node.kind == "intersection":
            tree = op("max", a, b)
        elif node.kind == "difference":
            tree = op("max", a, -b)
        else:
            # Polynomial smooth minimum, with a blend width in mm.
            h = op("max", node.blend - op("abs", a - b), 0) / node.blend
            tree = op("min", a, b) - h ** 2 * (node.blend / 4)
    inverse = rotation_matrix(node.rotation).T
    local = [sum(float(inverse[row, col]) * (coords[col] - node.position[col]) for col in range(3)) for row in range(3)]
    if any(node.position) or any(node.rotation):
        tree = tree.remap(local)
    cache[identifier] = tree
    return tree


@dataclass(frozen=True)
class SolidResult:
    mesh: trimesh.Trimesh
    scene: SolidScene


def generate_solid(scene: SolidScene) -> SolidResult:
    scene = SolidScene.from_dict(scene.to_dict())  # frozen snapshot of GUI state
    scene.validate()
    bounds = scene.bounds()
    size = bounds[1] - bounds[0]
    margin = scene.cell_size * 2
    levels = max(0, math.ceil(math.log2((min(size) + 2 * margin) / scene.cell_size)))
    if 8 ** levels > 16_777_216:
        raise ValueError("网格尺寸过小：潜在八叉树超过 1677 万叶节点，请增大网格尺寸")
    if scene.cell_size > min(size) / 4:
        raise ValueError("网格尺寸过粗，请设置不超过最小外形尺寸的四分之一")
    kernel = NativeKernel()
    with _TreeArena(kernel) as arena:
        tree = _scene_tree(arena, scene, scene.root, {})
        region = _Region(*[_Interval(float(lo - margin), float(hi + margin)) for lo, hi in zip(*bounds)])
        mesh = render_tree_mesh(kernel, tree, region, scene.cell_size)
    return SolidResult(mesh, scene)


def demo_scene(kind: str = "tpms_channel") -> SolidScene:
    scene = SolidScene(cell_size=0.6)
    if kind == "sphere_hole":
        a = scene.add("sphere", dimensions=(10,))
        b = scene.add("cylinder", dimensions=(3, 26))
        scene.add("difference", inputs=(a.id, b.id))
    elif kind == "smooth":
        a = scene.add("sphere", dimensions=(8,), position=(-5, 0, 0))
        b = scene.add("sphere", dimensions=(8,), position=(5, 0, 0))
        scene.add("smooth_union", inputs=(a.id, b.id), blend=4)
    else:
        p = TPMSParameters(size_x=24, size_y=24, size_z=24, cells_x=2, cells_y=2, cells_z=2,
                           thickness=1.8, samples_per_cell=32)
        a = scene.add("tpms", tpms=p)
        b = scene.add("cylinder", dimensions=(10, 24))
        fill = scene.add("intersection", inputs=(a.id, b.id))
        channel = scene.add("cylinder", dimensions=(3, 30))
        scene.add("difference", inputs=(fill.id, channel.id))
    return scene
