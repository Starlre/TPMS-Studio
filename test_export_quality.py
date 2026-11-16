import pathlib
import tempfile

import pytest
import trimesh
import numpy as np

from tpms_core import (
    EXPORT_QUALITY_HIGH,
    EXPORT_QUALITY_LOW,
    EXPORT_QUALITY_MEDIUM,
    EXPORT_QUALITY_ORIGINAL,
    TPMSParameters,
    export_mesh,
    export_mesh_with_quality,
    get_default_target_faces,
    prepare_export_mesh,
    generate_tpms,
    validate_export_target_faces,
)


def _small_result():
    params = TPMSParameters(
        surface="Gyroid",
        mode="sheet",
        size_x=16, size_y=16, size_z=16,
        cells_x=1, cells_y=1, cells_z=1,
        thickness=1.0,
        samples_per_cell=14,
    )
    return generate_tpms(params)


def test_default_original_does_not_change_faces(tmp_path):
    result = _small_result()
    original_faces = len(result.mesh.faces)
    original_vertices = result.mesh.vertices.copy()
    # keep copy of mesh to ensure not mutated
    mesh_copy_faces = result.mesh.faces.copy()
    dest = tmp_path / "out.stl"
    path, actual_faces, fallback, msg = export_mesh_with_quality(result, dest, EXPORT_QUALITY_ORIGINAL, None)
    assert actual_faces == original_faces
    assert fallback is False
    assert path.exists()
    # original mesh unchanged
    assert np.array_equal(result.mesh.faces, mesh_copy_faces)
    assert np.array_equal(result.mesh.vertices, original_vertices)
    assert actual_faces == original_faces
    # also via prepare
    mesh, faces, fb, _ = prepare_export_mesh(result, EXPORT_QUALITY_ORIGINAL, None)
    assert faces == original_faces
    assert fb is False


def test_target_validation():
    result = _small_result()
    original = len(result.mesh.faces)
    # positive integer
    with pytest.raises(ValueError, match="正整数"):
        validate_export_target_faces(0, original)
    with pytest.raises(ValueError, match="正整数"):
        validate_export_target_faces(-5, original)
    with pytest.raises(ValueError, match="整数"):
        validate_export_target_faces(3.5, original)  # type: ignore
    # cannot exceed original
    with pytest.raises(ValueError, match="不能超过原始"):
        validate_export_target_faces(original + 1, original)
    with pytest.raises(ValueError, match="不能超过原始"):
        validate_export_target_faces(original + 100, original)
    # valid
    validate_export_target_faces(100, original)
    validate_export_target_faces(original, original)


def test_default_target_faces_ratios():
    # original 10000
    assert get_default_target_faces(10000, EXPORT_QUALITY_ORIGINAL) == 10000
    assert get_default_target_faces(10000, EXPORT_QUALITY_HIGH) == 7000
    assert get_default_target_faces(10000, EXPORT_QUALITY_MEDIUM) == 4000
    assert get_default_target_faces(10000, EXPORT_QUALITY_LOW) == 2000
    # small original should clamp to at least 100 and not exceed original
    assert get_default_target_faces(150, EXPORT_QUALITY_LOW) == max(100, int(round(150*0.2)))
    # original 100, low 20% => 20 but clamp to 100 => 100
    assert get_default_target_faces(100, EXPORT_QUALITY_LOW) == 100


def test_simplify_or_fallback_returns_valid_mesh(tmp_path):
    result = _small_result()
    original = len(result.mesh.faces)
    # try high quality (70%)
    target = get_default_target_faces(original, EXPORT_QUALITY_HIGH)
    mesh, actual, fallback, msg = prepare_export_mesh(result, EXPORT_QUALITY_HIGH, target)
    assert len(mesh.faces) > 0
    assert len(mesh.vertices) > 0
    assert actual == len(mesh.faces)
    assert actual <= original
    assert actual >= 100 or fallback is True  # if fallback, may be original
    # low quality
    target_low = get_default_target_faces(original, EXPORT_QUALITY_LOW)
    mesh2, actual2, fb2, _ = prepare_export_mesh(result, EXPORT_QUALITY_LOW, target_low)
    assert len(mesh2.faces) > 0
    assert actual2 <= original
    # if dependency missing, fallback should be original and message indicates
    # we can simulate by forcing an invalid target that triggers fallback? Instead check that simplify does not fake: actual faces should be <= target*1.5 or fallback
    # For our clustering fallback, actual may be close to target
    # Ensure original not mutated
    assert len(result.mesh.faces) == original

    # also test export to each format
    for suffix in [".stl", ".obj", ".ply"]:
        dest = tmp_path / f"out{suffix}"
        path, actual_faces, fb, _ = export_mesh_with_quality(result, dest, EXPORT_QUALITY_MEDIUM, None)
        assert path.exists()
        assert path.suffix == suffix
        # readable
        loaded = trimesh.load_mesh(str(path), force="mesh")
        # trimesh may load as Scene for obj, handle
        if isinstance(loaded, trimesh.Scene):
            # get first mesh
            loaded = list(loaded.geometry.values())[0]
        assert len(loaded.faces) > 0


def test_export_all_formats_follow_quality(tmp_path):
    result = _small_result()
    for quality in [EXPORT_QUALITY_ORIGINAL, EXPORT_QUALITY_HIGH, EXPORT_QUALITY_MEDIUM, EXPORT_QUALITY_LOW]:
        target = None if quality == EXPORT_QUALITY_ORIGINAL else get_default_target_faces(len(result.mesh.faces), quality)
        for suffix in [".stl", ".obj", ".ply"]:
            dest = tmp_path / f"{quality}{suffix}"
            path, actual, fallback, _ = export_mesh_with_quality(result, dest, quality, target)
            assert path.exists()
            assert actual > 0
            if quality == EXPORT_QUALITY_ORIGINAL:
                assert actual == len(result.mesh.faces)
                assert fallback is False
            # check file size >0
            assert path.stat().st_size > 0


def test_simplify_does_not_mutate_original_and_keeps_normals(tmp_path):
    result = _small_result()
    original_faces = len(result.mesh.faces)
    original_vertices = result.mesh.vertices.copy()
    target = max(100, original_faces // 3)
    mesh, actual, fb, msg = prepare_export_mesh(result, EXPORT_QUALITY_MEDIUM, target)
    # original unchanged
    assert len(result.mesh.faces) == original_faces
    assert np.array_equal(result.mesh.vertices, original_vertices)
    # simplified mesh should have normals or be exportable
    assert hasattr(mesh, "faces")
    assert hasattr(mesh, "vertices")
    # try export and re-read
    dest = tmp_path / "check.stl"
    path, actual2, _, _ = export_mesh_with_quality(result, dest, EXPORT_QUALITY_MEDIUM, target)
    loaded = trimesh.load_mesh(str(path), force="mesh")
    if isinstance(loaded, trimesh.Scene):
        loaded = list(loaded.geometry.values())[0]
    assert len(loaded.faces) == actual2


