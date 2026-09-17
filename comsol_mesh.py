from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
import json
import math
from pathlib import Path

import meshio
import numpy as np
import trimesh

from tpms_core import PreviewMesh, TPMSParameters, generate_fluid_domain


PHYSICAL_IDS = {"inlet": 101, "outlet": 102, "walls": 103, "fluid": 201}
REGION_COLORS = {
    PHYSICAL_IDS["inlet"]: np.array([0.16, 0.47, 0.95], dtype=np.float32),
    PHYSICAL_IDS["outlet"]: np.array([0.94, 0.38, 0.12], dtype=np.float32),
    PHYSICAL_IDS["walls"]: np.array([0.12, 0.68, 0.40], dtype=np.float32),
}


@dataclass(frozen=True)
class CFDMeshOptions:
    flow_axis: str = "X"
    element_size: float = 1.5
    surface_samples_per_cell: int = 32
    boundary_layer_enabled: bool = False
    boundary_layer_layers: int = 3
    boundary_layer_first_height: float = 0.05
    boundary_layer_growth: float = 1.2
    end_refinement_enabled: bool = True
    end_refinement_distance: float = 2.0
    end_refinement_size_factor: float = 0.5
    curvature_refinement_enabled: bool = True
    curvature_points: int = 18
    low_quality_threshold: float = 0.2

    @property
    def boundary_layer_total_thickness(self) -> float:
        if self.boundary_layer_growth == 1.0:
            return self.boundary_layer_first_height * self.boundary_layer_layers
        return self.boundary_layer_first_height * (
            self.boundary_layer_growth**self.boundary_layer_layers - 1.0
        ) / (self.boundary_layer_growth - 1.0)

    def boundary_layer_heights(self) -> list[float]:
        cumulative = 0.0
        heights: list[float] = []
        height = self.boundary_layer_first_height
        for _index in range(self.boundary_layer_layers):
            cumulative += height
            heights.append(-cumulative)
            height *= self.boundary_layer_growth
        return heights

    def validate(self, sizes: tuple[float, float, float] | None = None) -> None:
        if self.flow_axis not in {"X", "Y", "Z"}:
            raise ValueError("流向必须是 X、Y 或 Z")
        if self.element_size <= 0:
            raise ValueError("体网格单元尺寸必须大于 0")
        if not 16 <= self.surface_samples_per_cell <= 96:
            raise ValueError("流体表面精度必须在 16 到 96 之间")
        if not 1 <= self.boundary_layer_layers <= 12:
            raise ValueError("边界层数必须在 1 到 12 之间")
        if self.boundary_layer_first_height <= 0:
            raise ValueError("边界层首层高度必须大于 0")
        if not 1.0 <= self.boundary_layer_growth <= 2.0:
            raise ValueError("边界层增长率必须在 1.0 到 2.0 之间")
        if self.end_refinement_distance <= 0:
            raise ValueError("入出口加密距离必须大于 0")
        if not 0.1 <= self.end_refinement_size_factor <= 1.0:
            raise ValueError("入出口加密系数必须在 0.1 到 1.0 之间")
        if not 6 <= self.curvature_points <= 60:
            raise ValueError("曲率采样点数必须在 6 到 60 之间")
        if not 0.01 <= self.low_quality_threshold <= 0.9:
            raise ValueError("低质量阈值必须在 0.01 到 0.9 之间")
        if sizes is not None and self.boundary_layer_enabled:
            if self.boundary_layer_total_thickness >= min(sizes) * 0.25:
                raise ValueError("边界层总厚度过大，必须小于最小外形尺寸的 25%")


@dataclass(frozen=True)
class MeshQualityStats:
    metric: str
    minimum: float
    percentile_05: float
    median: float
    mean: float
    maximum: float
    minimum_volume: float
    maximum_edge_ratio: float
    low_quality_threshold: float
    low_quality_elements: int
    histogram_edges: list[float]
    histogram_counts: list[int]


