from dataclasses import replace
import math

import numpy as np
import pytest
import trimesh

from libfive_backend import backend_status
from solid_model import SolidNode, SolidScene, demo_scene, generate_solid

native = pytest.mark.skipif(not backend_status()[0], reason="libfive native library unavailable")


@native
@pytest.mark.parametrize("kind,dimensions,expected", [
    ("sphere", (5,), 4 / 3 * math.pi * 125),
    ("box", (8, 10, 12), 960),
    ("cylinder", (4, 10), 160 * math.pi),
    ("torus", (7, 2), 2 * math.pi ** 2 * 7 * 4),
])
def test_primitive_closed_mesh_and_volume(kind, dimensions, expected):
    scene = SolidScene(cell_size=0.3)
    scene.add(kind, dimensions=dimensions)
    result = generate_solid(scene)
    assert result.mesh.is_watertight
    assert result.mesh.is_winding_consistent
    assert abs(result.mesh.volume / expected - 1) < 0.025


@native
def test_transform_box_and_cylinder_orientation():
    scene = SolidScene(cell_size=0.4)
    scene.add("box", dimensions=(4, 8, 12), position=(30, -10, 5), rotation=(0, 0, 90))
    mesh = generate_solid(scene).mesh
    assert np.allclose(mesh.bounds, [[26, -12, -1], [34, -8, 11]], atol=0.02)
    assert abs(mesh.volume - 384) < 1
    scene = SolidScene(cell_size=0.3)
    scene.add("cylinder", dimensions=(2, 12), rotation=(0, 90, 0))
    mesh = generate_solid(scene).mesh
    assert np.allclose(mesh.extents, [12, 4, 4], atol=0.03)


@native
@pytest.mark.parametrize("operation,expected", [("union", 1500), ("intersection", 500), ("difference", 500)])
def test_boolean_boxes(operation, expected):
    scene = SolidScene(cell_size=0.4)
    a = scene.add("box", dimensions=(10, 10, 10), position=(-2.5, 0, 0))
    b = scene.add("box", dimensions=(10, 10, 10), position=(2.5, 0, 0))
    scene.add(operation, inputs=(a.id, b.id))
    result = generate_solid(scene)
    assert result.mesh.is_watertight
    assert abs(result.mesh.volume - expected) < 2


@native
def test_smooth_union_and_shared_inputs():
    smooth = demo_scene("smooth")
    hard = SolidScene.from_dict(smooth.to_dict())
    hard.nodes[-1] = replace(hard.nodes[-1], kind="union")
    a = generate_solid(smooth).mesh
    b = generate_solid(hard).mesh
    assert a.is_watertight
    assert a.volume > b.volume
    assert np.all(a.bounds >= smooth.bounds()[0] - 0.1)
    assert np.all(a.bounds <= smooth.bounds()[1] + 0.1)


@native
def test_tpms_fill_channel_and_export_roundtrip(tmp_path):
    scene = demo_scene()
    result = generate_solid(scene)
    assert result.mesh.is_watertight
    radius = np.linalg.norm(result.mesh.vertices[:, :2], axis=1)
    assert radius.min() >= 3 - 0.05
    assert radius.max() <= 10 + 0.1
    assert result.mesh.volume > 0
    path = tmp_path / "cylinder-tpms.stl"
    result.mesh.export(path)
    mesh = trimesh.load(path, force="mesh")
    assert mesh.is_watertight
    assert len(mesh.faces) == len(result.mesh.faces)


def test_scene_roundtrip_and_dependent_delete(tmp_path):
    scene = demo_scene()
    path = tmp_path / "实体建模.json"
    scene.save(path)
    loaded = SolidScene.load(path)
    assert loaded.to_dict() == scene.to_dict()
    with pytest.raises(ValueError, match="引用"):
        loaded.remove(loaded.nodes[0].id)
    loaded.remove(loaded.root)
    loaded.validate()


def test_cycle_dangling_and_smooth_tpms_rejected():
    scene = demo_scene("sphere_hole")
    scene.nodes[-1] = replace(scene.nodes[-1], inputs=(scene.root, scene.nodes[0].id))
    with pytest.raises(ValueError, match="循环"):
        scene.validate()


