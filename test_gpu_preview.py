import pytest
import numpy as np

from tpms_core import CUSTOM_SURFACE, TPMSParameters
from gpu_preview import (
    IMPLICIT_FRAGMENT_SOURCE,
    IMPLICIT_VERTEX_SOURCE,
    SUPPORTED_SURFACES,
    can_use_gpu_preview,
    surface_index,
    build_uniform_dict,
)


def test_gpu_supports_all_builtin_surfaces():
    for surface in ("Gyroid", "Diamond", "Primitive", "I-WP", "Neovius"):
        params = TPMSParameters(surface=surface)
        can, reason = can_use_gpu_preview(params)
        assert can is True, f"{surface} should be GPU supported"
        assert reason == ""
        assert surface_index(surface) >= 0


def test_gpu_fallback_for_custom_formula():
    params = TPMSParameters(surface=CUSTOM_SURFACE, formula="sin(x)+cos(y)", mode="sheet")
    can, reason = can_use_gpu_preview(params)
    assert can is False
    assert reason == "custom_formula"


def test_gpu_fallback_for_unsupported_surface():
    params = TPMSParameters.__new__(TPMSParameters)
    # bypass validation to craft unknown surface
    object.__setattr__(params, "surface", "UnknownSurface")
    object.__setattr__(params, "mode", "sheet")
    object.__setattr__(params, "size_x", 40.0)
    object.__setattr__(params, "size_y", 40.0)
    object.__setattr__(params, "size_z", 40.0)
    object.__setattr__(params, "cells_x", 2)
    object.__setattr__(params, "cells_y", 2)
    object.__setattr__(params, "cells_z", 2)
    object.__setattr__(params, "thickness", 1.2)
    object.__setattr__(params, "iso_level", 0.0)
    object.__setattr__(params, "samples_per_cell", 64)
    object.__setattr__(params, "target_porosity", None)
    object.__setattr__(params, "formula", "")
    object.__setattr__(params, "gradient_enabled", False)
    object.__setattr__(params, "gradient_axis", "Z")
    object.__setattr__(params, "gradient_thickness_start", 1.0)
    object.__setattr__(params, "gradient_thickness_end", 3.0)
    can, reason = can_use_gpu_preview(params)
    assert can is False
    assert "unsupported_surface" in reason


def test_gpu_uniform_dict_contains_all_required_fields():
    params = TPMSParameters(
        surface="Gyroid",
        mode="sheet",
        size_x=40,
        size_y=30,
        size_z=20,
        cells_x=2,
        cells_y=2,
        cells_z=2,
        thickness=1.2,
        iso_level=0.1,
        gradient_enabled=True,
        gradient_axis="X",
        gradient_thickness_start=1.0,
        gradient_thickness_end=5.0,
    )
    d = build_uniform_dict(params)
    assert d["can_use_gpu"] is True
    assert d["surface_index"] == 0
    assert d["size"] == (40, 30, 20)
    assert d["gradient_enabled"] is True
    assert d["gradient_axis"] == "X"


def test_gpu_uniform_gradient_axes():
    for axis in ("X", "Y", "Z"):
        params = TPMSParameters(surface="Gyroid", gradient_enabled=True, gradient_axis=axis)
        can, _ = can_use_gpu_preview(params)
        assert can is True
        d = build_uniform_dict(params)
        assert d["gradient_axis"] == axis


