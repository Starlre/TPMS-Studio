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

def test_invalid_shell_thickness_and_nesting_cost():
    scene = SolidScene()
    body = scene.add('sphere', dimensions=(4,))
    scene.add('shell', inputs=(body.id,), dimensions=(4,))
    with pytest.raises(ValueError, match='内腔消失'):
        scene.validate()
    scene.nodes[-1] = replace(scene.nodes[-1], dimensions=(.2,))
    with pytest.raises(ValueError, match='网格过粗'):
        scene.validate()

    # Excessive fanout (pattern * pattern) is blocked cleanly before evaluation.
    heavy = SolidScene(cell_size=.5)
    c = heavy.add('cone', dimensions=(6.0, 12.0))
    p = heavy.add('linear_pattern', inputs=(c.id,), dimensions=(6, 6, 1, 14, 14, 14))
    p2 = heavy.add('circular_pattern', inputs=(p.id,), dimensions=(2, 180.0))
    heavy.add('shell', inputs=(p2.id,), dimensions=(1.0,))
    with pytest.raises(ValueError, match='扇出'):
        heavy.validate()


@native
def test_p1_normalized_shell_and_offset_on_approximate_and_boolean():
    # Ellipsoid inward shell uses 1st-order Quilez SDF for uniform wall thickness.
    scene = SolidScene(cell_size=.35)
    el = scene.add('ellipsoid', dimensions=(10.0, 6.0, 8.0))
    full_vol = generate_solid(SolidScene(cell_size=.35, nodes=list(scene.nodes), root=el.id)).mesh.volume
    scene.add('shell', inputs=(el.id,), dimensions=(1.5,))
    sh_mesh = generate_solid(scene).mesh
    assert sh_mesh.is_watertight and sh_mesh.volume < full_vol
    expected = 4 / 3 * math.pi * (10 * 6 * 8 - 8.5 * 4.5 * 6.5)
    assert sh_mesh.volume == pytest.approx(expected, rel=.025)

    # Boolean combination (box union cylinder) -> shell & offset
    bscene = SolidScene(cell_size=.35)
    bx = bscene.add('box', dimensions=(12, 12, 12))
    cy = bscene.add('cylinder', dimensions=(4, 20))
    u = bscene.add('union', inputs=(bx.id, cy.id))
    u_vol = generate_solid(SolidScene(cell_size=.35, nodes=list(bscene.nodes), root=u.id)).mesh.volume
    bscene.add('shell', inputs=(u.id,), dimensions=(1.2,))
    u_shell = generate_solid(bscene).mesh
    assert u_shell.is_watertight and 0 < u_shell.volume < u_vol

    off_scene = SolidScene(cell_size=.35)
    cn = off_scene.add('cone', dimensions=(6.0, 14.0))
    off_scene.add('offset', inputs=(cn.id,), dimensions=(1.5,))
    off_mesh = generate_solid(off_scene).mesh
    assert off_mesh.is_watertight and off_mesh.volume > (math.pi * 36 * 14 / 3)

    tscene = SolidScene(cell_size=.3)
    tp = tscene.add('tpms', tpms=TPMSParameters(surface='Gyroid', mode='solid', size_x=16, size_y=16, size_z=16, cells_x=1, cells_y=1, cells_z=1, iso_level=0.0, samples_per_cell=16))
    tscene.add('shell', inputs=(tp.id,), dimensions=(0.8,), operation={'direction': 'inward'})
    tp_shell = generate_solid(tscene).mesh
    assert tp_shell.is_watertight and tp_shell.volume > 0

    toff = SolidScene(cell_size=.35)
    tp2 = toff.add('tpms', tpms=TPMSParameters(surface='Gyroid', mode='sheet', size_x=16, size_y=16, size_z=16, cells_x=1, cells_y=1, cells_z=1, thickness=1.5, samples_per_cell=16))
    toff.add('offset', inputs=(tp2.id,), dimensions=(0.5,))
    tp_off = generate_solid(toff).mesh
    assert tp_off.is_watertight and tp_off.volume > 0

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


