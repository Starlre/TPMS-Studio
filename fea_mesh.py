"""Structural FEA tetrahedral volume meshing, quality inspection, and MSH/BDF export."""
from __future__ import annotations

from collections.abc import Callable
from dataclasses import asdict, dataclass
import json
import math
from pathlib import Path

import meshio
import numpy as np
from skimage.measure import marching_cubes
import trimesh

from comsol_mesh import (
    MeshQualityStats,
    _ComponentMesh,
    _configure_gmsh_threads,
    _extract_triangles,
    _extract_volume_cells,
    _low_quality_preview,
    _quality_statistics,
    _tetra_scaled_jacobians,
)
from sdf_grid import build_sdf_volume


FEA_PHYSICAL_IDS = {"surface": 101, "solid": 201}
AUTO_DIRECT_MAX_FACES = 45_000


@dataclass(frozen=True)
class FEAMeshOptions:
    element_size: float = 2.0
    curvature_refinement_enabled: bool = True
    curvature_points: int = 18
    remesh_surface: str = "auto"  # 'auto' | 'direct' | 'remesh'
    surface_size: float | None = None
    low_quality_threshold: float = 0.2

    def validate(self, sizes: tuple[float, float, float] | None = None) -> None:
        if isinstance(self.element_size, bool) or not isinstance(self.element_size, (int, float)) or not math.isfinite(self.element_size) or self.element_size <= 0 or self.element_size > 1000:
            raise ValueError("体单元尺寸必须在 (0, 1000] mm 范围内")
        if self.remesh_surface not in {"auto", "direct", "remesh"}:
            raise ValueError("表面处理方式须为 auto、direct 或 remesh")
        if self.surface_size is not None and (isinstance(self.surface_size, bool) or not isinstance(self.surface_size, (int, float)) or not math.isfinite(self.surface_size) or self.surface_size <= 0):
            raise ValueError("重划分表面尺寸必须大于 0")
        if not 6 <= int(self.curvature_points) <= 60:
            raise ValueError("曲率采样点数必须在 6 到 60 之间")
        if not 0.01 <= float(self.low_quality_threshold) <= 0.9:
            raise ValueError("低质量阈值必须在 0.01 到 0.9 之间")


@dataclass(frozen=True)
class FEAMeshResult:
    msh_path: Path
    bdf_path: Path
    metadata_path: Path
    quality_path: Path
    nodes: int
    tetrahedra: int
    volume_elements: int
    surface_triangles: int
    solid_domains: int
    min_scaled_jacobian: float
    mesh_volume: float
    remeshed: bool
    quality: MeshQualityStats
    low_quality_vertices: np.ndarray
    low_quality_faces: np.ndarray


def _group_solids_and_voids(mesh: trimesh.Trimesh) -> list[tuple[trimesh.Trimesh, list[trimesh.Trimesh]]]:
    """Pair each positive-volume solid shell with any enclosed negative-volume void cavities."""
    parts = mesh.split(only_watertight=False)
    solids = sorted([p for p in parts if p.is_watertight and p.volume > 1e-9],
                    key=lambda p: float(p.volume), reverse=True)
    voids = [p for p in parts if p.is_watertight and p.volume < -1e-9]
    if not solids:
        raise ValueError("当前模型没有可划分体网格的封闭实体（请先确保模型为水密正体积实体）")
    assigned: list[tuple[trimesh.Trimesh, list[trimesh.Trimesh]]] = [(s, []) for s in solids]
    for void in voids:
        probe = np.asarray(void.vertices[:1], dtype=np.float64)
        # Iterate smallest-to-largest enclosing solid so nested islands pick immediate parent.
        for solid, holes in reversed(assigned):
            lo, hi = solid.bounds
            if np.all(probe[0] >= lo - 1e-6) and np.all(probe[0] <= hi + 1e-6) and bool(solid.contains(probe)[0]):
                holes.append(void)
                break
    return assigned


