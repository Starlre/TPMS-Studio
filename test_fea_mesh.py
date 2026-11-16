"""Tests for FEA tetrahedral volume meshing, quality metrics, and MSH/BDF export."""
from __future__ import annotations

import json

import meshio
import numpy as np
import pytest
import trimesh

from electron_backend import Workbench
from fea_mesh import FEA_PHYSICAL_IDS, FEAMeshOptions, export_fea_volume_mesh
from solid_model import SolidNode, SolidScene
from tpms_core import TPMSParameters
from workflow_engine import WorkflowEngine


def test_fea_options_validation():
    FEAMeshOptions(element_size=1.5, remesh_surface="auto").validate()
    with pytest.raises(ValueError, match="体单元尺寸"):
        FEAMeshOptions(element_size=0.0).validate()
    with pytest.raises(ValueError, match="体单元尺寸"):
        FEAMeshOptions(element_size=1200.0).validate()
    with pytest.raises(ValueError, match="表面处理方式"):
        FEAMeshOptions(remesh_surface="bad").validate()
    with pytest.raises(ValueError, match="重划分表面尺寸"):
        FEAMeshOptions(surface_size=-0.5).validate()
    with pytest.raises(ValueError, match="曲率采样点数"):
        FEAMeshOptions(curvature_points=4).validate()
    with pytest.raises(ValueError, match="低质量阈值"):
        FEAMeshOptions(low_quality_threshold=0.95).validate()


def test_fea_hollow_shell_preserves_void_and_roundtrips_msh_bdf(tmp_path):
    outer = trimesh.creation.box(extents=[24.0, 24.0, 24.0])
    inner = trimesh.creation.box(extents=[18.0, 18.0, 18.0])
    inner.invert()
    hollow = trimesh.util.concatenate([outer, inner])

    res = export_fea_volume_mesh(
        hollow,
        tmp_path / "hollow_box.bdf",
        FEAMeshOptions(element_size=3.0, remesh_surface="direct"),
    )

    assert res.solid_domains == 1
    assert res.remeshed is False
    assert res.tetrahedra > 200
    assert res.volume_elements == res.tetrahedra
    assert res.min_scaled_jacobian > 0.01
    assert res.mesh_volume == pytest.approx(24.0**3 - 18.0**3, rel=0.01)

    for artifact in (res.msh_path, res.bdf_path, res.metadata_path, res.quality_path):
        assert artifact.is_file() and artifact.stat().st_size > 0

    msh = meshio.read(res.msh_path)
    cells_by_type = {block.type: block.data for block in msh.cells}
    assert "triangle" in cells_by_type and "tetra" in cells_by_type
    assert len(cells_by_type["tetra"]) == res.tetrahedra
    assert msh.field_data["surface"][0] == FEA_PHYSICAL_IDS["surface"]
    assert msh.field_data["solid"][0] == FEA_PHYSICAL_IDS["solid"]
    phys = msh.cell_data["gmsh:physical"]
    assert set(np.unique(phys[0])) == {FEA_PHYSICAL_IDS["surface"]}
    assert set(np.unique(phys[1])) == {FEA_PHYSICAL_IDS["solid"]}

    bdf = meshio.read(res.bdf_path, file_format="nastran")
    bdf_tets = sum(len(block.data) for block in bdf.cells if block.type == "tetra")
    assert bdf_tets == res.tetrahedra

    vtu = meshio.read(res.quality_path)
    assert len(vtu.cell_data["scaled_jacobian"][0]) == res.tetrahedra

    meta = json.loads(res.metadata_path.read_text(encoding="utf-8"))
    assert meta["solid_domains"] == 1
    assert meta["physical_ids"] == FEA_PHYSICAL_IDS
    assert meta["tetrahedra"] == res.tetrahedra
    assert meta["mesh_volume_mm3"] == pytest.approx(res.mesh_volume, rel=1e-6)


def test_fea_multi_domain_disjoint_solids(tmp_path):
    left = trimesh.creation.box(extents=[12.0, 12.0, 12.0])
    left.apply_translation([-20.0, 0.0, 0.0])
    right = trimesh.creation.box(extents=[10.0, 14.0, 12.0])
    right.apply_translation([20.0, 0.0, 0.0])
    combined = trimesh.util.concatenate([left, right])

    res = export_fea_volume_mesh(
        combined,
        tmp_path / "two_domains",
        FEAMeshOptions(element_size=3.0, remesh_surface="direct"),
    )

    assert res.solid_domains == 2
    assert res.mesh_volume == pytest.approx(left.volume + right.volume, rel=0.02)
    assert res.min_scaled_jacobian > 0.1


