from pathlib import Path

import numpy as np
import pytest
import trimesh

from tpms_core import (
    TPMS_FORMULAS,
    TPMSParameters,
    export_mesh,
    generate_fluid_domain,
    generate_tpms,
    simplify_mesh_for_preview,
)


def test_sheet_mesh_is_closed_and_has_expected_bounds(tmp_path: Path) -> None:
    parameters = TPMSParameters(
        surface="Gyroid",
        mode="sheet",
        size_x=20,
        size_y=18,
        size_z=16,
        cells_x=1,
        cells_y=1,
        cells_z=1,
        thickness=1.0,
        samples_per_cell=12,
    )
    result = generate_tpms(parameters)

    assert result.mesh.is_watertight
    assert result.triangles > 0
    assert 0 < result.relative_density < 1
    assert result.mesh.bounds[0][0] >= -10.01
    assert result.mesh.bounds[1][0] <= 10.01

    destination = export_mesh(result, tmp_path / "gyroid.stl")
    loaded = trimesh.load_mesh(destination)
    assert destination.exists()
    assert loaded.is_watertight


def test_solid_mesh_is_closed() -> None:
    result = generate_tpms(
        TPMSParameters(
            surface="Diamond",
            mode="solid",
            cells_x=1,
            cells_y=1,
            cells_z=1,
            samples_per_cell=12,
        )
    )
    assert result.mesh.is_watertight
    assert result.volume > 0


@pytest.mark.parametrize("mode", ["sheet", "solid"])
def test_fluid_domain_is_closed_and_complements_material(mode: str) -> None:
    parameters = TPMSParameters(
        mode=mode,
        size_x=16,
        size_y=14,
        size_z=12,
        cells_x=1,
        cells_y=1,
        cells_z=1,
        thickness=1.0,
        samples_per_cell=18,
    )
    material = generate_tpms(parameters)
    fluid = generate_fluid_domain(parameters)

    assert fluid.mesh.is_watertight
    assert fluid.volume > 0
    assert np.allclose(
        fluid.mesh.bounds,
        [[-8.0, -7.0, -6.0], [8.0, 7.0, 6.0]],
        atol=0.05,
    )
    assert abs(fluid.fluid_fraction + material.relative_density - 1.0) < 0.04


@pytest.mark.parametrize("surface", TPMS_FORMULAS)
@pytest.mark.parametrize("mode", ["sheet", "solid"])
def test_all_surface_modes_are_watertight(surface: str, mode: str) -> None:
    result = generate_tpms(
        TPMSParameters(
            surface=surface,
            mode=mode,
            cells_x=1,
            cells_y=1,
            cells_z=1,
            samples_per_cell=10,
        )
    )
    assert result.mesh.is_watertight


def test_preview_simplification_preserves_export_mesh() -> None:
    result = generate_tpms(TPMSParameters())
    original_faces = result.mesh.faces.copy()
    preview = simplify_mesh_for_preview(result.mesh, target_faces=2_500)

    assert result.mesh.body_count == 1
    assert result.removed_components == 2
    assert result.removed_faces == 64
    assert 100 < preview.triangles <= 2_500
    assert preview.vertices.shape[1] == 3
    assert preview.faces.shape[1] == 3
    assert np.array_equal(result.mesh.faces, original_faces)


@pytest.mark.parametrize("mode", ["sheet", "solid"])
def test_target_porosity_solver(mode: str) -> None:
    target = 0.80
    result = generate_tpms(
        TPMSParameters(
            mode=mode,
            target_porosity=target,
            samples_per_cell=32,
        )
    )

    assert abs(result.porosity - target) < 0.02
    assert result.parameters.target_porosity == target
    if mode == "sheet":
        assert result.parameters.thickness != 1.2
    else:
        assert result.parameters.iso_level != 0.0
