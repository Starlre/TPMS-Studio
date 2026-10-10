"""Typed references, real native cache invalidation and preview/export isolation."""
from dataclasses import replace
import copy

import numpy as np
import pytest
import trimesh

from libfive_backend import backend_status
from solid_model import SolidScene
from workflow_values import resolve_values
from workflow_engine import WorkflowEngine

native = pytest.mark.skipif(not backend_status()[0], reason='libfive unavailable')


def blocks():
    return [
        {'id': 'p1', 'name': '半径', 'symbol': 'radius', 'kind': 'number', 'value': 4},
        {'id': 'p2', 'name': '直径', 'symbol': 'diameter', 'kind': 'formula', 'expression': 'radius * 2'},
        {'id': 'p3', 'name': '位移', 'symbol': 'offset', 'kind': 'vector', 'components': ['diameter + 12', 0, 'radius']},
    ]


def test_typed_value_dependencies_and_legacy_constants():
    raw = blocks()[::-1]
    values, outputs = resolve_values({'wall': 1.2}, raw)
    assert values['diameter'] == 8 and values['offset_x'] == 20
    assert outputs['p3']['value'] == [20, 0, 4]
    assert outputs['p3']['type'] == 'vector' and outputs['p2']['type'] == 'number'
    raw[-1]['value'] = 6
    assert resolve_values({}, raw)[1]['p3']['value'] == [24, 0, 6]


@pytest.mark.parametrize('mutation', [
    lambda b: b[0].update(symbol='pi'),
    lambda b: b[0].update(symbol='offset_x'),
    lambda b: b[0].update(value=float('nan')),
    lambda b: b[0].update(value=True),
    lambda b: b[1].update(expression='offset * 2'),
    lambda b: b[1].update(expression='missing + 1'),
    lambda b: b[1].update(expression="__import__('os')"),
    lambda b: b[1].update(expression='diameter + 1'),
    lambda b: b[2].update(components=['offset_x', 0, 0]),
    lambda b: b[2].update(components=[1, 2]),
    lambda b: b[2].update(id='p1'),
    lambda b: b[1].update(expression='1 / 0'),
    lambda b: b[1].update(expression='1+' * 200 + '1'),
])
def test_invalid_or_unsafe_typed_values(mutation):
    raw = blocks(); mutation(raw)
    with pytest.raises(ValueError): resolve_values({}, raw)


def test_vector_binding_roundtrip_bounds_and_type_protection(tmp_path):
    scene = SolidScene(value_nodes=blocks(), cell_size=0.5)
    a = scene.add('sphere', expressions={'dimensions.0': 'radius'})
    t = scene.add('transform', inputs=(a.id,), vector_inputs={'position': 'p3'})
    scene.save(tmp_path / 'typed.json')
    restored = SolidScene.load(tmp_path / 'typed.json')
    assert restored.to_dict() == scene.to_dict()
    assert np.allclose(restored.bounds(), [[16, -4, 0], [24, 4, 8]])
    restored.value_nodes[0]['value'] = 5
    assert scene.value_nodes[0]['value'] == 4
    restored.nodes[-1] = replace(t, vector_inputs={'position': 'p1'})
    with pytest.raises(ValueError, match='向量'): restored.validate()
    restored.nodes[-1] = replace(t, expressions={'position.0': 'radius'})
    with pytest.raises(ValueError, match='同时'): restored.validate()


@native
def test_field_reuse_only_rebuilds_affected_ancestors_and_precision():
    scene = SolidScene(parameters={'radius': 4}, cell_size=0.5)
    a = scene.add('sphere', expressions={'dimensions.0': 'radius'})
    b = scene.add('cylinder', dimensions=(1.5, 12))
    root = scene.add('difference', inputs=(a.id, b.id))
    engine = WorkflowEngine()
    try:
        first, initial = engine.generate(scene)
        assert set(initial['rebuilt']) == {a.id, b.id, root.id}
        assert first.mesh.is_watertight
        _, repeat = engine.generate(scene)
        assert repeat['mesh_cached'] and not repeat['rebuilt']
        scene.parameters['radius'] = 5
        second, changed = engine.generate(scene)
        assert set(changed['rebuilt']) == {a.id, root.id}
        assert changed['reused'] == [b.id]
        assert second.mesh.volume > first.mesh.volume
        scene.nodes[-1] = replace(root, name='重命名输出')
        _, renamed = engine.generate(scene)
        assert renamed['mesh_cached']
        scene.cell_size = 0.4
        _, precision = engine.generate(scene)
        assert set(precision['rebuilt']) == {a.id, b.id, root.id}
        assert not precision['mesh_cached']
        assert first.scene.parameters['radius'] == 4
    finally: engine.close()
    assert engine.arena is None and not engine.meshes


@native
def test_vector_drives_mesh_and_bounded_cache_eviction():
    scene = SolidScene(value_nodes=blocks(), cell_size=0.5)
    a = scene.add('sphere', expressions={'dimensions.0': 'radius'})
    scene.add('transform', inputs=(a.id,), vector_inputs={'position': 'p3'})
    engine = WorkflowEngine(max_meshes=1, max_fields=1)
    try:
        result, _ = engine.generate(scene)
        assert np.allclose(result.mesh.bounds, scene.bounds(), atol=0.08)
        assert result.mesh.is_watertight
        engine.generate(scene, a.id)
        assert len(engine.meshes) == 1
        _, again = engine.generate(scene)
        assert not again['mesh_cached']
    finally: engine.close()
    tiny = WorkflowEngine(max_mesh_bytes=1)
    try:
        tiny.generate(scene)
        assert not tiny.meshes
        assert not tiny.generate(scene)[1]['mesh_cached']
    finally: tiny.close()


@native
def test_intermediate_preview_does_not_replace_final_export(tmp_path):
    from electron_backend import Workbench
    worker = Workbench(tmp_path)
    scene = SolidScene(cell_size=0.5)
    a = scene.add('box', dimensions=(8, 8, 8))
    scene.add('transform', inputs=(a.id,), position=(20, 0, 0))
    payload = {'scene': scene.to_dict()}
    try:
        final = worker.dispatch('generate_solid', payload)
        saved = worker.current
        preview = worker.dispatch('preview_node', {**payload, 'node_id': a.id})
        assert worker.current is saved
        assert preview['stats']['bounds'][0][0] < 0
        assert final['stats']['bounds'][0][0] > 15
        assert worker.dispatch('preview_node', {**payload, 'node_id': a.id})['workflow']['mesh_cached']
        path = tmp_path / 'final.stl'
        worker.dispatch('export', {'quality': 'original', 'destination': str(path)})
        assert np.allclose(trimesh.load(path).bounds, [[16, -4, -4], [24, 4, 4]], atol=0.04)
        with pytest.raises(ValueError): worker.dispatch('preview_node', payload)
        with pytest.raises(ValueError): worker.dispatch('preview_node', {**payload, 'node_id': 'missing'})
        assert worker.current is saved
        parameter_only = {'scene': {'parameters': {}, 'value_nodes': blocks()}}
        assert worker.dispatch('evaluate_values', parameter_only)['values']['p2']['value'] == 8
    finally: worker.workflow.close()
