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
    geom_h = float(np.prod(extent) ** (1.0 / 3.0)) / 48.0
    return max(0.22, budget_h, min(float(options.element_size) * 0.48, max(0.25, geom_h)))


def _tri_geom_metrics(verts: np.ndarray, faces: np.ndarray, adj: np.ndarray):
    v0, v1, v2 = verts[faces[:, 0]], verts[faces[:, 1]], verts[faces[:, 2]]
    e0, e1, e2 = v1 - v0, v2 - v1, v0 - v2
    fn = np.cross(e0, -e2)
    norms = np.linalg.norm(fn, axis=1)
    areas = 0.5 * norms
    unit_fn = fn / np.maximum(norms[:, None], 1e-12)
    l0 = np.sum(e0 * e0, axis=1)
    l1 = np.sum(e1 * e1, axis=1)
    l2 = np.sum(e2 * e2, axis=1)
    qual = (4.0 * math.sqrt(3.0) * areas) / np.maximum(l0 + l1 + l2, 1e-18)
    dots = np.sum(unit_fn[adj[:, 0]] * unit_fn[adj[:, 1]], axis=1) if len(adj) else np.empty(0, dtype=np.float64)
    return fn, unit_fn, areas, qual, dots


def _collapse_short_edges(mesh: trimesh.Trimesh, min_edge: float) -> trimesh.Trimesh:
    """Collapse marching-cubes micro-sliver edges while strictly preserving 2-manifold watertightness."""
    v = mesh.vertices.copy()
    edges = np.unique(np.sort(mesh.edges, axis=1), axis=0)
    lens = np.linalg.norm(v[edges[:, 1]] - v[edges[:, 0]], axis=1)
    short_mask = lens < min_edge
    if not np.any(short_mask):
        return mesh

    faces = np.asarray(mesh.faces, dtype=np.int64).tolist()
    n_verts = len(v)
    alive_v = [True] * n_verts
    alive_f = [True] * len(faces)
    v_faces = [set() for _ in range(n_verts)]
    for fi, (a, b, c) in enumerate(faces):
        v_faces[a].add(fi)
        v_faces[b].add(fi)
        v_faces[c].add(fi)

    short = edges[short_mask]
    for idx in np.argsort(lens[short_mask]):
        u, w = int(short[idx, 0]), int(short[idx, 1])
        if not (alive_v[u] and alive_v[w]) or u == w:
            continue
        if float(np.linalg.norm(v[w] - v[u])) >= min_edge:
            continue
        shared_f = list(v_faces[u] & v_faces[w])
        if len(shared_f) != 2:
            continue
        lu = {x for fi in v_faces[u] for x in faces[fi] if x != u}
        lw = {x for fi in v_faces[w] for x in faces[fi] if x != w}
        opp = {x for fi in shared_f for x in faces[fi] if x != u and x != w}
        if len(opp) != 2 or (lu & lw) != opp:
            continue
        check_faces = list((v_faces[u] | v_faces[w]) - set(shared_f))
        if not check_faces:
            continue
        # Precompute external adjacent face normals for each non-shared edge opposite (u/w) to prevent foldbacks.
        old_fn = {}
        ext_normals = []
        for fi in check_faces:
            a, b, c = faces[fi]
            fn = np.cross(v[b] - v[a], v[c] - v[a])
            nlen = float(np.linalg.norm(fn))
            if nlen <= 1e-12:
                old_fn = None
                break
            old_fn[fi] = fn / nlen
            for e0, e1 in ((a, b), (b, c), (c, a)):
                if e0 not in (u, w) and e1 not in (u, w):
                    for nfi in v_faces[e0] & v_faces[e1]:
                        if nfi != fi and nfi not in check_faces and alive_f[nfi]:
                            na, nb, nc = faces[nfi]
                            efn = np.cross(v[nb] - v[na], v[nc] - v[na])
                            elen = float(np.linalg.norm(efn))
                            if elen > 1e-12:
                                ext_normals.append((fi, efn / elen))
        if old_fn is None:
            continue
        chosen = None
        for cand in (0.5 * (v[u] + v[w]), v[u], v[w]):
            ok = True
            new_unit = {}
            for fi in check_faces:
                a, b, c = faces[fi]
                pa = cand if a in (u, w) else v[a]
                pb = cand if b in (u, w) else v[b]
                pc = cand if c in (u, w) else v[c]
                nfn = np.cross(pb - pa, pc - pa)
                nlen = float(np.linalg.norm(nfn))
                if 0.5 * nlen < 1e-7:
                    ok = False
                    break
                ufn = nfn / nlen
                if float(np.dot(old_fn[fi], ufn)) <= 0.25:
                    ok = False
                    break
                new_unit[fi] = ufn
            if ok and ext_normals:
                for fi, efn in ext_normals:
                    if float(np.dot(new_unit[fi], efn)) < -0.35:
                        ok = False
                        break
            if ok and len(check_faces) >= 2:
                # Also ensure no two remaining faces in the merged star fold against each other.
                cf_list = check_faces
                for ii in range(len(cf_list)):
                    fi_a = cf_list[ii]
                    sa = {u if x == w else x for x in faces[fi_a]}
                    for jj in range(ii + 1, len(cf_list)):
                        fi_b = cf_list[jj]
                        sb = {u if x == w else x for x in faces[fi_b]}
                        if len(sa & sb) >= 2 and float(np.dot(new_unit[fi_a], new_unit[fi_b])) < -0.35:
                            ok = False
                            break
                    if not ok:
                        break
            if ok:
                chosen = cand
                break
        if chosen is None:
            continue
        v[u] = chosen
        for fi in shared_f:
            alive_f[fi] = False
            for x in faces[fi]:
                v_faces[x].discard(fi)
        for fi in list(v_faces[w]):
            faces[fi] = [u if x == w else x for x in faces[fi]]
            v_faces[u].add(fi)
        v_faces[w].clear()
        alive_v[w] = False

    kept_f = np.array([faces[i] for i in range(len(faces)) if alive_f[i]], dtype=np.int64)
    out = trimesh.Trimesh(vertices=v, faces=kept_f, process=False)
    out.remove_unreferenced_vertices()
    return out