def _default_surface_spacing(mesh: trimesh.Trimesh, options: FEAMeshOptions) -> float:
    if options.surface_size is not None:
        return float(options.surface_size)
    extent = np.maximum(mesh.bounds[1] - mesh.bounds[0], 1e-3)
    target_box_voxels = 2_800_000.0
    budget_h = float((np.prod(extent) / target_box_voxels) ** (1.0 / 3.0))
    return max(0.25, min(float(options.element_size) * 0.65, max(budget_h, float(options.element_size) * 0.5)))


def _remesh_discrete_surface(mesh: trimesh.Trimesh, h_surf: float) -> trimesh.Trimesh:
    vol = build_sdf_volume(mesh, h_surf)
    if float(vol.data.min()) > 0.0 or float(vol.data.max()) < 0.0:
        raise ValueError("表面重划分尺寸过大，实体薄壁结构已丢失；请减小体单元尺寸")
    verts, faces, _n, _v = marching_cubes(
        vol.data, level=-1e-4 * h_surf, spacing=(h_surf, h_surf, h_surf), gradient_direction="ascent",
    )
    verts = verts.astype(np.float64) + vol.origin
    remeshed = trimesh.Trimesh(vertices=verts, faces=faces.astype(np.int64), process=False)
    remeshed.remove_unreferenced_vertices()
    if not remeshed.is_watertight:
        raise ValueError("表面重划分后未保持封闭，请调小体单元尺寸重试")
    trimesh.smoothing.filter_taubin(remeshed, lamb=0.45, nu=-0.46, iterations=4)
    if not remeshed.is_winding_consistent:
        remeshed.fix_normals(multibody=False)
    if remeshed.volume < 0:
        remeshed.invert()
    return remeshed


def _run_gmsh_on_component(
    gmsh,
    outer: trimesh.Trimesh,
    holes: list[trimesh.Trimesh],
    options: FEAMeshOptions,
    component_index: int,
    algo_id: int,
) -> _ComponentMesh:
    gmsh.model.add(f"tpms_fea_{component_index}")
    try:
        shells = [outer, *holes]
        loops = []
        node_offset = 0
        for shell in shells:
            verts = np.asarray(shell.vertices, dtype=np.float64)
            faces = np.asarray(shell.faces, dtype=np.int64)
            surf = gmsh.model.addDiscreteEntity(2)
            tags = np.arange(node_offset + 1, node_offset + len(verts) + 1, dtype=np.int64)
            gmsh.model.mesh.addNodes(2, surf, tags, verts.reshape(-1))
            gmsh.model.mesh.addElementsByType(surf, 2, [], (faces.reshape(-1) + node_offset + 1).astype(np.int64))
            node_offset += len(verts)
            loops.append(gmsh.model.geo.addSurfaceLoop([surf]))

        gmsh.model.geo.addVolume(loops)
        gmsh.model.geo.synchronize()
        _configure_gmsh_threads(gmsh)
        gmsh.option.setNumber("Mesh.Algorithm3D", algo_id)
        gmsh.option.setNumber("Mesh.MeshSizeMin", float(options.element_size) * 0.15)
        gmsh.option.setNumber("Mesh.MeshSizeMax", float(options.element_size))
        gmsh.option.setNumber("Mesh.ElementOrder", 1)
        gmsh.option.setNumber(
            "Mesh.MeshSizeFromCurvature",
            int(options.curvature_points) if options.curvature_refinement_enabled else 0,
        )
        gmsh.model.mesh.generate(3)
        gmsh.model.mesh.optimize("Netgen")

        node_tags, coordinates, _ = gmsh.model.mesh.getNodes()
        node_tags = np.asarray(node_tags, dtype=np.int64)
        points = np.asarray(coordinates, dtype=np.float64).reshape(-1, 3)
        triangles = _extract_triangles(gmsh, node_tags, -1)
        cells, qualities, volumes = _extract_volume_cells(gmsh, node_tags)
        if "tetra" in cells:
            qualities["tetra"] = _tetra_scaled_jacobians(points, cells["tetra"])
        return _ComponentMesh(points, triangles, cells, qualities, volumes)
    finally:
        gmsh.model.remove()


