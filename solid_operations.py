"""Analytic feature operations (shell, offset, mirror, patterns, tpms_infill) on implicit fields."""
from dataclasses import replace
from itertools import product
import math

import numpy as np

from libfive_backend import tpms_material_tree
from tpms_core import CUSTOM_SURFACE, _material_scalar_field

OP_DEFAULTS = {
    'shell': (1.0,),
    'offset': (1.0,),
    'mirror': (),
    'linear_pattern': (3.0, 1.0, 1.0, 16.0, 16.0, 16.0),
    'circular_pattern': (6.0, 360.0),
    'tpms_infill': (8.0, 0.0, 0.0),
}
EXACT_SOURCES = {'sphere', 'box', 'cube', 'rounded_box', 'cylinder', 'rounded_cylinder', 'capsule', 'torus'}
OPENINGS = {'closed', '+X', '-X', '+Y', '-Y', '+Z', '-Z'}
OPENING_FACES = {'+X', '-X', '+Y', '-Y', '+Z', '-Z'}
SHELL_DIRECTIONS = {'inward', 'outward', 'symmetric'}
AXES = {'X', 'Y', 'Z'}


def _check_finite_numbers(values, expected_len, name):
    if len(values) != expected_len or any(
        isinstance(v, bool) or not isinstance(v, (int, float)) or not math.isfinite(v) for v in values
    ):
        raise ValueError(f'{name} 的操作参数格式无效')


def _shell_config(options):
    if set(options) - {'opening', 'openings', 'direction'}:
        raise ValueError('抽壳开口方向无效')
    direction = options.get('direction', 'inward')
    if direction not in SHELL_DIRECTIONS:
        raise ValueError('抽壳方向必须为 inward、outward 或 symmetric')
    opening = options.get('opening', 'closed')
    if opening not in OPENINGS:
        raise ValueError('抽壳开口方向无效')
    raw_list = options.get('openings')
    if raw_list is not None:
        if not isinstance(raw_list, (list, tuple)) or any(not isinstance(item, str) or item not in OPENING_FACES for item in raw_list):
            raise ValueError('抽壳开口方向无效')
        openings = tuple(dict.fromkeys(raw_list))
        if opening != 'closed' and opening not in openings:
            raise ValueError('抽壳开口方向设置冲突')
    else:
        openings = () if opening == 'closed' else (opening,)
    return direction, openings


def _infill_openings(options):
    if set(options) - {'openings'}:
        raise ValueError('TPMS 填充设置无效')
    raw_list = options.get('openings', ())
    if not isinstance(raw_list, (list, tuple)) or any(not isinstance(item, str) or item not in OPENING_FACES for item in raw_list):
        raise ValueError('TPMS 填充开口方向无效')
    return tuple(dict.fromkeys(raw_list))


def _infill_tpms_parameters(p, unit_size):
    if p.target_porosity is None:
        return p
    unit_p = replace(
        p, size_x=unit_size, size_y=unit_size, size_z=unit_size,
        cells_x=1, cells_y=1, cells_z=1, tubular_enabled=False,
    )
    calibrated = _material_scalar_field(unit_p)[0]
    return replace(
        p, thickness=calibrated.thickness, iso_level=calibrated.iso_level,
        target_porosity=None,
    )


def _exact_primitive(scene, start_id, seen=None):
    visiting = set(seen) if seen else set()
    current = scene.by_id(start_id)
    while current.kind == 'transform' or (current.kind == 'mirror' and not current.operation.get('keep_original', True)):
        if current.id in visiting or len(current.inputs) != 1:
            raise ValueError('输入引用无效或存在循环')
        visiting.add(current.id)
        current = scene.by_id(current.inputs[0])
    if current.id in visiting:
        raise ValueError('输入引用存在循环')
    return current if current.kind in EXACT_SOURCES else None


def is_exact_sdf(scene, node_id):
    return _exact_primitive(scene, node_id) is not None


def shell_source(scene, node):
    return _exact_primitive(scene, node.inputs[0], {node.id})