def _smooth_and_repair_surface(mesh: trimesh.Trimesh, h_surf: float) -> trimesh.Trimesh:
    """Taubin smoothing with normal-flip/foldback guards, short-edge collapse, and local vertex repair."""
    v = mesh.vertices.copy()
    f = np.asarray(mesh.faces, dtype=np.int64)
    adj = np.asarray(mesh.face_adjacency, dtype=np.int64)
    n_verts = len(v)
    if not len(f):
        return mesh

    edges = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]], f[:, [1, 0]], f[:, [2, 1]], f[:, [0, 2]]])
    edges = edges[np.lexsort((edges[:, 1], edges[:, 0]))]
    keep = np.ones(len(edges), dtype=bool)
    keep[1:] = np.any(edges[1:] != edges[:-1], axis=1)
    edges = edges[keep]
    u, w = edges[:, 0], edges[:, 1]
    deg = np.maximum(np.bincount(u, minlength=n_verts).astype(np.float64), 1.0)
    min_target_area = 0.02 * (h_surf ** 2)

    for _ in range(6):
        fn, _ufn, areas, _qual, dots = _tri_geom_metrics(v, f, adj)
        for factor in (0.42, -0.43):
            disp = np.zeros_like(v)
            np.add.at(disp, u, v[w] - v[u])
            cand = v + factor * (disp / deg[:, None])
            n_fn, _nufn, n_areas, _nqual, n_dots = _tri_geom_metrics(cand, f, adj)
            bad_f = (np.sum(n_fn * fn, axis=1) <= 0) | ((n_areas < min_target_area) & (n_areas < areas * 0.98))
            if len(adj):
                worse_fold = (n_dots < -0.35) & (n_dots < dots - 1e-4)
                bad_f[adj[worse_fold, 0]] = True
                bad_f[adj[worse_fold, 1]] = True
            if np.any(bad_f):
                bad_v = np.unique(f[bad_f].ravel())
                cand[bad_v] = v[bad_v]
                v = cand
                fn, _ufn, areas, _qual, dots = _tri_geom_metrics(v, f, adj)
            else:
                v, fn, areas, dots = cand, n_fn, n_areas, n_dots

    cleaned = _collapse_short_edges(trimesh.Trimesh(vertices=v, faces=f, process=False), 0.16 * h_surf)
    if cleaned.is_watertight and 0 < len(cleaned.faces) != len(f):
        v = cleaned.vertices.copy()
        f = np.asarray(cleaned.faces, dtype=np.int64)
        adj = np.asarray(cleaned.face_adjacency, dtype=np.int64)
        n_verts = len(v)
        edges = np.vstack([f[:, [0, 1]], f[:, [1, 2]], f[:, [2, 0]], f[:, [1, 0]], f[:, [2, 1]], f[:, [0, 2]]])
        edges = edges[np.lexsort((edges[:, 1], edges[:, 0]))]
        keep = np.ones(len(edges), dtype=bool)
        keep[1:] = np.any(edges[1:] != edges[:-1], axis=1)
        edges = edges[keep]
        u, w = edges[:, 0], edges[:, 1]

    nbrs = v_faces = v_adjs = None
    for _ in range(12):
        fn, unit_fn, areas, qual, dots = _tri_geom_metrics(v, f, adj)
        bad_f = (qual < 0.16) | (areas < min_target_area)
        if len(adj):
            bad_f[adj[dots < -0.4, 0]] = True
            bad_f[adj[dots < -0.4, 1]] = True
        if not np.any(bad_f):
            break
        if nbrs is None:
            nbrs = [[] for _ in range(n_verts)]
            for a, b in zip(u.tolist(), w.tolist()):
                nbrs[a].append(b)
            v_faces = [[] for _ in range(n_verts)]
            for fi, (a, b, c) in enumerate(f.tolist()):
                v_faces[a].append(fi)
                v_faces[b].append(fi)
                v_faces[c].append(fi)
            v_adjs = [[] for _ in range(n_verts)]
            f_list = f.tolist()
            for ai, (f0, f1) in enumerate(adj.tolist()):
                for vi in set(f_list[f0]) | set(f_list[f1]):
                    v_adjs[vi].append(ai)
        changed = False
        for vi in np.unique(f[bad_f].ravel()):
            if not nbrs[vi]:
                continue
            fis = np.asarray(v_faces[vi], dtype=np.int64)
            ais = np.asarray(v_adjs[vi], dtype=np.int64)
            old_p = v[vi].copy()
            old_q = float(qual[fis].min())
            old_d = float(dots[ais].min()) if len(ais) else 1.0
            old_a = float(areas[fis].min())
            old_score = min(old_q, 0.25) + 0.5 * min(old_d, 0.0) + 0.05 * min(old_a / min_target_area, 1.0)
            avg = v[nbrs[vi]].mean(axis=0)
            best_p = None
            best_score = old_score
            for alpha in (0.5, 0.25, 0.75, 0.15, 0.95):
                v[vi] = old_p + alpha * (avg - old_p)
                tf = f[fis]
                tv0, tv1, tv2 = v[tf[:, 0]], v[tf[:, 1]], v[tf[:, 2]]
                te0, te1, te2 = tv1 - tv0, tv2 - tv1, tv0 - tv2
                tfn = np.cross(te0, -te2)
                if np.any(np.sum(tfn * fn[fis], axis=1) <= 0):
                    continue
                norms = np.linalg.norm(tfn, axis=1)
                ta = 0.5 * norms
                if float(ta.min()) < 1e-7:
                    continue
                tq = (4.0 * math.sqrt(3.0) * ta) / np.maximum(
                    np.sum(te0 * te0, axis=1) + np.sum(te1 * te1, axis=1) + np.sum(te2 * te2, axis=1), 1e-18
                )
                td = 1.0
                if len(ais):
                    unit_fn[fis] = tfn / np.maximum(norms[:, None], 1e-12)
                    td = float(np.sum(unit_fn[adj[ais, 0]] * unit_fn[adj[ais, 1]], axis=1).min())
                score = min(float(tq.min()), 0.25) + 0.5 * min(td, 0.0) + 0.05 * min(float(ta.min()) / min_target_area, 1.0)
                if score > best_score + 1e-4:
                    best_score = score
                    best_p = v[vi].copy()
            if best_p is not None:
                v[vi] = best_p
                changed = True
            else:
                v[vi] = old_p
                unit_fn[fis] = fn[fis] / np.maximum(np.linalg.norm(fn[fis], axis=1)[:, None], 1e-12)
        if not changed:
            break

    return trimesh.Trimesh(vertices=v, faces=f, process=False)


