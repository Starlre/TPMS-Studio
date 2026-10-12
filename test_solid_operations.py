from dataclasses import replace
import math
import numpy as np
import pytest
import trimesh
from libfive_backend import backend_status
from solid_model import SolidScene, generate_solid
from workflow_engine import WorkflowEngine
from tpms_core import MeshResult, TPMSParameters, export_mesh_with_quality, simplify_mesh_for_export, remove_tiny_components

native = pytest.mark.skipif(not backend_status()[0], reason='libfive unavailable')

@native
@pytest.mark.parametrize('kind,dims,volume', [
    ('box',(20,16,12),20*16*12-18*14*10),
    ('sphere',(8,),4/3*math.pi*(8**3-7**3)),
    ('cylinder',(6,14),math.pi*(6**2*14-5**2*12)),
    ('torus',(8,3),2*math.pi**2*8*(3**2-2**2)),
])
def test_closed_shell_volume_and_export(kind,dims,volume,tmp_path):
    scene = SolidScene(cell_size=.3)
    body = scene.add(kind,dimensions=dims)
    scene.add('shell',inputs=(body.id,))
    mesh = generate_solid(scene).mesh
    assert mesh.is_watertight and mesh.is_winding_consistent
    assert mesh.volume == pytest.approx(volume,rel=.025)
    mesh.export(tmp_path/'shell.stl')
    loaded = trimesh.load(tmp_path/'shell.stl',force='mesh')
    assert loaded.is_watertight and loaded.volume == pytest.approx(mesh.volume,rel=1e-5)
    # Both the original-quality helper and reduced-face path retain voids.
    result = MeshResult(mesh, TPMSParameters())
    export_mesh_with_quality(result,tmp_path/'quality-shell.stl')
    exported = trimesh.load(tmp_path/'quality-shell.stl',force='mesh')
    assert exported.volume == pytest.approx(mesh.volume,rel=1e-5)
    simplified, _, _ = simplify_mesh_for_export(mesh,int(len(mesh.faces)*.7))
    assert simplified.volume < mesh.convex_hull.volume
    assert any(part.volume < 0 for part in simplified.split(only_watertight=False,repair=False))

def test_cleanup_keeps_a_small_cavity_boundary():
    outer = trimesh.creation.box(extents=[20,20,20])
    inner = trimesh.creation.box(extents=[.1,.1,.1]);inner.invert()
    debris = trimesh.creation.box(extents=[.01,.01,.01]);debris.apply_translation([30,0,0])
    mesh = trimesh.util.concatenate([outer,inner,debris])
    cleaned,removed,_ = remove_tiny_components(mesh,relative_face_limit=.4,relative_volume_limit=.01)
    assert removed == 1
    assert cleaned.volume == pytest.approx(8000-.001)
    assert any(part.volume < 0 for part in cleaned.split(only_watertight=False,repair=False))

@native
@pytest.mark.parametrize('opening',['+X','-X','+Y','-Y','+Z','-Z'])
def test_box_open_shell_all_directions(opening):
    scene = SolidScene(cell_size=.4)
    box = scene.add('box',dimensions=(20,16,12),position=(5,3,-2))
    scene.add('shell',inputs=(box.id,),operation={'opening':opening})
    mesh = generate_solid(scene).mesh
    axis = 'XYZ'.index(opening[1])
    # Remove a full outer-face slab, leaving a closed material rim.
    removed = np.prod(np.delete([20,16,12],axis))
    assert mesh.volume == pytest.approx(20*16*12-18*14*10-removed,rel=.015)
    assert mesh.is_watertight
    assert np.allclose(mesh.bounds,scene.bounds(),atol=.02)

@native
def test_shell_parameter_save_cache_and_boolean():
    scene = SolidScene(cell_size=.3,parameters={'wall':1.0})
    body = scene.add('box',dimensions=(20,16,12))
    shell = scene.add('shell',inputs=(body.id,),expressions={'dimensions.0':'wall'},operation={'opening':'+Z'})
    cutter = scene.add('cylinder',dimensions=(2,24))
    cut = scene.add('difference',inputs=(shell.id,cutter.id))
    restored = SolidScene.from_dict(scene.to_dict())
    assert restored.to_dict() == scene.to_dict()
    engine = WorkflowEngine()
    try:
        first, meta = engine.generate(restored)
        again, meta = engine.generate(restored)
        assert meta['mesh_cached']
        restored.parameters['wall'] = 1.5
        changed, meta = engine.generate(restored)
        assert not meta['mesh_cached'] and changed.mesh.volume > first.mesh.volume
        assert body.id in meta['reused'] and cut.id in meta['rebuilt']
    finally:
        engine.close()

