from pathlib import Path
import json

import meshio
import numpy as np

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
            end_refinement_enabled=False,
            curvature_refinement_enabled=False,
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


def test_boundary_layers_export_prisms_and_quality_data(tmp_path: Path) -> None:
    options = CFDMeshOptions(
        flow_axis="X",
        element_size=1.5,
        surface_samples_per_cell=16,
        boundary_layer_enabled=True,
        boundary_layer_layers=2,
        boundary_layer_first_height=0.02,
        boundary_layer_growth=1.2,
        end_refinement_enabled=True,
        end_refinement_distance=1.0,
        end_refinement_size_factor=0.6,
        curvature_refinement_enabled=True,
        curvature_points=12,
        low_quality_threshold=0.2,
    )
    result = export_comsol_fluid_mesh(
        TPMSParameters(
            size_x=8,
            size_y=8,
            size_z=8,
            cells_x=1,
            cells_y=1,
            cells_z=1,
            thickness=1.0,
            samples_per_cell=16,
        ),
        tmp_path / "gyroid_boundary_layers.bdf",
        options,
    )

    assert options.boundary_layer_heights() == [-0.02, -0.044]
    assert result.prisms > 0
    assert result.tetrahedra > 0
    assert result.volume_elements == result.prisms + result.tetrahedra
    assert result.quality_path.exists()
    assert result.quality.metric == "scaled_jacobian"
    assert 0 < result.quality.minimum <= result.quality.median <= 1
    assert len(result.quality.histogram_counts) == 20
    assert sum(result.quality.histogram_counts) == result.volume_elements
    assert result.low_quality_vertices.shape[1] == 3
    assert result.low_quality_faces.shape[1] == 3

    bdf = meshio.read(result.bdf_path)
    assert len(bdf.cells_dict["wedge"]) == result.prisms
    assert set(bdf.cell_data_dict["nastran:ref"]["wedge"]) == {
        PHYSICAL_IDS["fluid"]
    }
    quality_mesh = meshio.read(result.quality_path)
    assert "scaled_jacobian" in quality_mesh.cell_data_dict
    assert np.min(quality_mesh.cell_data_dict["scaled_jacobian"]["wedge"]) > 0

    metadata = json.loads(result.metadata_path.read_text(encoding="utf-8"))
    assert metadata["boundary_layer_scope"] == "all_fluid_boundaries"
    assert metadata["prisms"] == result.prisms
    assert metadata["mesh_options"]["end_refinement_enabled"] is True
    assert metadata["mesh_options"]["curvature_refinement_enabled"] is True
    assert metadata["quality"]["low_quality_elements"] == result.quality.low_quality_elements