@dataclass(frozen=True)
class CFDMeshResult:
    msh_path: Path
    bdf_path: Path
    metadata_path: Path
    quality_path: Path
    nodes: int
    tetrahedra: int
    prisms: int
    volume_elements: int
    surface_triangles: int
    min_scaled_jacobian: float
    fluid_fraction: float
    fluid_domains: int
    boundary_triangles: dict[str, int]
    quality: MeshQualityStats
    low_quality_vertices: np.ndarray
    low_quality_faces: np.ndarray
    region_preview: PreviewMesh


@dataclass(frozen=True)
class _ComponentMesh:
    points: np.ndarray
    triangles: np.ndarray
    cells: dict[str, np.ndarray]
    qualities: dict[str, np.ndarray]
    volumes: dict[str, np.ndarray]


def _emit(progress: Callable[[str], None] | None, message: str) -> None:
    if progress is not None:
        progress(message)


def _indexed_connectivity(
    node_tags: np.ndarray,
    element_nodes: np.ndarray,
) -> np.ndarray:
    """Map arbitrary Gmsh node tags to zero-based point-array indices."""
    lookup = np.full(int(np.max(node_tags)) + 1, -1, dtype=np.int64)
    lookup[node_tags.astype(np.int64)] = np.arange(len(node_tags), dtype=np.int64)
    connectivity = lookup[element_nodes.astype(np.int64)]
    if np.any(connectivity < 0):
        raise RuntimeError("Gmsh 返回了无法匹配的单元节点")
    return connectivity


def _extract_triangles(gmsh, node_tags: np.ndarray, entity_tag: int = -1) -> np.ndarray:
    blocks: list[np.ndarray] = []
    element_types, _element_tags, element_nodes = gmsh.model.mesh.getElements(2, entity_tag)
    for element_type, nodes in zip(element_types, element_nodes):
        _name, dimension, order, node_count, _local, _primary = (
            gmsh.model.mesh.getElementProperties(element_type)
        )
        if dimension == 2 and order == 1 and node_count == 3:
            blocks.append(_indexed_connectivity(node_tags, np.asarray(nodes)).reshape(-1, 3))
    if not blocks:
        raise RuntimeError("Gmsh 没有生成一阶三角形边界单元")
    return np.vstack(blocks)


def _extract_volume_cells(
    gmsh,
    node_tags: np.ndarray,
) -> tuple[dict[str, np.ndarray], dict[str, np.ndarray], dict[str, np.ndarray]]:
    cell_blocks: dict[str, list[np.ndarray]] = {"tetra": [], "wedge": []}
    quality_blocks: dict[str, list[np.ndarray]] = {"tetra": [], "wedge": []}
    volume_blocks: dict[str, list[np.ndarray]] = {"tetra": [], "wedge": []}
    element_types, element_tags, element_nodes = gmsh.model.mesh.getElements(3)
    for element_type, tags, nodes in zip(element_types, element_tags, element_nodes):
        _name, dimension, order, node_count, _local, _primary = (
            gmsh.model.mesh.getElementProperties(element_type)
        )
        if dimension != 3 or order != 1 or node_count not in {4, 6}:
            continue
        cell_type = "tetra" if node_count == 4 else "wedge"
        cell_blocks[cell_type].append(
            _indexed_connectivity(node_tags, np.asarray(nodes)).reshape(-1, node_count)
        )
        quality_blocks[cell_type].append(
            np.asarray(
                gmsh.model.mesh.getElementQualities(
                    tags,
                    "minSICN" if cell_type == "tetra" else "minSJ",
                ),
                dtype=np.float64,
            )
        )
        volume_blocks[cell_type].append(
            np.abs(
                np.asarray(
                    gmsh.model.mesh.getElementQualities(tags, "volume"),
                    dtype=np.float64,
                )
            )
        )
    cells = {
        name: np.vstack(blocks)
        for name, blocks in cell_blocks.items()
        if blocks
    }
    qualities = {
        name: np.concatenate(blocks)
        for name, blocks in quality_blocks.items()
        if blocks
    }
    volumes = {
        name: np.concatenate(blocks)
        for name, blocks in volume_blocks.items()
        if blocks
    }
    if not cells:
        raise RuntimeError("Gmsh 没有生成可用的四面体或棱柱单元")
    return cells, qualities, volumes


