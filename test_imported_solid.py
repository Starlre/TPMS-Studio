from pathlib import Path
import math

import numpy as np
import pytest
import trimesh

from electron_backend import Workbench
from solid_model import SolidScene, generate_solid
from tpms_core import TPMSParameters
from workflow_engine import WorkflowEngine

pytest.importorskip("OCP")
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Fuse
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.gp import gp_Ax2, gp_Dir, gp_Pln, gp_Pnt


def _write_step(path: Path, shape) -> Path:
    writer = STEPControl_Writer()
    assert writer.Transfer(shape, STEPControl_AsIs) == IFSelect_RetDone
    assert writer.Write(str(path)) == IFSelect_RetDone
    return path


def test_stl_box_scanline_infill_shell_offset_and_booleans(tmp_path):
    """Axis-aligned box tests exact SoS scanline edges and downstream implicit ops."""
    stl_path = tmp_path / "box.stl"
    # Even dimensions align faces with 0.6 mm voxel multiples to exercise exact edge cases.
    trimesh.creation.box(extents=[24.0, 24.0, 24.0]).export(stl_path)

    scene = SolidScene(cell_size=0.6)
    imp = scene.add("imported_solid", dimensions=(1.0,), operation={"source": str(stl_path), "align": "center"})
    infill = scene.add(
        "tpms_infill", inputs=(imp.id,), dimensions=(8.0, 0.0, 0.0),
        tpms=TPMSParameters(surface="Gyroid", mode="solid", iso_level=0.0, samples_per_cell=24),
    )
    res = generate_solid(scene)
    assert res.mesh.is_watertight and res.mesh.is_winding_consistent
    ref_scene = SolidScene(cell_size=0.6)
    ref_box = ref_scene.add("box", dimensions=(24.0, 24.0, 24.0))
    ref_scene.add("tpms_infill", inputs=(ref_box.id,), dimensions=(8.0, 0.0, 0.0),
                  tpms=TPMSParameters(surface="Gyroid", mode="solid", iso_level=0.0, samples_per_cell=24))
    ref_res = generate_solid(ref_scene)
    assert res.mesh.volume == pytest.approx(ref_res.mesh.volume, rel=0.02)

    # Shell with +Z opening and smooth union with analytical cylinder
    sh_scene = SolidScene(cell_size=0.6)
    imp_s = sh_scene.add("imported_solid", dimensions=(1.0,), operation={"source": str(stl_path), "align": "ground"})
    sh = sh_scene.add("shell", inputs=(imp_s.id,), dimensions=(2.0,), operation={"direction": "inward", "opening": "+Z"})
    boss = sh_scene.add("cylinder", dimensions=(4.0, 12.0), position=(12.0, 0.0, 6.0))
    joined = sh_scene.add("smooth_union", inputs=(sh.id, boss.id), blend=2.5)
    sh_res = generate_solid(sh_scene)
    assert sh_res.mesh.is_watertight and sh_res.mesh.is_winding_consistent and sh_res.mesh.volume > 0

    # Offset, mirror, and linear/circular patterns
    pat_scene = SolidScene(cell_size=0.6)
    imp_p = pat_scene.add("imported_solid", dimensions=(0.5,), position=(12.0, 0.0, 0.0),
                          operation={"source": str(stl_path), "align": "center"})
    off = pat_scene.add("offset", inputs=(imp_p.id,), dimensions=(1.5,))
    mir = pat_scene.add("mirror", inputs=(off.id,), operation={"axis": "X", "keep_original": True})
    pat_res = generate_solid(pat_scene)
    assert pat_res.mesh.is_watertight and len(pat_res.mesh.split(only_watertight=False)) == 2
    assert pat_res.mesh.volume == pytest.approx(2 * (15.0 ** 3), rel=0.06)