def test_invalid_shell_sources_and_thickness():
    for kind in ['cone','frustum','ellipsoid','tpms']:
        scene = SolidScene()
        from tpms_core import TPMSParameters
        body = scene.add(kind,**({'tpms':TPMSParameters()} if kind=='tpms' else {}))
        scene.add('shell',inputs=(body.id,))
        with pytest.raises(ValueError,match='抽壳'):
            scene.validate()
    scene = SolidScene()
    body = scene.add('sphere',dimensions=(4,))
    scene.add('shell',inputs=(body.id,),dimensions=(4,))
    with pytest.raises(ValueError,match='内腔消失'):
        scene.validate()
    scene.nodes[-1] = replace(scene.nodes[-1],dimensions=(.2,))
    with pytest.raises(ValueError,match='网格过粗'):
        scene.validate()

@native
def test_shell_transformed_source():
    scene = SolidScene(cell_size=.3)
    body = scene.add('sphere',dimensions=(6,))
    moved = scene.add('transform',inputs=(body.id,),position=(15,0,0))
    scene.add('shell',inputs=(moved.id,))
    mesh = generate_solid(scene).mesh
    assert np.allclose(mesh.bounds,[[9,-6,-6],[21,6,6]],atol=.04)
    assert mesh.volume == pytest.approx(4/3*math.pi*(216-125),rel=.025)

def test_operation_config_errors_and_cycle():
    scene = SolidScene()
    body = scene.add('box')
    cut = scene.add('shell',inputs=(body.id,),operation={'opening':'unknown'})
    with pytest.raises(ValueError,match='开口'):
        scene.validate()
    scene.nodes[-1] = replace(cut,operation={},inputs=(cut.id,))
    with pytest.raises(ValueError,match='循环'):
        scene.validate()

@native
def test_tpms_difference_and_ordinary_boolean_after_shell():
    scene = SolidScene(cell_size=.4)
    tpms = scene.add('tpms',tpms=TPMSParameters(size_x=12,size_y=12,size_z=12,cells_x=2,cells_y=2,cells_z=2,thickness=1.2,samples_per_cell=24))
    uncut = generate_solid(scene).mesh
    tool = scene.add('cylinder',dimensions=(2,24))
    scene.add('difference',inputs=(tpms.id,tool.id))
    cut = generate_solid(scene).mesh
    assert cut.is_watertight and cut.volume < uncut.volume
    scene = SolidScene(cell_size=.4)
    body = scene.add('box',dimensions=(16,16,16))
    shell = scene.add('shell',inputs=(body.id,))
    strut = scene.add('cylinder',dimensions=(2,18))
    scene.add('union',inputs=(shell.id,strut.id))
    joined = generate_solid(scene).mesh
    assert joined.is_watertight
    assert joined.volume == pytest.approx(16**3-14**3+math.pi*4*16,rel=.015)

@pytest.mark.parametrize('kind', ['extrude', 'extrude_cut'])
def test_removed_operations_rejected_at_creation_validation_and_load(kind):
    scene = SolidScene()
    body = scene.add('box')
    with pytest.raises(ValueError, match='拉伸和切除操作已移除'):
        scene.add(kind)
    scene.nodes[0] = replace(body, kind=kind)
    with pytest.raises(ValueError, match='拉伸和切除操作已移除'):
        scene.validate()
    with pytest.raises(ValueError, match='拉伸和切除操作已移除'):
        SolidScene.from_dict(scene.to_dict())


def test_shell_cannot_participate_in_smooth_union():
    scene = SolidScene()
    body = scene.add('box')
    shell = scene.add('shell', inputs=(body.id,))
    sphere = scene.add('sphere')
    scene.add('smooth_union', inputs=(shell.id, sphere.id))
    with pytest.raises(ValueError, match='抽壳结果'):
        scene.validate()