@native
def test_p2_smooth_boolean_supports_shell_tpms_and_cones():
    # Hollow box shell + protruding sphere smoothed cleanly
    scene = SolidScene(cell_size=.3)
    body = scene.add('box', dimensions=(12, 12, 12))
    shell = scene.add('shell', inputs=(body.id,), dimensions=(2.0,))
    sphere = scene.add('sphere', dimensions=(4.0,), position=(6, 0, 0))
    scene.add('smooth_union', inputs=(shell.id, sphere.id), blend=1.5)
    mesh = generate_solid(scene).mesh
    assert mesh.is_watertight and mesh.volume > 0

    # Open cylinder shell + Gyroid infill smoothed cleanly
    tscene = SolidScene(cell_size=.35)
    tp = tscene.add('tpms', tpms=TPMSParameters(size_x=18, size_y=18, size_z=18, cells_x=1, cells_y=1, cells_z=1, thickness=1.8, samples_per_cell=20))
    inner = tscene.add('cylinder', dimensions=(7.5, 18.0))
    infill = tscene.add('intersection', inputs=(tp.id, inner.id))
    outer = tscene.add('cylinder', dimensions=(9.0, 18.0))
    tube = tscene.add('shell', inputs=(outer.id,), dimensions=(1.5,), operation={'opening': 'closed', 'openings': ['+Z', '-Z']})
    tscene.add('smooth_union', inputs=(infill.id, tube.id), blend=1.5)
    t_mesh = generate_solid(tscene).mesh
    assert t_mesh.is_watertight and t_mesh.volume > 0

    # Shell minus cylinder with smooth_difference fillet
    dscene = SolidScene(cell_size=.3)
    db = dscene.add('box', dimensions=(12, 12, 12))
    dsh = dscene.add('shell', inputs=(db.id,), dimensions=(1.5,))
    dc = dscene.add('cylinder', dimensions=(2.5, 16.0))
    dscene.add('smooth_difference', inputs=(dsh.id, dc.id), blend=1.5)
    d_mesh = generate_solid(dscene).mesh
    assert d_mesh.is_watertight and d_mesh.volume > 0

    # Fanout guard still protects deeply nested pattern smooth unions
    heavy = SolidScene(cell_size=.5)
    c1 = heavy.add('cone', dimensions=(6, 12))
    p1 = heavy.add('linear_pattern', inputs=(c1.id,), dimensions=(8, 8, 1, 14, 14, 14))
    sp = heavy.add('sphere')
    p2 = heavy.add('circular_pattern', inputs=(sp.id,), dimensions=(2, 180))
    heavy.add('smooth_union', inputs=(p1.id, p2.id))
    with pytest.raises(ValueError, match='扇出'):
        heavy.validate()


@native
def test_shell_outward_symmetric_and_multi_openings():
    scene = SolidScene(cell_size=.3)
    box = scene.add('box', dimensions=(10, 10, 10))
    out_shell = scene.add('shell', inputs=(box.id,), dimensions=(1.0,), operation={'direction': 'outward'})
    mesh = generate_solid(scene).mesh
    # True Euclidean outward offset rounds the 12 edges and 8 corners by r = 1.0 mm.
    expanded = 10**3 + 6 * 10**2 * 1.0 + 3 * math.pi * 10 * 1.0**2 + 4 / 3 * math.pi * 1.0**3
    assert mesh.is_watertight and mesh.volume == pytest.approx(expanded - 10**3, rel=.015)
    assert np.allclose(mesh.bounds, [[-6, -6, -6], [6, 6, 6]], atol=.02)

    sym_scene = SolidScene(cell_size=.3)
    s_box = sym_scene.add('box', dimensions=(10, 10, 10))
    sym_scene.add('shell', inputs=(s_box.id,), dimensions=(2.0,), operation={'direction': 'symmetric'})
    sym_mesh = generate_solid(sym_scene).mesh
    assert sym_mesh.is_watertight and sym_mesh.volume == pytest.approx(expanded - 8**3, rel=.015)

    tube_scene = SolidScene(cell_size=.3)
    t_box = tube_scene.add('box', dimensions=(12, 12, 10))
    tube_scene.add('shell', inputs=(t_box.id,), dimensions=(1.0,), operation={'opening': 'closed', 'openings': ['+Z', '-Z']})
    tube_mesh = generate_solid(tube_scene).mesh
    assert tube_mesh.is_watertight and tube_mesh.volume == pytest.approx((12**2 - 10**2) * 8, rel=.015)
    assert np.allclose(tube_mesh.bounds, [[-6, -6, -4], [6, 6, 4]], atol=.02)