def _remesh_discrete_surface(mesh: trimesh.Trimesh, h_surf: float) -> trimesh.Trimesh:
    vol = build_sdf_volume(mesh, h_surf)
    if float(vol.data.min()) > 0.0 or float(vol.data.max()) < 0.0:
        raise ValueError("表面重划分尺寸过大，实体薄壁结构已丢失；请减小体单元尺寸")
    iso_level = -0.0173 * h_surf if float(vol.data.min()) < -0.08 * h_surf else -1e-4 * h_surf
    verts, faces, _n, _v = marching_cubes(
        vol.data, level=iso_level, spacing=(h_surf, h_surf, h_surf), gradient_direction="ascent",
    )
    verts = verts.astype(np.float64) + vol.origin
    remeshed = trimesh.Trimesh(vertices=verts, faces=faces.astype(np.int64), process=False)
    remeshed.remove_unreferenced_vertices()
    if not remeshed.is_watertight:
        raise ValueError("表面重划分后未保持封闭，请调小体单元尺寸重试")
    remeshed = _smooth_and_repair_surface(remeshed, h_surf)
    if not remeshed.is_watertight:
        raise ValueError("表面重划分平滑后未保持封闭，请调小体单元尺寸重试")
    if not remeshed.is_winding_consistent:
        remeshed.fix_normals(multibody=False)
    if remeshed.volume < 0:
        remeshed.invert()
    return remeshed


