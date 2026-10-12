from dataclasses import asdict
import math
from pathlib import Path

import numpy as np
import pytest
import trimesh

from cad_import import StepImporter, validate_settings
from electron_backend import Workbench
from tpms_core import TPMSParameters

pytest.importorskip("OCP")
from OCP.BRepPrimAPI import BRepPrimAPI_MakeBox, BRepPrimAPI_MakeCylinder
from OCP.BRepAlgoAPI import BRepAlgoAPI_Cut
from OCP.STEPControl import STEPControl_Writer, STEPControl_AsIs
from OCP.IFSelect import IFSelect_RetDone
from OCP.gp import gp_Pnt


def write_step(path, shape):
    writer = STEPControl_Writer()
    assert writer.Transfer(shape, STEPControl_AsIs) == IFSelect_RetDone
    assert writer.Write(str(path)) == IFSelect_RetDone
    return path


@pytest.fixture
def step_file(tmp_path):
    outer = BRepPrimAPI_MakeBox(gp_Pnt(-15, -12, -9), 30, 24, 18).Shape()
    from OCP.gp import gp_Ax2, gp_Dir
    tool = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0, 0, -10), gp_Dir(0, 0, 1)), 3, 20).Shape()
    return write_step(tmp_path/"part.step", BRepAlgoAPI_Cut(outer, tool).Shape())


def test_step_metadata_geometry_transform_and_export(step_file, tmp_path):
    importer = StepImporter()
    result = importer.load({"source": str(step_file)})
    expected = 30*24*18-math.pi*3**2*18
    assert result.mesh.is_watertight and result.mesh.is_winding_consistent
    assert result.metadata["solids"] == 1 and result.metadata["cad_faces"] == 7
    assert result.metadata["cad_volume"] == pytest.approx(expected, rel=1e-8)
    assert result.mesh.volume == pytest.approx(expected, rel=.001)
    assert np.allclose(result.mesh.bounds, [[-15,-12,-9],[15,12,9]], atol=1e-6)
    before = result.mesh.vertices.copy()
    moved = importer.load({**result.settings, "position": [5,2,1], "rotation": [0,0,90]})
    assert np.allclose(moved.mesh.bounds, [[-7,-13,-8],[17,17,10]], atol=1e-6)
    assert np.array_equal(before, result.mesh.vertices)
    moved.mesh.export(tmp_path/"imported.stl")
    reread = trimesh.load(tmp_path/"imported.stl", force="mesh")
    assert reread.is_watertight and reread.volume == pytest.approx(expected, rel=.001)


def test_curved_refinement_units_and_open_surface(tmp_path):
    shape = BRepPrimAPI_MakeCylinder(10, 20).Shape()
    file = write_step(tmp_path/"cylinder.step", shape)
    importer = StepImporter()
    coarse = importer.load({"source": str(file), "deflection": .5, "angular_deflection": 40})
    fine = importer.load({**coarse.settings, "deflection": .01, "angular_deflection": 5})
    assert len(fine.mesh.faces) > len(coarse.mesh.faces)
    assert fine.mesh.volume == pytest.approx(math.pi*100*20, rel=.001)
    # Same STEP coordinates represented in metres must still import as millimetres.
    text = file.read_text()
    assert ".MILLI.,.METRE." in text
    metres = tmp_path/"metres.stp"
    metres.write_text(text.replace(".MILLI.,.METRE.", "$,.METRE."))
    scaled = importer.load({"source":str(metres), "deflection":1})
    assert np.allclose(scaled.mesh.bounds, [[-10000,-10000,0],[10000,10000,20000]], atol=1)
    from OCP.BRepBuilderAPI import BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeFace
    polygon = BRepBuilderAPI_MakePolygon()
    for p in [(0,0,0),(10,0,0),(10,10,0),(0,10,0)]:
        polygon.Add(gp_Pnt(*p))
    polygon.Close()
    file = write_step(tmp_path/"surface.step", BRepBuilderAPI_MakeFace(polygon.Wire()).Face())
    surface = importer.load({"source":str(file)})
    assert surface.metadata["solids"] == 0 and surface.metadata["cad_volume"] is None
    assert not surface.mesh.is_watertight


