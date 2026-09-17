from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass, replace
import json
import math
from pathlib import Path

import meshio
import numpy as np
import trimesh

from tpms_core import TPMSParameters, generate_fluid_domain


PHYSICAL_IDS = {"inlet": 101, "outlet": 102, "walls": 103, "fluid": 201}


@dataclass(frozen=True)
class CFDMeshOptions:
    flow_axis: str = "X"
    element_size: float = 1.5
    surface_samples_per_cell: int = 32

    def validate(self) -> None:
        if self.flow_axis not in {"X", "Y", "Z"}:
            raise ValueError("流向必须是 X、Y 或 Z")
        if self.element_size <= 0:
            raise ValueError("体网格单元尺寸必须大于 0")
        if not 16 <= self.surface_samples_per_cell <= 96:
            raise ValueError("流体表面精度必须在 16 到 96 之间")


@dataclass(frozen=True)
class CFDMeshResult:
    msh_path: Path
    bdf_path: Path
    metadata_path: Path
    nodes: int
    tetrahedra: int
    surface_triangles: int
    min_scaled_jacobian: float
    fluid_fraction: float
    fluid_domains: int
    boundary_triangles: dict[str, int]


def _emit(progress: Callable[[str], None] | None, message: str) -> None:
    if progress is not None:
        progress(message)


def _indexed_connectivity(
    node_tags: np.ndarray,
    element_nodes: np.ndarray,
) -> np.ndarray:
    """Map arbitrary Gmsh node tags to zero-based point array indices."""
    lookup = np.full(int(np.max(node_tags)) + 1, -1, dtype=np.int64)
    lookup[node_tags.astype(np.int64)] = np.arange(len(node_tags), dtype=np.int64)
    connectivity = lookup[element_nodes.astype(np.int64)]
    if np.any(connectivity < 0):
        raise RuntimeError("Gmsh 返回了无法匹配的单元节点")
    return connectivity


def _extract_elements(gmsh, dimension: int, node_tags: np.ndarray) -> np.ndarray:
    blocks: list[np.ndarray] = []
    element_types, _element_tags, element_nodes = gmsh.model.mesh.getElements(dimension)
    expected_nodes = 3 if dimension == 2 else 4
    for element_type, nodes in zip(element_types, element_nodes):
        _name, dim, order, node_count, _local, _primary = (
            gmsh.model.mesh.getElementProperties(element_type)
        )
        if dim == dimension and order == 1 and node_count == expected_nodes:
            blocks.append(
                _indexed_connectivity(node_tags, np.asarray(nodes)).reshape(-1, node_count)
            )
    if not blocks:
        kind = "三角形" if dimension == 2 else "四面体"
        raise RuntimeError(f"Gmsh 没有生成一阶{kind}单元")
    return np.vstack(blocks)