def _tree_cost(scene, node_id, visiting=None):
    seen = set(visiting) if visiting else set()
    if node_id in seen:
        raise ValueError('输入引用存在循环')
    node = scene.by_id(node_id)
    seen.add(node_id)
    if not node.inputs:
        return 5 if (node.kind == 'tpms' and node.tpms and not node.tpms.surface == 'Custom') else 1
    if node.kind == 'linear_pattern':
        mult = int(node.dimensions[0]) * int(node.dimensions[1]) * int(node.dimensions[2])
        return min(256, mult * _tree_cost(scene, node.inputs[0], seen))
    if node.kind == 'circular_pattern':
        return min(256, int(node.dimensions[0]) * _tree_cost(scene, node.inputs[0], seen))
    if node.kind == 'mirror':
        mult = 2 if node.operation.get('keep_original', True) else 1
        return min(256, mult * _tree_cost(scene, node.inputs[0], seen))
    if node.kind == 'tpms_infill':
        tpms_cost = 5 if (node.tpms and node.tpms.surface != CUSTOM_SURFACE) else 1
        return min(256, _tree_cost(scene, node.inputs[0], seen) + tpms_cost)
    return min(256, sum(_tree_cost(scene, cid, seen) for cid in node.inputs))


def _outward_slope_margin(scene, node_id, out_pad):
    """Extra radial margin for outward-expanded cones/frustums under Euclidean cap join."""
    if out_pad <= 0:
        return 0.0
    max_slope = 0.0
    pending, seen = [node_id], set()
    while pending:
        cid = pending.pop()
        if cid in seen:
            continue
        seen.add(cid)
        n = scene.by_id(cid)
        if n.kind == 'cone':
            max_slope = max(max_slope, abs(n.dimensions[0] / n.dimensions[1]))
        elif n.kind == 'frustum':
            max_slope = max(max_slope, abs((n.dimensions[1] - n.dimensions[0]) / n.dimensions[2]))
        pending.extend(n.inputs)
    if max_slope <= 0:
        return 0.0
    return out_pad * (math.sqrt(1.0 + 2.0 * max_slope ** 2) - 1.0)


def tree_cost(scene, node_id, visiting=None):
    return _tree_cost(scene, node_id, visiting)


def _inward_thickness_limit(scene, node):
    exact = _exact_primitive(scene, node.inputs[0], {node.id})
    if exact is not None:
        return _exact_inward_limit(exact)
    bounds = scene.bounds(node.inputs[0])
    return float(np.min(bounds[1] - bounds[0]) / 2.0)


def _exact_inward_limit(source):
    s = source.dimensions
    return (s[0] if source.kind in {'sphere', 'capsule'} else
            s[0] / 2 if source.kind == 'cube' else
            min(s[:3]) / 2 if source.kind in {'box', 'rounded_box'} else
            s[1] if source.kind == 'torus' else min(s[0], s[1] / 2))


def _linear_axis_offsets(node):
    d = node.dimensions
    centered = bool(node.operation.get('centered', False))
    result = []
    for axis in range(3):
        count, step = int(d[axis]), float(d[axis + 3])
        if centered:
            result.append([(k - (count - 1) / 2.0) * step for k in range(count)])
        else:
            result.append([float(k) * step for k in range(count)])
    return result


def _circular_angles(count, total_angle):
    if count <= 1:
        return [0.0]
    if abs(abs(total_angle) - 360.0) < 1e-6:
        return [total_angle * k / count for k in range(count)]
    return [total_angle * k / (count - 1) for k in range(count)]


def _rotate_coords(coords, axis_idx, angle_deg):
    if abs(angle_deg) < 1e-9:
        return None
    rad = math.radians(angle_deg)
    c, s = math.cos(rad), math.sin(rad)
    a, b = (axis_idx + 1) % 3, (axis_idx + 2) % 3
    out = list(coords)
    out[a] = c * coords[a] + s * coords[b]
    out[b] = -s * coords[a] + c * coords[b]
    return out


def _fold_min(op, trees):
    items = list(trees)
    while len(items) > 1:
        folded = [op('min', items[i], items[i + 1]) for i in range(0, len(items) - 1, 2)]
        if len(items) % 2:
            folded.append(items[-1])
        items = folded
    return items[0]


def _opening_planes(coords, bounds, openings, in_pad):
    planes = []
    for opening in openings:
        axis = 'XYZ'.index(opening[1])
        planes.append(
            coords[axis] - (bounds[1, axis] - in_pad)
            if opening[0] == '+'
            else (bounds[0, axis] + in_pad) - coords[axis]
        )
    return planes


def _apply_opening_bounds(bounds, orig_bounds, openings, in_pad):
    for opening in openings:
        axis = 'XYZ'.index(opening[1])
        if opening[0] == '+':
            bounds[1, axis] = orig_bounds[1, axis] - in_pad
        else:
            bounds[0, axis] = orig_bounds[0, axis] + in_pad
    return bounds


