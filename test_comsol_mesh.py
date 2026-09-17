from pathlib import Path

import meshio

from comsol_mesh import CFDMeshOptions, PHYSICAL_IDS, export_comsol_fluid_mesh
from tpms_core import TPMSParameters


def test_comsol_fluid_export_contains_grouped_tetrahedra(tmp_path: Path) -> None:
    result = export_comsol_fluid_mesh(
        TPMSParameters(
            size_x=10,
            size_y=10,
            size_z=10,
            cells_x=1,
            cells_y=1,
            cells_z=1,
            thickness=1.0,
            samples_per_cell=16,
        ),
        tmp_path / "gyroid_fluid.bdf",
        CFDMeshOptions(
            flow_axis="X",
            element_size=2.0,
            surface_samples_per_cell=16,
        ),
    )

    assert result.msh_path.exists()
    assert result.bdf_path.exists()
    assert result.metadata_path.exists()
    assert result.nodes > 0
    assert result.tetrahedra > 0
    assert 0 < result.min_scaled_jacobian <= 1
    assert result.boundary_triangles["inlet"] > 0
    assert result.boundary_triangles["outlet"] > 0

    msh = meshio.read(result.msh_path)
    assert len(msh.cells_dict["tetra"]) == result.tetrahedra
    assert msh.field_data["inlet"].tolist() == [PHYSICAL_IDS["inlet"], 2]
    assert msh.field_data["fluid"].tolist() == [PHYSICAL_IDS["fluid"], 3]
    assert set(msh.cell_data_dict["gmsh:physical"]["triangle"]) == {
        PHYSICAL_IDS["inlet"],
        PHYSICAL_IDS["outlet"],
        PHYSICAL_IDS["walls"],
    }
    assert set(msh.cell_data_dict["gmsh:physical"]["tetra"]) == {
        PHYSICAL_IDS["fluid"]
    }

    bdf = meshio.read(result.bdf_path)
    assert len(bdf.cells_dict["tetra"]) == result.tetrahedra
    assert set(bdf.cell_data_dict["nastran:ref"]["tetra"]) == {
        PHYSICAL_IDS["fluid"]
    }