def _configure_mesh_sizes(
    gmsh,
    options: CFDMeshOptions,
    sizes: tuple[float, float, float],
) -> None:
    gmsh.option.setNumber("Mesh.MeshSizeMin", options.element_size * 0.15)
    gmsh.option.setNumber("Mesh.MeshSizeMax", options.element_size)
    gmsh.option.setNumber("Mesh.ElementOrder", 1)
    gmsh.option.setNumber(
        "Mesh.MeshSizeFromCurvature",
        options.curvature_points if options.curvature_refinement_enabled else 0,
    )
    if not options.end_refinement_enabled:
        return

    axis = {"X": 0, "Y": 1, "Z": 2}[options.flow_axis]
    half_sizes = np.asarray(sizes, dtype=np.float64) / 2.0
    epsilon = max(sizes) * 1e-5
    fields: list[int] = []
    for positive in (False, True):
        bounds_min = -half_sizes - epsilon
        bounds_max = half_sizes + epsilon
        if positive:
            bounds_min[axis] = half_sizes[axis] - options.end_refinement_distance
        else:
            bounds_max[axis] = -half_sizes[axis] + options.end_refinement_distance
        field = gmsh.model.mesh.field.add("Box")
        gmsh.model.mesh.field.setNumber(
            field,
            "VIn",
            options.element_size * options.end_refinement_size_factor,
        )
        gmsh.model.mesh.field.setNumber(field, "VOut", options.element_size)
        gmsh.model.mesh.field.setNumber(field, "XMin", float(bounds_min[0]))
        gmsh.model.mesh.field.setNumber(field, "XMax", float(bounds_max[0]))
        gmsh.model.mesh.field.setNumber(field, "YMin", float(bounds_min[1]))
        gmsh.model.mesh.field.setNumber(field, "YMax", float(bounds_max[1]))
        gmsh.model.mesh.field.setNumber(field, "ZMin", float(bounds_min[2]))
        gmsh.model.mesh.field.setNumber(field, "ZMax", float(bounds_max[2]))
        gmsh.model.mesh.field.setNumber(
            field,
            "Thickness",
            max(options.end_refinement_distance * 0.25, options.element_size * 0.1),
        )
        fields.append(field)
    minimum = gmsh.model.mesh.field.add("Min")
    gmsh.model.mesh.field.setNumbers(minimum, "FieldsList", fields)
    gmsh.model.mesh.field.setAsBackgroundMesh(minimum)