def _run_gmsh_isolated(
    gmsh,
    outer: trimesh.Trimesh,
    holes: list[trimesh.Trimesh],
    options: FEAMeshOptions,
    component_index: int,
    algo_id: int,
) -> _ComponentMesh:
    if gmsh.isInitialized():
        gmsh.finalize()
    gmsh.initialize()
    try:
        gmsh.option.setNumber("General.Terminal", 0)
        return _run_gmsh_on_component(gmsh, outer, holes, options, component_index, algo_id)
    finally:
        if gmsh.isInitialized():
            gmsh.finalize()


def _mesh_solid_with_fallback(
    gmsh,
    outer: trimesh.Trimesh,
    holes: list[trimesh.Trimesh],
    options: FEAMeshOptions,
    component_index: int,
    progress: Callable[[str], None] | None = None,
) -> tuple[list[_ComponentMesh], bool]:
    # Try direct conformal meshing when requested or surface is compact; fallback cleanly on QEF pinch / self-intersections.
    allow_direct = (options.remesh_surface == "direct" or
                    (options.remesh_surface == "auto" and len(outer.faces) <= AUTO_DIRECT_MAX_FACES))
    last_exc: Exception | None = None
    if allow_direct:
        for algo_id in (10, 1):
            try:
                return [_run_gmsh_isolated(gmsh, outer, holes, options, component_index, algo_id)], False
            except Exception as exc:
                last_exc = exc
        if options.remesh_surface == "direct":
            raise RuntimeError(
                f"直接四面体划分失败（表面可能存在自交或微细捏合顶点，建议改用“智能自适应”重划分）：{last_exc}"
            ) from last_exc

    # Assemble combined watertight shell if holes exist, then build smooth 2-manifold SDF surface.
    combined = outer if not holes else trimesh.util.concatenate([outer, *holes])
    h_surf = _default_surface_spacing(combined, options)
    if progress:
        progress(f"正在重构光滑 FEA 表面网格（步长 {h_surf:.2f} mm）...")
    clean_surface = _remesh_discrete_surface(combined, h_surf)
    pairs = _group_solids_and_voids(clean_surface)
    results: list[_ComponentMesh] = []
    for sub_idx, (outer_r, holes_r) in enumerate(pairs):
        meshed = None
        for algo_id in (10, 1):
            try:
                meshed = _run_gmsh_isolated(gmsh, outer_r, holes_r, options, component_index * 100 + sub_idx, algo_id)
                break
            except Exception as exc:
                last_exc = exc
        if meshed is None:
            raise RuntimeError(f"Gmsh FEA 体网格划分失败：{last_exc}") from last_exc
        results.append(meshed)
    return results, True


