from dataclasses import replace
from pathlib import Path

import numpy as np
import pytest
import trimesh

import libfive_backend as backend
from tpms_core import CUSTOM_SURFACE, TPMSParameters, TPMS_FORMULAS, generate_tpms


@pytest.fixture(scope="module")
def kernel():
    try:
        return backend.NativeKernel()
    except backend.LibfiveUnavailable as exc:
        pytest.skip(str(exc))


def parameters(**kwargs):
    return replace(TPMSParameters(size_x=10, size_y=10, size_z=10,
                                  cells_x=1, cells_y=1, cells_z=1,
                                  thickness=1, samples_per_cell=24), **kwargs)


def test_missing_library_is_actionable(tmp_path):
    with pytest.raises(backend.LibfiveUnavailable, match="build_libfive"):
        backend.NativeKernel(tmp_path / "missing.dll")


def test_library_path_supports_portable_install_and_prefers_native(tmp_path, monkeypatch):
    monkeypatch.delenv("TPMS_LIBFIVE_LIBRARY", raising=False)
    monkeypatch.setattr(backend, "__file__", str(tmp_path / "libfive_backend.py"))
    monkeypatch.setattr(backend.sys, "platform", "win32")
    portable = tmp_path / "libfive.dll"
    portable.touch()
    assert backend.library_path() == portable
    installed = tmp_path / "native" / "libfive" / "libfive.dll"
    installed.parent.mkdir(parents=True)
    installed.touch()
    assert backend.library_path() == installed


def test_library_path_explicit_override_is_preserved(tmp_path, monkeypatch):
    override = tmp_path / "chosen.dll"
    monkeypatch.setenv("TPMS_LIBFIVE_LIBRARY", str(override))
    assert backend.library_path() == override.resolve()


@pytest.mark.parametrize("kwargs,cell_size", [
    ({"tubular_enabled": True}, 0.4), ({}, float("nan")),
    ({}, 0), ({}, 1), ({}, 0.00001),
])
def test_invalid_native_parameters_rejected(kwargs, cell_size):
    with pytest.raises(ValueError):
        backend.validate_libfive_parameters(parameters(**kwargs), cell_size)


@pytest.mark.parametrize("surface", list(TPMS_FORMULAS))
@pytest.mark.parametrize("mode", ["sheet", "solid"])
def test_native_tpms_is_closed_and_matches_material_fraction(kernel, surface, mode):
    p = parameters(surface=surface, mode=mode)
    result = backend.generate_libfive_mesh(p, 0.4, kernel=kernel)
    reference = generate_tpms(p)
    assert result.mesh.is_watertight
    assert result.mesh.is_winding_consistent
    assert result.mesh.volume > 0
    assert np.all(np.isfinite(result.mesh.vertices))
    assert np.max(np.abs(result.mesh.bounds - np.array([[-5] * 3, [5] * 3]))) < 0.06
    assert abs(result.relative_density - reference.relative_density) < 0.035


def test_custom_boolean_and_exponent_mesh(kernel):
    sphere = parameters(surface=CUSTOM_SURFACE, mode="solid", formula="9-x**2-y**2-z**2")
    mesh = backend.generate_libfive_mesh(sphere, 0.3, kernel=kernel).mesh
    assert abs(mesh.volume / (4 / 3 * np.pi * 27) - 1) < 0.02
    # Difference: sphere minus through-cylinder. Physical coordinates in mm.
    drilled = replace(sphere, formula="-max(sqrt((x^2)+(y^2)+(z^2))-3, -(sqrt(x*x+y*y)-1))")
    result = backend.generate_libfive_mesh(drilled, 0.3, kernel=kernel)
    assert result.mesh.is_watertight
    assert result.volume < mesh.volume
    assert result.volume > mesh.volume * 0.7
    assert result.mesh.euler_number == 0


def test_fractional_exponent_and_empty_region(kernel):
    sphere = parameters(surface=CUSTOM_SURFACE, mode="solid", formula="3-(x*x+y*y+z*z)**0.5")
    result = backend.generate_libfive_mesh(sphere, 0.3, kernel=kernel)
    assert abs(result.volume / (4 / 3 * np.pi * 27) - 1) < 0.02
    with pytest.raises(ValueError, match="曲面|空网格"):
        backend.generate_libfive_mesh(replace(sphere, formula="-1"), 0.3, kernel=kernel)


