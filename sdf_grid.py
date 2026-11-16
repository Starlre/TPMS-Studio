"""Hybrid Numba narrow-band mesh-to-SDF & chunked implicit field evaluator.

Evaluates solid workflows containing one or more external CAD/mesh solids
(`imported_solid`) alongside any analytical primitives, TPMS fields, booleans,
shell/offset, transforms, mirrors, and patterns, matching the sign convention
`f <= 0` inside material and returning closed watertight surfaces.
"""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import replace
from itertools import product
import math
from typing import Callable

import numpy as np
from numba import njit
from scipy.ndimage import distance_transform_edt, map_coordinates
from skimage.measure import marching_cubes
import trimesh

from mesh_source import canonical_imported_mesh
from solid_operations import (
    OP_DEFAULTS,
    _circular_angles,
    _infill_openings,
    _infill_tpms_parameters,
    _linear_axis_offsets,
    _shell_config,
)
from tpms_core import (
    CUSTOM_SURFACE,
    TPMSParameters,
    TPMS_FORMULAS,
    _FORMULA_ALIASES,
    _evaluate_formula_node,
    _material_scalar_field,
    _parse_formula,
    remove_tiny_components,
)


MAX_SDF_VOXELS = 24_000_000
_LOCAL_SDF_MAX = 16


@njit(cache=True)
def _pt_tri_dist2(px: float, py: float, pz: float,
                  ax: float, ay: float, az: float,
                  bx: float, by: float, bz: float,
                  cx: float, cy: float, cz: float) -> float:
    """Exact squared Euclidean distance from point P to triangle ABC (Ericson)."""
    abx, aby, abz = bx - ax, by - ay, bz - az
    acx, acy, acz = cx - ax, cy - ay, cz - az
    apx, apy, apz = px - ax, py - ay, pz - az
    d1 = abx * apx + aby * apy + abz * apz
    d2 = acx * apx + acy * apy + acz * apz
    if d1 <= 0.0 and d2 <= 0.0:
        return apx * apx + apy * apy + apz * apz
    bpx, bpy, bpz = px - bx, py - by, pz - bz
    d3 = abx * bpx + aby * bpy + abz * bpz
    d4 = acx * bpx + acy * bpy + acz * bpz
    if d3 >= 0.0 and d4 <= d3:
        return bpx * bpx + bpy * bpy + bpz * bpz
    vc = d1 * d4 - d3 * d2
    if vc <= 0.0 and d1 >= 0.0 and d3 <= 0.0:
        v = d1 / (d1 - d3)
        dx, dy, dz = apx - v * abx, apy - v * aby, apz - v * abz
        return dx * dx + dy * dy + dz * dz
    cpx, cpy, cpz = px - cx, py - cy, pz - cz
    d5 = abx * cpx + aby * cpy + abz * cpz
    d6 = acx * cpx + acy * cpy + acz * cpz
    if d6 >= 0.0 and d5 <= d6:
        return cpx * cpx + cpy * cpy + cpz * cpz
    vb = d5 * d2 - d1 * d6
    if vb <= 0.0 and d2 >= 0.0 and d6 <= 0.0:
        w = d2 / (d2 - d6)
        dx, dy, dz = apx - w * acx, apy - w * acy, apz - w * acz
        return dx * dx + dy * dy + dz * dz
    va = d3 * d6 - d5 * d4
    if va <= 0.0 and (d4 - d3) >= 0.0 and (d5 - d6) >= 0.0:
        w = (d4 - d3) / ((d4 - d3) + (d5 - d6))
        dx = bpx - w * (cx - bx)
        dy = bpy - w * (cy - by)
        dz = bpz - w * (cz - bz)
        return dx * dx + dy * dy + dz * dz
    denom = 1.0 / (va + vb + vc)
    v = vb * denom
    w = vc * denom
    dx = apx - abx * v - acx * w
    dy = apy - aby * v - acy * w
    dz = apz - abz * v - acz * w
    return dx * dx + dy * dy + dz * dz