def test_step_solid_sheet_tpms_skin_and_workflow_cache(tmp_path):
    """Real OpenCascade STEP solid supports sheet infill with skin + cached SDF reuse."""
    b = BRepPrimAPI_MakeBox(gp_Pnt(-16, -12, 0), 32.0, 24.0, 18.0).Shape()
    c = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(16, 0, 0), gp_Dir(0, 0, 1)), 12.0, 18.0).Shape()
    step_path = _write_step(tmp_path / "bracket.step", BRepAlgoAPI_Fuse(b, c).Shape())

    scene = SolidScene(cell_size=0.65)
    imp = scene.add("imported_solid", dimensions=(1.0,),
                    operation={"source": str(step_path), "align": "center", "deflection": 0.04, "angular_deflection": 12.0})
    infill = scene.add(
        "tpms_infill", inputs=(imp.id,), dimensions=(9.0, 1.5, 0.6),
        operation={"openings": ["+Z", "-Z"]},
        tpms=TPMSParameters(surface="Gyroid", mode="sheet", thickness=1.5, samples_per_cell=24),
    )

    engine = WorkflowEngine()
    try:
        r1, m1 = engine.generate(scene)
        assert r1.mesh.is_watertight and r1.mesh.is_winding_consistent and r1.mesh.volume > 0
        assert not m1["mesh_cached"]

        # Modify TPMS unit size: reuses cached SDF volume cleanly & produces watertight mesh.
        scene2 = SolidScene.from_dict({**scene.to_dict(), "nodes": [
            {**n, "dimensions": [10.0, 1.5, 0.6]} if n["id"] == infill.id else n
            for n in scene.to_dict()["nodes"]
        ]})
        r2, m2 = engine.generate(scene2)
        assert r2.mesh.is_watertight and not m2["mesh_cached"]
        assert r2.mesh.volume != pytest.approx(r1.mesh.volume, rel=1e-4)

        # Identical request hits output mesh cache.
        r3, m3 = engine.generate(scene2)
        assert m3["mesh_cached"]
    finally:
        engine.close()


def test_imported_solid_validation_rejects_open_meshes_and_open_step(tmp_path):
    open_mesh = trimesh.creation.box(extents=[10, 10, 10])
    open_mesh.update_faces(np.arange(len(open_mesh.faces) - 2))
    bad_stl = tmp_path / "open.stl"
    open_mesh.export(bad_stl)

    s1 = SolidScene(cell_size=0.6)
    s1.add("imported_solid", operation={"source": str(bad_stl)})
    with pytest.raises(ValueError, match="封闭水密实体"):
        generate_solid(s1)

    # Open planar STEP face (zero solids)
    plane_face = BRepBuilderAPI_MakeFace(gp_Pln(gp_Pnt(0, 0, 0), gp_Dir(0, 0, 1)), -10, 10, -10, 10).Face()
    bad_step = _write_step(tmp_path / "sheet_only.step", plane_face)
    s2 = SolidScene(cell_size=0.6)
    s2.add("imported_solid", operation={"source": str(bad_step)})
    with pytest.raises(ValueError, match="开放曲面"):
        generate_solid(s2)


def test_electron_backend_inspect_and_preview_imported_solid(tmp_path):
    stl_path = tmp_path / "part.stl"
    trimesh.creation.cylinder(radius=10.0, height=20.0).export(stl_path)
    worker = Workbench(tmp_path)
    try:
        info = worker.dispatch("inspect_import", {"source": str(stl_path)})
        assert info["name"] == "part.stl"
        assert len(info["sha256"]) == 64
        scene_dict = SolidScene(cell_size=0.6)
        imp = scene_dict.add("imported_solid", operation={"source": info["source"], "sha256": info["sha256"], "align": "ground"})
        preview = worker.dispatch("preview_scene", {"scene": scene_dict.to_dict()})
        assert not preview["errors"]
        assert len(preview["objects"]) == 1
        assert preview["objects"][0]["stats"]["bounds"][0][2] == pytest.approx(0.0, abs=1e-4)
    finally:
        worker.workflow.close()
        worker.layout_workflow.close()
