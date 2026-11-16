"""Analytic feature operations (shell, offset, mirror, patterns) on implicit fields."""
from itertools import product
import math

import numpy as np

OP_DEFAULTS = {
    'shell': (1.0,),
    'offset': (1.0,),
    'mirror': (),
    'linear_pattern': (3.0, 1.0, 1.0, 16.0, 16.0, 16.0),
    'circular_pattern': (6.0, 360.0),
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


def _exact_source(scene, node, label='抽壳'):
    current, seen = scene.by_id(node.inputs[0]), {node.id}
    while current.kind == 'transform':
        if current.id in seen or len(current.inputs) != 1:
            raise ValueError(f'{label}输入引用无效或存在循环')
        seen.add(current.id)
        current = scene.by_id(current.inputs[0])
    if current.id in seen:
        raise ValueError(f'{label}输入引用存在循环')
    if current.kind not in EXACT_SOURCES:
        if label == '抽壳':
            raise ValueError('抽壳目前支持距离函数基本体及其独立变换；请先抽壳，再做布尔或 TPMS 填充。复杂组合、TPMS、圆锥、圆台、椭球体尚不支持等壁厚抽壳')
        raise ValueError(f'{label}目前支持距离函数基本体及其独立变换')
    return current


def shell_source(scene, node):
    return _exact_source(scene, node, '抽壳')


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


def validate_operation(scene, node):
    d, options = node.dimensions, node.operation
    if not isinstance(options, dict) or not all(isinstance(key, str) for key in options):
        raise ValueError('操作设置必须为对象')
    if node.kind == 'shell':
        _check_finite_numbers(d, 1, node.name)
        direction, openings = _shell_config(options)
        source = shell_source(scene, node)
        wall = float(d[0])
        if wall <= 0 or wall > 200:
            raise ValueError('抽壳壁厚须大于 0 且不超过 200 mm')
        in_pad = wall if direction == 'inward' else 0.0 if direction == 'outward' else wall / 2.0
        limit = _exact_inward_limit(source)
        if in_pad > 0 and in_pad >= limit:
            max_wall = limit if direction == 'inward' else limit * 2
            raise ValueError(f'抽壳壁厚须为正数且小于 {max_wall:g} mm，否则内腔消失')
        if scene.cell_size > wall / 2:
            raise ValueError(f'抽壳网格过粗：网格尺寸须不超过壁厚的一半（{wall / 2:g} mm）')
        src_bounds = scene.bounds(node.inputs[0])
        for axis in range(3):
            letter = 'XYZ'[axis]
            if f'+{letter}' in openings and f'-{letter}' in openings and src_bounds[1, axis] - src_bounds[0, axis] <= 2 * in_pad + 1e-6:
                raise ValueError(f'{letter} 方向两端同时开口时，实体长度须大于双侧内退壁厚（{2 * in_pad:g} mm）')
    elif node.kind == 'offset':
        _check_finite_numbers(d, 1, node.name)
        if options:
            raise ValueError('偏置节点不支持额外设置项')
        source = _exact_source(scene, node, '偏置')
        distance = float(d[0])
        if distance == 0 or abs(distance) > 500:
            raise ValueError('偏置距离不能为 0，且绝对值不超过 500 mm')
        if distance < 0:
            limit = _exact_inward_limit(source)
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
        orig_lo, orig_hi = bounds[0].copy(), bounds[1].copy()
        bounds[0] = orig_lo - out_pad
        bounds[1] = orig_hi + out_pad
        for opening in openings:
            axis = 'XYZ'.index(opening[1])
            if opening[0] == '+':
                bounds[1, axis] = orig_hi[axis] - in_pad
            else:
                bounds[0, axis] = orig_lo[axis] + in_pad
        return bounds
    if node.kind == 'offset':
        distance = float(d[0])
        return np.array([bounds[0] - distance, bounds[1] + distance])
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
            for opening in openings:
                axis = 'XYZ'.index(opening[1])
                plane = coords[axis] - (bounds[1, axis] - in_pad) if opening[0] == '+' else (bounds[0, axis] + in_pad) - coords[axis]
                tree = op('max', tree, plane)
        return tree
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