@native
def test_offset_and_smooth_difference_real_geometry():
    scene = SolidScene(cell_size=.3)
    sph = scene.add('sphere', dimensions=(6.0,))
    off = scene.add('offset', inputs=(sph.id,), dimensions=(2.0,))
    mesh = generate_solid(scene).mesh
    assert mesh.is_watertight and mesh.volume == pytest.approx(4 / 3 * math.pi * 8**3, rel=.025)
    assert np.allclose(mesh.bounds, [[-8, -8, -8], [8, 8, 8]], atol=.05)

    scene2 = SolidScene(cell_size=.3)
    sph2 = scene2.add('sphere', dimensions=(6.0,))
    scene2.add('offset', inputs=(sph2.id,), dimensions=(-2.0,))
    mesh2 = generate_solid(scene2).mesh
    assert mesh2.is_watertight and mesh2.volume == pytest.approx(4 / 3 * math.pi * 4**3, rel=.025)

    scene3 = SolidScene(cell_size=.3)
    b = scene3.add('box', dimensions=(16, 16, 10))
    c = scene3.add('cylinder', dimensions=(3, 14))
    scene3.add('difference', inputs=(b.id, c.id))
    sharp = generate_solid(scene3).mesh

    scene4 = SolidScene(cell_size=.3)
    b4 = scene4.add('box', dimensions=(16, 16, 10))
    c4 = scene4.add('cylinder', dimensions=(3, 14))
    scene4.add('smooth_difference', inputs=(b4.id, c4.id), blend=3.0)
    smooth = generate_solid(scene4).mesh
    assert smooth.is_watertight and smooth.volume < sharp.volume


@native
def test_mirror_linear_and_circular_patterns():
    scene = SolidScene(cell_size=.3)
    sph = scene.add('sphere', dimensions=(4.0,), position=(10, 0, 0))
    scene.add('mirror', inputs=(sph.id,), operation={'axis': 'X', 'keep_original': True})
    mir = generate_solid(scene).mesh
    assert mir.is_watertight and mir.volume == pytest.approx(2 * 4 / 3 * math.pi * 64, rel=.025)
    assert np.allclose(mir.bounds, [[-14, -4, -4], [14, 4, 4]], atol=.05)

    l_scene = SolidScene(cell_size=.35)
    lsph = l_scene.add('sphere', dimensions=(3.0,))
    l_scene.add('linear_pattern', inputs=(lsph.id,), dimensions=(3, 2, 1, 12, 10, 10))
    l_mesh = generate_solid(l_scene).mesh
    assert l_mesh.is_watertight and l_mesh.volume == pytest.approx(6 * 4 / 3 * math.pi * 27, rel=.03)
    assert np.allclose(l_mesh.bounds, [[-3, -3, -3], [27, 13, 3]], atol=.05)

    c_scene = SolidScene(cell_size=.35)
    ccyl = c_scene.add('cylinder', dimensions=(2.0, 8.0), position=(10, 0, 0))
    c_scene.add('circular_pattern', inputs=(ccyl.id,), dimensions=(6, 360.0), operation={'axis': 'Z'})
    c_mesh = generate_solid(c_scene).mesh
    assert c_mesh.is_watertight and c_mesh.volume == pytest.approx(6 * math.pi * 4 * 8, rel=.03)


def test_tpms_infill_validation_and_bounds():
    scene = SolidScene(cell_size=.3)
    cyl = scene.add('cylinder', dimensions=(10.0, 20.0), position=(12.0, -6.0, 4.0))
    inf = scene.add('tpms_infill', inputs=(cyl.id,), dimensions=(8.0, 1.2, 0.5),
                    operation={'openings': ['+Z', '-Z']}, tpms=TPMSParameters(thickness=1.2, samples_per_cell=20))
    scene.validate()
    b = scene.bounds()
    assert np.allclose(b, [[2.0, -16.0, -4.8], [22.0, 4.0, 12.8]], atol=1e-6)

    with pytest.raises(ValueError, match='单胞周期尺寸'):
        bad = SolidScene.from_dict(scene.to_dict())
        bad.nodes[-1] = replace(inf, dimensions=(0.0, 1.2, 0.5))
        bad.validate()
    with pytest.raises(ValueError, match='外蒙皮壁厚'):
        bad = SolidScene.from_dict(scene.to_dict())
        bad.nodes[-1] = replace(inf, dimensions=(8.0, 10.0, 0.5))
        bad.validate()
    with pytest.raises(ValueError, match='网格过粗'):
        bad = SolidScene.from_dict(scene.to_dict())
        bad.cell_size = 0.8
        bad.validate()