def _mesh_component(
    gmsh,
    component: trimesh.Trimesh,
    options: CFDMeshOptions,
    sizes: tuple[float, float, float],
    component_index: int,
) -> _ComponentMesh:
    """Mesh one closed fluid component, optionally with inward prism layers."""
    gmsh.model.add(f"tpms_fluid_{component_index}")
    try:
        vertices = np.asarray(component.vertices, dtype=np.float64)
        faces = np.asarray(component.faces, dtype=np.int64)
        source_surface = gmsh.model.addDiscreteEntity(2)
        source_node_tags = np.arange(1, len(vertices) + 1, dtype=np.int64)
        gmsh.model.mesh.addNodes(2, source_surface, source_node_tags, vertices.reshape(-1))
        gmsh.model.mesh.addElementsByType(
            source_surface,
            2,
            [],
            (faces.reshape(-1) + 1).astype(np.int64),
        )

        if options.boundary_layer_enabled:
            out_entities = gmsh.model.geo.extrudeBoundaryLayer(
                [(2, source_surface)],
                [1] * options.boundary_layer_layers,
                options.boundary_layer_heights(),
                True,
                False,
            )
            gmsh.model.geo.synchronize()
            inner_surfaces = [tag for dimension, tag in out_entities if dimension == 2]
            if len(inner_surfaces) != 1:
                raise RuntimeError("无法构造边界层内侧的封闭核心表面")
            surface_loop = gmsh.model.geo.addSurfaceLoop(inner_surfaces)
            gmsh.model.geo.addVolume([surface_loop])
            gmsh.model.geo.synchronize()
            gmsh.option.setNumber("Mesh.Algorithm3D", 1)
        else:
            gmsh.model.mesh.classifySurfaces(
                math.radians(40.0),
                True,
                True,
                math.pi,
            )
            gmsh.model.mesh.createGeometry()
            surface_tags = [tag for _dimension, tag in gmsh.model.getEntities(2)]
            if not surface_tags:
                raise RuntimeError("Gmsh 未能识别流体域边界")
            surface_loop = gmsh.model.geo.addSurfaceLoop(surface_tags)
            gmsh.model.geo.addVolume([surface_loop])
            gmsh.model.geo.synchronize()
            gmsh.option.setNumber("Mesh.Algorithm3D", 10)  # HXT

        _configure_mesh_sizes(gmsh, options, sizes)
        try:
            gmsh.model.mesh.generate(3)
        except Exception as exc:
            if options.boundary_layer_enabled:
                raise RuntimeError(
                    "边界棱柱层在高曲率或狭窄孔道中发生自交；"
                    "请减小首层高度、层数或增长率"
                ) from exc
            raise
        if not options.boundary_layer_enabled:
            gmsh.model.mesh.optimize("Netgen")

        node_tags, coordinates, _parametric = gmsh.model.mesh.getNodes()
        node_tags = np.asarray(node_tags, dtype=np.int64)
        points = np.asarray(coordinates, dtype=np.float64).reshape(-1, 3)
        triangles = _extract_triangles(
            gmsh,
            node_tags,
            source_surface if options.boundary_layer_enabled else -1,
        )
        cells, qualities, volumes = _extract_volume_cells(gmsh, node_tags)
        if "tetra" in cells:
            qualities["tetra"] = _tetra_scaled_jacobians(points, cells["tetra"])
        return _ComponentMesh(points, triangles, cells, qualities, volumes)
    finally:
        gmsh.model.remove()


def _boundary_references(
    points: np.ndarray,
    triangles: np.ndarray,
    flow_axis: int,
    negative_limit: float,
    positive_limit: float,
    tolerance: float,
) -> np.ndarray:
    coordinates = points[triangles, flow_axis]
    inlet = np.all(np.abs(coordinates - negative_limit) <= tolerance, axis=1)
    outlet = np.all(np.abs(coordinates - positive_limit) <= tolerance, axis=1)
    references = np.full(len(triangles), PHYSICAL_IDS["walls"], dtype=np.int32)
    references[inlet] = PHYSICAL_IDS["inlet"]
    references[outlet] = PHYSICAL_IDS["outlet"]
    return references


def _tetra_scaled_jacobians(points: np.ndarray, tetrahedra: np.ndarray) -> np.ndarray:
    if len(tetrahedra) == 0:
        return np.empty(0, dtype=np.float64)
    tetra_points = points[tetrahedra]
    corner_edges = (
        (0, 1, 2, 3),
        (1, 0, 3, 2),
        (2, 3, 0, 1),
        (3, 2, 1, 0),
    )
    corner_qualities: list[np.ndarray] = []
    for corner, first, second, third in corner_edges:
        edge_1 = tetra_points[:, first] - tetra_points[:, corner]
        edge_2 = tetra_points[:, second] - tetra_points[:, corner]
        edge_3 = tetra_points[:, third] - tetra_points[:, corner]
        determinant = np.einsum("ij,ij->i", np.cross(edge_1, edge_2), edge_3)
        denominator = (
            np.linalg.norm(edge_1, axis=1)
            * np.linalg.norm(edge_2, axis=1)
            * np.linalg.norm(edge_3, axis=1)
        )
        quality = np.sqrt(2.0) * np.abs(determinant) / np.maximum(denominator, 1e-30)
        corner_qualities.append(np.clip(quality, 0.0, 1.0))
    return np.min(np.vstack(corner_qualities), axis=0)