def _check_opposite_openings(src_bounds, openings, in_pad):
    for axis in range(3):
        letter = 'XYZ'[axis]
        if f'+{letter}' in openings and f'-{letter}' in openings and src_bounds[1, axis] - src_bounds[0, axis] <= 2 * in_pad + 1e-6:
            raise ValueError(f'{letter} 方向两端同时开口时，实体长度须大于双侧内退壁厚（{2 * in_pad:g} mm）')


def validate_operation(scene, node):
    d, options = node.dimensions, node.operation
    if not isinstance(options, dict) or not all(isinstance(key, str) for key in options):
        raise ValueError('操作设置必须为对象')
    if node.kind == 'shell':
        _check_finite_numbers(d, 1, node.name)
        direction, openings = _shell_config(options)
        if _tree_cost(scene, node.id) > 64:
            raise ValueError('抽壳嵌套或阵列层级过多（计算扇出超过上限），请简化上游层级')
        wall = float(d[0])
        if wall <= 0 or wall > 200:
            raise ValueError('抽壳壁厚须大于 0 且不超过 200 mm')
        in_pad = wall if direction == 'inward' else 0.0 if direction == 'outward' else wall / 2.0
        limit = _inward_thickness_limit(scene, node)
        if in_pad > 0 and in_pad >= limit:
            max_wall = limit if direction == 'inward' else limit * 2
            raise ValueError(f'抽壳壁厚须为正数且小于 {max_wall:g} mm，否则内腔消失')
        if scene.cell_size > wall / 2:
            raise ValueError(f'抽壳网格过粗：网格尺寸须不超过壁厚的一半（{wall / 2:g} mm）')
        src_bounds = scene.bounds(node.inputs[0])
        _check_opposite_openings(src_bounds, openings, in_pad)
    elif node.kind == 'tpms_infill':
        _check_finite_numbers(d, 3, node.name)
        openings = _infill_openings(options)
        if node.tpms is None:
            raise ValueError('TPMS 填充节点缺少 TPMS 参数')
        node.tpms.validate()
        if node.tpms.tubular_enabled:
            raise ValueError('实体组合暂不支持管状卷绕 TPMS')
        if _tree_cost(scene, node.id) > 64:
            raise ValueError('TPMS 填充嵌套或阵列层级过多（计算扇出超过上限），请简化上游层级')
        unit_size, skin_thickness, join_blend = float(d[0]), float(d[1]), float(d[2])
        if unit_size <= 0 or unit_size > 1000:
            raise ValueError('单胞周期尺寸须大于 0 且不超过 1000 mm')
        if skin_thickness < 0 or skin_thickness > 200:
            raise ValueError('外蒙皮壁厚须在 0–200 mm 之间')
        if join_blend < 0 or join_blend > 50:
            raise ValueError('接壁平滑宽度须在 0–50 mm 之间')
        src_bounds = scene.bounds(node.inputs[0])
        if skin_thickness > 0:
            limit = _inward_thickness_limit(scene, node)
            if skin_thickness >= limit:
                raise ValueError(f'外蒙皮壁厚须小于 {limit:g} mm，否则内腔消失')
            _check_opposite_openings(src_bounds, openings, skin_thickness)
        eff_p = _infill_tpms_parameters(node.tpms, unit_size)
        max_cell = unit_size / 8.0 if eff_p.surface != CUSTOM_SURFACE else float('inf')
        if eff_p.mode == 'sheet':
            thin = min(eff_p.gradient_thickness_start, eff_p.gradient_thickness_end) if eff_p.gradient_enabled else eff_p.thickness
            max_cell = min(max_cell, thin / 2.0)
        if skin_thickness > 0:
            max_cell = min(max_cell, skin_thickness / 2.0)
        if scene.cell_size > max_cell * (1 + 1e-6):
            raise ValueError(f'TPMS 填充网格过粗（当前 {scene.cell_size:g} mm），请将输出网格尺寸设至不超过 {max_cell:g} mm')
    elif node.kind == 'offset':
        _check_finite_numbers(d, 1, node.name)
        if options:
            raise ValueError('偏置节点不支持额外设置项')
        if _tree_cost(scene, node.id) > 64:
            raise ValueError('偏置嵌套或阵列层级过多（计算扇出超过上限），请简化上游层级')
        distance = float(d[0])
        if distance == 0 or abs(distance) > 500:
            raise ValueError('偏置距离不能为 0，且绝对值不超过 500 mm')
        if distance < 0:
            limit = _inward_thickness_limit(scene, node)
            if abs(distance) >= limit:
                raise ValueError(f'向内收缩距离须小于 {limit:g} mm，否则实体消失')
    elif node.kind == 'mirror':
        _check_finite_numbers(d, 0, node.name)
        if set(options) - {'axis', 'keep_original'}:
            raise ValueError('镜像操作设置无效')
        if options.get('axis', 'X') not in AXES:
            raise ValueError('镜像法向轴必须是 X、Y 或 Z')
        if not isinstance(options.get('keep_original', True), bool):
            raise ValueError('保留原实体设置必须为布尔值')
    elif node.kind == 'linear_pattern':
        _check_finite_numbers(d, 6, node.name)
        if set(options) - {'centered'} or not isinstance(options.get('centered', False), bool):
            raise ValueError('线性阵列设置无效')
        total = 1
        for i in range(3):
            if not float(d[i]).is_integer() or not 1 <= int(d[i]) <= 32:
                raise ValueError('线性阵列每轴数量须为 1–32 的整数')
            total *= int(d[i])
            if abs(float(d[i + 3])) > 1000:
                raise ValueError('线性阵列间距绝对值不能超过 1000 mm')
        if total > 64:
            raise ValueError('线性阵列总实例数量不能超过 64 个')
    elif node.kind == 'circular_pattern':
        _check_finite_numbers(d, 2, node.name)
        if set(options) - {'axis'} or options.get('axis', 'Z') not in AXES:
            raise ValueError('圆周阵列旋转轴必须是 X、Y 或 Z')
        if not float(d[0]).is_integer() or not 1 <= int(d[0]) <= 64:
            raise ValueError('圆周阵列数量须为 1–64 的整数')
        if not 0 < abs(float(d[1])) <= 360:
            raise ValueError('圆周阵列总角度须在 (0, 360°] 范围内')