@native
def test_tpms_infill_watertight_pure_and_sandwich_modes():
    # Pure conformal infill automatically centers on shifted ellipsoid without manual sizing.
    scene = SolidScene(cell_size=.3)
    el = scene.add('ellipsoid', dimensions=(10.0, 7.0, 9.0), position=(10.0, -8.0, 4.0))
    el_vol = generate_solid(SolidScene(cell_size=.3, nodes=list(scene.nodes), root=el.id)).mesh.volume
    scene.add('tpms_infill', inputs=(el.id,), dimensions=(8.0, 0.0, 0.0),
              tpms=TPMSParameters(surface='Gyroid', mode='sheet', thickness=1.4, samples_per_cell=20))
    pure = generate_solid(scene).mesh
    assert pure.is_watertight and 0 < pure.volume < el_vol
    assert np.all(pure.bounds[0] >= np.array([0.0, -15.0, -5.0]) - 0.1)
    assert np.all(pure.bounds[1] <= np.array([20.0, -1.0, 13.0]) + 0.1)

    # Shifted frustum open-skin sandwich infill renders cleanly and watertight.
    s_fr = SolidScene(cell_size=.3)
    fr = s_fr.add('frustum', dimensions=(9.0, 5.0, 16.0), position=(10.0, -8.0, 4.0))
    s_fr.add('tpms_infill', inputs=(fr.id,), dimensions=(8.0, 1.2, 0.5),
             operation={'openings': ['+Z', '-Z']},
             tpms=TPMSParameters(surface='Gyroid', mode='sheet', thickness=1.4, samples_per_cell=20))
    fr_mesh = generate_solid(s_fr).mesh
    assert fr_mesh.is_watertight and fr_mesh.volume > 0
    assert np.allclose(fr_mesh.bounds, [[1.3, -16.7, -2.8], [18.7, 0.7, 10.8]], atol=0.15)

    # Open-ended outer skin + smooth fillet join keeps exterior flush (no outward bulge).
    s2 = SolidScene(cell_size=.3)
    cy = s2.add('cylinder', dimensions=(10.0, 16.0))
    open_shell_only = SolidScene(cell_size=.3, nodes=list(s2.nodes), root=cy.id)
    sh = open_shell_only.add('shell', inputs=(cy.id,), dimensions=(1.2,), operation={'openings': ['+Z', '-Z']})
    shell_vol = generate_solid(open_shell_only).mesh.volume
    s2.add('tpms_infill', inputs=(cy.id,), dimensions=(8.0, 1.2, 0.6),
           operation={'openings': ['+Z', '-Z']},
           tpms=TPMSParameters(surface='Gyroid', mode='sheet', thickness=1.2, samples_per_cell=20))
    sandwich = generate_solid(s2).mesh
    assert sandwich.is_watertight and sandwich.volume > shell_vol
    assert np.allclose(sandwich.bounds, [[-10.0, -10.0, -6.8], [10.0, 10.0, 6.8]], atol=0.1)

    # Porosity calibration mode on tpms_infill calibrates unit cell directly.
    s3 = SolidScene(cell_size=.3)
    bx = s3.add('box', dimensions=(16.0, 16.0, 16.0))
    s3.add('tpms_infill', inputs=(bx.id,), dimensions=(8.0, 0.0, 0.0),
           tpms=TPMSParameters(surface='Primitive', mode='sheet', target_porosity=0.68, samples_per_cell=20))
    por = generate_solid(s3).mesh
    assert por.is_watertight and 0.15 * 16**3 < por.volume < 0.55 * 16**3

    # Default pure infills on cylinder, box, and sphere stay watertight without floating corner debris.
    for kind, dims in (('cylinder', (6.0, 24.0)), ('box', (16.0, 16.0, 16.0)), ('sphere', (8.0,))):
        s_def = SolidScene(cell_size=.3)
        prim = s_def.add(kind, dimensions=dims)
        s_def.add('tpms_infill', inputs=(prim.id,), dimensions=(8.0, 0.0, 0.0),
                  tpms=TPMSParameters(surface='Gyroid', mode='sheet', thickness=1.2, samples_per_cell=64))
        m_def = generate_solid(s_def).mesh
        assert m_def.is_watertight and m_def.is_winding_consistent and m_def.volume > 0
        if kind == 'box':
            assert m_def.body_count == 1


