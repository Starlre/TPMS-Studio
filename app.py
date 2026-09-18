from __future__ import annotations

import ctypes
import sys
import tempfile
import traceback
from pathlib import Path

import numpy as np
from PyQt5.QtCore import QObject, QPoint, QThread, QTimer, Qt, pyqtSignal
from PyQt5.QtGui import (
    QColor,
    QMatrix4x4,
    QOpenGLBuffer,
    QOpenGLShader,
    QOpenGLShaderProgram,
    QOpenGLVertexArrayObject,
    QPainter,
    QPen,
    QSurfaceFormat,
    QVector3D,
)
from PyQt5.QtWidgets import (
    QAction,
    QApplication,
    QComboBox,
    QCheckBox,
    QDoubleSpinBox,
    QDialog,
    QDialogButtonBox,
    QFileDialog,
    QFormLayout,
    QFrame,
    QGridLayout,
    QGroupBox,
    QHBoxLayout,
    QLabel,
    QLineEdit,
    QMainWindow,
    QMessageBox,
    QOpenGLWidget,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSizePolicy,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QTabWidget,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from comsol_mesh import (
    CFDMeshOptions,
    CFDMeshResult,
    export_comsol_fluid_mesh,
    generate_simulation_region_preview,
)
from tpms_core import (
    CUSTOM_SURFACE,
    MeshResult,
    PreviewMesh,
    TPMSParameters,
    export_mesh,
    generate_tpms,
    simplify_mesh_for_preview,
)


STYLE = """
/* Modern Slate/Teal Design System - TPMS Studio */
QMainWindow { background: #f1f5f9; color: #0f172a; }
QWidget {
    color: #0f172a;
    font-family: "Microsoft YaHei UI", "Segoe UI", "Inter";
    font-size: 19px;
}
QWidget#centralRoot, QWidget#workspace { background: #f1f5f9; }

/* Top toolbar - deep slate with teal accent line */
QToolBar {
    background: #0f172a;
    border: none;
    border-bottom: 2px solid #0f766e;
    spacing: 4px;
    padding: 8px 16px;
}
QToolBar::separator {
    background: #334155;
    width: 1px;
    margin: 8px 10px;
    border-radius: 1px;
}
QToolBar QLabel#brand {
    color: #f8fafc;
    font-size: 23px;
    font-weight: 800;
    letter-spacing: 0.3px;
    padding-right: 22px;
}
QToolButton {
    background: rgba(255,255,255,0.06);
    border: 1px solid rgba(255,255,255,0.08);
    border-radius: 8px;
    color: #e2e8f0;
    font-size: 18px;
    font-weight: 600;
    min-height: 40px;
    padding: 6px 18px;
}
QToolButton:hover { background: rgba(255,255,255,0.12); border-color: rgba(255,255,255,0.16); color: #ffffff; }
QToolButton:pressed { background: rgba(15,118,110,0.9); border-color: #0f766e; }
QToolButton:checked { background: #f8fafc; color: #0f766e; border-color: #e2e8f0; font-weight: 700; }
QToolButton:disabled { color: #64748b; background: transparent; border-color: transparent; }

/* Left parameter deck - elevated card */
QWidget#parameterDeck {
    background: #ffffff;
    border-right: 1px solid #e2e8f0;
    border-radius: 0px;
}
QLabel#panelTitle { color: #0f172a; font-size: 20px; font-weight: 800; letter-spacing: -0.3px; }
QLabel#panelSubtitle { color: #64748b; font-size: 13px; font-weight: 500; }

/* Scroll area - soft inner shadow */
QScrollArea#parameterScroll {
    background: #ffffff;
    border: none;
}
QWidget#parameterPage { background: #ffffff; }

/* Tabs - pill style */
QTabWidget#parameterTabs::pane {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    top: -1px;
    margin-top: 6px;
}
QTabWidget#parameterTabs QTabBar::tab {
    background: #f1f5f9;
    color: #475569;
    border: 1px solid transparent;
    border-radius: 8px;
    min-width: 108px;
    min-height: 42px;
    padding: 7px 16px;
    margin-right: 4px;
    font-size: 18px;
    font-weight: 600;
}
QTabWidget#parameterTabs QTabBar::tab:selected {
    background: #0f766e;
    color: #ffffff;
    border-color: #0f766e;
    font-weight: 700;
}
QTabWidget#parameterTabs QTabBar::tab:hover:!selected { background: #e2e8f0; color: #0f172a; }

/* Thin modern scrollbar */
QScrollBar:vertical {
    background: #f8fafc;
    width: 10px;
    margin: 0;
    border-radius: 5px;
}
QScrollBar::handle:vertical {
    background: #cbd5e1;
    min-height: 40px;
    border-radius: 5px;
    margin: 2px;
}
QScrollBar::handle:vertical:hover { background: #94a3b8; }
QScrollBar::add-line:vertical, QScrollBar::sub-line:vertical { height: 0; }
QScrollBar::add-page:vertical, QScrollBar::sub-page:vertical { background: transparent; }
QSplitter::handle { background: #e2e8f0; width: 1px; }
QSplitter::handle:hover { background: #0f766e; }

/* Group cards - elevated */
QGroupBox {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 10px;
    margin-top: 14px;
    padding: 10px 10px 8px 10px;
    font-size: 15px;
    font-weight: 700;
    color: #0f172a;
}
QGroupBox::title {
    subcontrol-origin: margin;
    left: 10px;
    padding: 0 6px;
    background: #ffffff;
    color: #0f766e;
    font-size: 13px;
    font-weight: 700;
    border-radius: 4px;
}
QLabel { background: transparent; }
QLabel#fieldAxis { color: #475569; font-size: 15px; font-weight: 700; letter-spacing: 0.4px; }
QLabel#metricLabel { color: #64748b; font-size: 14px; font-weight: 600; letter-spacing: 0.3px; text-transform: uppercase; }
QLabel#metricValue { color: #0f172a; font-size: 21px; font-weight: 800; }

/* Metrics bar - floating card */
QFrame#metricsBar {
    background: #ffffff;
    border: 1px solid #e2e8f0;
    border-radius: 12px;
    padding: 2px;
}

/* Inputs - soft focus ring */
QComboBox, QDoubleSpinBox, QSpinBox, QLineEdit {
    background: #ffffff;
    color: #0f172a;
    border: 1.5px solid #e2e8f0;
    border-radius: 8px;
    min-height: 42px;
    padding: 0 12px;
    font-size: 18px;
    selection-background-color: #0f766e;
    selection-color: #ffffff;
}
QComboBox:hover, QDoubleSpinBox:hover, QSpinBox:hover, QLineEdit:hover {
    border-color: #94a3b8;
    background: #f8fafc;
}
QComboBox:focus, QDoubleSpinBox:focus, QSpinBox:focus, QLineEdit:focus {
    border: 1.5px solid #0f766e;
    background: #ffffff;
}
QComboBox:disabled, QDoubleSpinBox:disabled, QSpinBox:disabled, QLineEdit:disabled {
    background: #f1f5f9;
    color: #94a3b8;
    border-color: #e2e8f0;
}
QComboBox::drop-down { border: none; width: 28px; }
QComboBox::down-arrow { width: 10px; height: 10px; }

/* Checks - larger hit area */
QCheckBox, QRadioButton {
    background: transparent;
    border: none;
    min-height: 36px;
    spacing: 8px;
    font-weight: 500;
}
QCheckBox::indicator, QRadioButton::indicator { width: 18px; height: 18px; border-radius: 4px; }
QCheckBox:disabled, QRadioButton:disabled { color: #94a3b8; }

/* Buttons */
QPushButton {
    background: #ffffff;
    border: 1.5px solid #e2e8f0;
    border-radius: 8px;
    min-height: 44px;
    padding: 0 18px;
    font-size: 18px;
    font-weight: 600;
}
QPushButton:hover { background: #f8fafc; border-color: #cbd5e1; }
QPushButton:pressed { background: #f1f5f9; }
QPushButton#generateButton {
    background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #0f766e, stop:1 #0d5c56);
    color: #ffffff;
    border: 1px solid #0f5f59;
    border-radius: 10px;
    min-width: 168px;
    min-height: 50px;
    font-size: 19px;
    font-weight: 700;
    letter-spacing: 0.2px;
}
QPushButton#generateButton:hover { background: qlineargradient(x1:0, y1:0, x2:0, y2:1, stop:0 #149a8f, stop:1 #0f766e); border-color: #0f766e; }
QPushButton#generateButton:pressed { background: #0f5f59; }
QPushButton#generateButton:disabled { background: #cbd5e1; color: #f1f5f9; border-color: #cbd5e1; }
QWidget#parameterDeck QPushButton#generateButton { min-width: 0; border-radius: 10px; }

/* Status bar - subtle */
QStatusBar { background: #ffffff; border-top: 1px solid #e2e8f0; color: #475569; font-size: 15px; font-weight: 500; }
QStatusBar::item { border: none; }
"""


class MeshWorker(QObject):
    finished = pyqtSignal(object, object)
    failed = pyqtSignal(str)

    def __init__(self, parameters: TPMSParameters) -> None:
        super().__init__()
        self.parameters = parameters

    def run(self) -> None:
        try:
            result = generate_tpms(self.parameters)
            if result.triangles <= 1_500_000:
                preview = PreviewMesh(
                    vertices=np.asarray(result.mesh.vertices, dtype=np.float32).copy(),
                    faces=np.asarray(result.mesh.faces, dtype=np.int64).copy(),
                )
            else:
                preview = simplify_mesh_for_preview(result.mesh, target_faces=1_500_000)
            self.finished.emit(result, preview)
        except Exception as exc:
            traceback.print_exc()
            self.failed.emit(str(exc))


class CFDMeshWorker(QObject):
    finished = pyqtSignal(object)
    failed = pyqtSignal(str)
    progress = pyqtSignal(str)

    def __init__(
        self,
        parameters: TPMSParameters,
        destination: Path,
        options: CFDMeshOptions,
    ) -> None:
        super().__init__()
        self.parameters = parameters
        self.destination = destination
        self.options = options

    def run(self) -> None:
        try:
            result = export_comsol_fluid_mesh(
                self.parameters,
                self.destination,
                self.options,
                progress=self.progress.emit,
            )
            self.finished.emit(result)
        except Exception as exc:
            traceback.print_exc()
            self.failed.emit(str(exc))


class SimulationRegionWorker(QObject):
    finished = pyqtSignal(object)
    failed = pyqtSignal(str)

    def __init__(self, parameters: TPMSParameters, options: CFDMeshOptions) -> None:
        super().__init__()
        self.parameters = parameters
        self.options = options

    def run(self) -> None:
        try:
            preview = generate_simulation_region_preview(self.parameters, self.options)
            self.finished.emit(preview)
        except Exception as exc:
            traceback.print_exc()
            self.failed.emit(str(exc))


class QualityHistogram(QWidget):
    def __init__(self, result: CFDMeshResult, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.result = result
        self.setMinimumHeight(220)

    def paintEvent(self, _event) -> None:
        painter = QPainter(self)
        painter.setRenderHint(QPainter.Antialiasing)
        plot_left, plot_top = 52, 16
        plot_right, plot_bottom = self.width() - 18, self.height() - 34
        plot_width = max(plot_right - plot_left, 1)
        plot_height = max(plot_bottom - plot_top, 1)
        counts = self.result.quality.histogram_counts
        maximum = max(counts, default=1)

        painter.setPen(QPen(QColor("#cfd6d1"), 1))
        painter.drawRect(plot_left, plot_top, plot_width, plot_height)
        bar_width = plot_width / max(len(counts), 1)
        threshold = self.result.quality.low_quality_threshold
        for index, count in enumerate(counts):
            height = plot_height * count / maximum
            bin_center = (index + 0.5) / len(counts)
            color = QColor("#c94b3c") if bin_center < threshold else QColor("#187b62")
            painter.fillRect(
                int(plot_left + index * bar_width + 1),
                int(plot_bottom - height),
                max(int(bar_width - 2), 1),
                int(height),
                color,
            )

        painter.setPen(QColor("#46514a"))
        for value in (0.0, 0.25, 0.5, 0.75, 1.0):
            x = int(plot_left + value * plot_width)
            painter.drawLine(x, plot_bottom, x, plot_bottom + 4)
            painter.drawText(x - 12, plot_bottom + 19, f"{value:.2g}")
        painter.drawText(6, plot_top + 6, f"{maximum:,}")
        painter.drawText(6, plot_bottom, "0")
        painter.drawText(plot_left + plot_width // 2 - 46, self.height() - 5, "缩放雅可比")


class MeshQualityDialog(QDialog):
    def __init__(self, result: CFDMeshResult, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setWindowTitle("CFD 网格质量")
        self.resize(680, 430)
        layout = QVBoxLayout(self)
        summary = QGridLayout()
        quality = result.quality
        values = (
            ("最小值", f"{quality.minimum:.4f}"),
            ("5% 分位", f"{quality.percentile_05:.4f}"),
            ("中位数", f"{quality.median:.4f}"),
            ("平均值", f"{quality.mean:.4f}"),
            ("最大边长比", f"{quality.maximum_edge_ratio:.1f}"),
            ("最小体积", f"{quality.minimum_volume:.3e} mm³"),
            ("低质量单元", f"{quality.low_quality_elements:,}"),
            ("质量阈值", f"{quality.low_quality_threshold:.2f}"),
        )
        for index, (name, value) in enumerate(values):
            row, column = divmod(index, 4)
            cell = QVBoxLayout()
            label = QLabel(name)
            label.setObjectName("metricLabel")
            data = QLabel(value)
            data.setObjectName("metricValue")
            cell.addWidget(label)
            cell.addWidget(data)
            summary.addLayout(cell, row, column)
        layout.addLayout(summary)
        chart_title = QLabel("体单元质量分布")
        chart_title.setObjectName("sectionTitle")
        layout.addWidget(chart_title)
        layout.addWidget(QualityHistogram(result), 1)
        paths = QLabel(f"完整质量场：{result.quality_path}")
        paths.setWordWrap(True)
        paths.setStyleSheet("color: #667069;")
        layout.addWidget(paths)
        buttons = QDialogButtonBox(QDialogButtonBox.Close)
        buttons.rejected.connect(self.reject)
        layout.addWidget(buttons)


class OpenGLMeshView(QOpenGLWidget):
    """Retained GPU mesh viewport with shader-based lighting."""

    error = pyqtSignal(str)

    def __init__(self, parent: QWidget | None = None) -> None:
        super().__init__(parent)
        self.setMinimumSize(640, 220)
        self.setFocusPolicy(Qt.StrongFocus)
        self.program: QOpenGLShaderProgram | None = None
        self.vbo = QOpenGLBuffer(QOpenGLBuffer.VertexBuffer)
        self.ibo = QOpenGLBuffer(QOpenGLBuffer.IndexBuffer)
        self.vao = QOpenGLVertexArrayObject(self)
        self.index_count = 0
        self.pending_mesh: PreviewMesh | None = None
        self.last_pos = QPoint()
        self.dragging = False
        self.yaw = -42.0
        self.pitch = 23.0
        self.distance = 78.0
        self.model_radius = 35.0
        self.light_background = False
        self.highlight_mode = False
        self.vertex_color_mode = False

    def initializeGL(self) -> None:
        try:
            self.gl = ctypes.windll.opengl32
            self.gl.glEnable.argtypes = [ctypes.c_uint]
            self.gl.glCullFace.argtypes = [ctypes.c_uint]
            self.gl.glBlendFunc.argtypes = [ctypes.c_uint, ctypes.c_uint]
            self.gl.glClearColor.argtypes = [
                ctypes.c_float,
                ctypes.c_float,
                ctypes.c_float,
                ctypes.c_float,
            ]
            self.gl.glClear.argtypes = [ctypes.c_uint]
            self.gl.glViewport.argtypes = [
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_int,
                ctypes.c_int,
            ]
            self.gl.glDrawElements.argtypes = [
                ctypes.c_uint,
                ctypes.c_int,
                ctypes.c_uint,
                ctypes.c_void_p,
            ]
            self.gl.glEnable(0x0B71)  # GL_DEPTH_TEST
            self.gl.glEnable(0x0B44)  # GL_CULL_FACE
            self.gl.glCullFace(0x0405)  # GL_BACK
            self.gl.glEnable(0x0BE2)  # GL_BLEND
            self.gl.glBlendFunc(0x0302, 0x0303)
            self._apply_background_color()
            self._build_shader()
            self.vao.create()
            if self.pending_mesh is not None:
                self._upload_mesh(self.pending_mesh)
        except Exception as exc:
            traceback.print_exc()
            self.error.emit(str(exc))

    def _build_shader(self) -> None:
        self.program = QOpenGLShaderProgram(self)
        vertex_source = """
        #version 330 core
        layout(location = 0) in vec3 a_position;
        layout(location = 1) in vec3 a_normal;
        layout(location = 2) in vec3 a_color;
        uniform mat4 u_mvp;
        uniform mat4 u_model;
        uniform float u_outline_mode;
        uniform float u_outline_width;
        out vec3 v_normal;
        out vec3 v_world;
        out vec3 v_color;
        void main() {
            vec3 position = a_position + a_normal * u_outline_width * u_outline_mode;
            vec4 world = u_model * vec4(position, 1.0);
            v_world = world.xyz;
            v_normal = normalize(mat3(u_model) * a_normal);
            v_color = a_color;
            gl_Position = u_mvp * vec4(position, 1.0);
        }
        """
        fragment_source = """
        #version 330 core
        in vec3 v_normal;
        in vec3 v_world;
        in vec3 v_color;
        uniform vec3 u_camera;
        uniform float u_light_background;
        uniform float u_highlight_mode;
        uniform float u_use_vertex_color;
        uniform float u_outline_mode;
        out vec4 frag_color;
        void main() {
            if (u_outline_mode > 0.5) {
                frag_color = vec4(0.015, 0.075, 0.11, 1.0);
                return;
            }
            vec3 n = normalize(v_normal);
            vec3 view_dir = normalize(u_camera - v_world);
            if (!gl_FrontFacing) n = -n;
            vec3 key = normalize(vec3(-0.45, -0.55, 0.75));
            vec3 fill = normalize(vec3(0.70, 0.15, 0.30));
            float light = 0.12 + 0.72 * max(dot(n, key), 0.0)
                              + 0.18 * max(dot(n, fill), 0.0);
            float rim = pow(1.0 - max(dot(n, view_dir), 0.0), 2.4);
            vec3 dark_base = vec3(0.09, 0.46, 0.62);
            vec3 light_base = vec3(0.018, 0.22, 0.34);
            vec3 base = mix(dark_base, light_base, u_light_background);
            base = mix(base, v_color, u_use_vertex_color);
            base = mix(base, vec3(0.78, 0.12, 0.055), u_highlight_mode);
            float ambient = mix(0.30, 0.30, u_light_background);
            float diffuse_scale = mix(0.92, 0.76, u_light_background);
            float rim_scale = mix(0.16, 0.07, u_light_background);
            vec3 color = base * (ambient + light * diffuse_scale)
                       + vec3(0.24, 0.72, 0.82) * rim * rim_scale;
            color = pow(clamp(color, 0.0, 1.0), vec3(0.88));
            frag_color = vec4(color, 1.0);
        }
        """
        if not self.program.addShaderFromSourceCode(QOpenGLShader.Vertex, vertex_source):
            raise RuntimeError(self.program.log())
        if not self.program.addShaderFromSourceCode(QOpenGLShader.Fragment, fragment_source):
            raise RuntimeError(self.program.log())
        if not self.program.link():
            raise RuntimeError(self.program.log())

    @staticmethod
    def _interleaved_mesh(mesh: PreviewMesh) -> tuple[np.ndarray, np.ndarray]:
        vertices = np.asarray(mesh.vertices, dtype=np.float32)
        faces = np.asarray(mesh.faces, dtype=np.uint32)
        triangles = vertices[faces]
        face_normals = np.cross(
            triangles[:, 1] - triangles[:, 0],
            triangles[:, 2] - triangles[:, 0],
        )
        normals = np.zeros_like(vertices, dtype=np.float32)
        np.add.at(normals, faces[:, 0], face_normals)
        np.add.at(normals, faces[:, 1], face_normals)
        np.add.at(normals, faces[:, 2], face_normals)
        normals /= np.maximum(np.linalg.norm(normals, axis=1, keepdims=True), 1e-8)
        if mesh.colors is None:
            colors = np.ones_like(vertices, dtype=np.float32)
        else:
            colors = np.asarray(mesh.colors, dtype=np.float32)
            if colors.shape != vertices.shape:
                raise ValueError("预览网格颜色必须与顶点数组形状一致")
            colors = np.clip(colors, 0.0, 1.0)
        return np.column_stack((vertices, normals, colors)).astype(np.float32), faces

    def set_mesh(self, mesh: PreviewMesh) -> None:
        extents = np.ptp(mesh.vertices, axis=0)
        self.model_radius = max(float(np.linalg.norm(extents)) * 0.5, 1.0)
        self.distance = self.model_radius * 3.20
        self.pending_mesh = mesh
        if self.isValid() and self.program is not None:
            self._upload_mesh(mesh)

    def _upload_mesh(self, mesh: PreviewMesh) -> None:
        interleaved, faces = self._interleaved_mesh(mesh)
        self.makeCurrent()
        self.vao.bind()
        if not self.vbo.isCreated():
            self.vbo.create()
        if not self.ibo.isCreated():
            self.ibo.create()
        self.vbo.bind()
        self.vbo.setUsagePattern(QOpenGLBuffer.StaticDraw)
        self.vbo.allocate(interleaved.tobytes(), interleaved.nbytes)
        self.ibo.bind()
        self.ibo.setUsagePattern(QOpenGLBuffer.StaticDraw)
        self.ibo.allocate(faces.tobytes(), faces.nbytes)
        assert self.program is not None
        self.program.bind()
        stride = 9 * np.dtype(np.float32).itemsize
        self.program.enableAttributeArray(0)
        self.program.setAttributeBuffer(0, 0x1406, 0, 3, stride)
        self.program.enableAttributeArray(1)
        self.program.setAttributeBuffer(1, 0x1406, 3 * 4, 3, stride)
        self.program.enableAttributeArray(2)
        self.program.setAttributeBuffer(2, 0x1406, 6 * 4, 3, stride)
        self.program.release()
        self.ibo.release()
        self.vbo.release()
        self.vao.release()
        self.index_count = int(faces.size)
        self.vertex_color_mode = mesh.colors is not None
        self.pending_mesh = None
        self.doneCurrent()
        self.update()

    def paintGL(self) -> None:
        self.gl.glClear(0x00004000 | 0x00000100)
        if self.program is None or self.index_count == 0:
            return
        aspect = max(float(self.width()) / max(self.height(), 1), 0.1)
        projection = QMatrix4x4()
        projection.perspective(40.0, aspect, 0.05, max(self.distance * 10.0, 500.0))
        view = QMatrix4x4()
        view.translate(0.0, 0.0, -self.distance)
        view.rotate(self.pitch, 1.0, 0.0, 0.0)
        view.rotate(self.yaw, 0.0, 1.0, 0.0)
        model = QMatrix4x4()

        self.program.bind()
        self.program.setUniformValue("u_mvp", projection * view * model)
        self.program.setUniformValue("u_model", model)
        self.program.setUniformValue("u_camera", QVector3D(0.0, 0.0, self.distance))
        self.program.setUniformValue("u_light_background", 1.0 if self.light_background else 0.0)
        self.program.setUniformValue("u_highlight_mode", 1.0 if self.highlight_mode else 0.0)
        self.program.setUniformValue("u_use_vertex_color", 1.0 if self.vertex_color_mode else 0.0)
        self.vao.bind()
        self.ibo.bind()
        if self.light_background:
            self.program.setUniformValue("u_outline_mode", 1.0)
            self.program.setUniformValue("u_outline_width", self.model_radius * 0.006)
            self.gl.glCullFace(0x0404)  # GL_FRONT
            self.gl.glDrawElements(
                0x0004,
                self.index_count,
                0x1405,
                ctypes.c_void_p(0),
            )
        self.program.setUniformValue("u_outline_mode", 0.0)
        self.program.setUniformValue("u_outline_width", 0.0)
        self.gl.glCullFace(0x0405)  # GL_BACK
        self.gl.glDrawElements(
            0x0004,
            self.index_count,
            0x1405,
            ctypes.c_void_p(0),
        )
        self.ibo.release()
        self.vao.release()
        self.program.release()

    def resizeGL(self, width: int, height: int) -> None:
        self.gl.glViewport(0, 0, width, height)

    def mousePressEvent(self, event) -> None:
        if event.button() in (Qt.LeftButton, Qt.RightButton):
            self.dragging = True
            self.last_pos = event.pos()
        event.accept()

    def mouseMoveEvent(self, event) -> None:
        if self.dragging:
            delta = event.pos() - self.last_pos
            self.last_pos = event.pos()
            self.yaw += delta.x() * 0.45
            self.pitch = max(-89.0, min(89.0, self.pitch + delta.y() * 0.45))
            self.update()
        event.accept()

    def mouseReleaseEvent(self, event) -> None:
        self.dragging = False
        event.accept()

    def wheelEvent(self, event) -> None:
        self.distance *= 0.88 if event.angleDelta().y() > 0 else 1.14
        self.distance = max(self.model_radius * 0.55, min(self.model_radius * 14.0, self.distance))
        self.update()
        event.accept()

    def reset_view(self) -> None:
        self.yaw = -42.0
        self.pitch = 23.0
        self.distance = self.model_radius * 3.20
        self.update()

    def _apply_background_color(self) -> None:
        if self.light_background:
            self.gl.glClearColor(0.975, 0.982, 0.978, 1.0)
        else:
            self.gl.glClearColor(0.035, 0.055, 0.070, 1.0)

    def set_light_background(self, enabled: bool) -> None:
        self.light_background = enabled
        if self.isValid():
            self.makeCurrent()
            self._apply_background_color()
            self.doneCurrent()
        self.update()

    def set_highlight_mode(self, enabled: bool) -> None:
        self.highlight_mode = enabled
        self.update()


class MainWindow(QMainWindow):
    def __init__(self) -> None:
        super().__init__()
        self.setWindowTitle("TPMS Studio")
        self.setMinimumSize(1120, 720)
        self.resize(1366, 768)
        self.current_result: MeshResult | None = None
        self.current_preview: PreviewMesh | None = None
        self.current_cfd_result: CFDMeshResult | None = None
        self.low_quality_preview: PreviewMesh | None = None
        self.region_preview: PreviewMesh | None = None
        self.worker_thread: QThread | None = None
        self.worker: MeshWorker | CFDMeshWorker | None = None
        self._gmsh_module = None
        self._gmsh_initialized_by_app = False
        self._build_toolbar()
        self._build_ui()
        self.setStatusBar(QStatusBar())
        self.statusBar().showMessage("OpenGL GPU 视口就绪")

    def _build_toolbar(self) -> None:
        toolbar = QToolBar("主工具栏")
        toolbar.setMovable(False)
        self.addToolBar(toolbar)
        brand = QLabel("TPMS Studio")
        brand.setObjectName("brand")
        toolbar.addWidget(brand)
        toolbar.addSeparator()
        self.export_action = QAction("导出模型", self)
        self.export_action.setShortcut("Ctrl+S")
        self.export_action.setEnabled(False)
        self.export_action.triggered.connect(self.export_current)
        toolbar.addAction(self.export_action)
        self.cfd_export_action = QAction("导出 COMSOL 流体网格", self)
        self.cfd_export_action.setEnabled(False)
        self.cfd_export_action.triggered.connect(self.export_comsol_mesh)
        toolbar.addAction(self.cfd_export_action)
        self.quality_report_action = QAction("网格质量", self)
        self.quality_report_action.setEnabled(False)
        self.quality_report_action.triggered.connect(self.show_quality_report)
        toolbar.addAction(self.quality_report_action)
        self.low_quality_action = QAction("低质量单元", self)
        self.low_quality_action.setCheckable(True)
        self.low_quality_action.setEnabled(False)
        self.low_quality_action.toggled.connect(self._toggle_low_quality_view)
        toolbar.addAction(self.low_quality_action)
        self.region_action = QAction("仿真区域", self)
        self.region_action.setCheckable(True)
        self.region_action.setEnabled(False)
        self.region_action.toggled.connect(self._toggle_region_view)
        toolbar.addAction(self.region_action)
        reset_action = QAction("重置视角", self)
        reset_action.triggered.connect(self.reset_view)
        toolbar.addAction(reset_action)
        toolbar.addSeparator()
        self.background_action = QAction("亮色背景", self)
        self.background_action.setCheckable(True)
        self.background_action.setChecked(False)
        self.background_action.toggled.connect(self.set_light_background)
        toolbar.addAction(self.background_action)

    @staticmethod
    def _double(value: float, low: float, high: float, suffix: str, step: float) -> QDoubleSpinBox:
        field = QDoubleSpinBox()
        field.setRange(low, high)
        field.setValue(value)
        field.setSingleStep(step)
        field.setDecimals(2 if step < 0.5 else 1)
        field.setSuffix(suffix)
        return field

    @staticmethod
    def _form_layout() -> QFormLayout:
        form = QFormLayout()
        form.setContentsMargins(0, 0, 0, 0)
        form.setHorizontalSpacing(12)
        form.setVerticalSpacing(6)
        form.setLabelAlignment(Qt.AlignRight | Qt.AlignVCenter)
        form.setFieldGrowthPolicy(QFormLayout.AllNonFixedFieldsGrow)
        return form

    @staticmethod
    def _axis_grid(fields: list[QWidget]) -> QVBoxLayout:
        layout = QVBoxLayout()
        layout.setContentsMargins(2, 2, 2, 0)
        layout.setSpacing(6)
        for axis, field in zip(("X", "Y", "Z"), fields):
            row = QHBoxLayout()
            row.setContentsMargins(0, 0, 0, 0)
            row.setSpacing(8)
            label = QLabel(axis)
            label.setObjectName("fieldAxis")
            label.setFixedWidth(18)
            label.setAlignment(Qt.AlignCenter)
            field.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            row.addWidget(label)
            row.addWidget(field, 1)
            layout.addLayout(row)
        return layout

    @staticmethod
    def _scroll_page(content: QWidget) -> QScrollArea:
        content.setObjectName("parameterPage")
        scroll = QScrollArea()
        scroll.setObjectName("parameterScroll")
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setVerticalScrollBarPolicy(Qt.ScrollBarAsNeeded)
        scroll.setFrameShape(QFrame.NoFrame)
        scroll.setWidget(content)
        return scroll

    def _build_ui(self) -> None:
        central = QWidget()
        central.setObjectName("centralRoot")
        root = QVBoxLayout(central)
        root.setContentsMargins(0, 0, 0, 0)
        root.setSpacing(0)
        self.setCentralWidget(central)

        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        root.addWidget(splitter, 1)

        parameter_deck = QWidget()
        parameter_deck.setObjectName("parameterDeck")
        parameter_deck.setMinimumWidth(480)
        parameter_deck.setMaximumWidth(600)
        deck_layout = QVBoxLayout(parameter_deck)
        deck_layout.setContentsMargins(12, 10, 12, 10)
        deck_layout.setSpacing(8)

        title = QLabel("参数设置")
        title.setObjectName("panelTitle")
        subtitle = QLabel("几何、结构与流体网格")
        subtitle.setObjectName("panelSubtitle")
        deck_layout.addWidget(title)
        deck_layout.addWidget(subtitle)

        self.parameter_tabs = QTabWidget()
        self.parameter_tabs.setObjectName("parameterTabs")
        self.parameter_tabs.setDocumentMode(True)
        self.parameter_tabs.tabBar().setExpanding(True)
        self.parameter_tabs.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Expanding)

        geometry_tab = QWidget()
        geometry_layout = QVBoxLayout(geometry_tab)
        geometry_layout.setContentsMargins(9, 8, 9, 10)
        geometry_layout.setSpacing(8)

        surface_group = QGroupBox("曲面与结构模式")
        surface_form = self._form_layout()
        self.surface_combo = QComboBox()
        for surface_name in ("Gyroid", "Diamond", "Primitive", "I-WP", "Neovius"):
            self.surface_combo.addItem(surface_name, surface_name)
        self.surface_combo.addItem("自定义公式", CUSTOM_SURFACE)
        self.surface_combo.currentIndexChanged.connect(self._update_formula_fields)
        self.surface_combo.setAccessibleName("TPMS 曲面类型")
        self.formula_edit = QLineEdit("gyroid")
        self.formula_edit.setPlaceholderText(
            "例如 min(gyroid, sqrt(x*x+y*y+z*z)-12)"
        )
        self.formula_edit.setToolTip(
            "支持 x、y、z、pi、sin、cos、sqrt、abs、exp、log，以及 min/max 组合"
        )
        self.formula_edit.setAccessibleName("自定义隐式公式")
        mode_widget = QWidget()
        mode_row = QHBoxLayout(mode_widget)
        mode_row.setContentsMargins(0, 0, 0, 0)
        mode_row.setSpacing(16)
        self.sheet_radio = QRadioButton("片层结构")
        self.solid_radio = QRadioButton("实体结构")
        self.sheet_radio.setChecked(True)
        self.sheet_radio.toggled.connect(self._update_mode_fields)
        mode_row.addWidget(self.sheet_radio)
        mode_row.addWidget(self.solid_radio)
        mode_row.addStretch(1)
        surface_form.addRow("曲面类型", self.surface_combo)
        surface_form.addRow("数学公式", self.formula_edit)
        surface_form.addRow("结构模式", mode_widget)
        surface_group.setLayout(surface_form)

        size_group = QGroupBox("外形尺寸 / mm")
        self.size_fields = [self._double(40.0, 2, 500, " mm", 1.0) for _ in range(3)]
        for axis, field in zip(("X", "Y", "Z"), self.size_fields):
            field.setAccessibleName(f"{axis} 方向外形尺寸")
        size_group.setLayout(self._axis_grid(self.size_fields))

        self.cell_group = QGroupBox("周期数量")
        self.cell_fields = [QSpinBox() for _ in range(3)]
        for axis, field in zip(("X", "Y", "Z"), self.cell_fields):
            field.setRange(1, 8)
            field.setValue(2)
            field.setAccessibleName(f"{axis} 方向周期数量")
        self.cell_group.setLayout(self._axis_grid(self.cell_fields))

        geometry_layout.addWidget(surface_group)
        geometry_layout.addWidget(size_group)
        geometry_layout.addWidget(self.cell_group)
        geometry_layout.addStretch(1)
        self.parameter_tabs.addTab(self._scroll_page(geometry_tab), "几何定义")

        structure_tab = QWidget()
        structure_layout = QVBoxLayout(structure_tab)
        structure_layout.setContentsMargins(9, 8, 9, 10)
        structure_layout.setSpacing(8)

        structure_group = QGroupBox("结构参数")
        structure_form = self._form_layout()
        # duplicate mode selector for convenience (synced with geometry tab)
        mode_struct_widget = QWidget()
        mode_struct_row = QHBoxLayout(mode_struct_widget)
        mode_struct_row.setContentsMargins(0, 0, 0, 0)
        mode_struct_row.setSpacing(16)
        self.sheet_radio_struct = QRadioButton("片层结构")
        self.solid_radio_struct = QRadioButton("实体结构")
        self.sheet_radio_struct.setChecked(True)
        # sync both radio sets
        self.sheet_radio.toggled.connect(lambda c: (self.sheet_radio_struct.blockSignals(True), self.sheet_radio_struct.setChecked(c), self.sheet_radio_struct.blockSignals(False)) if c else None)
        self.solid_radio.toggled.connect(lambda c: (self.solid_radio_struct.blockSignals(True), self.solid_radio_struct.setChecked(c), self.solid_radio_struct.blockSignals(False)) if c else None)
        self.sheet_radio_struct.toggled.connect(lambda c: (self.sheet_radio.blockSignals(True), self.sheet_radio.setChecked(c), self.sheet_radio.blockSignals(False), self._update_mode_fields()) if c else None)
        self.solid_radio_struct.toggled.connect(lambda c: (self.solid_radio.blockSignals(True), self.solid_radio.setChecked(c), self.solid_radio.blockSignals(False), self._update_mode_fields()) if c else None)
        mode_struct_row.addWidget(self.sheet_radio_struct)
        mode_struct_row.addWidget(self.solid_radio_struct)
        mode_struct_row.addStretch(1)
        self.thickness = self._double(1.2, 0.1, 20, " mm", 0.1)
        self.iso_level = self._double(0.0, -20, 20, "", 0.05)
        self.samples = QSpinBox()
        self.samples.setRange(16, 96)
        self.samples.setValue(64)
        self.thickness.setAccessibleName("目标壁厚")
        self.iso_level.setAccessibleName("等值面偏移")
        self.samples.setAccessibleName("模型网格精度")
        for field in (self.thickness, self.iso_level, self.samples):
            field.setMaximumWidth(420)
        structure_form.addRow("结构模式", mode_struct_widget)
        structure_form.addRow("目标壁厚", self.thickness)
        structure_form.addRow("等值面偏移", self.iso_level)
        structure_form.addRow("网格精度", self.samples)
        structure_group.setLayout(structure_form)

        gradient_group = QGroupBox("梯度壁厚")
        gradient_layout = QVBoxLayout(gradient_group)
        gradient_layout.setContentsMargins(10, 10, 10, 7)
        gradient_layout.setSpacing(5)
        self.gradient_enabled = QCheckBox("启用梯度壁厚（仅片层）")
        self.gradient_enabled.setToolTip("沿选定轴从起始厚度线性渐变至结束厚度，例如 Z 向 1→5 mm")
        self.gradient_enabled.toggled.connect(self._update_mode_fields)
        gradient_layout.addWidget(self.gradient_enabled)
        gradient_form = self._form_layout()
        self.gradient_axis = QComboBox()
        self.gradient_axis.addItems(["X", "Y", "Z"])
        self.gradient_axis.setCurrentText("Z")
        self.gradient_axis.setAccessibleName("梯度方向")
        self.gradient_thickness_start = self._double(1.0, 0.1, 20, " mm", 0.1)
        self.gradient_thickness_end = self._double(5.0, 0.1, 20, " mm", 0.1)
        self.gradient_thickness_start.setAccessibleName("梯度起始壁厚")
        self.gradient_thickness_end.setAccessibleName("梯度结束壁厚")
        self.gradient_thickness_start.setMaximumWidth(420)
        self.gradient_thickness_end.setMaximumWidth(420)
        gradient_form.addRow("梯度方向", self.gradient_axis)
        gradient_form.addRow("起始壁厚", self.gradient_thickness_start)
        gradient_form.addRow("结束壁厚", self.gradient_thickness_end)
        gradient_layout.addLayout(gradient_form)
        gradient_layout.addStretch(1)

        porosity_group = QGroupBox("孔隙率控制")
        porosity_layout = QVBoxLayout(porosity_group)
        porosity_layout.setContentsMargins(10, 10, 10, 7)
        porosity_layout.setSpacing(5)
        self.porosity_enabled = QCheckBox("按目标孔隙率自动求解")
        self.porosity_enabled.toggled.connect(self._update_mode_fields)
        porosity_layout.addWidget(self.porosity_enabled)
        porosity_form = self._form_layout()
        self.target_porosity = self._double(80.0, 5.0, 95.0, " %", 1.0)
        self.target_porosity.setEnabled(False)
        self.target_porosity.setAccessibleName("目标孔隙率")
        self.target_porosity.setMaximumWidth(420)
        porosity_form.addRow("目标孔隙率", self.target_porosity)
        porosity_layout.addLayout(porosity_form)
        porosity_layout.addStretch(1)

        gradient_group = QGroupBox("梯度壁厚")
        gradient_layout = QVBoxLayout(gradient_group)
        gradient_layout.setContentsMargins(10, 10, 10, 7)
        gradient_layout.setSpacing(5)
        self.gradient_enabled = QCheckBox("启用梯度壁厚（仅片层）")
        self.gradient_enabled.setToolTip("沿选定轴从起始厚度线性渐变至结束厚度，例如 Z 向 1→5 mm")
        self.gradient_enabled.toggled.connect(self._update_mode_fields)
        gradient_layout.addWidget(self.gradient_enabled)
        gradient_form = self._form_layout()
        self.gradient_axis = QComboBox()
        self.gradient_axis.addItems(["X", "Y", "Z"])
        self.gradient_axis.setCurrentText("Z")
        self.gradient_axis.setAccessibleName("梯度方向")
        self.gradient_thickness_start = self._double(1.0, 0.1, 20, " mm", 0.1)
        self.gradient_thickness_end = self._double(3.0, 0.1, 20, " mm", 0.1)
        self.gradient_thickness_start.setAccessibleName("梯度起始壁厚")
        self.gradient_thickness_end.setAccessibleName("梯度结束壁厚")
        self.gradient_thickness_start.setMaximumWidth(420)
        self.gradient_thickness_end.setMaximumWidth(420)
        gradient_form.addRow("梯度方向", self.gradient_axis)
        gradient_form.addRow("起始壁厚", self.gradient_thickness_start)
        gradient_form.addRow("结束壁厚", self.gradient_thickness_end)
        gradient_layout.addLayout(gradient_form)
        gradient_layout.addStretch(1)

        structure_layout.addWidget(structure_group)
        structure_layout.addWidget(gradient_group)
        structure_layout.addWidget(porosity_group)
        structure_layout.addStretch(1)
        self.parameter_tabs.addTab(self._scroll_page(structure_tab), "结构控制")

        cfd_tab = QWidget()
        cfd_layout = QVBoxLayout(cfd_tab)
        cfd_layout.setContentsMargins(9, 8, 9, 10)
        cfd_layout.setSpacing(8)

        cfd_base_group = QGroupBox("基础网格")
        cfd_form = self._form_layout()
        self.flow_axis = QComboBox()
        self.flow_axis.addItems(["X", "Y", "Z"])
        self.cfd_element_size = self._double(1.5, 0.05, 100.0, " mm", 0.1)
        self.cfd_surface_samples = QSpinBox()
        self.cfd_surface_samples.setRange(16, 96)
        self.cfd_surface_samples.setValue(32)
        self.flow_axis.setAccessibleName("CFD 流动方向")
        self.cfd_element_size.setAccessibleName("CFD 四面体尺寸")
        self.cfd_surface_samples.setAccessibleName("流体表面精度")
        self.flow_axis.currentTextChanged.connect(self._invalidate_region_preview)
        self.cfd_surface_samples.valueChanged.connect(self._invalidate_region_preview)
        cfd_form.addRow("流动方向", self.flow_axis)
        cfd_form.addRow("四面体尺寸", self.cfd_element_size)
        cfd_form.addRow("流体表面精度", self.cfd_surface_samples)
        cfd_base_group.setLayout(cfd_form)

        boundary_group = QGroupBox("棱柱边界层")
        boundary_layout = QVBoxLayout(boundary_group)
        boundary_layout.setContentsMargins(10, 10, 10, 7)
        boundary_layout.setSpacing(4)
        self.boundary_layer_enabled = QCheckBox("生成棱柱边界层")
        self.boundary_layer_enabled.toggled.connect(self._update_cfd_fields)
        self.boundary_layer_enabled.setToolTip(
            "边界层覆盖封闭流体域全部边界；厚度过大会因自交而拒绝导出"
        )
        boundary_layout.addWidget(self.boundary_layer_enabled)
        boundary_layer_form = self._form_layout()
        self.boundary_layer_layers = QSpinBox()
        self.boundary_layer_layers.setRange(1, 12)
        self.boundary_layer_layers.setValue(3)
        self.boundary_layer_first_height = self._double(0.05, 0.001, 10.0, " mm", 0.01)
        self.boundary_layer_first_height.setDecimals(3)
        self.boundary_layer_growth = self._double(1.2, 1.0, 2.0, "", 0.05)
        self.boundary_layer_layers.setAccessibleName("边界层层数")
        self.boundary_layer_first_height.setAccessibleName("边界层首层高度")
        self.boundary_layer_growth.setAccessibleName("边界层增长率")
        boundary_layer_form.addRow("边界层层数", self.boundary_layer_layers)
        boundary_layer_form.addRow("首层高度", self.boundary_layer_first_height)
        boundary_layer_form.addRow("增长率", self.boundary_layer_growth)
        boundary_layout.addLayout(boundary_layer_form)

        refinement_group = QGroupBox("端部加密")
        refinement_layout = QVBoxLayout(refinement_group)
        refinement_layout.setContentsMargins(10, 10, 10, 7)
        refinement_layout.setSpacing(4)
        self.end_refinement_enabled = QCheckBox("入口/出口局部加密")
        self.end_refinement_enabled.setChecked(True)
        self.end_refinement_enabled.toggled.connect(self._update_cfd_fields)
        refinement_layout.addWidget(self.end_refinement_enabled)
        refinement_form = self._form_layout()
        self.end_refinement_distance = self._double(2.0, 0.05, 100.0, " mm", 0.25)
        self.end_refinement_factor = self._double(50.0, 10.0, 100.0, " %", 5.0)
        self.end_refinement_distance.setAccessibleName("入口出口加密距离")
        self.end_refinement_factor.setAccessibleName("入口出口局部尺寸比例")
        refinement_form.addRow("加密距离", self.end_refinement_distance)
        refinement_form.addRow("局部尺寸", self.end_refinement_factor)
        refinement_layout.addLayout(refinement_form)
        refinement_layout.addStretch(1)

        quality_group = QGroupBox("曲率与质量")
        quality_layout = QVBoxLayout(quality_group)
        quality_layout.setContentsMargins(10, 10, 10, 7)
        quality_layout.setSpacing(4)
        self.curvature_refinement_enabled = QCheckBox("曲率自适应加密")
        self.curvature_refinement_enabled.setChecked(True)
        self.curvature_refinement_enabled.toggled.connect(self._update_cfd_fields)
        quality_layout.addWidget(self.curvature_refinement_enabled)
        quality_form = self._form_layout()
        self.curvature_points = QSpinBox()
        self.curvature_points.setRange(6, 60)
        self.curvature_points.setValue(18)
        self.low_quality_threshold = self._double(0.2, 0.01, 0.9, "", 0.05)
        self.curvature_points.setAccessibleName("每圆周曲率采样点")
        self.low_quality_threshold.setAccessibleName("低质量单元阈值")
        quality_form.addRow("每圆周采样点", self.curvature_points)
        quality_form.addRow("低质量阈值", self.low_quality_threshold)
        quality_layout.addLayout(quality_form)
        quality_layout.addStretch(1)

        cfd_layout.addWidget(cfd_base_group)
        cfd_layout.addWidget(boundary_group)
        cfd_layout.addWidget(refinement_group)
        cfd_layout.addWidget(quality_group)
        cfd_layout.addStretch(1)
        self.parameter_tabs.addTab(self._scroll_page(cfd_tab), "CFD 网格")
        deck_layout.addWidget(self.parameter_tabs, 1)

        self.generate_button = QPushButton("生成模型")
        self.generate_button.setObjectName("generateButton")
        self.generate_button.setShortcut("Ctrl+Return")
        self.generate_button.setToolTip("使用当前参数重新生成 TPMS 模型")
        self.generate_button.setAccessibleName("生成 TPMS 模型")
        self.generate_button.clicked.connect(self.generate)
        deck_layout.addWidget(self.generate_button)
        splitter.addWidget(parameter_deck)

        workspace = QWidget()
        workspace.setObjectName("workspace")
        workspace_layout = QVBoxLayout(workspace)
        workspace_layout.setContentsMargins(12, 9, 12, 11)
        workspace_layout.setSpacing(7)

        metrics_bar = QFrame()
        metrics_bar.setObjectName("metricsBar")
        metrics = QHBoxLayout(metrics_bar)
        metrics.setContentsMargins(12, 5, 12, 5)
        metrics.setSpacing(22)
        self.triangle_value = self._metric(metrics, "三角面", "--")
        self.volume_value = self._metric(metrics, "体积", "--")
        self.density_value = self._metric(metrics, "相对密度", "--")
        self.porosity_value = self._metric(metrics, "孔隙率", "--")
        metrics.addStretch(1)
        self.region_legend = QLabel()
        self.region_legend.setTextFormat(Qt.RichText)
        self.region_legend.setStyleSheet("color: #46514a;")
        self.region_legend.setVisible(False)
        metrics.addWidget(self.region_legend, 0, Qt.AlignVCenter)
        workspace_layout.addWidget(metrics_bar)
        self.viewport = OpenGLMeshView()
        self.viewport.error.connect(self._viewport_error)
        workspace_layout.addWidget(self.viewport, 1)
        splitter.addWidget(workspace)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([430, 1010])
        self._update_mode_fields()
        self._update_formula_fields()
        self._update_cfd_fields()

    @staticmethod
    def _metric(row: QHBoxLayout, name: str, value: str) -> QLabel:
        column = QVBoxLayout()
        label = QLabel(name)
        label.setObjectName("metricLabel")
        data = QLabel(value)
        data.setObjectName("metricValue")
        column.addWidget(label)
        column.addWidget(data)
        row.addLayout(column)
        return data

    def _update_mode_fields(self) -> None:
        # Ensure structure mode radios always selectable
        if hasattr(self, "sheet_radio"):
            self.sheet_radio.setEnabled(True)
            self.solid_radio.setEnabled(True)
        sheet = self.sheet_radio.isChecked()
        has_gradient = hasattr(self, "gradient_enabled")
        has_porosity = hasattr(self, "porosity_enabled")
        is_gradient = self.gradient_enabled.isChecked() if has_gradient else False
        automatic = self.porosity_enabled.isChecked() if has_porosity else False

        # mutual exclusion: gradient vs porosity
        if has_gradient and has_porosity:
            # gradient only for sheet; also disable porosity when gradient, and vice versa
            if is_gradient and automatic:
                # prefer gradient, clear porosity
                self.porosity_enabled.blockSignals(True)
                self.porosity_enabled.setChecked(False)
                self.porosity_enabled.blockSignals(False)
                automatic = False

        if has_gradient:
            self.gradient_enabled.setEnabled(sheet and not automatic)
            if (not sheet or automatic) and is_gradient:
                self.gradient_enabled.blockSignals(True)
                self.gradient_enabled.setChecked(False)
                self.gradient_enabled.blockSignals(False)
                is_gradient = False
            self.gradient_axis.setEnabled(is_gradient and sheet)
            self.gradient_thickness_start.setEnabled(is_gradient and sheet)
            self.gradient_thickness_end.setEnabled(is_gradient and sheet)

        if has_porosity:
            self.porosity_enabled.setEnabled(not is_gradient)
            if is_gradient and automatic:
                self.porosity_enabled.blockSignals(True)
                self.porosity_enabled.setChecked(False)
                self.porosity_enabled.blockSignals(False)
                automatic = False

        self.thickness.setEnabled(sheet and not automatic and not is_gradient)
        self.iso_level.setEnabled(not sheet and not automatic)
        if has_porosity and hasattr(self, "target_porosity"):
            self.target_porosity.setEnabled(automatic and not is_gradient)

    def _update_formula_fields(self) -> None:
        if hasattr(self, "formula_edit"):
            custom = self.surface_combo.currentData() == CUSTOM_SURFACE
            self.formula_edit.setEnabled(custom)
            self.cell_group.setVisible(not custom)

    def _update_cfd_fields(self) -> None:
        boundary_layer = self.boundary_layer_enabled.isChecked()
        self.boundary_layer_layers.setEnabled(boundary_layer)
        self.boundary_layer_first_height.setEnabled(boundary_layer)
        self.boundary_layer_growth.setEnabled(boundary_layer)
        end_refinement = self.end_refinement_enabled.isChecked()
        self.end_refinement_distance.setEnabled(end_refinement)
        self.end_refinement_factor.setEnabled(end_refinement)
        self.curvature_points.setEnabled(self.curvature_refinement_enabled.isChecked())

    def _invalidate_region_preview(self) -> None:
        if not hasattr(self, "region_action"):
            return
        self.region_preview = None
        self.region_legend.setVisible(False)
        self.region_action.blockSignals(True)
        self.region_action.setChecked(False)
        self.region_action.blockSignals(False)
        can_enable = self.current_result is not None and not (
            self.worker_thread is not None and self.worker_thread.isRunning()
        )
        self.region_action.setEnabled(can_enable)

    def _parameters(self) -> TPMSParameters:
        return TPMSParameters(
            surface=self.surface_combo.currentData() or self.surface_combo.currentText(),
            mode="sheet" if self.sheet_radio.isChecked() else "solid",
            size_x=self.size_fields[0].value(),
            size_y=self.size_fields[1].value(),
            size_z=self.size_fields[2].value(),
            cells_x=self.cell_fields[0].value(),
            cells_y=self.cell_fields[1].value(),
            cells_z=self.cell_fields[2].value(),
            thickness=self.thickness.value(),
            iso_level=self.iso_level.value(),
            samples_per_cell=self.samples.value(),
            target_porosity=(
                self.target_porosity.value() / 100.0
                if self.porosity_enabled.isChecked()
                else None
            ),
            formula=self.formula_edit.text(),
            gradient_enabled=self.gradient_enabled.isChecked() if hasattr(self, "gradient_enabled") else False,
            gradient_axis=self.gradient_axis.currentText() if hasattr(self, "gradient_axis") else "Z",
            gradient_thickness_start=self.gradient_thickness_start.value() if hasattr(self, "gradient_thickness_start") else 1.0,
            gradient_thickness_end=self.gradient_thickness_end.value() if hasattr(self, "gradient_thickness_end") else 3.0,
        )

    def _cfd_options(self) -> CFDMeshOptions:
        return CFDMeshOptions(
            flow_axis=self.flow_axis.currentText(),
            element_size=self.cfd_element_size.value(),
            surface_samples_per_cell=self.cfd_surface_samples.value(),
            boundary_layer_enabled=self.boundary_layer_enabled.isChecked(),
            boundary_layer_layers=self.boundary_layer_layers.value(),
            boundary_layer_first_height=self.boundary_layer_first_height.value(),
            boundary_layer_growth=self.boundary_layer_growth.value(),
            end_refinement_enabled=self.end_refinement_enabled.isChecked(),
            end_refinement_distance=self.end_refinement_distance.value(),
            end_refinement_size_factor=self.end_refinement_factor.value() / 100.0,
            curvature_refinement_enabled=self.curvature_refinement_enabled.isChecked(),
            curvature_points=self.curvature_points.value(),
            low_quality_threshold=self.low_quality_threshold.value(),
        )

    def _prepare_gmsh_for_worker(self) -> None:
        """Initialize Gmsh on the Python main thread before starting a QThread."""
        try:
            import gmsh
        except ImportError as exc:
            raise RuntimeError("缺少 Gmsh，请先运行 pip install gmsh") from exc

        if not gmsh.isInitialized():
            gmsh.initialize()
            self._gmsh_initialized_by_app = True
        gmsh.option.setNumber("General.Terminal", 0)
        self._gmsh_module = gmsh

    def _release_gmsh_after_worker(self) -> None:
        """Finalize a Gmsh runtime that this window initialized on the main thread."""
        gmsh = self._gmsh_module
        try:
            if gmsh is not None and self._gmsh_initialized_by_app and gmsh.isInitialized():
                gmsh.finalize()
        finally:
            self._gmsh_module = None
            self._gmsh_initialized_by_app = False

    def generate(self) -> None:
        if self.worker_thread is not None and self.worker_thread.isRunning():
            return
        parameters = self._parameters()
        try:
            parameters.validate()
        except ValueError as exc:
            QMessageBox.critical(self, "参数无效", str(exc))
            return
        self.generate_button.setEnabled(False)
        self.generate_button.setText("正在生成...")
        self.export_action.setEnabled(False)
        self.cfd_export_action.setEnabled(False)
        self.quality_report_action.setEnabled(False)
        self.low_quality_action.setChecked(False)
        self.low_quality_action.setEnabled(False)
        self.region_action.setChecked(False)
        self.region_action.setEnabled(False)
        self.current_cfd_result = None
        self.low_quality_preview = None
        self.region_preview = None
        self.region_legend.setVisible(False)
        self.statusBar().showMessage("正在生成完整网格和 GPU 预览网格...")
        self.worker_thread = QThread(self)
        self.worker = MeshWorker(parameters)
        self.worker.moveToThread(self.worker_thread)
        self.worker_thread.started.connect(self.worker.run)
        self.worker.finished.connect(self._generation_finished)
        self.worker.failed.connect(self._generation_failed)
        self.worker.finished.connect(self.worker_thread.quit)
        self.worker.failed.connect(self.worker_thread.quit)
        self.worker.finished.connect(self.worker.deleteLater)
        self.worker.failed.connect(self.worker.deleteLater)
        self.worker_thread.finished.connect(self.worker_thread.deleteLater)
        self.worker_thread.start()

    def _generation_finished(self, result: MeshResult, preview: PreviewMesh) -> None:
        self.current_result = result
        self.current_preview = preview
        self.viewport.set_mesh(preview)
        self.viewport.set_highlight_mode(False)
        self.triangle_value.setText(f"{result.triangles:,}")
        self.volume_value.setText(f"{result.volume:,.1f} mm³")
        self.density_value.setText(f"{result.relative_density * 100:.1f}%")
        self.porosity_value.setText(f"{result.porosity * 100:.2f}%")
        self.thickness.setValue(result.parameters.thickness)
        self.iso_level.setValue(result.parameters.iso_level)
        self.generate_button.setEnabled(True)
        self.generate_button.setText("生成模型")
        self.export_action.setEnabled(True)
        self.cfd_export_action.setEnabled(True)
        # 网格质量分析可以按需生成临时 CFD 体网格，不必先正式导出。
        self.quality_report_action.setEnabled(True)
        self.region_action.setEnabled(True)
        cleanup = (
            f" · 已清理 {result.removed_components} 个孤立碎片"
            if result.removed_components
            else ""
        )
        target_status = ""
        if result.parameters.target_porosity is not None:
            error = (result.porosity - result.parameters.target_porosity) * 100.0
            solved = (
                f"壁厚 {result.parameters.thickness:.3f} mm"
                if result.parameters.mode == "sheet"
                else f"等值面 {result.parameters.iso_level:.4f}"
            )
            target_status = f" · {solved} · 孔隙率误差 {error:+.2f}%"
        gradient_status = ""
        if result.parameters.gradient_enabled:
            gradient_status = (
                f" · 梯度 {result.parameters.gradient_thickness_start:.2f}"
                f"->{result.parameters.gradient_thickness_end:.2f} mm"
                f" {result.parameters.gradient_axis}向"
            )
        self.statusBar().showMessage(
            f"生成完成 · GPU 显示 {preview.triangles:,} 面 · 导出 {result.triangles:,} 面"
            f"{target_status}{gradient_status}{cleanup}"
        )
        self.worker_thread = None
        self.worker = None

    def _generation_failed(self, message: str) -> None:
        self.generate_button.setEnabled(True)
        self.generate_button.setText("生成模型")
        self.statusBar().showMessage("生成失败")
        QMessageBox.critical(self, "无法生成模型", message)
        self.worker_thread = None
        self.worker = None

    def _viewport_error(self, message: str) -> None:
        self.statusBar().showMessage("OpenGL 初始化失败")
        QMessageBox.critical(self, "GPU 视口初始化失败", message)

    def reset_view(self) -> None:
        self.viewport.reset_view()

    def set_light_background(self, enabled: bool) -> None:
        self.viewport.set_light_background(enabled)
        mode = "亮色" if enabled else "暗色"
        self.statusBar().showMessage(f"已切换为{mode}背景")

    def export_current(self) -> None:
        if self.current_result is None:
            return
        default_name = f"{self.current_result.parameters.surface.lower()}_tpms.stl"
        destination, selected_filter = QFileDialog.getSaveFileName(
            self,
            "导出 TPMS 模型",
            str(Path.cwd() / default_name),
            "STL 网格 (*.stl);;OBJ 网格 (*.obj);;PLY 网格 (*.ply)",
        )
        if not destination:
            return
        if not Path(destination).suffix:
            destination += ".obj" if "OBJ" in selected_filter else ".ply" if "PLY" in selected_filter else ".stl"
        try:
            path = export_mesh(self.current_result, destination)
            self.statusBar().showMessage(f"已导出 {path}")
        except Exception as exc:
            QMessageBox.critical(self, "导出失败", str(exc))

    def export_comsol_mesh(self) -> None:
        if self.current_result is None:
            return
        if self.worker_thread is not None and self.worker_thread.isRunning():
            return
        default_name = f"{self.current_result.parameters.surface.lower()}_fluid.bdf"
        destination, _selected_filter = QFileDialog.getSaveFileName(
            self,
            "导出 COMSOL 流体体网格",
            str(Path.cwd() / default_name),
            "NASTRAN 体网格 (*.bdf)",
        )
        if not destination:
            return
        options = self._cfd_options()
        try:
            parameters = self.current_result.parameters
            options.validate((parameters.size_x, parameters.size_y, parameters.size_z))
        except ValueError as exc:
            QMessageBox.critical(self, "参数无效", str(exc))
            return
        try:
            self._prepare_gmsh_for_worker()
        except RuntimeError as exc:
            QMessageBox.critical(self, "COMSOL 网格不可用", str(exc))
            return

        self.generate_button.setEnabled(False)
        self.export_action.setEnabled(False)
        self.cfd_export_action.setEnabled(False)
        self.quality_report_action.setEnabled(False)
        self.low_quality_action.setChecked(False)
        self.low_quality_action.setEnabled(False)
        self.region_action.setChecked(False)
        self.region_action.setEnabled(False)
        self.region_legend.setVisible(False)
        self.statusBar().showMessage("正在准备 COMSOL 流体体网格...")
        self.worker_thread = QThread(self)
        self.worker = CFDMeshWorker(
            self.current_result.parameters,
            Path(destination),
            options,
        )
        self.worker.moveToThread(self.worker_thread)
        self.worker_thread.started.connect(self.worker.run)
        self.worker.progress.connect(self.statusBar().showMessage)
        self.worker.finished.connect(self._cfd_export_finished)
        self.worker.failed.connect(self._cfd_export_failed)
        self.worker.finished.connect(self.worker_thread.quit)
        self.worker.failed.connect(self.worker_thread.quit)
        self.worker.finished.connect(self.worker.deleteLater)
        self.worker.failed.connect(self.worker.deleteLater)
        self.worker_thread.finished.connect(self.worker_thread.deleteLater)
        self.worker_thread.start()

    def _cfd_export_finished(self, result: CFDMeshResult) -> None:
        self._set_cfd_result(result)
        self._release_gmsh_after_worker()
        self.generate_button.setEnabled(True)
        self.export_action.setEnabled(True)
        self.cfd_export_action.setEnabled(True)
        self.statusBar().showMessage(
            f"COMSOL 体网格已导出 · {result.nodes:,} 节点 · "
            f"{result.volume_elements:,} 体单元 · 最小缩放雅可比 "
            f"{result.quality.minimum:.3f}"
        )
        QMessageBox.information(
            self,
            "COMSOL 流体网格已导出",
            f"NASTRAN: {result.bdf_path}\n"
            f"Gmsh: {result.msh_path}\n"
            f"边界元数据: {result.metadata_path}\n\n"
            f"质量场: {result.quality_path}\n\n"
            f"流体域: {result.fluid_domains}\n"
            f"节点: {result.nodes:,}\n"
            f"四面体: {result.tetrahedra:,}\n"
            f"棱柱: {result.prisms:,}\n"
            f"最小缩放雅可比: {result.quality.minimum:.3f}\n"
            f"低质量单元: {result.quality.low_quality_elements:,}",
        )
        MeshQualityDialog(result, self).exec_()
        self.worker_thread = None
        self.worker = None

    def _cfd_export_failed(self, message: str) -> None:
        self._release_gmsh_after_worker()
        self.generate_button.setEnabled(True)
        self.export_action.setEnabled(self.current_result is not None)
        self.cfd_export_action.setEnabled(self.current_result is not None)
        self.quality_report_action.setEnabled(self.current_cfd_result is not None)
        self.low_quality_action.setEnabled(
            self.current_cfd_result is not None
            and self.current_cfd_result.quality.low_quality_elements > 0
        )
        self.region_action.setEnabled(False)
        self.region_legend.setVisible(False)
        self.statusBar().showMessage("COMSOL 体网格导出失败")
        QMessageBox.critical(self, "COMSOL 体网格导出失败", message)
        self.worker_thread = None
        self.worker = None

    def show_quality_report(self) -> None:
        if self.current_cfd_result is not None:
            MeshQualityDialog(self.current_cfd_result, self).exec_()
            return
        self._start_quality_preview()

    def _set_cfd_result(self, result: CFDMeshResult) -> None:
        self.current_cfd_result = result
        self.low_quality_preview = PreviewMesh(
            vertices=result.low_quality_vertices,
            faces=result.low_quality_faces,
        )
        self.region_preview = result.region_preview
        self.quality_report_action.setEnabled(True)
        self.low_quality_action.setEnabled(result.quality.low_quality_elements > 0)
        self.region_action.setEnabled(result.region_preview.triangles > 0)

    def _start_quality_preview(self) -> None:
        if self.current_result is None:
            self.quality_report_action.setEnabled(False)
            return
        if self.worker_thread is not None and self.worker_thread.isRunning():
            return
        options = self._cfd_options()
        try:
            parameters = self.current_result.parameters
            options.validate((parameters.size_x, parameters.size_y, parameters.size_z))
        except ValueError as exc:
            QMessageBox.critical(self, "参数无效", str(exc))
            return
        try:
            self._prepare_gmsh_for_worker()
        except RuntimeError as exc:
            QMessageBox.critical(self, "网格质量分析不可用", str(exc))
            return

        # 质量报告只需要计算结果，使用临时目录避免覆盖用户尚未导出的文件。
        preview_dir = Path(tempfile.mkdtemp(prefix="tpms-quality-"))
        destination = preview_dir / "quality_preview.bdf"
        self.generate_button.setEnabled(False)
        self.export_action.setEnabled(False)
        self.cfd_export_action.setEnabled(False)
        self.quality_report_action.setEnabled(False)
        self.low_quality_action.setChecked(False)
        self.low_quality_action.setEnabled(False)
        self.region_action.setChecked(False)
        self.region_action.setEnabled(False)
        self.region_legend.setVisible(False)
        self.statusBar().showMessage("正在生成网格质量分析数据...")
        self.worker_thread = QThread(self)
        self.worker = CFDMeshWorker(parameters, destination, options)
        self.worker.moveToThread(self.worker_thread)
        self.worker_thread.started.connect(self.worker.run)
        self.worker.progress.connect(self.statusBar().showMessage)
        self.worker.finished.connect(self._quality_preview_finished)
        self.worker.failed.connect(self._quality_preview_failed)
        self.worker.finished.connect(self.worker_thread.quit)
        self.worker.failed.connect(self.worker_thread.quit)
        self.worker.finished.connect(self.worker.deleteLater)
        self.worker.failed.connect(self.worker.deleteLater)
        self.worker_thread.finished.connect(self.worker_thread.deleteLater)
        self.worker_thread.start()

    def _quality_preview_finished(self, result: CFDMeshResult) -> None:
        self._set_cfd_result(result)
        self._release_gmsh_after_worker()
        self.generate_button.setEnabled(True)
        self.export_action.setEnabled(self.current_result is not None)
        self.cfd_export_action.setEnabled(self.current_result is not None)
        self.statusBar().showMessage(
            f"网格质量分析完成 · {result.nodes:,} 节点 · "
            f"{result.volume_elements:,} 体单元 · 最小缩放雅可比 "
            f"{result.quality.minimum:.3f}"
        )
        self.worker_thread = None
        self.worker = None
        MeshQualityDialog(result, self).exec_()

    def _quality_preview_failed(self, message: str) -> None:
        self._release_gmsh_after_worker()
        self.generate_button.setEnabled(True)
        self.export_action.setEnabled(self.current_result is not None)
        self.cfd_export_action.setEnabled(self.current_result is not None)
        self.quality_report_action.setEnabled(False)
        self.low_quality_action.setChecked(False)
        self.low_quality_action.setEnabled(False)
        self.region_action.setChecked(False)
        self.region_action.setEnabled(self.current_result is not None)
        self.region_legend.setVisible(False)
        self.statusBar().showMessage("网格质量分析失败")
        QMessageBox.critical(self, "网格质量分析失败", message)
        self.worker_thread = None
        self.worker = None

    def _toggle_low_quality_view(self, enabled: bool) -> None:
        if enabled:
            self.region_action.setChecked(False)
        preview = self.low_quality_preview if enabled else self.current_preview
        if preview is None or preview.triangles == 0:
            if enabled:
                self.low_quality_action.setChecked(False)
            return
        self.viewport.set_mesh(preview)
        self.viewport.set_highlight_mode(enabled)
        if enabled and self.current_cfd_result is not None:
            quality = self.current_cfd_result.quality
            self.statusBar().showMessage(
                f"显示缩放雅可比 < {quality.low_quality_threshold:.2f} 的 "
                f"{quality.low_quality_elements:,} 个体单元"
            )
        elif self.current_result is not None:
            self.statusBar().showMessage("已返回 TPMS 模型预览")

    def _toggle_region_view(self, enabled: bool) -> None:
        if enabled:
            if self.current_result is None:
                self.region_action.setChecked(False)
                return
            if self.region_preview is None:
                if self.worker_thread is not None and self.worker_thread.isRunning():
                    self.region_action.setChecked(False)
                    return
                options = self._cfd_options()
                self.region_action.setEnabled(False)
                self.region_legend.setVisible(False)
                self.statusBar().showMessage("正在生成仿真区域预览...")
                self.worker_thread = QThread(self)
                self.worker = SimulationRegionWorker(
                    self.current_result.parameters,
                    options,
                )
                self.worker.moveToThread(self.worker_thread)
                self.worker_thread.started.connect(self.worker.run)
                self.worker.finished.connect(self._region_preview_finished)
                self.worker.failed.connect(self._region_preview_failed)
                self.worker.finished.connect(self.worker_thread.quit)
                self.worker.failed.connect(self.worker_thread.quit)
                self.worker.finished.connect(self.worker.deleteLater)
                self.worker.failed.connect(self.worker.deleteLater)
                self.worker_thread.finished.connect(self.worker_thread.deleteLater)
                self.worker_thread.start()
                return
            self.low_quality_action.setChecked(False)
        preview = self.region_preview if enabled else self.current_preview
        if preview is None or preview.triangles == 0:
            if enabled:
                self.region_action.setChecked(False)
            return
        self.viewport.set_mesh(preview)
        self.viewport.set_highlight_mode(False)
        self.region_legend.setVisible(enabled)
        if enabled:
            self.region_legend.setText(
                "仿真区域："
                "<span style='color:#296ff2'>● 入口</span>&nbsp;&nbsp;"
                "<span style='color:#f0601f'>● 出口</span>&nbsp;&nbsp;"
                "<span style='color:#20ad66'>● 壁面</span>"
            )
            self.statusBar().showMessage("已显示仿真区域：入口、出口和壁面")
        elif self.current_result is not None:
            self.statusBar().showMessage("已返回 TPMS 模型预览")

    def _region_preview_finished(self, preview: PreviewMesh) -> None:
        self.region_preview = preview
        self.region_action.setEnabled(True)
        self.worker_thread = None
        self.worker = None
        self._toggle_region_view(True)

    def _region_preview_failed(self, message: str) -> None:
        self.region_action.setChecked(False)
        self.region_action.setEnabled(self.current_result is not None)
        self.region_legend.setVisible(False)
        self.statusBar().showMessage("仿真区域预览失败")
        QMessageBox.critical(self, "仿真区域预览失败", message)
        self.worker_thread = None
        self.worker = None


def main() -> int:
    surface_format = QSurfaceFormat()
    surface_format.setRenderableType(QSurfaceFormat.OpenGL)
    surface_format.setVersion(3, 3)
    surface_format.setProfile(QSurfaceFormat.CoreProfile)
    surface_format.setDepthBufferSize(24)
    surface_format.setSamples(4)
    surface_format.setSwapInterval(1)
    QSurfaceFormat.setDefaultFormat(surface_format)

    app = QApplication(sys.argv)
    app.setApplicationName("TPMS Studio")
    app.setStyle("Fusion")
    app.setStyleSheet(STYLE)
    window = MainWindow()
    window.show()
    QTimer.singleShot(250, window.generate)
    return app.exec_()


if __name__ == "__main__":
    raise SystemExit(main())
