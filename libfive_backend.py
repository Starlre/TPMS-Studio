"""Optional libfive C-API backend; negative field values represent material.

No third-party Python package or Python eval is used. Native trees and meshes
are owned explicitly and released even if evaluation / validation fails.
"""
from __future__ import annotations

import ast
import ctypes as ct
import math
import os
import sys
import tempfile
from dataclasses import replace
from pathlib import Path

import numpy as np
import trimesh

from tpms_core import (
    CUSTOM_SURFACE, MeshResult, TPMSParameters, _parse_formula,
    _material_scalar_field, _grid, _FORMULA_ALIASES, TPMS_FORMULAS,
    evaluate_implicit_formula, remove_tiny_components, export_mesh,
)


class LibfiveUnavailable(RuntimeError):
    pass


class _Interval(ct.Structure):
    _fields_ = [("lower", ct.c_float), ("upper", ct.c_float)]


class _Region(ct.Structure):
    _fields_ = [(axis, _Interval) for axis in ("x", "y", "z")]


class _Vec3(ct.Structure):
    _fields_ = [(axis, ct.c_float) for axis in ("x", "y", "z")]


class _Tri(ct.Structure):
    _fields_ = [(axis, ct.c_uint32) for axis in ("a", "b", "c")]


class _Mesh(ct.Structure):
    # Field order is ABI-sensitive: triangle count precedes vertex count.
    _fields_ = [("verts", ct.POINTER(_Vec3)), ("tris", ct.POINTER(_Tri)),
                ("tri_count", ct.c_uint32), ("vert_count", ct.c_uint32)]


def library_path() -> Path:
    override = os.environ.get("TPMS_LIBFIVE_LIBRARY")
    if override:
        return Path(override).expanduser().resolve()
    name = "libfive.dll" if sys.platform == "win32" else (
        "libfive.dylib" if sys.platform == "darwin" else "libfive.so")
    project_root = Path(__file__).resolve().parent
    installed = project_root / "native" / "libfive" / name
    # A portable installation can keep the DLL and its dependencies together
    # beside this module, without requiring an extra directory hierarchy.
    portable = project_root / name
    return installed if installed.is_file() or not portable.is_file() else portable


class NativeKernel:
    def __init__(self, path: Path | None = None):
        self.path = Path(path) if path is not None else library_path()
        self._dll_dir = None
        try:
            if not self.path.is_file():
                raise OSError(f"文件不存在：{self.path}")
            if sys.platform == "win32":
                self._dll_dir = os.add_dll_directory(str(self.path.parent))
            self.lib = ct.CDLL(str(self.path))
            signatures = {
                "libfive_opcode_enum": ([ct.c_char_p], ct.c_int),
                "libfive_tree_const": ([ct.c_float], ct.c_void_p),
                "libfive_tree_nullary": ([ct.c_int], ct.c_void_p),
                "libfive_tree_unary": ([ct.c_int, ct.c_void_p], ct.c_void_p),
                "libfive_tree_binary": ([ct.c_int, ct.c_void_p, ct.c_void_p], ct.c_void_p),
                "libfive_tree_remap": ([ct.c_void_p] * 4, ct.c_void_p),
                "libfive_tree_eval_f": ([ct.c_void_p, _Vec3], ct.c_float),
                "libfive_tree_render_mesh_st": (
                    [ct.c_void_p, _Region, ct.c_float], ct.POINTER(_Mesh)),
                "libfive_mesh_delete": ([ct.POINTER(_Mesh)], None),
                "libfive_tree_delete": ([ct.c_void_p], None),
                "libfive_git_revision": ([], ct.c_char_p),
            }
            for name, (arguments, result) in signatures.items():
                function = getattr(self.lib, name)
                function.argtypes, function.restype = arguments, result
        except (OSError, AttributeError) as exc:
            if self._dll_dir is not None:
                self._dll_dir.close()
            raise LibfiveUnavailable(
                f"libfive 内核不可用：{exc}\n"
                "请运行 scripts/build_libfive.ps1 安装匹配 Python 位数的内核，"
                "或用 TPMS_LIBFIVE_LIBRARY 指定 DLL 完整路径。") from exc
        self.opcodes: dict[str, int] = {}

    @property
    def revision(self) -> str:
        return self.lib.libfive_git_revision().decode("ascii", errors="replace")

    def opcode(self, name: str) -> int:
        if name not in self.opcodes:
            value = self.lib.libfive_opcode_enum(name.encode("ascii"))
            if value < 0:
                raise LibfiveUnavailable(f"libfive 缺少运算：{name}")
            self.opcodes[name] = value
        return self.opcodes[name]


