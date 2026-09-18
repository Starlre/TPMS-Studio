from __future__ import annotations

import ast
from dataclasses import dataclass, replace
from functools import lru_cache
from pathlib import Path
from typing import Callable

import numpy as np
import trimesh
from skimage.measure import marching_cubes


TPMS_FORMULAS: dict[str, Callable[[np.ndarray, np.ndarray, np.ndarray], np.ndarray]] = {
    "Gyroid": lambda x, y, z: (
        np.sin(x) * np.cos(y)
        + np.sin(y) * np.cos(z)
        + np.sin(z) * np.cos(x)
    ),
    "Diamond": lambda x, y, z: (
        np.sin(x) * np.sin(y) * np.sin(z)
        + np.sin(x) * np.cos(y) * np.cos(z)
        + np.cos(x) * np.sin(y) * np.cos(z)
        + np.cos(x) * np.cos(y) * np.sin(z)
    ),
    "Primitive": lambda x, y, z: np.cos(x) + np.cos(y) + np.cos(z),
    "I-WP": lambda x, y, z: (
        2.0 * (np.cos(x) * np.cos(y) + np.cos(y) * np.cos(z) + np.cos(z) * np.cos(x))
        - (np.cos(2.0 * x) + np.cos(2.0 * y) + np.cos(2.0 * z))
    ),
    "Neovius": lambda x, y, z: (
        3.0 * (np.cos(x) + np.cos(y) + np.cos(z))
        + 4.0 * np.cos(x) * np.cos(y) * np.cos(z)
    ),
}

CUSTOM_SURFACE = "Custom"
_FORMULA_ALIASES = {
    "gyroid": "Gyroid",
    "diamond": "Diamond",
    "primitive": "Primitive",
    "i_wp": "I-WP",
    "neovius": "Neovius",
}
_FORMULA_FUNCTIONS = {
    "sin": np.sin,
    "cos": np.cos,
    "tan": np.tan,
    "sqrt": np.sqrt,
    "abs": np.abs,
    "exp": np.exp,
    "log": np.log,
}
_FORMULA_NAMES = {"x", "y", "z", "pi", *_FORMULA_ALIASES}
_FORMULA_BINARY_OPERATORS = (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow, ast.BitXor)


def _validate_formula_node(node: ast.AST) -> None:
    if isinstance(node, ast.Expression):
        _validate_formula_node(node.body)
    elif isinstance(node, ast.Constant):
        if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
            raise ValueError("公式只允许数字常量")
        if not np.isfinite(float(node.value)):
            raise ValueError("公式包含非有限数字")
    elif isinstance(node, ast.Name):
        if node.id not in _FORMULA_NAMES:
            raise ValueError(f"公式包含不支持的名称: {node.id}")
    elif isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
        _validate_formula_node(node.operand)
    elif isinstance(node, ast.BinOp) and isinstance(node.op, _FORMULA_BINARY_OPERATORS):
        _validate_formula_node(node.left)
        _validate_formula_node(node.right)
        if isinstance(node.op, (ast.Pow, ast.BitXor)):
            if not isinstance(node.right, ast.Constant):
                raise ValueError("幂运算指数必须是数字常量")
            if abs(float(node.right.value)) > 16:
                raise ValueError("幂运算指数绝对值不能超过 16")
    elif isinstance(node, ast.Call) and isinstance(node.func, ast.Name):
        function_name = node.func.id
        if function_name not in {*_FORMULA_FUNCTIONS, "min", "max"}:
            raise ValueError(f"公式包含不支持的函数: {function_name}")
        if node.keywords or any(isinstance(argument, ast.Starred) for argument in node.args):
            raise ValueError("公式函数不支持关键字参数或展开参数")
        if function_name in {"min", "max"}:
            if len(node.args) < 2:
                raise ValueError(f"{function_name} 至少需要两个参数")
        elif len(node.args) != 1:
            raise ValueError(f"{function_name} 只接受一个参数")
        for argument in node.args:
            _validate_formula_node(argument)
    else:
        raise ValueError("公式包含不支持的语法")