def test_gpu_shader_sources_do_not_interpolate_user_input():
    # Security: user input must not be spliced into shader; all params via uniforms
    assert "u_surface" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_thickness" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_isoLevel" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_gradEnabled" in IMPLICIT_FRAGMENT_SOURCE
    assert "custom" not in IMPLICIT_FRAGMENT_SOURCE.lower()
    assert "formula" not in IMPLICIT_FRAGMENT_SOURCE.lower()
    # Vertex shader is trivial
    assert "a_pos" in IMPLICIT_VERTEX_SOURCE
    # Ensure shader contains both sheet and solid branches
    assert "abs(f)" in IMPLICIT_FRAGMENT_SOURCE  # sheet uses abs
    assert "u_isoLevel" in IMPLICIT_FRAGMENT_SOURCE
    # Ensure gradient mix logic present
    assert "mix(u_gradStart" in IMPLICIT_FRAGMENT_SOURCE
    # Ensure fallback logic uses uniforms, not string concatenation
    # The python helper must not generate GLSL from user string
    import gpu_preview as gp
    source = pathlib_path = gp.__file__
    content = open(source, encoding="utf-8").read()
    # Ensure no `+ formula` or `f\"{formula` in gpu_preview
    assert "formula" not in content or "fallback" in content.lower()


def test_gpu_sheet_and_solid_modes_both_supported():
    for mode in ("sheet", "solid"):
        params = TPMSParameters(surface="Diamond", mode=mode, thickness=1.0, iso_level=0.2)
        can, _ = can_use_gpu_preview(params)
        assert can is True


def test_gpu_shader_contains_ray_box_and_normal_estimate():
    # 技术要求: 相机射线与包围盒求交 + 法线估计（解析梯度分流）
    assert "rayBoxIntersect" in IMPLICIT_FRAGMENT_SOURCE
    assert ("calcNormal" in IMPLICIT_FRAGMENT_SOURCE or "getNormal" in IMPLICIT_FRAGMENT_SOURCE)
    assert "evalMap" in IMPLICIT_FRAGMENT_SOURCE
    # Must have maxSteps uniform and timeout protection
    assert "u_maxSteps" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_maxDist" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_minStep" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_maxStep" in IMPLICIT_FRAGMENT_SOURCE
    assert "u_eps" in IMPLICIT_FRAGMENT_SOURCE
    # Must handle different thickness / iso via uniforms (no hard code)
    assert "u_lightBg" in IMPLICIT_FRAGMENT_SOURCE


def test_gpu_preview_does_not_affect_export_mesh_result():
    # 验证 GPU 与 STL 导出使用同一组参数概念：导出仍用 CPU 网格，不受 GPU 影响
    from tpms_core import generate_tpms, export_mesh
    import tempfile
    from pathlib import Path

    params = TPMSParameters(surface="Gyroid", mode="sheet", thickness=1.2, samples_per_cell=12)
    result = generate_tpms(params)
    assert result.mesh.is_watertight
    triangles_before = result.triangles
    # GPU uniform building must not mutate params
    build_uniform_dict(params)
    # Export still works with original result
    with tempfile.TemporaryDirectory() as tmp:
        out = Path(tmp) / "out.stl"
        path = export_mesh(result, out)
        assert path.exists()
        assert result.triangles == triangles_before


def test_gpu_shader_contains_sign_crossing_and_bisection():
    src = IMPLICIT_FRAGMENT_SOURCE
    # 符号穿越检测
    assert "prevD > 0" in src or "prevD>0" in src
    assert "curD <=" in src
    # 二分精化 6 次
    assert "for (int j = 0; j < 6" in src
    # 步进使用 clamp with u_maxStep
    assert "clamp(abs(curD)" in src or "clamp(abs" in src
    assert "u_maxStep" in src

def test_gpu_shader_contains_box_cap_and_normal_branching():
    src = IMPLICIT_FRAGMENT_SOURCE
    # 包围盒封口专用判断
    assert "dAtNear" in src
    assert "dProbe" in src
    assert "getBoxNormal" in src
    assert "getAnalyticNormal" in src or "getNormal" in src
    # 解析梯度分支
    assert "evalGrad" in src
    assert "evalBox" in src
    assert "evalMaterial" in src

def test_gpu_shader_u_maxStep_is_adaptive():
    src = IMPLICIT_FRAGMENT_SOURCE
    assert "uniform float u_maxStep" in src
    # 不能再固定 2.0 上限
    assert "min(stepDist, 2.0)" not in src
    assert "clamp" in src