@pytest.mark.parametrize("data", [[], {}, {"version": 1, "nodes": "bad"}])
def test_malformed_scene_is_rejected(data):
    with pytest.raises(ValueError):
        SolidScene.from_dict(data)
    scene = demo_scene()
    scene.nodes[-1] = replace(scene.nodes[-1], inputs=("missing", scene.nodes[0].id))
    with pytest.raises(ValueError, match="不存在"):
        scene.validate()
    scene = demo_scene()
    scene.nodes[-1] = replace(scene.nodes[-1], kind="smooth_union")
    with pytest.raises(ValueError, match="距离场"):
        scene.validate()


@native
def test_empty_difference_and_low_resolution_rejected():
    scene = SolidScene(cell_size=0.5)
    a = scene.add("sphere", dimensions=(2,))
    b = scene.add("sphere", dimensions=(5,))
    scene.add("difference", inputs=(a.id, b.id))
    with pytest.raises(ValueError, match="曲面|空网格"):
        generate_solid(scene)
    scene = demo_scene("sphere_hole")
    scene.cell_size = 0.001
    with pytest.raises(ValueError, match="叶节点"):
        generate_solid(scene)


def test_qt_editor_operations_and_serialization(tmp_path, monkeypatch):
    import os
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PyQt5.QtWidgets import QApplication
    from app import MainWindow
    application = QApplication.instance() or QApplication([])
    window = MainWindow()
    window.modeling_mode.setCurrentIndex(1)
    panel = window.solid_panel
    assert window.generate_button.text() == "生成实体"
    assert not window.parameter_tabs.isVisible()
    panel.kind_combo.setCurrentIndex(0)
    panel.add_object()
    panel.position_fields[0].setValue(7)
    assert panel.apply_properties()
    assert panel.scene.nodes[0].position == (7, 0, 0)
    panel.kind_combo.setCurrentIndex(2)
    panel.add_object()
    panel.combine_a.setCurrentIndex(0)
    panel.combine_b.setCurrentIndex(1)
    panel.operation_combo.setCurrentIndex(2)
    panel.combine()
    assert panel.scene.by_id(panel.scene.root).kind == "difference"
    panel.snapshot().save(tmp_path / "ui-model.json")
    panel.scene = SolidScene.load(tmp_path / "ui-model.json")
    panel.refresh()
    assert panel.objects.count() == 3
    # Cycle editor rolls back and leaves a useful inline error.
    panel.input_a.setCurrentIndex(panel.input_a.findData(panel.scene.nodes[0].id))
    panel.input_b.setCurrentIndex(panel.input_b.findData(panel.scene.nodes[0].id))
    assert not panel.apply_properties()
    assert "两个不同" in panel.message.text()
    assert panel.scene.nodes[-1].inputs == ("n1", "n2")
    window.close()
    application.processEvents()


@native
def test_qt_solid_result_fits_translated_mesh_and_restores_tpms():
    import os
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PyQt5.QtWidgets import QApplication
    from app import MainWindow
    from tpms_core import generate_tpms, TPMSParameters, simplify_mesh_for_preview
    application = QApplication.instance() or QApplication([])
    scene = SolidScene(cell_size=0.5)
    scene.add("sphere", dimensions=(4,), position=(100, 20, -30))
    result = generate_solid(scene)
    window = MainWindow()
    window._solid_finished(result)
    assert np.allclose(window.current_preview.vertices.min(axis=0) + window.current_preview.vertices.max(axis=0), 0, atol=0.01)
    assert np.allclose(window.current_result.mesh.bounds.mean(axis=0), [100, 20, -30], atol=0.01)
    window._invalidate_region_preview()
    assert not window.region_action.isEnabled()
    tpms = generate_tpms(TPMSParameters(samples_per_cell=12))
    window._generation_finished(tpms, simplify_mesh_for_preview(tpms.mesh, 100000))
    assert window.current_solid_result is None
    assert window.export_backend_combo.isEnabled()
    assert window.cfd_export_action.isEnabled()
    assert window.region_action.isEnabled()
    window.close()
    application.processEvents()