@lru_cache(maxsize=128)
def _parse_formula(expression: str) -> ast.AST:
    expression = expression.strip()
    if not expression:
        raise ValueError("自定义公式不能为空")
    if len(expression) > 500:
        raise ValueError("自定义公式不能超过 500 个字符")
    try:
        tree = ast.parse(expression, mode="eval")
    except SyntaxError as exc:
        raise ValueError(f"公式语法错误: {exc.msg}") from exc
    _validate_formula_node(tree)
    return tree.body


def _evaluate_formula_node(node: ast.AST, values: dict[str, np.ndarray | float]) -> np.ndarray | float:
    if isinstance(node, ast.Constant):
        return float(node.value)
    if isinstance(node, ast.Name):
        return values[node.id]
    if isinstance(node, ast.UnaryOp):
        value = _evaluate_formula_node(node.operand, values)
        return value if isinstance(node.op, ast.UAdd) else -value
    if isinstance(node, ast.BinOp):
        left = _evaluate_formula_node(node.left, values)
        right = _evaluate_formula_node(node.right, values)
        if isinstance(node.op, ast.Add):
            return left + right
        if isinstance(node.op, ast.Sub):
            return left - right
        if isinstance(node.op, ast.Mult):
            return left * right
        if isinstance(node.op, ast.Div):
            return left / right
        return left**right
    if isinstance(node, ast.Call):
        arguments = [_evaluate_formula_node(argument, values) for argument in node.args]
        if node.func.id == "min":
            result = arguments[0]
            for argument in arguments[1:]:
                result = np.minimum(result, argument)
            return result
        if node.func.id == "max":
            result = arguments[0]
            for argument in arguments[1:]:
                result = np.maximum(result, argument)
            return result
        return _FORMULA_FUNCTIONS[node.func.id](arguments[0])
    raise ValueError("公式包含不支持的语法")


def evaluate_implicit_formula(
    expression: str,
    x: np.ndarray,
    y: np.ndarray,
    z: np.ndarray,
    aliases: dict[str, np.ndarray],
) -> np.ndarray:
    """Safely evaluate a vectorized implicit formula on physical coordinates."""
    node = _parse_formula(expression)
    values: dict[str, np.ndarray | float] = {
        "x": x,
        "y": y,
        "z": z,
        "pi": float(np.pi),
        **aliases,
    }
    try:
        value = _evaluate_formula_node(node, values)
        result = np.asarray(value, dtype=np.float32)
    except (FloatingPointError, TypeError, ValueError, ZeroDivisionError) as exc:
        raise ValueError(f"公式计算失败: {exc}") from exc
    if not np.all(np.isfinite(result)):
        raise ValueError("公式计算结果包含非有限值，请检查除零或 log/sqrt 的定义域")
    return result


@dataclass(frozen=True)
class TPMSParameters:
    surface: str = "Gyroid"
    mode: str = "sheet"
    size_x: float = 40.0
    size_y: float = 40.0
    size_z: float = 40.0
    cells_x: int = 2
    cells_y: int = 2
    cells_z: int = 2
    thickness: float = 1.2
    iso_level: float = 0.0
    samples_per_cell: int = 64
    target_porosity: float | None = None
    formula: str = ""
    gradient_enabled: bool = False
    gradient_axis: str = "Z"
    gradient_thickness_start: float = 1.0
    gradient_thickness_end: float = 5.0

    def validate(self) -> None:
        if self.surface != CUSTOM_SURFACE and self.surface not in TPMS_FORMULAS:
            raise ValueError(f"未知 TPMS 类型: {self.surface}")
        if self.surface == CUSTOM_SURFACE:
            _parse_formula(self.formula)
        if self.mode not in {"sheet", "solid"}:
            raise ValueError("生成模式必须是 sheet 或 solid")
        if min(self.size_x, self.size_y, self.size_z) <= 0:
            raise ValueError("外形尺寸必须大于 0")
        if min(self.cells_x, self.cells_y, self.cells_z) < 1:
            raise ValueError("周期数必须至少为 1")
        if self.thickness <= 0:
            raise ValueError("壁厚必须大于 0")
        if self.samples_per_cell < 8:
            raise ValueError("每周期采样数不能小于 8")
        if self.target_porosity is not None and not 0.01 <= self.target_porosity <= 0.99:
            raise ValueError("目标孔隙率必须在 1% 到 99% 之间")
        if self.gradient_enabled:
            if self.gradient_axis not in {"X", "Y", "Z"}:
                raise ValueError("梯度方向必须是 X、Y 或 Z")
            if min(self.gradient_thickness_start, self.gradient_thickness_end) <= 0:
                raise ValueError("梯度壁厚起止值必须大于 0")
            if max(self.gradient_thickness_start, self.gradient_thickness_end) > 20:
                raise ValueError("梯度壁厚不能超过 20 mm")
            if self.mode != "sheet":
                raise ValueError("梯度壁厚仅支持片层结构")
            if self.target_porosity is not None:
                raise ValueError("梯度壁厚与目标孔隙率不能同时启用")


