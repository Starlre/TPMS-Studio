from __future__ import annotations

import ctypes
import sys
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
    QHBoxLayout,
    QLabel,
    QMainWindow,
    QMessageBox,
    QOpenGLWidget,
    QPushButton,
    QRadioButton,
    QScrollArea,
    QSpinBox,
    QSplitter,
    QStatusBar,
    QToolBar,
    QVBoxLayout,
    QWidget,
)

from comsol_mesh import (
    CFDMeshOptions,
    CFDMeshResult,
    export_comsol_fluid_mesh,
)
from tpms_core import (
    MeshResult,
    PreviewMesh,
    TPMSParameters,
    export_mesh,
    generate_tpms,
    simplify_mesh_for_preview,
)


STYLE = """
QMainWindow, QWidget { background: #f2f5f4; color: #202622; }
QToolBar { background: #ffffff; border: none; border-bottom: 1px solid #d9dfdb; spacing: 7px; padding: 8px 14px; }
QToolBar QLabel#brand { color: #18201c; font-size: 17px; font-weight: 600; padding-right: 18px; }
QToolButton { background: transparent; border: none; border-radius: 4px; padding: 7px 10px; }
QToolButton:hover { background: #edf1ee; }
QToolButton:checked { background: #e5f1ed; color: #0d654f; }
QScrollArea { border: none; background: #ffffff; }
QWidget#parameterPanel { background: #ffffff; }
QLabel#sectionTitle { color: #46514a; font-size: 12px; font-weight: 600; padding-top: 8px; }
QLabel#metricLabel { color: #667069; font-size: 11px; }
QLabel#metricValue { color: #18201c; font-size: 14px; font-weight: 600; }
QComboBox, QDoubleSpinBox, QSpinBox { background: #ffffff; border: 1px solid #cfd6d1; border-radius: 4px; min-height: 30px; padding: 0 8px; }
QComboBox:focus, QDoubleSpinBox:focus, QSpinBox:focus { border: 1px solid #187b62; }
QPushButton, QRadioButton { background: #ffffff; border: 1px solid #cfd6d1; border-radius: 4px; min-height: 30px; padding: 0 12px; }
QPushButton:hover, QRadioButton:hover { background: #eef2ef; }
QRadioButton:checked { background: #e5f1ed; color: #0d654f; border-color: #65a996; }
QPushButton#generateButton { background: #176f59; color: #ffffff; border: 1px solid #176f59; min-height: 38px; font-weight: 600; }
QPushButton#generateButton:hover { background: #115e4a; }
QPushButton#generateButton:disabled { background: #97aaa2; border-color: #97aaa2; }
QFrame#separator { background: #e5e8e6; max-height: 1px; }
QStatusBar { background: #ffffff; border-top: 1px solid #d9dfdb; color: #5d6761; }
QSplitter::handle { background: #d9dfdb; width: 1px; }
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
        self.setMinimumSize(560, 500)
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
        uniform mat4 u_mvp;
        uniform mat4 u_model;
        uniform float u_outline_mode;
        uniform float u_outline_width;
        out vec3 v_normal;
        out vec3 v_world;
        void main() {
            vec3 position = a_position + a_normal * u_outline_width * u_outline_mode;
            vec4 world = u_model * vec4(position, 1.0);
            v_world = world.xyz;
            v_normal = normalize(mat3(u_model) * a_normal);
            gl_Position = u_mvp * vec4(position, 1.0);
        }
        """
        fragment_source = """
        #version 330 core
        in vec3 v_normal;
        in vec3 v_world;
        uniform vec3 u_camera;
        uniform float u_light_background;
        uniform float u_highlight_mode;
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
        return np.column_stack((vertices, normals)).astype(np.float32), faces

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
        stride = 6 * np.dtype(np.float32).itemsize
        self.program.enableAttributeArray(0)
        self.program.setAttributeBuffer(0, 0x1406, 0, 3, stride)
        self.program.enableAttributeArray(1)
        self.program.setAttributeBuffer(1, 0x1406, 3 * 4, 3, stride)
        self.program.release()
        self.ibo.release()
        self.vbo.release()
        self.vao.release()
        self.index_count = int(faces.size)
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
        self.setMinimumSize(1020, 700)
        self.resize(1320, 840)
        self.current_result: MeshResult | None = None
        self.current_preview: PreviewMesh | None = None
        self.current_cfd_result: CFDMeshResult | None = None
        self.low_quality_preview: PreviewMesh | None = None
        self.worker_thread: QThread | None = None
        self.worker: MeshWorker | CFDMeshWorker | None = None
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
    def _section(layout: QVBoxLayout, text: str) -> None:
        label = QLabel(text)
        label.setObjectName("sectionTitle")
        layout.addWidget(label)

    @staticmethod
    def _separator(layout: QVBoxLayout) -> None:
        line = QFrame()
        line.setObjectName("separator")
        line.setFrameShape(QFrame.HLine)
        layout.addWidget(line)

    @staticmethod
    def _double(value: float, low: float, high: float, suffix: str, step: float) -> QDoubleSpinBox:
        field = QDoubleSpinBox()
        field.setRange(low, high)
        field.setValue(value)
        field.setSingleStep(step)
        field.setDecimals(2 if step < 0.5 else 1)
        field.setSuffix(suffix)
        return field

    def _build_ui(self) -> None:
        splitter = QSplitter(Qt.Horizontal)
        splitter.setChildrenCollapsible(False)
        self.setCentralWidget(splitter)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        scroll.setMinimumWidth(420)
        scroll.setMaximumWidth(460)
        panel = QWidget()
        panel.setObjectName("parameterPanel")
        controls = QVBoxLayout(panel)
        controls.setContentsMargins(20, 16, 20, 20)
        controls.setSpacing(10)

        self._section(controls, "曲面定义")
        form = QFormLayout()
        self.surface_combo = QComboBox()
        self.surface_combo.addItems(["Gyroid", "Diamond", "Primitive", "I-WP", "Neovius"])
        form.addRow("TPMS 类型", self.surface_combo)
        controls.addLayout(form)
        mode_row = QHBoxLayout()
        self.sheet_radio = QRadioButton("片层结构")
        self.solid_radio = QRadioButton("实体结构")
        self.sheet_radio.setChecked(True)
        self.sheet_radio.toggled.connect(self._update_mode_fields)
        mode_row.addWidget(self.sheet_radio)
        mode_row.addWidget(self.solid_radio)
        controls.addLayout(mode_row)
        self._separator(controls)

        self._section(controls, "外形尺寸 / mm")
        size_grid = QGridLayout()
        self.size_fields = [self._double(40.0, 2, 500, " mm", 1.0) for _ in range(3)]
        for column, name in enumerate(("X", "Y", "Z")):
            size_grid.addWidget(QLabel(name), 0, column)
            size_grid.addWidget(self.size_fields[column], 1, column)
        controls.addLayout(size_grid)
        self._section(controls, "周期数量")
        cell_grid = QGridLayout()
        self.cell_fields = [QSpinBox() for _ in range(3)]
        for column, name in enumerate(("X", "Y", "Z")):
            self.cell_fields[column].setRange(1, 8)
            self.cell_fields[column].setValue(2)
            cell_grid.addWidget(QLabel(name), 0, column)
            cell_grid.addWidget(self.cell_fields[column], 1, column)
        controls.addLayout(cell_grid)
        self._separator(controls)

        self._section(controls, "结构参数")
        structure = QFormLayout()
        self.thickness = self._double(1.2, 0.1, 20, " mm", 0.1)
        self.iso_level = self._double(0.0, -20, 20, "", 0.05)
        self.samples = QSpinBox()
        self.samples.setRange(16, 96)
        self.samples.setValue(64)
        structure.addRow("目标壁厚", self.thickness)
        structure.addRow("等值面偏移", self.iso_level)
        structure.addRow("网格精度", self.samples)
        controls.addLayout(structure)
        self.porosity_enabled = QCheckBox("按目标孔隙率自动求解")
        self.porosity_enabled.toggled.connect(self._update_mode_fields)
        controls.addWidget(self.porosity_enabled)
        porosity_form = QFormLayout()
        self.target_porosity = self._double(80.0, 5.0, 95.0, " %", 1.0)
        self.target_porosity.setEnabled(False)
        porosity_form.addRow("目标孔隙率", self.target_porosity)
        controls.addLayout(porosity_form)
        hint = QLabel("GPU 实时预览，导出保留完整高精度封闭网格。")
        hint.setStyleSheet("color: #667069;")
        hint.setWordWrap(True)
        controls.addWidget(hint)

        self._separator(controls)
        self._section(controls, "COMSOL 流体体网格")
        cfd_form = QFormLayout()
        self.flow_axis = QComboBox()
        self.flow_axis.addItems(["X", "Y", "Z"])
        self.cfd_element_size = self._double(1.5, 0.05, 100.0, " mm", 0.1)
        self.cfd_surface_samples = QSpinBox()
        self.cfd_surface_samples.setRange(16, 96)
        self.cfd_surface_samples.setValue(32)
        cfd_form.addRow("流动方向", self.flow_axis)
        cfd_form.addRow("四面体尺寸", self.cfd_element_size)
        cfd_form.addRow("流体表面精度", self.cfd_surface_samples)
        controls.addLayout(cfd_form)

        self.boundary_layer_enabled = QCheckBox("生成棱柱边界层")
        self.boundary_layer_enabled.toggled.connect(self._update_cfd_fields)
        controls.addWidget(self.boundary_layer_enabled)
        boundary_layer_form = QFormLayout()
        self.boundary_layer_layers = QSpinBox()
        self.boundary_layer_layers.setRange(1, 12)
        self.boundary_layer_layers.setValue(3)
        self.boundary_layer_first_height = self._double(0.05, 0.001, 10.0, " mm", 0.01)
        self.boundary_layer_first_height.setDecimals(3)
        self.boundary_layer_growth = self._double(1.2, 1.0, 2.0, "", 0.05)
        boundary_layer_form.addRow("边界层层数", self.boundary_layer_layers)
        boundary_layer_form.addRow("首层高度", self.boundary_layer_first_height)
        boundary_layer_form.addRow("增长率", self.boundary_layer_growth)
        controls.addLayout(boundary_layer_form)

        self.end_refinement_enabled = QCheckBox("入口/出口局部加密")
        self.end_refinement_enabled.setChecked(True)
        self.end_refinement_enabled.toggled.connect(self._update_cfd_fields)
        controls.addWidget(self.end_refinement_enabled)
        refinement_form = QFormLayout()
        self.end_refinement_distance = self._double(2.0, 0.05, 100.0, " mm", 0.25)
        self.end_refinement_factor = self._double(50.0, 10.0, 100.0, " %", 5.0)
        refinement_form.addRow("加密距离", self.end_refinement_distance)
        refinement_form.addRow("局部尺寸", self.end_refinement_factor)
        controls.addLayout(refinement_form)

        self.curvature_refinement_enabled = QCheckBox("曲率自适应加密")
        self.curvature_refinement_enabled.setChecked(True)
        self.curvature_refinement_enabled.toggled.connect(self._update_cfd_fields)
        controls.addWidget(self.curvature_refinement_enabled)
        quality_form = QFormLayout()
        self.curvature_points = QSpinBox()
        self.curvature_points.setRange(6, 60)
        self.curvature_points.setValue(18)
        self.low_quality_threshold = self._double(0.2, 0.01, 0.9, "", 0.05)
        quality_form.addRow("每圆周采样点", self.curvature_points)
        quality_form.addRow("低质量阈值", self.low_quality_threshold)
        controls.addLayout(quality_form)

        cfd_hint = QLabel("棱柱层覆盖封闭流体域全部边界；厚度过大会因自交而拒绝导出。")
        cfd_hint.setStyleSheet("color: #667069;")
        cfd_hint.setWordWrap(True)
        controls.addWidget(cfd_hint)
        controls.addStretch(1)
        self.generate_button = QPushButton("生成模型")
        self.generate_button.setObjectName("generateButton")
        self.generate_button.setShortcut("Ctrl+Return")
        self.generate_button.clicked.connect(self.generate)
        controls.addWidget(self.generate_button)
        scroll.setWidget(panel)
        splitter.addWidget(scroll)

        right = QWidget()
        right_layout = QVBoxLayout(right)
        right_layout.setContentsMargins(14, 10, 14, 12)
        metrics = QHBoxLayout()
        self.triangle_value = self._metric(metrics, "三角面", "--")
        self.volume_value = self._metric(metrics, "体积", "--")
        self.density_value = self._metric(metrics, "相对密度", "--")
        self.porosity_value = self._metric(metrics, "孔隙率", "--")
        metrics.addStretch(1)
        right_layout.addLayout(metrics)
        self.viewport = OpenGLMeshView()
        self.viewport.error.connect(self._viewport_error)
        right_layout.addWidget(self.viewport, 1)
        splitter.addWidget(right)
        splitter.setStretchFactor(0, 0)
        splitter.setStretchFactor(1, 1)
        splitter.setSizes([430, 890])
        self._update_mode_fields()
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
        sheet = self.sheet_radio.isChecked()
        automatic = self.porosity_enabled.isChecked() if hasattr(self, "porosity_enabled") else False
        self.thickness.setEnabled(sheet and not automatic)
        self.iso_level.setEnabled(not sheet and not automatic)
        if hasattr(self, "target_porosity"):
            self.target_porosity.setEnabled(automatic)

    def _update_cfd_fields(self) -> None:
        boundary_layer = self.boundary_layer_enabled.isChecked()
        self.boundary_layer_layers.setEnabled(boundary_layer)
        self.boundary_layer_first_height.setEnabled(boundary_layer)
        self.boundary_layer_growth.setEnabled(boundary_layer)
        end_refinement = self.end_refinement_enabled.isChecked()
        self.end_refinement_distance.setEnabled(end_refinement)
        self.end_refinement_factor.setEnabled(end_refinement)
        self.curvature_points.setEnabled(self.curvature_refinement_enabled.isChecked())

    def _parameters(self) -> TPMSParameters:
        return TPMSParameters(
            surface=self.surface_combo.currentText(),
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
        )

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
        self.current_cfd_result = None
        self.low_quality_preview = None
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
        self.statusBar().showMessage(
            f"生成完成 · GPU 显示 {preview.triangles:,} 面 · 导出 {result.triangles:,} 面"
            f"{target_status}{cleanup}"
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
        options = CFDMeshOptions(
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
        try:
            parameters = self.current_result.parameters
            options.validate((parameters.size_x, parameters.size_y, parameters.size_z))
        except ValueError as exc:
            QMessageBox.critical(self, "参数无效", str(exc))
            return

        self.generate_button.setEnabled(False)
        self.export_action.setEnabled(False)
        self.cfd_export_action.setEnabled(False)
        self.quality_report_action.setEnabled(False)
        self.low_quality_action.setChecked(False)
        self.low_quality_action.setEnabled(False)
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
        self.current_cfd_result = result
        self.low_quality_preview = PreviewMesh(
            vertices=result.low_quality_vertices,
            faces=result.low_quality_faces,
        )
        self.generate_button.setEnabled(True)
        self.export_action.setEnabled(True)
        self.cfd_export_action.setEnabled(True)
        self.quality_report_action.setEnabled(True)
        self.low_quality_action.setEnabled(result.quality.low_quality_elements > 0)
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
        self.generate_button.setEnabled(True)
        self.export_action.setEnabled(self.current_result is not None)
        self.cfd_export_action.setEnabled(self.current_result is not None)
        self.quality_report_action.setEnabled(self.current_cfd_result is not None)
        self.low_quality_action.setEnabled(
            self.current_cfd_result is not None
            and self.current_cfd_result.quality.low_quality_elements > 0
        )
        self.statusBar().showMessage("COMSOL 体网格导出失败")
        QMessageBox.critical(self, "COMSOL 体网格导出失败", message)
        self.worker_thread = None
        self.worker = None

    def show_quality_report(self) -> None:
        if self.current_cfd_result is not None:
            MeshQualityDialog(self.current_cfd_result, self).exec_()

    def _toggle_low_quality_view(self, enabled: bool) -> None:
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
