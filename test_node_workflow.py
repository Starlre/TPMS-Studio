"""Numerical and project-level checks for linked parametric workflows."""
from dataclasses import replace
import math

import numpy as np
import pytest

from libfive_backend import backend_status
from parametric import evaluate_expression, validate_parameters
from solid_model import SolidScene, generate_solid, demo_scene
from tpms_core import TPMSParameters

native = pytest.mark.skipif(not backend_status()[0], reason="libfive native library unavailable")


def test_shared_parameter_resolves_all_consumers_and_preserves_editable_project(tmp_path):
    scene = SolidScene(parameters={"radius": 4, "height": 12}, cell_size=0.4)
    a = scene.add("sphere", expressions={"dimensions.0": "radius * 2"})
    b = scene.add("cylinder", dimensions=(4, 20), expressions={"dimensions.0": "radius", "dimensions.1": "height + 8"})
    scene.add("difference", inputs=(a.id, b.id))
    scene.save(tmp_path / "workflow.json")
    loaded = SolidScene.load(tmp_path / "workflow.json")
    assert loaded.to_dict() == scene.to_dict()
    assert loaded.resolved().nodes[0].dimensions == (8,)
    assert loaded.resolved().nodes[1].dimensions == (4, 20)
    loaded.parameters["radius"] = 3
    assert loaded.resolved().nodes[0].dimensions == (6,)
    assert loaded.resolved().nodes[1].dimensions == (3, 20)
    assert loaded.nodes[0].expressions["dimensions.0"] == "radius * 2"
    assert scene.nodes[0].dimensions == (8,)


@pytest.mark.parametrize("expression", [
    "__import__('os').system('whoami')", "radius.real", "radius[0]", "lambda: 1", "1 / 0",
    "10 ** 999999", "sqrt(-1)", "True", "1e999", "missing + 1", "max(1)",
    "[1, 2]", "abs(value=1)", "1+" , "1+" * 80 + "1",
])
def test_invalid_parameter_expressions_are_rejected(expression):
    with pytest.raises(ValueError):
        evaluate_expression(expression, {"radius": 3})


def test_arithmetic_and_invalid_parameter_values():
    assert evaluate_expression("max(radius * 2, sqrt(9)) + abs(-2) + pi", {"radius": 4}) == pytest.approx(10 + math.pi)
    for values in ({"bad-name": 2}, {"pi": 3}, {"radius": float('nan')}, {"radius": True}, {"radius": "3"}):
        with pytest.raises(ValueError):
            validate_parameters(values)


def test_tpms_parameter_bindings_and_integer_protection():
    scene = SolidScene(parameters={"wall": 1.2, "periods": 2})
    scene.add("tpms", tpms=TPMSParameters(), expressions={"tpms.thickness": "wall * 2", "tpms.cells_x": "periods"})
    scene.validate()
    assert scene.resolved().nodes[0].tpms.thickness == 2.4
    assert type(scene.resolved().nodes[0].tpms.cells_x) is int
    scene.parameters["periods"] = 1.5
    with pytest.raises(ValueError, match="整数"):
        scene.validate()
    scene.parameters["periods"] = 2
    scene.nodes[0] = replace(scene.nodes[0], expressions={"tpms.formula": "wall"})
    with pytest.raises(ValueError, match="目标"):
        scene.validate()


def test_transform_cycle_and_missing_input_are_rejected():
    scene = SolidScene()
    a = scene.add("sphere")
    b = scene.add("transform", inputs=(a.id,))
    scene.validate()
    scene.nodes[1] = replace(b, inputs=(b.id,))
    with pytest.raises(ValueError, match="循环"):
        scene.validate()
    scene.nodes[1] = replace(b, inputs=())
    with pytest.raises(ValueError, match="上游"):
        scene.validate()
    scene.nodes[1] = replace(b, inputs=("missing",))
    with pytest.raises(ValueError, match="不存在"):
        scene.validate()
    scene.nodes[1] = replace(b, inputs=(a.id,), expressions={"dimensions.2": "4"})
    with pytest.raises(ValueError, match="节点"):
        scene.validate()


@native
def test_linked_transform_propagates_to_real_mesh():
    scene = SolidScene(cell_size=0.35, parameters={"width": 4, "offset": 20})
    a = scene.add("box", dimensions=(4, 8, 12), expressions={"dimensions.0": "width"})
    scene.add("transform", inputs=(a.id,), rotation=(0, 0, 90), expressions={"position.0": "offset"})
    first = generate_solid(scene)
    assert first.mesh.is_watertight
    assert np.allclose(first.mesh.bounds, [[16, -2, -6], [24, 2, 6]], atol=0.03)
    assert first.mesh.volume == pytest.approx(384, abs=2)
    scene.parameters.update(width=6, offset=30)
    second = generate_solid(scene)
    assert second.mesh.is_watertight
    assert np.allclose(second.mesh.bounds, [[26, -3, -6], [34, 3, 6]], atol=0.03)
    assert second.mesh.volume == pytest.approx(576, abs=2)
    assert first.scene.parameters["offset"] == 20
    assert second.scene.nodes[1].expressions["position.0"] == "offset"


def test_legacy_project_without_expressions_still_loads():
    data = demo_scene('sphere_hole').to_dict()
    data.pop('parameters')
    for node in data['nodes']:
        node.pop('expressions')
    loaded = SolidScene.from_dict(data)
    assert loaded.parameters == {}
    assert loaded.nodes[-1].kind == 'difference'


def test_shared_subgraphs_do_not_expand_bounds_exponentially():
    scene = SolidScene()
    a = scene.add('box', dimensions=(4, 8, 12))
    b = scene.add('sphere', dimensions=(3,))
    for _ in range(28):
        a, b = scene.add('union', inputs=(a.id, b.id)), scene.add('transform', inputs=(a.id,))
    scene.validate()
    assert np.allclose(scene.bounds(), [[-3, -4, -6], [3, 4, 6]])


def test_electron_accepts_nodes_project_and_rejects_invalid_binding(tmp_path):
    from electron_backend import Workbench
    scene = demo_scene('sphere_hole')
    scene.parameters = {'radius': 9}
    scene.nodes[0] = replace(scene.nodes[0], expressions={'dimensions.0': 'radius'})
    project = {'type': 'tpms-electron', 'version': 1, 'mode': 'nodes',
               'parameters': {}, 'scene': scene.to_dict(), 'cfd': {}}
    worker = Workbench(tmp_path)
    assert worker.dispatch('validate_project', {'project': project})['project']['mode'] == 'nodes'
    project['scene']['nodes'][0]['expressions']['dimensions.0'] = 'missing'
    with pytest.raises(ValueError, match='未定义'):
        worker.dispatch('validate_project', {'project': project})