def _edge_ratios(points: np.ndarray, cells: dict[str, np.ndarray]) -> np.ndarray:
    ratios: list[np.ndarray] = []
    topology_edges = {
        "tetra": ((0, 1), (0, 2), (0, 3), (1, 2), (1, 3), (2, 3)),
        "wedge": (
            (0, 1), (1, 2), (2, 0),
            (3, 4), (4, 5), (5, 3),
            (0, 3), (1, 4), (2, 5),
        ),
    }
    for cell_type, connectivity in cells.items():
        cell_points = points[connectivity]
        lengths = np.column_stack(
            [
                np.linalg.norm(cell_points[:, first] - cell_points[:, second], axis=1)
                for first, second in topology_edges[cell_type]
            ]
        )
        ratios.append(np.max(lengths, axis=1) / np.maximum(np.min(lengths, axis=1), 1e-30))
    return np.concatenate(ratios)


def _quality_statistics(
    points: np.ndarray,
    cells: dict[str, np.ndarray],
    qualities: dict[str, np.ndarray],
    volumes: dict[str, np.ndarray],
    threshold: float,
) -> MeshQualityStats:
    all_qualities = np.concatenate([qualities[name] for name in cells])
    all_volumes = np.concatenate([volumes[name] for name in cells])
    if np.min(all_qualities) <= 0 or np.min(all_volumes) <= 1e-15:
        raise RuntimeError("体网格中存在倒置或退化单元，请调整网格参数")
    histogram_counts, histogram_edges = np.histogram(all_qualities, bins=20, range=(0.0, 1.0))
    return MeshQualityStats(
        metric="scaled_jacobian",
        minimum=float(np.min(all_qualities)),
        percentile_05=float(np.percentile(all_qualities, 5.0)),
        median=float(np.median(all_qualities)),
        mean=float(np.mean(all_qualities)),
        maximum=float(np.max(all_qualities)),
        minimum_volume=float(np.min(all_volumes)),
        maximum_edge_ratio=float(np.max(_edge_ratios(points, cells))),
        low_quality_threshold=threshold,
        low_quality_elements=int(np.count_nonzero(all_qualities < threshold)),
        histogram_edges=histogram_edges.tolist(),
        histogram_counts=histogram_counts.astype(int).tolist(),
    )


def _low_quality_preview(
    points: np.ndarray,
    cells: dict[str, np.ndarray],
    qualities: dict[str, np.ndarray],
    threshold: float,
) -> tuple[np.ndarray, np.ndarray]:
    faces: list[tuple[int, int, int]] = []
    tetra_faces = ((0, 2, 1), (0, 1, 3), (1, 2, 3), (2, 0, 3))
    wedge_faces = (
        (0, 2, 1), (3, 4, 5),
        (0, 1, 4), (0, 4, 3),
        (1, 2, 5), (1, 5, 4),
        (2, 0, 3), (2, 3, 5),
    )
    for cell_type, connectivity in cells.items():
        selected = connectivity[qualities[cell_type] < threshold]
        local_faces = tetra_faces if cell_type == "tetra" else wedge_faces
        for face in local_faces:
            faces.extend(map(tuple, selected[:, face]))
    if not faces:
        return np.empty((0, 3), dtype=np.float32), np.empty((0, 3), dtype=np.int64)

    face_array = np.asarray(faces, dtype=np.int64)
    canonical = np.sort(face_array, axis=1)
    _unique, inverse, counts = np.unique(
        canonical,
        axis=0,
        return_inverse=True,
        return_counts=True,
    )
    exposed = counts[inverse] == 1
    face_array = face_array[exposed]
    if len(face_array) > 300_000:
        step = int(math.ceil(len(face_array) / 300_000))
        face_array = face_array[::step]
    used, remapped = np.unique(face_array.reshape(-1), return_inverse=True)
    return (
        np.asarray(points[used], dtype=np.float32),
        remapped.reshape(-1, 3).astype(np.int64),
    )