def operation_bounds(scene, node, cache, rotation_matrix):
    bounds = scene.bounds(node.inputs[0], cache)
    d, options = node.dimensions, node.operation
    if node.kind == 'shell':
        wall = float(d[0])
        direction, openings = _shell_config(options)
        out_pad = 0.0 if direction == 'inward' else wall if direction == 'outward' else wall / 2.0
        in_pad = wall if direction == 'inward' else 0.0 if direction == 'outward' else wall / 2.0
        slope_pad = _outward_slope_margin(scene, node.inputs[0], out_pad)
        orig_lo, orig_hi = bounds[0].copy(), bounds[1].copy()
        bounds[0] = orig_lo - (out_pad + slope_pad)
        bounds[1] = orig_hi + (out_pad + slope_pad)
        return _apply_opening_bounds(bounds, np.array([orig_lo, orig_hi]), openings, in_pad)
    if node.kind == 'tpms_infill':
        skin_thickness = float(d[1])
        if skin_thickness > 0:
            return _apply_opening_bounds(bounds.copy(), bounds, _infill_openings(options), skin_thickness)
        return bounds
    if node.kind == 'offset':
        distance = float(d[0])
        pad = distance + (_outward_slope_margin(scene, node.inputs[0], distance) if distance > 0 else 0.0)
        return np.array([bounds[0] - pad, bounds[1] + pad])
    if node.kind == 'mirror':
        idx = 'XYZ'.index(options.get('axis', 'X'))
        keep_original = options.get('keep_original', True)
        m_lo, m_hi = -bounds[1, idx], -bounds[0, idx]
        if keep_original:
            bounds[0, idx] = min(bounds[0, idx], m_lo)
            bounds[1, idx] = max(bounds[1, idx], m_hi)
        else:
            bounds[0, idx], bounds[1, idx] = m_lo, m_hi
        return bounds
    if node.kind == 'linear_pattern':
        axis_offs = _linear_axis_offsets(node)
        for i, offs in enumerate(axis_offs):
            bounds[0, i] += min(offs)
            bounds[1, i] += max(offs)
        return bounds
    if node.kind == 'circular_pattern':
        idx = 'XYZ'.index(options.get('axis', 'Z'))
        angles = _circular_angles(int(d[0]), float(d[1]))
        corners = np.array([[bounds[(m >> k) & 1, k] for k in range(3)] for m in range(8)], dtype=float)
        all_pts = []
        a, b = (idx + 1) % 3, (idx + 2) % 3
        for angle in angles:
            rad = math.radians(angle)
            c, s = math.cos(rad), math.sin(rad)
            rot = corners.copy()
            rot[:, a] = c * corners[:, a] - s * corners[:, b]
            rot[:, b] = s * corners[:, a] + c * corners[:, b]
            all_pts.append(rot)
        merged = np.vstack(all_pts)
        return np.array([merged.min(axis=0), merged.max(axis=0)])
    return bounds