@njit(cache=True)
def _sos_edge_ccw(ax: float, ay: float, bx: float, by: float, px: float, py: float) -> bool:
    """Coordinate-canonical Simulation-of-Simplicity 2D edge predicate at (px+eps, py+eps^2)."""
    swapped = False
    p0x, p0y, p1x, p1y = ax, ay, bx, by
    if ax > bx or (ax == bx and ay > by):
        p0x, p0y, p1x, p1y = bx, by, ax, ay
        swapped = True
    det = (p1x - p0x) * (py - p0y) - (p1y - p0y) * (px - p0x)
    if det > 0.0:
        res = True
    elif det < 0.0:
        res = False
    elif p0y != p1y:
        res = (p0y > p1y)
    elif p1x != p0x:
        res = (p1x > p0x)
    else:
        return False
    return not res if swapped else res


@njit(cache=True)
def _scanline_and_band(verts: np.ndarray, faces: np.ndarray,
                       ox: float, oy: float, oz: float, dx: float,
                       nx: int, ny: int, nz: int, band_mm: float):
    inside = np.zeros((nx, ny, nz), dtype=np.bool_)
    diff = np.zeros((nx, ny, nz + 1), dtype=np.uint8)
    dist2 = np.full((nx, ny, nz), np.float32(1e12), dtype=np.float32)
    band2 = float(band_mm * band_mm)
    for fi in range(faces.shape[0]):
        i0, i1, i2 = faces[fi, 0], faces[fi, 1], faces[fi, 2]
        ax, ay, az = verts[i0, 0], verts[i0, 1], verts[i0, 2]
        bx, by, bz = verts[i1, 0], verts[i1, 1], verts[i1, 2]
        cx, cy, cz = verts[i2, 0], verts[i2, 1], verts[i2, 2]
        minx = min(ax, min(bx, cx))
        maxx = max(ax, max(bx, cx))
        miny = min(ay, min(by, cy))
        maxy = max(ay, max(by, cy))
        minz = min(az, min(bz, cz))
        maxz = max(az, max(bz, cz))

        det = (bx - ax) * (cy - ay) - (cx - ax) * (by - ay)
        if abs(det) > 1e-24:
            ix0 = max(0, int(math.floor((minx - ox) / dx)))
            ix1 = min(nx - 1, int(math.ceil((maxx - ox) / dx)))
            iy0 = max(0, int(math.floor((miny - oy) / dx)))
            iy1 = min(ny - 1, int(math.ceil((maxy - oy) / dx)))
            want = det > 0.0
            inv_det = 1.0 / det
            for ix in range(ix0, ix1 + 1):
                px = ox + ix * dx
                for iy in range(iy0, iy1 + 1):
                    py = oy + iy * dx
                    if _sos_edge_ccw(ax, ay, bx, by, px, py) != want:
                        continue
                    if _sos_edge_ccw(bx, by, cx, cy, px, py) != want:
                        continue
                    if _sos_edge_ccw(cx, cy, ax, ay, px, py) != want:
                        continue
                    u = ((px - ax) * (cy - ay) - (cx - ax) * (py - ay)) * inv_det
                    v = ((bx - ax) * (py - ay) - (px - ax) * (by - ay)) * inv_det
                    zh = az + u * (bz - az) + v * (cz - az)
                    iz = int(math.ceil((zh - oz) / dx))
                    if iz < 0:
                        iz = 0
                    if iz <= nz:
                        diff[ix, iy, iz] ^= 1

        bx0 = max(0, int(math.floor((minx - band_mm - ox) / dx)))
        bx1 = min(nx - 1, int(math.ceil((maxx + band_mm - ox) / dx)))
        by0 = max(0, int(math.floor((miny - band_mm - oy) / dx)))
        by1 = min(ny - 1, int(math.ceil((maxy + band_mm - oy) / dx)))
        bz0 = max(0, int(math.floor((minz - band_mm - oz) / dx)))
        bz1 = min(nz - 1, int(math.ceil((maxz + band_mm - oz) / dx)))
        for ix in range(bx0, bx1 + 1):
            px = ox + ix * dx
            for iy in range(by0, by1 + 1):
                py = oy + iy * dx
                for iz in range(bz0, bz1 + 1):
                    pz = oz + iz * dx
                    d2 = _pt_tri_dist2(px, py, pz, ax, ay, az, bx, by, bz, cx, cy, cz)
                    if d2 <= band2 and d2 < dist2[ix, iy, iz]:
                        dist2[ix, iy, iz] = np.float32(d2)

    for ix in range(nx):
        for iy in range(ny):
            acc = 0
            for iz in range(nz):
                acc ^= diff[ix, iy, iz]
                inside[ix, iy, iz] = (acc != 0)
    return inside, dist2