def export_fea_volume_mesh(
    mesh: trimesh.Trimesh,
    destination: str | Path,
    options: FEAMeshOptions,
    progress: Callable[[str], None] | None = None,
    write_files: bool = True,
) -> FEAMeshResult:
    """Tetrahedralize any closed watertight solid mesh (composite, imported, shell, or lattice) for FEA."""
    if not isinstance(mesh, trimesh.Trimesh) or not len(mesh.faces) or not mesh.is_watertight:
        raise ValueError("当前模型不是封闭水密实体，无法生成 FEA 体网格")
    extent = tuple(np.maximum(mesh.bounds[1] - mesh.bounds[0], 1e-3).tolist())
    options.validate(extent)
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
    metadata_path = base.with_name(base.name + "_fea.json")
    quality_path = base.with_name(base.name + "_quality.vtu")

    pairs = _group_solids_and_voids(mesh)
    point_blocks: list[np.ndarray] = []
    triangle_blocks: list[np.ndarray] = []
    tetra_blocks: list[np.ndarray] = []
    quality_blocks: list[np.ndarray] = []
    volume_blocks: list[np.ndarray] = []
    point_offset = 0
    any_remeshed = False

    for index, (outer, holes) in enumerate(pairs, start=1):
        if progress:
            progress(f"正在生成 FEA 四面体网格 {index}/{len(pairs)}（HXT + Netgen）...")
        components_meshed, remeshed = _mesh_solid_with_fallback(gmsh, outer, holes, options, index, progress)
        any_remeshed = any_remeshed or remeshed
        for cm in components_meshed:
            if "tetra" not in cm.cells:
                raise RuntimeError("Gmsh 未生成有效的四面体单元")
            point_blocks.append(cm.points)
            triangle_blocks.append(cm.triangles + point_offset)
            tetra_blocks.append(cm.cells["tetra"] + point_offset)
            quality_blocks.append(cm.qualities["tetra"])
            volume_blocks.append(cm.volumes["tetra"])
            point_offset += len(cm.points)

    points = np.vstack(point_blocks)
    triangles = np.vstack(triangle_blocks)
    tetrahedra = np.vstack(tetra_blocks)
    cells = {"tetra": tetrahedra}
    qualities = {"tetra": np.concatenate(quality_blocks)}
    volumes = {"tetra": np.concatenate(volume_blocks)}

    quality = _quality_statistics(points, cells, qualities, volumes, options.low_quality_threshold)
    low_v, low_f = _low_quality_preview(points, cells, qualities, options.low_quality_threshold)
    total_volume = float(np.sum(volumes["tetra"]))

    if write_files:
        surf_refs = np.full(len(triangles), FEA_PHYSICAL_IDS["surface"], dtype=np.int32)
        solid_refs = np.full(len(tetrahedra), FEA_PHYSICAL_IDS["solid"], dtype=np.int32)
        mesh_cells = [("triangle", triangles), ("tetra", tetrahedra)]
        cell_refs = [surf_refs, solid_refs]

        if progress:
            progress("正在写入 FEA MSH、NASTRAN BDF 与质量分析文件...")
        out_mesh = meshio.Mesh(
            points=points,
            cells=mesh_cells,
            cell_data={"gmsh:physical": cell_refs, "gmsh:geometrical": cell_refs},
            field_data={
                "surface": np.array([FEA_PHYSICAL_IDS["surface"], 2]),
                "solid": np.array([FEA_PHYSICAL_IDS["solid"], 3]),
            },
        )
        meshio.write(msh_path, out_mesh, file_format="gmsh22", binary=False)
        nastran_mesh = meshio.Mesh(
            points=np.round(points, decimals=8),
            cells=mesh_cells,
            cell_data={"nastran:ref": cell_refs},
        )
        meshio.write(bdf_path, nastran_mesh, file_format="nastran", point_format="free", cell_format="fixed-small")
        meshio.write(
            quality_path,
            meshio.Mesh(points=points, cells=[("tetra", tetrahedra)], cell_data={"scaled_jacobian": [qualities["tetra"]]}),
        )

        metadata = {
            "format": "TPMS Studio FEA solid volume mesh",
            "units": "mm",
            "physical_ids": FEA_PHYSICAL_IDS,
            "solid_domains": len(pairs),
            "remeshed_surface": any_remeshed,
            "nodes": int(len(points)),
            "tetrahedra": int(len(tetrahedra)),
            "volume_elements": int(len(tetrahedra)),
            "surface_triangles": int(len(triangles)),
            "mesh_volume_mm3": total_volume,
            "min_scaled_jacobian": quality.minimum,
            "quality": asdict(quality),
            "quality_vtu": str(quality_path),
            "mesh_options": asdict(options),
        }
        metadata_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")

    return FEAMeshResult(
        msh_path=msh_path,
        bdf_path=bdf_path,
        metadata_path=metadata_path,
        quality_path=quality_path,
        nodes=int(len(points)),
        tetrahedra=int(len(tetrahedra)),
        volume_elements=int(len(tetrahedra)),
        surface_triangles=int(len(triangles)),
        solid_domains=len(pairs),
        min_scaled_jacobian=quality.minimum,
        mesh_volume=total_volume,
        remeshed=any_remeshed,
        quality=quality,
        low_quality_vertices=low_v,
        low_quality_faces=low_f,
    )