def _smooth_join(op, a, b, width, mode='min'):
    h = op('max', width - op('abs', a - b), 0) / width
    if mode == 'min':
        return op('min', a, b) - h ** 2 * (width / 4)
    return op('max', a, b) + h ** 2 * (width / 4)


def operation_tree(arena, scene, node, source, coords, rotation_matrix):
    op, d, options = arena.op, node.dimensions, node.operation
    if node.kind == 'shell':
        wall = float(d[0])
        direction, openings = _shell_config(options)
        if direction == 'inward':
            tree = op('max', source, -source - wall)
            in_pad = wall
        elif direction == 'outward':
            tree = op('max', source - wall, -source)
            in_pad = 0.0
        else:
            half = wall / 2.0
            tree = op('max', source - half, -source - half)
            in_pad = half
        if openings:
            bounds = scene.bounds(node.inputs[0])
            for plane in _opening_planes(coords, bounds, openings, in_pad):
                tree = op('max', tree, plane)
        return tree
    if node.kind == 'tpms_infill':
        unit_size, skin_thickness, join_blend = float(d[0]), float(d[1]), float(d[2])
        openings = _infill_openings(options)
        src_bounds = scene.bounds(node.inputs[0])
        center = tuple(((src_bounds[0] + src_bounds[1]) * 0.5).tolist())
        extent = tuple(np.maximum(src_bounds[1] - src_bounds[0], 1e-3).tolist())
        eff_p = _infill_tpms_parameters(node.tpms, unit_size)
        tpms_field = tpms_material_tree(
            arena, eff_p, coords, center=center, sizes=extent,
            periods=(unit_size, unit_size, unit_size),
        )
        if skin_thickness <= 0:
            # Micro-fillet intersection relieves grazing Dual Contouring pinch seams cleanly.
            k_crop = max(1e-3, min(0.35, unit_size * 0.05))
            return _smooth_join(op, tpms_field, source, k_crop, 'max')
        cap_planes = _opening_planes(coords, src_bounds, openings, skin_thickness) if openings else []
        capped_source = source
        for plane in cap_planes:
            capped_source = op('max', capped_source, plane)
        shell_tree = op('max', source, -source - skin_thickness)
        for plane in cap_planes:
            shell_tree = op('max', shell_tree, plane)
        if join_blend <= 0:
            core_tree = op('max', tpms_field, capped_source)
            return op('min', shell_tree, core_tree)
        core_clip = source + 0.35 * skin_thickness
        for plane in cap_planes:
            core_clip = op('max', core_clip, plane)
        core_tree = op('max', tpms_field, core_clip)
        joined = _smooth_join(op, shell_tree, core_tree, join_blend, 'min')
        return op('max', joined, capped_source)
    if node.kind == 'offset':
        return source - float(d[0])
    if node.kind == 'mirror':
        idx = 'XYZ'.index(options.get('axis', 'X'))
        flipped = list(coords)
        flipped[idx] = -coords[idx]
        mirrored = source.remap(flipped)
        return op('min', source, mirrored) if options.get('keep_original', True) else mirrored
    if node.kind == 'linear_pattern':
        axis_offs = _linear_axis_offsets(node)
        trees = []
        for ox, oy, oz in product(*axis_offs):
            if ox == 0.0 and oy == 0.0 and oz == 0.0:
                trees.append(source)
            else:
                trees.append(source.remap([coords[0] - ox, coords[1] - oy, coords[2] - oz]))
        return _fold_min(op, trees)
    if node.kind == 'circular_pattern':
        idx = 'XYZ'.index(options.get('axis', 'Z'))
        angles = _circular_angles(int(d[0]), float(d[1]))
        trees = []
        for angle in angles:
            mapped = _rotate_coords(coords, idx, angle)
            trees.append(source if mapped is None else source.remap(mapped))
        return _fold_min(op, trees)
    return source