class SdfVolume:
    """Cached canonical local SDF volume with fast O(1) trilinear + far-field query."""

    def __init__(self, origin: np.ndarray, spacing: float, data: np.ndarray):
        self.origin = origin.astype(np.float64)
        self.spacing = float(spacing)
        self.data = data  # float32 (nx, ny, nz)
        self.lo = self.origin
        self.hi = self.origin + (np.array(data.shape, dtype=np.float64) - 1.0) * self.spacing

    def sample(self, x: np.ndarray, y: np.ndarray, z: np.ndarray) -> np.ndarray:
        shape = x.shape
        ix = (x - self.origin[0]) / self.spacing
        iy = (y - self.origin[1]) / self.spacing
        iz = (z - self.origin[2]) / self.spacing
        nx, ny, nz = self.data.shape
        cx = np.clip(ix, 0.0, nx - 1.0)
        cy = np.clip(iy, 0.0, ny - 1.0)
        cz = np.clip(iz, 0.0, nz - 1.0)
        sampled = map_coordinates(
            self.data,
            np.vstack([cx.ravel(), cy.ravel(), cz.ravel()]),
            order=1,
            mode="nearest",
        ).reshape(shape).astype(np.float32)

        dx_out = np.maximum(0.0, np.maximum(self.lo[0] - x, x - self.hi[0]))
        dy_out = np.maximum(0.0, np.maximum(self.lo[1] - y, y - self.hi[1]))
        dz_out = np.maximum(0.0, np.maximum(self.lo[2] - z, z - self.hi[2]))
        out_dist = np.sqrt(dx_out * dx_out + dy_out * dy_out + dz_out * dz_out, dtype=np.float32)
        return sampled + out_dist


def build_sdf_volume(mesh: trimesh.Trimesh, cell_size: float) -> SdfVolume:
    lo, hi = np.asarray(mesh.bounds, dtype=np.float64)
    margin = max(6.0 * cell_size, 3.0)
    origin = lo - margin
    span = (hi + margin) - origin
    dims = [int(math.ceil(s / cell_size)) + 1 for s in span]
    if dims[0] * dims[1] * dims[2] > MAX_SDF_VOXELS:
        raise ValueError(
            f"外部实体体积网格过大（约 {dims[0] * dims[1] * dims[2] // 1_000_000}M 体素，上限 24M），"
            "请调大输出网格尺寸"
        )
    verts = np.ascontiguousarray(mesh.vertices, dtype=np.float64)
    faces = np.ascontiguousarray(mesh.faces, dtype=np.int32)
    band = max(2.5 * cell_size, 1.0)
    inside, dist2 = _scanline_and_band(verts, faces, origin[0], origin[1], origin[2],
                                        cell_size, dims[0], dims[1], dims[2], band)
    edt_out = distance_transform_edt(~inside) * cell_size
    edt_in = distance_transform_edt(inside) * cell_size
    sdf = np.where(inside, -edt_in, edt_out).astype(np.float32)
    mask = dist2 < np.float32(1e11)
    exact = np.sqrt(dist2[mask])
    sdf[mask] = np.where(inside[mask], -exact, exact)
    return SdfVolume(origin, cell_size, sdf)


_GLOBAL_SDF_CACHE: OrderedDict[tuple, SdfVolume] = OrderedDict()