def _boundary_region_preview(
    points: np.ndarray,
    triangles: np.ndarray,
    boundary_refs: np.ndarray,
) -> PreviewMesh:
    """Build a color-per-face surface preview for inlet, outlet and walls."""
    selected_faces: list[np.ndarray] = []
    selected_colors: list[np.ndarray] = []
    for physical_id, color in REGION_COLORS.items():
        region_faces = triangles[boundary_refs == physical_id]
        if len(region_faces) == 0:
            continue
        selected_faces.append(region_faces)
        selected_colors.append(
            np.repeat(color[None, :], len(region_faces), axis=0)
        )
    if not selected_faces:
        return PreviewMesh(
            vertices=np.empty((0, 3), dtype=np.float32),
            faces=np.empty((0, 3), dtype=np.int64),
            colors=np.empty((0, 3), dtype=np.float32),
        )

    face_array = np.vstack(selected_faces).astype(np.int64)
    face_colors = np.vstack(selected_colors).astype(np.float32)
    vertices = np.asarray(points[face_array.reshape(-1)], dtype=np.float32)
    faces = np.arange(len(vertices), dtype=np.int64).reshape(-1, 3)
    colors = np.repeat(face_colors, 3, axis=0)
    return PreviewMesh(vertices=vertices, faces=faces, colors=colors)


def generate_simulation_region_preview(
    parameters: TPMSParameters,
    options: CFDMeshOptions,
) -> PreviewMesh:
    """Generate color-coded simulation boundaries without creating volume cells."""
    sizes = (parameters.size_x, parameters.size_y, parameters.size_z)
    preview_options = replace(options, boundary_layer_enabled=False)
    preview_options.validate(sizes)
    fluid_parameters = replace(
        parameters,
        samples_per_cell=options.surface_samples_per_cell,
        target_porosity=None,
    )
    fluid = generate_fluid_domain(fluid_parameters)
    if not fluid.mesh.is_watertight:
        raise RuntimeError("流体域表面未封闭，无法显示仿真区域")
    components = fluid.mesh.split(only_watertight=True)
    if not components:
        raise RuntimeError("没有找到可显示的封闭流体域")

    point_blocks: list[np.ndarray] = []
    triangle_blocks: list[np.ndarray] = []
    point_offset = 0
    for component in components:
        component_points = np.asarray(component.vertices, dtype=np.float64)
        component_triangles = np.asarray(component.faces, dtype=np.int64)
        point_blocks.append(component_points)
        triangle_blocks.append(component_triangles + point_offset)
        point_offset += len(component_points)
    points = np.vstack(point_blocks)
    triangles = np.vstack(triangle_blocks)
    axis = {"X": 0, "Y": 1, "Z": 2}[options.flow_axis]
    negative_limit = -sizes[axis] / 2.0
    positive_limit = sizes[axis] / 2.0
    tolerance = max(max(sizes) * 1e-6, 1e-7)
    boundary_refs = _boundary_references(
        points,
        triangles,
        axis,
        negative_limit,
        positive_limit,
        tolerance,
    )
    if not np.any(boundary_refs == PHYSICAL_IDS["inlet"]):
        raise RuntimeError("无法在所选流向上识别入口区域")
    if not np.any(boundary_refs == PHYSICAL_IDS["outlet"]):
        raise RuntimeError("无法在所选流向上识别出口区域")
    return _boundary_region_preview(points, triangles, boundary_refs)