@dataclass(frozen=True)
class MeshResult:
    mesh: trimesh.Trimesh
    parameters: TPMSParameters
    removed_components: int = 0
    removed_faces: int = 0

    @property
    def triangles(self) -> int:
        return int(len(self.mesh.faces))

    @property
    def volume(self) -> float:
        return float(abs(self.mesh.volume))

    @property
    def area(self) -> float:
        return float(self.mesh.area)

    @property
    def relative_density(self) -> float:
        p = self.parameters
        box_volume = p.size_x * p.size_y * p.size_z
        return self.volume / box_volume if box_volume else 0.0

    @property
    def porosity(self) -> float:
        return 1.0 - self.relative_density


@dataclass(frozen=True)
class PreviewMesh:
    vertices: np.ndarray
    faces: np.ndarray
    colors: np.ndarray | None = None

    @property
    def triangles(self) -> int:
        return int(len(self.faces))


@dataclass(frozen=True)
class FluidDomainResult:
    mesh: trimesh.Trimesh
    parameters: TPMSParameters
    removed_components: int = 0
    removed_faces: int = 0

    @property
    def volume(self) -> float:
        return float(abs(self.mesh.volume))

    @property
    def fluid_fraction(self) -> float:
        p = self.parameters
        box_volume = p.size_x * p.size_y * p.size_z
        return self.volume / box_volume if box_volume else 0.0


def simplify_mesh_for_preview(mesh: trimesh.Trimesh, target_faces: int) -> PreviewMesh:
    """Create a lightweight display mesh without changing the export mesh."""
    vertices = np.asarray(mesh.vertices, dtype=np.float32)
    faces = np.asarray(mesh.faces, dtype=np.int64)
    if target_faces < 100:
        raise ValueError("预览目标面数不能小于 100")
    if len(faces) <= target_faces:
        return PreviewMesh(vertices=vertices.copy(), faces=faces.copy())

    minimum = vertices.min(axis=0)
    extent = vertices.max(axis=0) - minimum
    longest = max(float(extent.max()), 1e-6)

    def cluster(bins: int) -> PreviewMesh:
        cell_size = longest / bins
        keys = np.floor((vertices - minimum) / cell_size).astype(np.int32)
        _unique, inverse = np.unique(keys, axis=0, return_inverse=True)
        counts = np.bincount(inverse).astype(np.float32)
        clustered_vertices = np.column_stack(
            [np.bincount(inverse, weights=vertices[:, axis]) / counts for axis in range(3)]
        ).astype(np.float32)
        clustered_faces = inverse[faces]
        valid = (
            (clustered_faces[:, 0] != clustered_faces[:, 1])
            & (clustered_faces[:, 1] != clustered_faces[:, 2])
            & (clustered_faces[:, 0] != clustered_faces[:, 2])
        )
        clustered_faces = clustered_faces[valid]
        if len(clustered_faces):
            canonical = np.sort(clustered_faces, axis=1)
            _deduplicated, first = np.unique(canonical, axis=0, return_index=True)
            clustered_faces = clustered_faces[np.sort(first)]
        return PreviewMesh(vertices=clustered_vertices, faces=clustered_faces.astype(np.int64))

    low, high = 2, max(8, int(round(len(vertices) ** (1.0 / 3.0) * 4.0)))
    best: PreviewMesh | None = None
    while low <= high:
        bins = (low + high) // 2
        candidate = cluster(bins)
        if candidate.triangles <= target_faces:
            best = candidate
            low = bins + 1
        else:
            high = bins - 1
    return best if best is not None else cluster(2)


