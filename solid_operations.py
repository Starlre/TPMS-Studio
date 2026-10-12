"""Analytic inward shells for exact-distance primitives and their transforms."""
import math

OP_DEFAULTS = {'shell': (1.0,)}
EXACT_SOURCES = {'sphere', 'box', 'cube', 'rounded_box', 'cylinder', 'rounded_cylinder', 'capsule', 'torus'}
OPENINGS = {'closed', '+X', '-X', '+Y', '-Y', '+Z', '-Z'}


def shell_source(scene, node):
    current, seen = scene.by_id(node.inputs[0]), {node.id}
    while current.kind == 'transform':
        if current.id in seen or len(current.inputs) != 1:
            raise ValueError('抽壳输入引用无效或存在循环')
        seen.add(current.id)
        current = scene.by_id(current.inputs[0])
    if current.id in seen:
        raise ValueError('抽壳输入引用存在循环')
    if current.kind not in EXACT_SOURCES:
        raise ValueError('抽壳目前支持距离函数基本体及其独立变换；请先抽壳，再做布尔或 TPMS 填充。复杂组合、TPMS、圆锥、圆台、椭球体尚不支持等壁厚抽壳')
    return current


def validate_operation(scene, node):
    d, options = node.dimensions, node.operation
    if not isinstance(options, dict) or not all(isinstance(key, str) for key in options):
        raise ValueError('操作设置必须为对象')
    if len(d) != 1 or not all(isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v) for v in d):
        raise ValueError(f'{node.name} 的操作尺寸格式无效')
    if set(options) - {'opening'} or options.get('opening', 'closed') not in OPENINGS:
        raise ValueError('抽壳开口方向无效')
    source = shell_source(scene, node)
    s = source.dimensions
    limit = (s[0] if source.kind in {'sphere', 'capsule'} else
             s[0] / 2 if source.kind == 'cube' else
             min(s[:3]) / 2 if source.kind in {'box', 'rounded_box'} else
             s[1] if source.kind == 'torus' else min(s[0], s[1] / 2))
    if not 0 < d[0] < limit:
        raise ValueError(f'抽壳壁厚须为正数且小于 {limit:g} mm，否则内腔消失')
    if scene.cell_size > d[0] / 2:
        raise ValueError(f'抽壳网格过粗：网格尺寸须不超过壁厚的一半（{d[0]/2:g} mm）')


def operation_bounds(scene, node, cache, rotation_matrix):
    bounds = scene.bounds(node.inputs[0], cache)
    opening = node.operation.get('opening', 'closed')
    if opening != 'closed':
        axis = 'XYZ'.index(opening[1])
        bounds[1 if opening[0] == '+' else 0, axis] += -node.dimensions[0] if opening[0] == '+' else node.dimensions[0]
    return bounds


def operation_tree(arena, scene, node, source, coords, rotation_matrix):
    # Source must be an analytic Euclidean distance function.
    op, wall = arena.op, node.dimensions[0]
    tree = op('max', source, -source - wall)
    opening = node.operation.get('opening', 'closed')
    if opening != 'closed':
        axis = 'XYZ'.index(opening[1])
        bounds = scene.bounds(node.inputs[0])
        plane = coords[axis] - (bounds[1, axis] - wall) if opening[0] == '+' else (bounds[0, axis] + wall) - coords[axis]
        tree = op('max', tree, plane)
    return tree