def _surface_has_defects(mesh: trimesh.Trimesh) -> bool:
    """Detect hairpin folds or extreme needle slivers that break direct tetrahedralization or COMSOL import."""
    if not len(mesh.faces) or float(mesh.area_faces.min()) < 1e-6:
        return True
    adj = np.asarray(mesh.face_adjacency, dtype=np.int64)
    if len(adj):
        dots = np.sum(mesh.face_normals[adj[:, 0]] * mesh.face_normals[adj[:, 1]], axis=1)
        if float(dots.min()) < -0.75:
            return True
    v = mesh.vertices[mesh.faces]
    e0, e1, e2 = v[:, 1] - v[:, 0], v[:, 2] - v[:, 1], v[:, 0] - v[:, 2]
    l0 = np.linalg.norm(e0, axis=1)
    l1 = np.linalg.norm(e1, axis=1)
    l2 = np.linalg.norm(e2, axis=1)
    cos_max = max(
        float(np.max(np.sum(-e2 * e0, axis=1) / np.maximum(l2 * l0, 1e-12))),
        float(np.max(np.sum(-e0 * e1, axis=1) / np.maximum(l0 * l1, 1e-12))),
        float(np.max(np.sum(-e1 * e2, axis=1) / np.maximum(l1 * l2, 1e-12))),
    )
    return cos_max > math.cos(math.radians(1.5))


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
                    (options.remesh_surface == "auto" and
                     len(outer.faces) <= AUTO_DIRECT_MAX_FACES and
                     not _surface_has_defects(outer) and
                     all(not _surface_has_defects(h) for h in holes)))
    last_exc: Exception | None = None
    if allow_direct:
        for algo_id in (10, 1):
            try:
                cm = _run_gmsh_isolated(gmsh, outer, holes, options, component_index, algo_id)
                if options.remesh_surface == "auto" and "tetra" in cm.qualities and float(np.min(cm.qualities["tetra"])) < 0.03:
                    raise RuntimeError("直接四面体网格存在畸变单元，自动转入表面重划分")
                return [cm], False
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
    msh_path = base.with_name(base.name + ".msh")
    bdf_path = base.with_name(base.name + ".bdf")
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