def remove_tiny_components(
    mesh: trimesh.Trimesh,
    relative_face_limit: float = 1e-4,
    relative_volume_limit: float = 1e-4,
) -> tuple[trimesh.Trimesh, int, int]:
    """Remove disconnected debris only when both relative limits are met."""
    components = list(mesh.split(only_watertight=False))
    if len(components) <= 1:
        return mesh, 0, 0

    def component_volume(component: trimesh.Trimesh) -> float:
        with np.errstate(divide="ignore", invalid="ignore"):
            volume = abs(float(component.volume))
        return volume if np.isfinite(volume) else 0.0

    total_faces = len(mesh.faces)
    component_volumes = [component_volume(component) for component in components]
    total_volume = sum(component_volumes)
    face_limit = total_faces * relative_face_limit
    volume_limit = total_volume * relative_volume_limit
    largest_index = int(np.argmax([len(component.faces) for component in components]))

    kept: list[trimesh.Trimesh] = []
    removed_faces = 0
    for index, (component, volume) in enumerate(zip(components, component_volumes)):
        is_tiny = (
            index != largest_index
            and len(component.faces) < face_limit
            and volume < volume_limit
        )
        if is_tiny:
            removed_faces += len(component.faces)
        else:
            kept.append(component)

    removed_components = len(components) - len(kept)
    if removed_components == 0:
        return mesh, 0, 0
    cleaned = kept[0].copy() if len(kept) == 1 else trimesh.util.concatenate(kept)
    cleaned.fix_normals()
    return cleaned, removed_components, removed_faces


def _grid(parameters: TPMSParameters) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    p = parameters
    counts = (
        p.cells_x * p.samples_per_cell,
        p.cells_y * p.samples_per_cell,
        p.cells_z * p.samples_per_cell,
    )
    sampled_shape = tuple(count + 2 for count in counts)
    points = sampled_shape[0] * sampled_shape[1] * sampled_shape[2]
    if points > 6_000_000:
        raise ValueError(
            f"当前设置需要 {points / 1_000_000:.1f} 百万个采样点，请降低周期数或网格精度"
        )
    def extended_cell_centers(size: float, count: int) -> np.ndarray:
        step = size / count
        return np.linspace(
            -size / 2.0 - step / 2.0,
            size / 2.0 + step / 2.0,
            count + 2,
            dtype=np.float32,
        )

    x = extended_cell_centers(p.size_x, counts[0])
    y = extended_cell_centers(p.size_y, counts[1])
    z = extended_cell_centers(p.size_z, counts[2])
    return x, y, z


def _material_scalar_field(
    parameters: TPMSParameters,
) -> tuple[
    TPMSParameters,
    np.ndarray,
    np.ndarray,
    np.ndarray,
    tuple[float, float, float],
    np.ndarray,
    np.ndarray,
    np.ndarray,
    np.ndarray,
]:
    parameters.validate()
    p = parameters
    x, y, z = _grid(p)
    xx, yy, zz = np.meshgrid(x, y, z, indexing="ij", sparse=True)

    phase_x = 2.0 * np.pi * p.cells_x * (xx / p.size_x + 0.5)
    phase_y = 2.0 * np.pi * p.cells_y * (yy / p.size_y + 0.5)
    phase_z = 2.0 * np.pi * p.cells_z * (zz / p.size_z + 0.5)
    if p.surface == CUSTOM_SURFACE:
        aliases = {
            alias: TPMS_FORMULAS[surface](phase_x, phase_y, phase_z)
            for alias, surface in _FORMULA_ALIASES.items()
        }
        field = evaluate_implicit_formula(p.formula, xx, yy, zz, aliases)
    else:
        field = TPMS_FORMULAS[p.surface](phase_x, phase_y, phase_z).astype(np.float32)
    spacing = tuple(float(v) for v in (x[1] - x[0], y[1] - y[0], z[1] - z[0]))
    gradients = np.gradient(field, *spacing, edge_order=1)
    grad_norm = np.sqrt(sum(component * component for component in gradients))
    distance_scale = np.maximum(grad_norm, 1e-6)

    if p.target_porosity is not None:
        interior = np.s_[1:-1, 1:-1, 1:-1]
        if p.mode == "sheet":
            surface_distance = np.abs(field) / distance_scale
            half_thickness = float(
                np.quantile(surface_distance[interior], 1.0 - p.target_porosity)
            )
            p = replace(p, thickness=max(2.0 * half_thickness, 1e-6))
        else:
            solved_iso_level = float(np.quantile(field[interior], p.target_porosity))
            p = replace(p, iso_level=solved_iso_level)

    if p.mode == "sheet":
        if p.gradient_enabled:
            if p.gradient_axis == "X":
                coord = xx
                size = p.size_x
            elif p.gradient_axis == "Y":
                coord = yy
                size = p.size_y
            else:
                coord = zz
                size = p.size_z
            u = (coord + size / 2.0) / size
            u = np.clip(u, 0.0, 1.0)
            thickness_field = p.gradient_thickness_start + (p.gradient_thickness_end - p.gradient_thickness_start) * u
            scalar = np.abs(field) / distance_scale - thickness_field / 2.0
        else:
            scalar = np.abs(field) / distance_scale - p.thickness / 2.0
    else:
        scalar = (p.iso_level - field) / distance_scale
    return p, x, y, z, spacing, scalar.astype(np.float32), xx, yy, zz