def _mesh_component(
    gmsh,
    component: trimesh.Trimesh,
    element_size: float,
    component_index: int,
) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Tetrahedralize one closed fluid component in an isolated Gmsh model."""
    gmsh.model.add(f"tpms_fluid_{component_index}")
    try:
        vertices = np.asarray(component.vertices, dtype=np.float64)
        faces = np.asarray(component.faces, dtype=np.int64)
        source_surface = gmsh.model.addDiscreteEntity(2)
        source_node_tags = np.arange(1, len(vertices) + 1, dtype=np.int64)
        gmsh.model.mesh.addNodes(
            2,
            source_surface,
            source_node_tags,
            vertices.reshape(-1),
        )
        gmsh.model.mesh.addElementsByType(
            source_surface,
            2,
            [],
            (faces.reshape(-1) + 1).astype(np.int64),
        )

        # Reparametrize the triangulated shell so Gmsh can remesh and fill it.
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
        gmsh.option.setNumber("Mesh.MeshSizeFromCurvature", 0)
        gmsh.option.setNumber("Mesh.MeshSizeMin", element_size * 0.65)
        gmsh.option.setNumber("Mesh.MeshSizeMax", element_size)
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.model.mesh.generate(3)
        gmsh.model.mesh.optimize("Netgen")

        node_tags, coordinates, _parametric = gmsh.model.mesh.getNodes()
        node_tags = np.asarray(node_tags, dtype=np.int64)
        points = np.asarray(coordinates, dtype=np.float64).reshape(-1, 3)
        triangles = _extract_elements(gmsh, 2, node_tags)
        tetrahedra = _extract_elements(gmsh, 3, node_tags)

        return points, triangles, tetrahedra
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


def _minimum_scaled_jacobian(points: np.ndarray, tetrahedra: np.ndarray) -> float:
    """Return corner-based tetrahedral scaled Jacobian in the range [0, 1]."""
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
        determinant = np.einsum(
            "ij,ij->i",
            np.cross(edge_1, edge_2),
            edge_3,
        )
        denominator = (
            np.linalg.norm(edge_1, axis=1)
            * np.linalg.norm(edge_2, axis=1)
            * np.linalg.norm(edge_3, axis=1)
        )
        quality = np.sqrt(2.0) * np.abs(determinant) / np.maximum(denominator, 1e-30)
        corner_qualities.append(np.clip(quality, 0.0, 1.0))
    minimum_by_tetrahedron = np.min(np.vstack(corner_qualities), axis=0)
    minimum = float(np.min(minimum_by_tetrahedron))
    if minimum <= 1e-8:
        raise RuntimeError("体网格中存在退化四面体，请调整单元尺寸或表面精度")
    return minimum


def export_comsol_fluid_mesh(
    parameters: TPMSParameters,
    destination: str | Path,
    options: CFDMeshOptions,
    progress: Callable[[str], None] | None = None,
) -> CFDMeshResult:
    """Generate the void domain and export grouped COMSOL volume meshes."""
    options.validate()
    try:
        import gmsh
    except ImportError as exc:
        raise RuntimeError("缺少 Gmsh，请先运行 pip install gmsh") from exc

    base = Path(destination)
    if base.suffix.lower() in {".msh", ".bdf", ".json"}:
        base = base.with_suffix("")
    base.parent.mkdir(parents=True, exist_ok=True)
    msh_path = base.with_suffix(".msh")
    bdf_path = base.with_suffix(".bdf")
    metadata_path = base.with_name(base.name + "_boundaries.json")

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
    tetrahedron_blocks: list[np.ndarray] = []
    point_offset = 0
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        for index, component in enumerate(components, start=1):
            _emit(progress, f"正在划分流体域 {index}/{len(components)}...")
            points, triangles, tetrahedra = _mesh_component(
                gmsh,
                component,
                options.element_size,
                index,
            )
            point_blocks.append(points)
            triangle_blocks.append(triangles + point_offset)
            tetrahedron_blocks.append(tetrahedra + point_offset)
            point_offset += len(points)
    finally:
        if initialized_here:
            gmsh.finalize()

    points = np.vstack(point_blocks)
    triangles = np.vstack(triangle_blocks)
    tetrahedra = np.vstack(tetrahedron_blocks)
    minimum_quality = _minimum_scaled_jacobian(points, tetrahedra)
    axis = {"X": 0, "Y": 1, "Z": 2}[options.flow_axis]
    sizes = (parameters.size_x, parameters.size_y, parameters.size_z)
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

    tetra_refs = np.full(len(tetrahedra), PHYSICAL_IDS["fluid"], dtype=np.int32)
    cells = [("triangle", triangles), ("tetra", tetrahedra)]
    cell_references = [boundary_refs, tetra_refs]
    mesh = meshio.Mesh(
        points=points,
        cells=cells,
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
    _emit(progress, "正在写入 MSH、NASTRAN 和边界元数据...")
    meshio.write(msh_path, mesh, file_format="gmsh22", binary=False)
    # meshio's NASTRAN writer reserves 16 characters for scientific values.
    # Nanometre-level rounding in millimetre units keeps values within that
    # field without changing the CFD geometry in any meaningful way.
    nastran_mesh = meshio.Mesh(
        points=np.round(points, decimals=8),
        cells=cells,
        cell_data={"nastran:ref": cell_references},
    )
    meshio.write(
        bdf_path,
        nastran_mesh,
        file_format="nastran",
        point_format="free",
        cell_format="fixed-small",
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
        "surface_triangles": len(triangles),
        "min_scaled_jacobian": minimum_quality,
        "fluid_fraction": fluid.fluid_fraction,
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
        nodes=len(points),
        tetrahedra=len(tetrahedra),
        surface_triangles=len(triangles),
        min_scaled_jacobian=minimum_quality,
        fluid_fraction=fluid.fluid_fraction,
        fluid_domains=len(components),
        boundary_triangles=boundary_counts,
    )