def _get_sdf_volume(node, cell_size: float, local_cache: dict,
                    progress: Callable[[str], None] | None = None) -> SdfVolume:
    mesh, _meta, canon_key = canonical_imported_mesh(node, progress)
    vol_key = (*canon_key, round(float(cell_size), 6))
    if vol_key in local_cache:
        return local_cache[vol_key]
    if vol_key in _GLOBAL_SDF_CACHE:
        _GLOBAL_SDF_CACHE.move_to_end(vol_key)
        local_cache[vol_key] = _GLOBAL_SDF_CACHE[vol_key]
        return local_cache[vol_key]
    if progress:
        progress(f"{node.name} · 正在构建隐式距离场…")
    volume = build_sdf_volume(mesh, cell_size)
    _GLOBAL_SDF_CACHE[vol_key] = volume
    while len(_GLOBAL_SDF_CACHE) > _LOCAL_SDF_MAX:
        _GLOBAL_SDF_CACHE.popitem(last=False)
    local_cache[vol_key] = volume
    return volume


def _builtins_np(x: np.ndarray, y: np.ndarray, z: np.ndarray) -> dict[str, np.ndarray]:
    sx, sy, sz = np.sin(x), np.sin(y), np.sin(z)
    cx, cy, cz = np.cos(x), np.cos(y), np.cos(z)
    return {
        "gyroid": sx * cy + sy * cz + sz * cx,
        "diamond": sx * sy * sz + sx * cy * cz + cx * sy * cz + cx * cy * sz,
        "primitive": cx + cy + cz,
        "i_wp": 2.0 * (cx * cy + cy * cz + cz * cx) - (np.cos(2.0 * x) + np.cos(2.0 * y) + np.cos(2.0 * z)),
        "neovius": 3.0 * (cx + cy + cz) + 4.0 * cx * cy * cz,
    }


def _eval_tpms_field(p: TPMSParameters, coords: tuple[np.ndarray, np.ndarray, np.ndarray],
                     center: tuple[float, float, float] = (0.0, 0.0, 0.0),
                     sizes: tuple[float, float, float] | None = None,
                     periods: tuple[float, float, float] | None = None) -> np.ndarray:
    eff_sizes = tuple(float(v) for v in (sizes if sizes is not None else (p.size_x, p.size_y, p.size_z)))
    cells = (p.cells_x, p.cells_y, p.cells_z)

    def raw_field(pt: tuple[np.ndarray, np.ndarray, np.ndarray]) -> np.ndarray:
        if periods is None:
            phases = [2.0 * math.pi * count * ((c - ctr) / sz + 0.5)
                      for c, ctr, sz, count in zip(pt, center, eff_sizes, cells)]
        else:
            phases = [2.0 * math.pi * ((c - ctr) / per)
                      for c, ctr, per in zip(pt, center, periods)]
        aliases = _builtins_np(*phases)
        if p.surface == CUSTOM_SURFACE:
            local = [c - ctr for c, ctr in zip(pt, center)]
            ast_node = _parse_formula(p.formula)
            with np.errstate(all="ignore"):
                val = _evaluate_formula_node(ast_node, {
                    "x": local[0], "y": local[1], "z": local[2], "pi": math.pi, **aliases
                })
            return np.broadcast_to(np.asarray(val, dtype=np.float32), pt[0].shape)
        key = _FORMULA_ALIASES.get(p.surface.lower().replace("-", "_"), p.surface)
        return aliases[key.lower().replace("-", "_")] if key.lower().replace("-", "_") in aliases else TPMS_FORMULAS[key](*phases).astype(np.float32)

    field = raw_field(coords)
    if p.mode == "solid" and p.surface == CUSTOM_SURFACE:
        return (np.float32(p.iso_level) - field).astype(np.float32)

    eff_periods = (tuple(sz / cnt for sz, cnt in zip(eff_sizes, cells))
                   if periods is None else tuple(float(v) for v in periods))
    grad_sq = np.zeros_like(field, dtype=np.float32)
    for axis, period in enumerate(eff_periods):
        step = float(period / p.samples_per_cell)
        plus, minus = list(coords), list(coords)
        plus[axis] = coords[axis] + np.float32(step)
        minus[axis] = coords[axis] - np.float32(step)
        g = (raw_field(tuple(plus)) - raw_field(tuple(minus))) / np.float32(2.0 * step)
        grad_sq += g * g
    norm = np.maximum(np.sqrt(grad_sq), np.float32(0.05))
    if p.mode == "solid":
        return ((np.float32(p.iso_level) - field) / norm).astype(np.float32)

    if p.gradient_enabled:
        idx = "XYZ".index(p.gradient_axis)
        u = np.clip((coords[idx] - np.float32(center[idx])) / np.float32(eff_sizes[idx]) + np.float32(0.5),
                    np.float32(0.0), np.float32(1.0))
        thickness = np.float32(p.gradient_thickness_start) + np.float32(
            p.gradient_thickness_end - p.gradient_thickness_start) * u
    else:
        thickness = np.float32(p.thickness)
    return (np.abs(field) / norm - np.float32(0.5) * thickness).astype(np.float32)