def backend_status() -> tuple[bool, str]:
    try:
        kernel = NativeKernel()
        return True, f"libfive {kernel.revision}"
    except LibfiveUnavailable as exc:
        return False, str(exc)


class _TreeArena:
    def __init__(self, kernel: NativeKernel):
        self.kernel = kernel
        self.pointers: list[int] = []
        self.constants: dict[float, _Tree] = {}

    def __enter__(self):
        return self

    def __exit__(self, *_):
        for pointer in reversed(self.pointers):
            self.kernel.lib.libfive_tree_delete(pointer)
        self.pointers.clear()

    def own(self, pointer) -> _Tree:
        if not pointer:
            raise RuntimeError("libfive 无法创建表达式")
        self.pointers.append(pointer)
        return _Tree(self, pointer)

    def wrap(self, value) -> _Tree:
        if isinstance(value, _Tree):
            if value.arena is not self:
                raise ValueError("不能混用不同内核的表达式")
            return value
        value = float(value)
        if not math.isfinite(value) or abs(value) > np.finfo(np.float32).max:
            raise ValueError("libfive 常数必须是有限的单精度数")
        if value not in self.constants:
            self.constants[value] = self.own(self.kernel.lib.libfive_tree_const(value))
        return self.constants[value]

    def op(self, name: str, *args) -> _Tree:
        code = self.kernel.opcode(name)
        pointers = [self.wrap(arg).pointer for arg in args]
        return self.own(getattr(self.kernel.lib, (
            "libfive_tree_nullary", "libfive_tree_unary", "libfive_tree_binary"
        )[len(args)])(code, *pointers))


class _Tree:
    def __init__(self, arena: _TreeArena, pointer: int):
        self.arena, self.pointer = arena, pointer

    def __add__(self, other): return self.arena.op("add", self, other)
    def __radd__(self, other): return self + other
    def __sub__(self, other): return self.arena.op("sub", self, other)
    def __rsub__(self, other): return self.arena.op("sub", other, self)
    def __mul__(self, other): return self.arena.op("mul", self, other)
    def __rmul__(self, other): return self * other
    def __truediv__(self, other): return self.arena.op("div", self, other)
    def __pow__(self, other):
        # libfive's pow supports integer exponents. Fractional powers use
        # exp(log(x)*n), preserving the real-valued positive-domain meaning.
        exponent = float(other)
        if exponent == 0:
            return self.arena.wrap(1)
        if exponent == 2:
            return self.arena.op("square", self)
        if exponent.is_integer():
            return self.arena.op("pow", self, exponent)
        return self.arena.op("exp", self.arena.op("log", self) * exponent)
    def __neg__(self): return self.arena.op("neg", self)

    def remap(self, coords) -> _Tree:
        return self.arena.own(self.arena.kernel.lib.libfive_tree_remap(
            self.pointer, *(self.arena.wrap(c).pointer for c in coords)))


def _builtins(arena: _TreeArena, x: _Tree, y: _Tree, z: _Tree) -> dict[str, _Tree]:
    sx, sy, sz = [arena.op("sin", t) for t in (x, y, z)]
    cx, cy, cz = [arena.op("cos", t) for t in (x, y, z)]
    return {
        "gyroid": sx * cy + sy * cz + sz * cx,
        "diamond": sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz,
        "primitive": cx + cy + cz,
        "i_wp": 2 * (cx * cy + cy * cz + cz * cx) - (
            arena.op("cos", 2 * x) + arena.op("cos", 2 * y) + arena.op("cos", 2 * z)),
        "neovius": 3 * (cx + cy + cz) + 4 * cx * cy * cz,
    }


def _formula_tree(node: ast.AST, arena: _TreeArena, values) -> _Tree:
    if isinstance(node, ast.Constant):
        return arena.wrap(node.value)
    if isinstance(node, ast.Name):
        return arena.wrap(values[node.id])
    if isinstance(node, ast.UnaryOp):
        value = _formula_tree(node.operand, arena, values)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp):
        left = _formula_tree(node.left, arena, values)
        right = _formula_tree(node.right, arena, values)
        names = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul", ast.Div: "div"}
        if type(node.op) in names:
            return arena.op(names[type(node.op)], left, right)
        return left ** node.right.value
    if isinstance(node, ast.Call):
        arguments = [_formula_tree(arg, arena, values) for arg in node.args]
        if node.func.id in {"min", "max"}:
            result = arguments[0]
            for argument in arguments[1:]:
                result = arena.op(node.func.id, result, argument)
            return result
        return arena.op(node.func.id, arguments[0])
    raise ValueError("公式包含不支持的语法")