@native
def test_sphere_infill_precision_preserves_geometry_and_has_no_folds(tmp_path):
    # Regression: the reported R=8, Gyroid/8 mm/1.2 mm, 0.15 mm STL had
    # 228 folds >90 degrees and changed volume by 7% relative to standard.
    standard = SolidScene(cell_size=.3)
    sphere = standard.add('sphere', dimensions=(8.0,))
    fill = standard.add('tpms_infill', inputs=(sphere.id,))
    coarse = generate_solid(standard).mesh
    fine = SolidScene.from_dict(standard.to_dict())
    fine.cell_size = .15
    engine = WorkflowEngine()
    try:
        result, _ = engine.generate(fine)
        mesh = result.mesh
        assert mesh.is_watertight and mesh.is_winding_consistent
        assert mesh.body_count == 1 and mesh.euler_number == coarse.euler_number
        assert mesh.volume == pytest.approx(coarse.volume, rel=.005)
        assert np.degrees(mesh.face_adjacency_angles).max() < 90
        assert mesh.edges_unique_length.max() < .45
        assert np.linalg.norm(mesh.vertices, axis=1).max() <= 8.01
        path, *_ = export_mesh_with_quality(MeshResult(mesh, TPMSParameters()),
                                           tmp_path / 'sphere-infill.stl')
        loaded = trimesh.load(path, force='mesh')
        assert loaded.is_watertight and loaded.is_winding_consistent
        assert np.degrees(loaded.face_adjacency_angles).max() < 90
        cached, metadata = engine.generate(fine)
        assert metadata['mesh_cached'] and cached.mesh is mesh
    finally:
        engine.close()


@native
def test_sphere_infill_rejects_watertight_folded_surface(monkeypatch):
    import solid_operations
    # Recreate the old fine-mode crop without storing a 16 MB binary fixture.
    monkeypatch.setattr(solid_operations, 'infill_crop_width', lambda p, unit: .525)
    scene = SolidScene(cell_size=.15)
    sphere = scene.add('sphere', dimensions=(8.0,))
    scene.add('tpms_infill', inputs=(sphere.id,))
    with pytest.raises(ValueError, match='局部曲面折叠'):
        generate_solid(scene)
    engine = WorkflowEngine()
    try:
        with pytest.raises(ValueError, match='局部曲面折叠'):
            engine.generate(scene)
        assert not engine.meshes
    finally:
        engine.close()

    from solid_operations import validate_infill_surface
    from solid_model import SolidNode
    empty_tri = trimesh.Trimesh(vertices=[[0, 0, 0], [1, 0, 0], [0, 1, 0]], faces=[[0, 1, 2]], process=False)
    validate_infill_surface(empty_tri, SolidNode(id='n', name='N', kind='tpms_infill', dimensions=(8.0, 0.0, 0.0)), 0.3)


@native
def test_infill_numpy_and_native_keep_same_geometry_across_precision():
    from sdf_grid import evaluate_sdf_scene
    from solid_model import rotation_matrix
    scene = SolidScene(cell_size=.3)
    sphere = scene.add('sphere', dimensions=(8.0,))
    scene.add('tpms_infill', inputs=(sphere.id,))
    native_mesh = generate_solid(scene).mesh
    volumes = []
    for step in (.3, .15):
        scene.cell_size = step
        mesh = evaluate_sdf_scene(scene, scene.root, step, rotation_matrix)
        assert mesh.is_watertight and mesh.is_winding_consistent
        assert mesh.volume == pytest.approx(native_mesh.volume, rel=.02)
        volumes.append(mesh.volume)
        if step == .15:
            assert np.degrees(mesh.face_adjacency_angles).max() < 90
    assert volumes[0] == pytest.approx(volumes[1], rel=.02)