def test_fea_non_watertight_rejected(tmp_path):
    box = trimesh.creation.box(extents=[10.0, 10.0, 10.0])
    open_mesh = trimesh.Trimesh(vertices=box.vertices, faces=box.faces[:-2], process=False)
    with pytest.raises(ValueError, match="封闭水密实体"):
        export_fea_volume_mesh(open_mesh, tmp_path / "bad.msh", FEAMeshOptions(element_size=2.0))


def test_fea_composite_tpms_infill_remesh_and_low_quality_preview(tmp_path):
    scene = SolidScene(
        nodes=[
            SolidNode(id="n1", name="Outer Box", kind="box", dimensions=(24.0, 24.0, 16.0)),
            SolidNode(
                id="n2",
                name="Gyroid Infill",
                kind="tpms_infill",
                dimensions=(12.0, 0.0, 0.0),
                inputs=("n1",),
                tpms=TPMSParameters(surface="Gyroid", mode="solid", iso_level=-0.05),
            ),
        ],
        root="n2",
        cell_size=0.7,
    )
    engine = WorkflowEngine()
    try:
        solid_result, _ = engine.generate(scene)
    finally:
        engine.close()

    res = export_fea_volume_mesh(
        solid_result.mesh,
        tmp_path / "tpms_infill_fea.bdf",
        FEAMeshOptions(element_size=1.4, remesh_surface="auto", low_quality_threshold=0.9),
    )

    assert res.solid_domains >= 1
    assert res.remeshed is True
    assert res.tetrahedra > 500
    assert res.min_scaled_jacobian > 0.0
    assert res.mesh_volume > 1000.0
    assert res.low_quality_vertices.ndim == 2 and res.low_quality_vertices.shape[1] == 3
    assert len(res.low_quality_faces) > 0


def test_electron_backend_fea_dispatch_and_validation(tmp_path):
    worker = Workbench(tmp_path)
    try:
        with pytest.raises(ValueError, match="请先生成模型"):
            worker.dispatch("fea_quality", {})

        valid_project = {
            "type": "tpms-electron",
            "version": 1,
            "mode": "nodes",
            "parameters": TPMSParameters().__dict__,
            "cfd": {},
            "fea": {"element_size": 2.0, "remesh_surface": "auto"},
            "scene": {"version": 1, "root": "", "cell_size": 0.4, "parameters": {}, "value_nodes": [], "nodes": []},
        }
        checked = worker.dispatch("validate_project", {"project": valid_project})
        assert checked["project"]["mode"] == "nodes"

        bad_project = {**valid_project, "fea": {"element_size": -2.0}}
        with pytest.raises(ValueError, match="体单元尺寸"):
            worker.dispatch("validate_project", {"project": bad_project})

        worker.dispatch(
            "generate_tpms",
            {
                "parameters": {
                    "surface": "Gyroid",
                    "mode": "solid",
                    "size_x": 16.0,
                    "size_y": 16.0,
                    "size_z": 16.0,
                    "cells_x": 1,
                    "cells_y": 1,
                    "cells_z": 1,
                    "thickness": 2.0,
                    "samples_per_cell": 18,
                    "iso_level": 0.0,
                }
            },
        )
        preview = worker.dispatch("fea_quality", {"options": {"element_size": 1.8, "remesh_surface": "auto"}})
        assert preview["kind"] == "fea"
        assert preview["tetrahedra"] > 100
        assert preview["solid_domains"] >= 1
        assert preview["quality"]["minimum"] > 0.0

        low = worker.dispatch("low_quality", {})
        assert low["geometry"]["faces"] > 0
        assert low["geometry"]["vertices"] > 0
        assert (tmp_path / low["geometry"]["file"]).is_file()

        exported = worker.dispatch(
            "fea",
            {
                "destination": str(tmp_path / "tpms_fea.bdf"),
                "options": {"element_size": 1.8, "remesh_surface": "auto"},
            },
        )
        assert exported["kind"] == "fea"
        for p in exported["paths"]:
            assert (tmp_path / p).is_file() or p
            assert json.loads((tmp_path / "tpms_fea_fea.json").read_text(encoding="utf-8"))["tetrahedra"] == exported["tetrahedra"]
    finally:
        worker.workflow.close()
        worker.layout_workflow.close()