def _smooth_join_np(a: np.ndarray, b: np.ndarray, width: float, mode: str = "min") -> np.ndarray:
    w = np.float32(width)
    h = np.maximum(w - np.abs(a - b), np.float32(0.0)) / w
    if mode == "min":
        return np.minimum(a, b) - h * h * np.float32(width * 0.25)
    return np.maximum(a, b) + h * h * np.float32(width * 0.25)


def _opening_planes_np(coords, bounds: np.ndarray, openings: list[str], in_pad: float) -> list[np.ndarray]:
    planes = []
    for opening in openings:
        axis = "XYZ".index(opening[1])
        if opening[0] == "+":
            planes.append(coords[axis] - np.float32(bounds[1, axis] - in_pad))
        else:
            planes.append(np.float32(bounds[0, axis] + in_pad) - coords[axis])
    return planes


def _rotate_np(coords, axis_idx: int, angle_deg: float):
    if abs(angle_deg) < 1e-9:
        return coords
    rad = math.radians(angle_deg)
    c, s = np.float32(math.cos(rad)), np.float32(math.sin(rad))
    a, b = (axis_idx + 1) % 3, (axis_idx + 2) % 3
    out = list(coords)
    out[a] = c * coords[a] + s * coords[b]
    out[b] = -s * coords[a] + c * coords[b]
    return tuple(out)


def _pullback(coords: tuple[np.ndarray, np.ndarray, np.ndarray],
              position: tuple[float, float, float],
              rotation: tuple[float, float, float],
              rotation_matrix) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    if not any(position) and not any(rotation):
        return coords
    inv = rotation_matrix(rotation).T
    sx = coords[0] - np.float32(position[0])
    sy = coords[1] - np.float32(position[1])
    sz = coords[2] - np.float32(position[2])
    return (
        np.float32(inv[0, 0]) * sx + np.float32(inv[0, 1]) * sy + np.float32(inv[0, 2]) * sz,
        np.float32(inv[1, 0]) * sx + np.float32(inv[1, 1]) * sy + np.float32(inv[1, 2]) * sz,
        np.float32(inv[2, 0]) * sx + np.float32(inv[2, 1]) * sy + np.float32(inv[2, 2]) * sz,
    )