def _field_tree(arena: _TreeArena, p: TPMSParameters) -> _Tree:
    coords = [arena.op(f"var-{axis}") for axis in ("x", "y", "z")]
    sizes = (p.size_x, p.size_y, p.size_z)
    cells = (p.cells_x, p.cells_y, p.cells_z)
    phases = [2 * math.pi * count * (coord / size + 0.5)
              for coord, size, count in zip(coords, sizes, cells)]
    aliases = _builtins(arena, *phases)
    if p.surface == CUSTOM_SURFACE:
        field = _formula_tree(_parse_formula(p.formula), arena, {
            **dict(zip(("x", "y", "z"), coords)), "pi": math.pi, **aliases})
    else:
        field = aliases[p.surface.lower().replace("-", "_")]
    if p.mode == "solid":
        material = p.iso_level - field
    else:
        # Same central difference spacing as the NumPy field. Multiplying
        # through by the positive gradient norm avoids interval division by
        # zero while retaining the zero set and material sign.
        gradients = []
        for axis, (size, count) in enumerate(zip(sizes, cells)):
            step = size / (count * p.samples_per_cell)
            plus, minus = list(coords), list(coords)
            plus[axis], minus[axis] = coords[axis] + step, coords[axis] - step
            gradients.append((field.remap(plus) - field.remap(minus)) / (2 * step))
        norm = arena.op("max", arena.op("sqrt", sum(g ** 2 for g in gradients)), 1e-6)
        thickness = p.thickness
        if p.gradient_enabled:
            index = "XYZ".index(p.gradient_axis)
            u = arena.op("min", 1, arena.op("max", 0, coords[index] / sizes[index] + 0.5))
            thickness = p.gradient_thickness_start + (
                p.gradient_thickness_end - p.gradient_thickness_start) * u
        material = arena.op("abs", field) - 0.5 * thickness * norm
    box = arena.op("abs", coords[0]) - sizes[0] / 2
    for coord, size in zip(coords[1:], sizes[1:]):
        box = arena.op("max", box, arena.op("abs", coord) - size / 2)
    return arena.op("max", material, box)


def validate_libfive_parameters(p: TPMSParameters, cell_size: float) -> None:
    p.validate()
    if p.tubular_enabled:
        raise ValueError("libfive 首阶段尚不支持管状卷绕；请选择现有网格导出内核。")
    if not math.isfinite(cell_size) or cell_size < 0.001:
        raise ValueError("libfive 网格尺寸必须是至少 0.001 mm 的有限数")
    sizes = (p.size_x, p.size_y, p.size_z)
    if not all(math.isfinite(size) for size in sizes):
        raise ValueError("模型尺寸必须是有限数")
    numeric = (p.thickness, p.iso_level, p.gradient_thickness_start, p.gradient_thickness_end)
    if not all(math.isfinite(value) for value in numeric):
        raise ValueError("壁厚和等值面必须是有限数")
    limit = min(size / cells for size, cells in zip(sizes, (p.cells_x, p.cells_y, p.cells_z))) / 8
    if p.mode == "sheet":
        thickness = min(p.gradient_thickness_start, p.gradient_thickness_end) if p.gradient_enabled else p.thickness
        limit = min(limit, thickness / 2)
    if cell_size > limit * (1 + 1e-6):
        raise ValueError(f"网格过粗，可能丢失薄壁/周期细节；请设置不超过 {limit:.4g} mm。")
    # Bound worst-case leaf count before entering the native renderer.
    margin = max(cell_size, max(sizes) * 1e-5)
    levels = max(0, math.ceil(math.log2((min(sizes) + 2 * margin) / cell_size)))
    if 8 ** levels > 16_777_216:
        raise ValueError("libfive 精度过高：潜在八叉树叶节点超过 1677 万，请增大网格尺寸或缩小模型。")


def suggested_cell_size(p: TPMSParameters) -> float:
    spacing = min(size / (count * p.samples_per_cell) for size, count in zip(
        (p.size_x, p.size_y, p.size_z), (p.cells_x, p.cells_y, p.cells_z)))
    if p.mode == "sheet":
        thickness = min(p.gradient_thickness_start, p.gradient_thickness_end) if p.gradient_enabled else p.thickness
        spacing = min(spacing, thickness / 3)
    return max(0.001, spacing)