def test_step_error_preserves_snapshot_and_changed_source_rejected(step_file, tmp_path):
    worker = Workbench(tmp_path)
    loaded = worker.dispatch("import_step", {"cad":{"source":str(step_file)}})
    snapshot = worker.current
    invalid = tmp_path/"bad.step"; invalid.write_text("invalid")
    with pytest.raises(ValueError, match="读取|曲面"):
        worker.dispatch("import_step", {"cad":{"source":str(invalid)}})
    assert worker.current is snapshot
    step_file.write_bytes(step_file.read_bytes()+b"\n")
    with pytest.raises(ValueError, match="已改变"):
        worker.dispatch("import_step", {"cad":loaded["cad"]})
    assert worker.current is snapshot
    with pytest.raises(ValueError, match="CFD"):
        worker.require_tpms()
    exported = worker.dispatch("export", {"destination":str(tmp_path/"mesh.stl")})
    assert exported["watertight"]
    project = {"type":"tpms-electron", "version":1, "mode":"cad",
               "parameters":asdict(TPMSParameters()), "cad":loaded["cad"], "scene":{}, "cfd":{}}
    assert worker.dispatch("validate_project", {"project":project})["project"]["mode"] == "cad"


@pytest.mark.parametrize("patch", [
    {"deflection":0}, {"deflection":float("nan")}, {"angular_deflection":100},
    {"position":[0,0]}, {"rotation":[0,0,float("inf")]}, {"sha256":"bad"}, {"unknown":1},
])
def test_invalid_settings(patch):
    with pytest.raises(ValueError):
        validate_settings({"source":"part.step", **patch})


def test_missing_wrong_extension_and_mesh_budget(step_file, monkeypatch):
    importer = StepImporter()
    with pytest.raises(ValueError, match="不存在"):
        importer.load({"source":"missing.step"})
    with pytest.raises(ValueError, match="仅支持"):
        importer.load({"source":"part.obj"})
    monkeypatch.setattr("cad_import.MAX_TRIANGLES", 1)
    with pytest.raises(ValueError, match="200 万"):
        importer.load({"source":str(step_file)})


def test_multiple_bodies_and_closed_cavity_orientation(tmp_path):
    from OCP.TopoDS import TopoDS_Compound
    from OCP.BRep import BRep_Builder
    outer = BRepPrimAPI_MakeBox(20,20,20).Shape()
    inner = BRepPrimAPI_MakeBox(gp_Pnt(2,2,2),16,16,16).Shape()
    hollow = BRepAlgoAPI_Cut(outer,inner).Shape()
    second = BRepPrimAPI_MakeBox(gp_Pnt(30,0,0),5,5,5).Shape()
    compound, builder = TopoDS_Compound(), BRep_Builder()
    builder.MakeCompound(compound);builder.Add(compound,hollow);builder.Add(compound,second)
    result = StepImporter().load({"source":str(write_step(tmp_path/"assembly.step",compound))})
    assert result.metadata["solids"] == 2
    assert result.mesh.is_watertight and result.mesh.is_winding_consistent
    assert result.mesh.volume == pytest.approx(20**3-16**3+5**3)
    assert any(part.volume < 0 for part in result.mesh.split(only_watertight=False,repair=False))
    assert np.allclose(result.mesh.bounds,[[0,0,0],[35,20,20]])


if __name__ == "__main__":
    import sys
    destination = Path(sys.argv[1])
    from OCP.gp import gp_Ax2, gp_Dir
    outer = BRepPrimAPI_MakeBox(gp_Pnt(-15,-12,-9),30,24,18).Shape()
    hole = BRepPrimAPI_MakeCylinder(gp_Ax2(gp_Pnt(0,0,-10),gp_Dir(0,0,1)),3,20).Shape()
    write_step(destination, BRepAlgoAPI_Cut(outer,hole).Shape())