def export_comsol_fluid_mesh(
    parameters: TPMSParameters,
    destination: str | Path,
    options: CFDMeshOptions,
    progress: Callable[[str], None] | None = None,
) -> CFDMeshResult:
    """Generate the void domain and export grouped, quality-checked CFD meshes."""
    sizes = (parameters.size_x, parameters.size_y, parameters.size_z)
    options.validate(sizes)
    try:
        import gmsh
    except ImportError as exc:
        raise RuntimeError("缺少 Gmsh，请先运行 pip install gmsh") from exc

    base = Path(destination)
    if base.suffix.lower() in {".msh", ".bdf", ".json", ".vtu"}:
        base = base.with_suffix("")
    base.parent.mkdir(parents=True, exist_ok=True)
    msh_path = base.with_suffix(".msh")
    bdf_path = base.with_suffix(".bdf")
    metadata_path = base.with_name(base.name + "_boundaries.json")
    quality_path = base.with_name(base.name + "_quality.vtu")

    fluid_parameters = replace(
        parameters,
        samples_per_cell=options.surface_samples_per_cell,
        target_porosity=None,
    )
    _emit(progress, "正在生成封闭流体域...")
    fluid = generate_fluid_domain(fluid_parameters)
    if not fluid.mesh.is_watertight:
        raise RuntimeError("流体域表面未封闭，无法生成可靠的体网格")
    components = sorted(
        fluid.mesh.split(only_watertight=True),
        key=lambda item: abs(float(item.volume)),
        reverse=True,
    )
    if not components:
        raise RuntimeError("没有找到可划分的封闭流体域")

    initialized_here = not gmsh.isInitialized()
    if initialized_here:
        gmsh.initialize()
    point_blocks: list[np.ndarray] = []
    triangle_blocks: list[np.ndarray] = []
    cell_blocks: dict[str, list[np.ndarray]] = {"tetra": [], "wedge": []}
    quality_blocks: dict[str, list[np.ndarray]] = {"tetra": [], "wedge": []}
    volume_blocks: dict[str, list[np.ndarray]] = {"tetra": [], "wedge": []}
    point_offset = 0
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        for index, component in enumerate(components, start=1):
            layer_text = "（含棱柱边界层）" if options.boundary_layer_enabled else ""
            _emit(progress, f"正在划分流体域 {index}/{len(components)}{layer_text}...")
            component_mesh = _mesh_component(gmsh, component, options, sizes, index)
            point_blocks.append(component_mesh.points)
            triangle_blocks.append(component_mesh.triangles + point_offset)
            for cell_type, connectivity in component_mesh.cells.items():
                cell_blocks[cell_type].append(connectivity + point_offset)
                quality_blocks[cell_type].append(component_mesh.qualities[cell_type])
                volume_blocks[cell_type].append(component_mesh.volumes[cell_type])
            point_offset += len(component_mesh.points)
    finally:
        if initialized_here:
            gmsh.finalize()

    points = np.vstack(point_blocks)
    triangles = np.vstack(triangle_blocks)
    cells = {
        name: np.vstack(blocks)
        for name, blocks in cell_blocks.items()
        if blocks
    }
    qualities = {
        name: np.concatenate(blocks)
        for name, blocks in quality_blocks.items()
        if blocks
    }
    volumes = {
        name: np.concatenate(blocks)
        for name, blocks in volume_blocks.items()
        if blocks
    }
    quality = _quality_statistics(
        points,
        cells,
        qualities,
        volumes,
        options.low_quality_threshold,
    )
    low_quality_vertices, low_quality_faces = _low_quality_preview(
        points,
        cells,
        qualities,
        options.low_quality_threshold,
    )
    tetrahedra = cells.get("tetra", np.empty((0, 4), dtype=np.int64))
    prisms = cells.get("wedge", np.empty((0, 6), dtype=np.int64))
    minimum_scaled_jacobian = quality.minimum

    axis = {"X": 0, "Y": 1, "Z": 2}[options.flow_axis]
    negative_limit = -sizes[axis] / 2.0
    positive_limit = sizes[axis] / 2.0
    tolerance = max(max(sizes) * 1e-6, 1e-7)
    boundary_refs = _boundary_references(
        points,
        triangles,
        axis,
        negative_limit,
        positive_limit,
        tolerance,
    )
    boundary_counts = {
        name: int(np.count_nonzero(boundary_refs == physical_id))
        for name, physical_id in PHYSICAL_IDS.items()
        if name != "fluid"
    }
    if boundary_counts["inlet"] == 0 or boundary_counts["outlet"] == 0:
        raise RuntimeError("无法在所选流向上识别入口或出口三角面")
    region_preview = _boundary_region_preview(points, triangles, boundary_refs)

    mesh_cells: list[tuple[str, np.ndarray]] = [("triangle", triangles)]
    cell_references: list[np.ndarray] = [boundary_refs]
    for cell_type in ("tetra", "wedge"):
        if cell_type in cells:
            mesh_cells.append((cell_type, cells[cell_type]))
            cell_references.append(
                np.full(len(cells[cell_type]), PHYSICAL_IDS["fluid"], dtype=np.int32)
            )
    mesh = meshio.Mesh(
        points=points,
        cells=mesh_cells,
        cell_data={
            "gmsh:physical": cell_references,
            "gmsh:geometrical": cell_references,
        },
        field_data={
            "inlet": np.array([PHYSICAL_IDS["inlet"], 2]),
            "outlet": np.array([PHYSICAL_IDS["outlet"], 2]),
            "walls": np.array([PHYSICAL_IDS["walls"], 2]),
            "fluid": np.array([PHYSICAL_IDS["fluid"], 3]),
        },
    )
    _emit(progress, "正在写入 MSH、NASTRAN 和质量定位文件...")
    meshio.write(msh_path, mesh, file_format="gmsh22", binary=False)
    nastran_mesh = meshio.Mesh(
        points=np.round(points, decimals=8),
        cells=mesh_cells,
        cell_data={"nastran:ref": cell_references},
    )
    meshio.write(
        bdf_path,
        nastran_mesh,
        file_format="nastran",
        point_format="free",
        cell_format="fixed-small",
    )
    quality_cell_data = [
        qualities[cell_type]
        for cell_type in ("tetra", "wedge")
        if cell_type in cells
    ]
    meshio.write(
        quality_path,
        meshio.Mesh(
            points=points,
            cells=[(cell_type, cells[cell_type]) for cell_type in ("tetra", "wedge") if cell_type in cells],
            cell_data={"scaled_jacobian": quality_cell_data},
        ),
    )

    metadata = {
        "format": "TPMS Studio COMSOL CFD mesh",
        "units": "mm",
        "flow_axis": options.flow_axis,
        "inlet": f"{options.flow_axis}-",
        "outlet": f"{options.flow_axis}+",
        "physical_ids": PHYSICAL_IDS,
        "boundary_triangles": boundary_counts,
        "fluid_domains": len(components),
        "nodes": len(points),
        "tetrahedra": len(tetrahedra),
        "prisms": len(prisms),
        "volume_elements": sum(len(connectivity) for connectivity in cells.values()),
        "surface_triangles": len(triangles),
        "min_scaled_jacobian_tetrahedra": minimum_scaled_jacobian,
        "fluid_fraction": fluid.fluid_fraction,
        "boundary_layer_scope": (
            "all_fluid_boundaries" if options.boundary_layer_enabled else "disabled"
        ),
        "quality": asdict(quality),
        "quality_vtu": str(quality_path),
        "mesh_options": asdict(options),
        "tpms_parameters": asdict(fluid_parameters),
    }
    metadata_path.write_text(
        json.dumps(metadata, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )
    return CFDMeshResult(
        msh_path=msh_path,
        bdf_path=bdf_path,
        metadata_path=metadata_path,
        quality_path=quality_path,
        nodes=len(points),
        tetrahedra=len(tetrahedra),
        prisms=len(prisms),
        volume_elements=sum(len(connectivity) for connectivity in cells.values()),
        surface_triangles=len(triangles),
        min_scaled_jacobian=minimum_scaled_jacobian,
        fluid_fraction=fluid.fluid_fraction,
        fluid_domains=len(components),
        boundary_triangles=boundary_counts,
        quality=quality,
        low_quality_vertices=low_quality_vertices,
        low_quality_faces=low_quality_faces,
        region_preview=region_preview,
    )