def evaluate_sdf_scene(
    scene,
    target_id: str,
    cell_size: float,
    rotation_matrix,
    sdf_cache: dict | None = None,
    progress: Callable[[str], None] | None = None,
) -> trimesh.Trimesh:
    """Evaluate a resolved SolidScene whose DAG includes imported_solid node(s)."""
    local_sdf = sdf_cache if sdf_cache is not None else {}
    bounds = scene.bounds(target_id)
    size = bounds[1] - bounds[0]
    if cell_size > float(np.min(size)) / 4.0:
        raise ValueError("网格尺寸过粗，请设置不超过最小外形尺寸的四分之一")
    margin = max(2.5 * cell_size, 0.5)
    origin = bounds[0] - margin
    span = (bounds[1] + margin) - origin
    nx, ny, nz = [int(math.ceil(float(s) / cell_size)) + 1 for s in span]
    total_voxels = nx * ny * nz
    if total_voxels > MAX_SDF_VOXELS:
        raise ValueError(
            f"混合实体网格过细（约 {total_voxels // 1_000_000}M 体素，上限 24M），"
            "请适当调大输出网格尺寸（如快速 0.6 mm）"
        )

    # Pre-resolve bounds & canonical SDF volumes once so per-slice evaluation is pure vectorized math.
    node_bounds: dict[str, np.ndarray] = {}
    resolved_tpms: dict[str, TPMSParameters] = {}
    for node in scene.nodes:
        if node.kind == "imported_solid":
            _get_sdf_volume(node, cell_size, local_sdf, progress)
        if node.kind in {"tpms", "tpms_infill"} and node.tpms is not None:
            p = node.tpms
            if p.target_porosity is not None:
                p = _material_scalar_field(p)[0]
            resolved_tpms[node.id] = p
        if node.kind in {"shell", "tpms_infill"}:
            node_bounds[node.inputs[0]] = scene.bounds(node.inputs[0])

    def eval_node(identifier: str, coords: tuple[np.ndarray, np.ndarray, np.ndarray]) -> np.ndarray:
        node = scene.by_id(identifier)
        c = _pullback(coords, node.position, node.rotation, rotation_matrix)
        x, y, z = c
        d = node.dimensions
        kind = node.kind

        if kind == "imported_solid":
            return _get_sdf_volume(node, cell_size, local_sdf, progress).sample(x, y, z)
        if kind == "sphere":
            return np.sqrt(x * x + y * y + z * z) - np.float32(d[0])
        if kind in {"box", "cube", "rounded_box"}:
            sizes = [d[0]] * 3 if kind == "cube" else d[:3]
            r = np.float32(d[3] if kind == "rounded_box" else 0.0)
            qx = np.abs(x) - np.float32(sizes[0] * 0.5 - float(r))
            qy = np.abs(y) - np.float32(sizes[1] * 0.5 - float(r))
            qz = np.abs(z) - np.float32(sizes[2] * 0.5 - float(r))
            ox, oy, oz = np.maximum(qx, 0.0), np.maximum(qy, 0.0), np.maximum(qz, 0.0)
            return np.sqrt(ox * ox + oy * oy + oz * oz) + np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0.0) - r
        if kind in {"cylinder", "rounded_cylinder"}:
            r = np.float32(d[2] if kind == "rounded_cylinder" else 0.0)
            radial = np.sqrt(x * x + y * y) - np.float32(d[0] - float(r))
            axial = np.abs(z) - np.float32(d[1] * 0.5 - float(r))
            orad, oax = np.maximum(radial, 0.0), np.maximum(axial, 0.0)
            return np.sqrt(orad * orad + oax * oax) + np.minimum(np.maximum(radial, axial), 0.0) - r
        if kind == "capsule":
            axial = np.maximum(np.abs(z) - np.float32(d[1] * 0.5 - d[0]), 0.0)
            return np.sqrt(x * x + y * y + axial * axial) - np.float32(d[0])
        if kind in {"cone", "frustum"}:
            bottom, top, height = (d[0], 0.0, d[1]) if kind == "cone" else d
            slope = (top - bottom) / height
            side = (np.sqrt(x * x + y * y) - np.float32((bottom + top) * 0.5) - np.float32(slope) * z) / np.float32(
                math.sqrt(1.0 + slope * slope))
            cap = np.abs(z) - np.float32(height * 0.5)
            oside, ocap = np.maximum(side, 0.0), np.maximum(cap, 0.0)
            return np.sqrt(oside * oside + ocap * ocap) + np.minimum(np.maximum(side, cap), 0.0)
        if kind == "ellipsoid":
            rx, ry, rz = np.float32(d[0]), np.float32(d[1]), np.float32(d[2])
            k0 = np.sqrt((x / rx) ** 2 + (y / ry) ** 2 + (z / rz) ** 2)
            k1 = np.maximum(np.sqrt((x / (rx * rx)) ** 2 + (y / (ry * ry)) ** 2 + (z / (rz * rz)) ** 2),
                            np.float32(1e-6))
            return (k0 - np.float32(1.0)) * k0 / k1
        if kind == "torus":
            radial = np.sqrt(x * x + y * y) - np.float32(d[0])
            return np.sqrt(radial * radial + z * z) - np.float32(d[1])
        if kind == "tpms":
            p = resolved_tpms[identifier]
            field = _eval_tpms_field(p, c)
            qx = np.abs(x) - np.float32(p.size_x * 0.5)
            qy = np.abs(y) - np.float32(p.size_y * 0.5)
            qz = np.abs(z) - np.float32(p.size_z * 0.5)
            ox, oy, oz = np.maximum(qx, 0.0), np.maximum(qy, 0.0), np.maximum(qz, 0.0)
            box = np.sqrt(ox * ox + oy * oy + oz * oz) + np.minimum(np.maximum(qx, np.maximum(qy, qz)), 0.0)
            return np.maximum(field, box)
        if kind == "transform":
            return eval_node(node.inputs[0], c)
        if kind == "offset":
            return eval_node(node.inputs[0], c) - np.float32(d[0])
        if kind == "shell":
            src = eval_node(node.inputs[0], c)
            wall = np.float32(d[0])
            direction, openings = _shell_config(node.operation)
            if direction == "inward":
                out, in_pad = np.maximum(src, -src - wall), float(wall)
            elif direction == "outward":
                out, in_pad = np.maximum(src - wall, -src), 0.0
            else:
                half = np.float32(float(wall) * 0.5)
                out, in_pad = np.maximum(src - half, -src - half), float(half)
            if openings:
                for plane in _opening_planes_np(c, node_bounds[node.inputs[0]], openings, in_pad):
                    out = np.maximum(out, plane)
            return out
        if kind == "tpms_infill":
            src = eval_node(node.inputs[0], c)
            unit_size, skin, join_blend = float(d[0]), float(d[1]), float(d[2])
            openings = _infill_openings(node.operation)
            src_bounds = node_bounds[node.inputs[0]]
            center = tuple(((src_bounds[0] + src_bounds[1]) * 0.5).tolist())
            extent = tuple(np.maximum(src_bounds[1] - src_bounds[0], 1e-3).tolist())
            eff_p = _infill_tpms_parameters(resolved_tpms[identifier], unit_size)
            tpms_field = _eval_tpms_field(eff_p, c, center=center, sizes=extent,
                                          periods=(unit_size, unit_size, unit_size))
            if skin <= 0.0:
                thin = unit_size
                if eff_p.mode == "sheet":
                    sheet_t = min(eff_p.gradient_thickness_start, eff_p.gradient_thickness_end) if eff_p.gradient_enabled else eff_p.thickness
                    thin = min(thin, sheet_t)
                k_crop = max(1e-3, min(max(cell_size * 3.5, 0.35), thin * 0.9, unit_size * 0.18))
                return _smooth_join_np(tpms_field, src, k_crop, "max")
            planes = _opening_planes_np(c, src_bounds, openings, skin) if openings else []
            capped = src
            for plane in planes:
                capped = np.maximum(capped, plane)
            shell_field = np.maximum(src, -src - np.float32(skin))
            for plane in planes:
                shell_field = np.maximum(shell_field, plane)
            if join_blend <= 0.0:
                return np.minimum(shell_field, np.maximum(tpms_field, capped))
            core_clip = src + np.float32(0.35 * skin)
            for plane in planes:
                core_clip = np.maximum(core_clip, plane)
            joined = _smooth_join_np(shell_field, np.maximum(tpms_field, core_clip), join_blend, "min")
            return np.maximum(joined, capped)
        if kind == "mirror":
            idx = "XYZ".index(node.operation.get("axis", "X"))
            flipped = list(c)
            flipped[idx] = -c[idx]
            mirrored = eval_node(node.inputs[0], tuple(flipped))
            if node.operation.get("keep_original", True):
                return np.minimum(eval_node(node.inputs[0], c), mirrored)
            return mirrored
        if kind == "linear_pattern":
            acc = None
            for ox, oy, oz in product(*_linear_axis_offsets(node)):
                pts = c if (ox == 0.0 and oy == 0.0 and oz == 0.0) else (
                    x - np.float32(ox), y - np.float32(oy), z - np.float32(oz))
                val = eval_node(node.inputs[0], pts)
                acc = val if acc is None else np.minimum(acc, val)
            return acc
        if kind == "circular_pattern":
            idx = "XYZ".index(node.operation.get("axis", "Z"))
            acc = None
            for angle in _circular_angles(int(d[0]), float(d[1])):
                val = eval_node(node.inputs[0], _rotate_np(c, idx, angle))
                acc = val if acc is None else np.minimum(acc, val)
            return acc
        if kind in {"union", "intersection", "difference", "smooth_union", "smooth_difference"}:
            a = eval_node(node.inputs[0], c)
            b = eval_node(node.inputs[1], c)
            if kind == "union":
                return np.minimum(a, b)
            if kind == "intersection":
                return np.maximum(a, b)
            if kind == "difference":
                return np.maximum(a, -b)
            w = np.float32(node.blend)
            if kind == "smooth_difference":
                h = np.maximum(w - np.abs(a + b), np.float32(0.0)) / w
                return np.maximum(a, -b) + h * h * np.float32(node.blend * 0.25)
            h = np.maximum(w - np.abs(a - b), np.float32(0.0)) / w
            return np.minimum(a, b) - h * h * np.float32(node.blend * 0.25)
        raise ValueError(f"不支持的节点类型：{kind}")

    if progress:
        progress(f"{scene.by_id(target_id).name} · 正在求值混合隐式场…")
    xs = (origin[0] + np.arange(nx, dtype=np.float32) * np.float32(cell_size))
    ys = (origin[1] + np.arange(ny, dtype=np.float32) * np.float32(cell_size))
    zs = (origin[2] + np.arange(nz, dtype=np.float32) * np.float32(cell_size))
    field = np.empty((nx, ny, nz), dtype=np.float32)
    chunk_x = max(1, min(nx, 1_000_000 // max(1, ny * nz)))
    for x0 in range(0, nx, chunk_x):
        x1 = min(nx, x0 + chunk_x)
        gx, gy, gz = np.meshgrid(xs[x0:x1], ys, zs, indexing="ij")
        field[x0:x1] = eval_node(target_id, (gx, gy, gz))

    if progress:
        progress(f"{scene.by_id(target_id).name} · 正在提取表面网格…")
    if float(field.min()) > 0.0 or float(field.max()) < 0.0:
        raise ValueError("混合隐式场未穿过零等值面（材料为空或充满整个空间）；请检查导入位置、布尔交集或偏移参数")

    verts, faces, _norms, _vals = marching_cubes(
        field, level=0.0, spacing=(cell_size, cell_size, cell_size), gradient_direction="ascent",
    )
    verts = verts.astype(np.float64) + origin
    faces = faces.astype(np.int64)
    if not len(faces) or not np.all(np.isfinite(verts)):
        raise ValueError("混合隐式场未生成有效三角网格，请调整参数或精度")

    mesh = trimesh.Trimesh(vertices=verts, faces=faces, process=False)
    mesh.remove_unreferenced_vertices()
    if not mesh.is_winding_consistent:
        mesh.fix_normals(multibody=False)
    if mesh.volume < 0:
        mesh.invert()
    mesh, _components, _removed = remove_tiny_components(
        mesh, relative_face_limit=1e-3, relative_volume_limit=5e-4,
    )
    if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
        raise ValueError("生成网格未通过封闭性检查；请减小输出网格尺寸后重试")
    return mesh