def _box_distance(
    p: TPMSParameters,
    scalar_shape: tuple[int, ...],
    xx: np.ndarray,
    yy: np.ndarray,
    zz: np.ndarray,
) -> np.ndarray:
    return np.maximum.reduce(
        (
            np.broadcast_to(np.abs(xx) - p.size_x / 2.0, scalar_shape),
            np.broadcast_to(np.abs(yy) - p.size_y / 2.0, scalar_shape),
            np.broadcast_to(np.abs(zz) - p.size_z / 2.0, scalar_shape),
        )
    )


def _mesh_scalar_field(
    scalar: np.ndarray,
    x: np.ndarray,
    y: np.ndarray,
    z: np.ndarray,
    spacing: tuple[float, float, float],
) -> trimesh.Trimesh:
    vertices, faces, _normals, _values = marching_cubes(
        scalar,
        level=0.0,
        spacing=spacing,
        allow_degenerate=False,
    )
    vertices += np.array([x[0], y[0], z[0]], dtype=np.float32)
    mesh = trimesh.Trimesh(vertices=vertices, faces=faces, process=False)
    mesh.fix_normals()
    return mesh


def generate_tpms(parameters: TPMSParameters) -> MeshResult:
    """Generate a closed TPMS mesh clipped to the requested bounding box."""
    p, x, y, z, spacing, material_scalar, xx, yy, zz = _material_scalar_field(parameters)
    clipped_scalar = np.maximum(
        material_scalar,
        _box_distance(p, material_scalar.shape, xx, yy, zz),
    ).astype(np.float32)
    mesh = _mesh_scalar_field(clipped_scalar, x, y, z, spacing)
    mesh, removed_components, removed_faces = remove_tiny_components(mesh)
    return MeshResult(
        mesh=mesh,
        parameters=p,
        removed_components=removed_components,
        removed_faces=removed_faces,
    )


def generate_fluid_domain(parameters: TPMSParameters) -> FluidDomainResult:
    """Generate the closed void volume used by an internal-flow simulation."""
    p, x, y, z, spacing, material_scalar, xx, yy, zz = _material_scalar_field(parameters)
    fluid_scalar = np.maximum(
        -material_scalar,
        _box_distance(p, material_scalar.shape, xx, yy, zz),
    ).astype(np.float32)
    mesh = _mesh_scalar_field(fluid_scalar, x, y, z, spacing)
    mesh, removed_components, removed_faces = remove_tiny_components(mesh)
    return FluidDomainResult(
        mesh=mesh,
        parameters=p,
        removed_components=removed_components,
        removed_faces=removed_faces,
    )


def export_mesh(result: MeshResult, destination: str | Path) -> Path:
    path = Path(destination)
    suffix = path.suffix.lower()
    if suffix not in {".stl", ".obj", ".ply"}:
        raise ValueError("仅支持 STL、OBJ 或 PLY 格式")
    path.parent.mkdir(parents=True, exist_ok=True)
    result.mesh.export(path)
    return path