def generate_libfive_mesh(parameters: TPMSParameters, cell_size: float,
                          *, kernel: NativeKernel | None = None) -> MeshResult:
    """Mesh the mathematical field with libfive adaptive Dual Contouring.

    cell_size is the minimum subdivision scale in mm, not a triangle target
    or a guaranteed surface error. Porosity retains the existing grid solver.
    """
    parameters.validate()
    p = parameters
    if p.tubular_enabled:
        raise ValueError("libfive 首阶段尚不支持管状卷绕；请选择现有网格导出内核。")
    if p.target_porosity is not None:
        p = _material_scalar_field(p)[0]
    validate_libfive_parameters(p, cell_size)
    if p.surface == CUSTOM_SURFACE:
        # Check real-valued domains before invoking native code; broadcast
        # scalar / one-coordinate formulas without taking NumPy gradients.
        vectors = _grid(p)
        coords = np.meshgrid(*vectors, indexing="ij", sparse=True)
        phases = [2 * math.pi * count * (coord / size + 0.5) for coord, size, count in zip(
            coords, (p.size_x, p.size_y, p.size_z), (p.cells_x, p.cells_y, p.cells_z))]
        aliases = {name: TPMS_FORMULAS[surface](*phases) for name, surface in _FORMULA_ALIASES.items()}
        with np.errstate(all="ignore"):
            evaluate_implicit_formula(p.formula, *coords, aliases)
    kernel = kernel or NativeKernel()
    with _TreeArena(kernel) as arena:
        tree = _field_tree(arena, p)
        # Region must extend beyond the clipping box for closed boundary caps.
        margin = max(cell_size, max(p.size_x, p.size_y, p.size_z) * 1e-5)
        region = _Region(*(_Interval(-size / 2 - margin, size / 2 + margin)
                           for size in (p.size_x, p.size_y, p.size_z)))
        # Upstream implementation sets min_feature=1/res (not res).
        return MeshResult(render_tree_mesh(kernel, tree, region, cell_size), p)


def render_tree_mesh(kernel: NativeKernel, tree: _Tree, region: _Region,
                     cell_size: float) -> trimesh.Trimesh:
    """Extract a closed native expression; the caller owns the tree arena."""
    pointer = kernel.lib.libfive_tree_render_mesh_st(tree.pointer, region, 1 / cell_size)
    if not pointer:
        raise ValueError("libfive 未生成曲面；请检查公式、等值面与精度。")
    try:
        native = pointer.contents
        if not native.tri_count or not native.vert_count:
            raise ValueError("libfive 生成了空网格；请检查参数与精度。")
        vertices = np.ctypeslib.as_array(native.verts, shape=(native.vert_count,))
        faces = np.ctypeslib.as_array(native.tris, shape=(native.tri_count,))
        vertices = np.column_stack([vertices[axis] for axis in ("x", "y", "z")]).astype(np.float64)
        faces = np.column_stack([faces[axis] for axis in ("a", "b", "c")]).astype(np.int64)
    finally:
        kernel.lib.libfive_mesh_delete(pointer)
    if not np.all(np.isfinite(vertices)) or faces.max() >= len(vertices):
        raise ValueError("libfive 返回了无效网格，未导出文件。")
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.remove_unreferenced_vertices()
    mesh.fix_normals()
    mesh, _components, _removed = remove_tiny_components(mesh)
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
        raise ValueError("libfive 网格未通过封闭性检查；请减小网格尺寸，或使用现有网格内核导出。")
    return mesh


def export_libfive_mesh(result: MeshResult, destination: str | Path, cell_size: float) -> tuple[Path, int]:
    path = Path(destination)
    if path.suffix.lower() not in {".stl", ".obj", ".ply"}:
        raise ValueError("仅支持 STL、OBJ 或 PLY 格式")
    # current_result already contains solved thickness / iso-level. Do not
    # solve porosity again with a different sampling or meshing backend.
    generated = generate_libfive_mesh(replace(result.parameters, target_porosity=None), cell_size)
    # Replace only after a complete export. Native / disk failures preserve
    # any previously existing destination file.
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary = tempfile.mkstemp(prefix=".tpms-libfive-", suffix=path.suffix, dir=path.parent)
    os.close(descriptor)
    staged = Path(temporary)
    try:
        export_mesh(generated, staged)
        staged.replace(path)
    finally:
        staged.unlink(missing_ok=True)
    return path, generated.triangles