def test_planar_formula_and_domain_validation(kernel):
    p = parameters(surface=CUSTOM_SURFACE, mode="solid", formula="x")
    result = backend.generate_libfive_mesh(p, 0.4, kernel=kernel)
    assert abs(result.volume - 500) < 0.5
    with pytest.raises(ValueError, match="非有限"):
        backend.generate_libfive_mesh(replace(p, formula="sqrt(x)"), 0.4, kernel=kernel)


def test_export_failure_preserves_existing_file(tmp_path, monkeypatch):
    source = generate_tpms(parameters())
    monkeypatch.setattr(backend, "generate_libfive_mesh", lambda *a, **k: source)
    path = tmp_path / "existing.stl"
    path.write_bytes(b"previous export")
    def interrupted_export(result, target):
        target.write_bytes(b"partial export")
        raise OSError("disk write failure")
    monkeypatch.setattr(backend, "export_mesh", interrupted_export)
    with pytest.raises(OSError, match="disk write"):
        backend.export_libfive_mesh(source, path, 0.3)
    assert path.read_bytes() == b"previous export"
    assert sorted(p.name for p in tmp_path.iterdir()) == ["existing.stl"]


@pytest.mark.parametrize("axis", ["X", "Y", "Z"])
def test_gradient_wall_matches_existing_definition(kernel, axis):
    p = parameters(gradient_enabled=True, gradient_axis=axis,
                   gradient_thickness_start=0.8, gradient_thickness_end=1.6)
    result = backend.generate_libfive_mesh(p, 0.3, kernel=kernel)
    assert result.mesh.is_watertight
    assert abs(result.relative_density - generate_tpms(p).relative_density) < 0.035


def test_formula_ast_rejects_python_execution(kernel):
    p = parameters(surface=CUSTOM_SURFACE, formula="__import__('os').system('echo unsafe')")
    with pytest.raises(ValueError):
        backend.generate_libfive_mesh(p, 0.3, kernel=kernel)


def test_export_formats_keep_original_and_use_solved_parameters(kernel, tmp_path, monkeypatch):
    source = generate_tpms(parameters(target_porosity=0.7))
    original = source.mesh.vertices.copy()
    def no_resolve(_):
        raise AssertionError("Export must not solve porosity again")
    monkeypatch.setattr(backend, "_material_scalar_field", no_resolve)
    for suffix in ("stl", "obj", "ply"):
        path, faces = backend.export_libfive_mesh(source, tmp_path / f"模型.{suffix}", 0.3)
        loaded = trimesh.load(path, force="mesh")
        assert len(loaded.faces) == faces
        assert loaded.is_watertight
        assert abs(loaded.volume / 1000 - 0.3) < 0.035
    assert np.array_equal(source.mesh.vertices, original)


def test_libfive_export_ui_state_and_worker_failure(tmp_path, monkeypatch):
    import os
    os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
    from PyQt5.QtWidgets import QApplication
    from app import MainWindow, LibfiveExportWorker
    application = QApplication.instance() or QApplication([])
    clicks = []
    monkeypatch.setattr(MainWindow, "export_current", lambda self: clicks.append(True))
    window = MainWindow()
    source = generate_tpms(parameters())
    window.current_result = source
    window._update_export_quality_defaults()
    window.export_action.setEnabled(True)
    window.export_tool_button.click()
    assert clicks == [True]
    window._on_export_quality_selected("medium")
    assert window.export_target_spin.isEnabled()
    window.export_backend_combo.setCurrentIndex(1)
    assert window.libfive_cell_spin.isEnabled()
    assert not window.export_target_spin.isEnabled()
    assert all(not action.isEnabled() for action in window._export_quality_actions.values())
    window.export_backend_combo.setCurrentIndex(0)
    assert window.export_target_spin.isEnabled()
    messages = []
    def fail(*args):
        raise RuntimeError("Native unavailable")
    monkeypatch.setattr("app.export_libfive_mesh", fail)
    worker = LibfiveExportWorker(source, tmp_path / "out.stl", 0.3)
    worker.failed.connect(messages.append)
    worker.run()
    assert messages == ["Native unavailable"]
    assert not (tmp_path / "out.stl").exists()
    window.close()
    application.processEvents()
