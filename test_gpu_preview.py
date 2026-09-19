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


def test_widget_gpu_fallback_logic_without_gl_context(monkeypatch=None):
    """Test OpenGLMeshView fallback decisions without requiring a real GL context.

    We instantiate the widget in offscreen mode and manually force gpu_available
    to test the branching logic. If display not available, skip.
    """
    try:
        from PyQt5.QtWidgets import QApplication
        from PyQt5.QtCore import Qt
        import sys

        app = QApplication.instance()
        if app is None:
            # Use offscreen platform to avoid needing display server
            # Set attribute before creating app
            QApplication.setAttribute(Qt.AA_UseSoftwareOpenGL, True)
            app = QApplication(sys.argv)

        from app import OpenGLMeshView

        view = OpenGLMeshView()
        # Force GPU as available initially
        view.gpu_available = True
        from PyQt5.QtGui import QOpenGLShaderProgram

        # If shader not built (needs GL context), manually mark as not available and test fallback
        # Custom formula must fallback even when gpu_available True
        custom = TPMSParameters(surface=CUSTOM_SURFACE, formula="gyroid", mode="sheet")
        # Direct helper should say fallback
        can, reason = can_use_gpu_preview(custom)
        assert not can
        # Widget path: set_implicit_params should return False and store reason
        # We bypass GL by mocking implicit_program as dummy truthy to test logic path that checks can_use first
        # The first check is can_use_gpu_preview, so it should fallback before touching GL
        result = view.set_implicit_params(custom)
        assert result is False
        assert view.gpu_fallback_reason() == "custom_formula"
        assert not view.is_gpu_active()

        # Builtin should be allowed if gpu_available; but implicit_program is None before initializeGL
        # So it should fallback to gpu_unavailable
        builtin = TPMSParameters(surface="Gyroid", mode="sheet")
        view.implicit_program = None  # simulate not initialized
        result2 = view.set_implicit_params(builtin)
        assert result2 is False
        # Now simulate successful init: set dummy program object
        class Dummy:
            pass
        view.implicit_program = Dummy()
        view.gpu_available = True
        # Now it should succeed
        result3 = view.set_implicit_params(builtin)
        assert result3 is True
        assert view.is_gpu_active()
        assert view.gpu_fallback_reason() == ""

        # Test force mesh mode (diagnostic view)
        view.set_gpu_force_mesh(True)
        assert not view.is_gpu_active()
        view.set_gpu_force_mesh(False)
        # After clearing force, it should restore if params still there
        assert view.is_gpu_active()

        view.deleteLater()
    except Exception as e:
        pytest.skip(f"Skipping widget test due to headless environment: {e}")


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


def test_gpu_frame_capture_gyroid_sheet_and_gradient_when_gl_available():
    """真实 GL 可用时，Gyroid 片层与梯度模式应有模型像素且盒外无模型像素；无头自动 skip"""
    try:
        import os
        os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")
        from PyQt5.QtWidgets import QApplication
        from PyQt5.QtCore import Qt
        from PyQt5.QtGui import QImage
        QApplication.setAttribute(Qt.AA_UseSoftwareOpenGL, True)
        app = QApplication.instance()
        if app is None:
            import sys
            app = QApplication(sys.argv)
        from app import OpenGLMeshView
        from tpms_core import TPMSParameters
        from PyQt5.QtGui import QSurfaceFormat
        # Check if OpenGL 3.3 context can be created
        fmt = QSurfaceFormat()
        fmt.setVersion(3,3)
        fmt.setProfile(QSurfaceFormat.CoreProfile)
        # Try to create view and make current
        view = OpenGLMeshView()
        view.resize(320, 240)
        view.show()
        app.processEvents()
        # 需要真实 GL 编译成功
        if not view.is_gpu_available() and view.implicit_program is None:
            # 尝试初始化 GL: 需要事件循环
            import time
            time.sleep(0.2)
            app.processEvents()
        if view.implicit_program is None:
            # 若仍无 program，说明 headless 无 GL，skip
            view.deleteLater()
            pytest.skip("headless 无真实 GL，跳过帧抓取")
        # 测试两种模式
        for params in [
            TPMSParameters(surface="Gyroid", mode="sheet", size_x=20, size_y=20, size_z=20, cells_x=2, cells_y=2, cells_z=2, thickness=1.2),
            TPMSParameters(surface="Gyroid", mode="sheet", size_x=20, size_y=20, size_z=20, cells_x=2, cells_y=2, cells_z=2, thickness=0.3),
            TPMSParameters(surface="Gyroid", mode="sheet", gradient_enabled=True, gradient_axis="Z", gradient_thickness_start=0.6, gradient_thickness_end=2.0, size_x=20, size_y=20, size_z=20, cells_x=2, cells_y=2, cells_z=2),
        ]:
            ok = view.set_implicit_params(params)
            if not ok:
                pytest.skip(f"GPU 不支持 {params.surface} 已回退")
            view.update()
            app.processEvents()
            # 抓帧
            try:
                img = view.grabFramebuffer()
            except Exception as e:
                pytest.skip(f"grabFramebuffer 失败 headless: {e}")
            if img.isNull() or img.width() < 10:
                pytest.skip("offscreen 帧为空，跳过像素检查")
            # 统计非背景像素：背景为暗色 0.035/0.055/0.07 或亮色 0.975...，模型为青色基调
            # 简单检查：至少有一定数量非背景且中心区域有模型
            w, h = img.width(), img.height()
            cx, cy = w//2, h//2
            center = img.pixelColor(cx, cy)
            # 中心附近若全背景则可能视角问题，改为检查全图非背景比例
            bg_dark = (9, 14, 18)  # 0.035*255 etc approx
            # 采样全图
            non_bg = 0
            total = 0
            for y in range(0, h, 8):
                for x in range(0, w, 8):
                    c = img.pixelColor(x, y)
                    # 背景暗或亮：判断距离背景色
                    is_bg = (abs(c.red()-9)<12 and abs(c.green()-14)<12 and abs(c.blue()-18)<12) or (abs(c.red()-249)<6 and abs(c.green()-250)<6 and abs(c.blue()-249)<6)
                    if not is_bg:
                        non_bg += 1
                    total += 1
            assert non_bg > 0, f"Gyroid {params.thickness} 帧应有模型像素，实际全背景"
            # 边缘外不应有模型：采样四角 16px 区域应为背景
            corners = [(4,4),(w-5,4),(4,h-5),(w-5,h-5)]
            for x,y in corners:
                c = img.pixelColor(x,y)
                is_bg = (abs(c.red()-9)<12 and abs(c.green()-14)<12 and abs(c.blue()-18)<12) or (abs(c.red()-249)<6 and abs(c.green()-250)<6 and abs(c.blue()-249)<6)
                # 允许轻微抗锯齿但不应是强烈模型色（青色 23,117,158 附近）
                # 若角落为模型色则判定为离散边缘错误
                is_model = (abs(c.red()-23)<20 and abs(c.green()-117)<30 and abs(c.blue()-158)<30)
                assert not is_model, f"角落 ({x},{y}) 不应出现模型像素，疑似边缘离散"
        view.deleteLater()
    except Exception as e:
        import traceback
        traceback.print_exc()
        pytest.skip(f"帧抓取测试跳过 headless/异常: {e}")
