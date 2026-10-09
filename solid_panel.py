"""Qt object editor for implicit primitives and CSG combinations."""
from dataclasses import replace
from pathlib import Path

from PyQt5.QtCore import Qt, pyqtSignal
from PyQt5.QtWidgets import (QWidget, QVBoxLayout, QHBoxLayout, QFormLayout,
    QGroupBox, QLabel, QPushButton, QComboBox, QDoubleSpinBox, QLineEdit,
    QListWidget, QListWidgetItem, QScrollArea, QFileDialog, QSizePolicy)

from solid_model import KINDS, OPERATIONS, SolidScene, demo_scene


class SolidPanel(QWidget):
    changed = pyqtSignal()

    def __init__(self, parameters_provider, parent=None):
        super().__init__(parent)
        self.parameters_provider = parameters_provider
        self.scene = SolidScene()
        self._loading = False
        layout = QVBoxLayout(self)
        layout.setContentsMargins(0, 0, 0, 0)
        layout.setSpacing(8)
        self.message = QLabel("添加实体 → 选择 A/B → 创建组合 → 生成模型")
        self.message.setWordWrap(True)
        self.message.setStyleSheet("color:#475569; font-size:16px;")
        layout.addWidget(self.message)
        content = QWidget()
        body = QVBoxLayout(content)
        body.setContentsMargins(8, 8, 8, 8)
        body.setSpacing(12)

        object_group = QGroupBox("01  建模对象")
        object_layout = QVBoxLayout(object_group)
        add_row = QHBoxLayout()
        self.kind_combo = QComboBox()
        for kind in ("sphere", "box", "cylinder", "torus", "tpms"):
            self.kind_combo.addItem(KINDS[kind], kind)
        self.kind_combo.setAccessibleName("新增实体类型")
        add_row.addWidget(self.kind_combo, 1)
        add_button = QPushButton("添加")
        add_button.clicked.connect(self.add_object)
        add_row.addWidget(add_button)
        object_layout.addLayout(add_row)
        self.objects = QListWidget()
        self.objects.setMinimumHeight(155)
        self.objects.setMaximumHeight(220)
        self.objects.setAccessibleName("建模对象列表")
        self.objects.setStyleSheet("QListWidget {background:#fff; border:1px solid #cbd5e1; border-radius:6px;} QListWidget::item {padding:8px;} QListWidget::item:selected {background:#ccfbf1; color:#134e4a;}")
        self.objects.currentRowChanged.connect(self.select_object)
        object_layout.addWidget(self.objects)
        root_form = QFormLayout()
        self.root_combo = QComboBox()
        self.root_combo.setAccessibleName("最终输出对象")
        self.root_combo.currentIndexChanged.connect(self.change_root)
        root_form.addRow("最终输出", self.root_combo)
        object_layout.addLayout(root_form)
        row = QHBoxLayout()
        for label, action in (("复制", self.duplicate_object), ("删除", self.remove_object)):
            button = QPushButton(label)
            button.clicked.connect(action)
            row.addWidget(button)
        object_layout.addLayout(row)
        body.addWidget(object_group)

        self.editor = QGroupBox("02  对象属性")
        self.form = QFormLayout(self.editor)
        self.form.setSpacing(9)
        self.name_edit = QLineEdit()
        self.name_edit.setAccessibleName("对象名称")
        self.form.addRow("名称", self.name_edit)
        self.dimension_fields = []
        for index in range(3):
            spin = self._spin(0.01, 2000, 10, " mm")
            self.dimension_fields.append(spin)
            self.form.addRow(f"尺寸 {index + 1}", spin)
        self.position_fields = []
        self.rotation_fields = []
        for title, fields, suffix, limit in (("位置", self.position_fields, " mm", 2000),
                                              ("旋转", self.rotation_fields, " °", 360)):
            row = QWidget()
            grid = QFormLayout(row)
            grid.setContentsMargins(0, 0, 0, 0)
            grid.setSpacing(4)
            for axis in "XYZ":
                spin = self._spin(-limit, limit, 0, suffix)
                spin.setAccessibleName(f"对象{title} {axis}")
                fields.append(spin)
                grid.addRow(axis, spin)
            self.form.addRow(title, row)
        self.input_a = QComboBox()
        self.input_b = QComboBox()
        self.form.addRow("对象 A", self.input_a)
        self.form.addRow("对象 B", self.input_b)
        self.blend_spin = self._spin(0.001, 100, 2, " mm")
        self.form.addRow("融合宽度", self.blend_spin)
        self.tpms_label = QLabel()
        self.tpms_label.setWordWrap(True)
        self.tpms_label.setStyleSheet("font-size:16px; color:#475569;")
        self.form.addRow(self.tpms_label)
        self.tpms_update = QPushButton("读取左侧 TPMS 参数")
        self.tpms_update.setToolTip("先切到 TPMS 参数模式设置，再回到实体建模读取；参数保存为独立对象快照")
        self.tpms_update.clicked.connect(self.update_tpms)
        self.form.addRow(self.tpms_update)
        apply_button = QPushButton("应用属性")
        apply_button.clicked.connect(self.apply_properties)
        self.form.addRow(apply_button)
        body.addWidget(self.editor)

        combine_group = QGroupBox("03  实体组合")
        combine_layout = QFormLayout(combine_group)
        self.combine_a = QComboBox()
        self.combine_b = QComboBox()
        self.operation_combo = QComboBox()
        for operation in ("union", "intersection", "difference", "smooth_union"):
            self.operation_combo.addItem(KINDS[operation], operation)
        combine_layout.addRow("对象 A", self.combine_a)
        combine_layout.addRow("对象 B", self.combine_b)
        combine_layout.addRow("操作", self.operation_combo)
        self.new_blend_spin = self._spin(0.001, 100, 2, " mm")
        combine_layout.addRow("融合宽度", self.new_blend_spin)
        self.operation_combo.currentIndexChanged.connect(lambda: self.new_blend_spin.setEnabled(
            self.operation_combo.currentData() == "smooth_union"))
        self.new_blend_spin.setEnabled(False)
        combine_button = QPushButton("创建组合")
        combine_button.clicked.connect(self.combine)
        combine_layout.addRow(combine_button)
        note = QLabel("差集为 A 减去 B。交集可用实体裁剪 TPMS。平滑融合仅适用于基本实体组合。")
        note.setWordWrap(True)
        note.setStyleSheet("font-size:16px; color:#475569;")
        combine_layout.addRow(note)
        body.addWidget(combine_group)

        output_group = QGroupBox("04  精度与项目")
        output_layout = QFormLayout(output_group)
        self.cell_spin = self._spin(0.001, 100, 0.6, " mm")
        self.cell_spin.setDecimals(3)
        self.cell_spin.setToolTip("最小网格划分尺寸。应小于最薄结构厚度的一半；越小越精细。")
        self.cell_spin.valueChanged.connect(self.change_precision)
        output_layout.addRow("网格尺寸", self.cell_spin)
        file_row = QWidget()
        files = QHBoxLayout(file_row)
        files.setContentsMargins(0, 0, 0, 0)
        for label, callback in (("保存项目", self.save_scene), ("打开项目", self.load_scene)):
            button = QPushButton(label)
            button.clicked.connect(callback)
            files.addWidget(button)
        output_layout.addRow(file_row)
        self.demo_combo = QComboBox()
        self.demo_combo.addItem("示例：圆柱 TPMS + 流道", "tpms_channel")
        self.demo_combo.addItem("示例：球体贯穿孔", "sphere_hole")
        self.demo_combo.addItem("示例：双球平滑融合", "smooth")
        output_layout.addRow(self.demo_combo)
        demo_button = QPushButton("加载示例（替换当前对象）")
        demo_button.clicked.connect(self.load_demo)
        output_layout.addRow(demo_button)
        body.addWidget(output_group)
        body.addStretch(1)
        for combo in self.findChildren(QComboBox):
            combo.setSizeAdjustPolicy(QComboBox.AdjustToMinimumContentsLengthWithIcon)
            combo.setMinimumContentsLength(1)
            combo.setSizePolicy(QSizePolicy.Expanding, QSizePolicy.Fixed)
            combo.setMinimumWidth(0)
        for spin in self.findChildren(QDoubleSpinBox):
            spin.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        self.name_edit.setSizePolicy(QSizePolicy.Ignored, QSizePolicy.Fixed)
        scroll = QScrollArea()
        scroll.setWidgetResizable(True)
        scroll.setFrameShape(QScrollArea.NoFrame)
        scroll.setWidget(content)
        scroll.setHorizontalScrollBarPolicy(Qt.ScrollBarAlwaysOff)
        layout.addWidget(scroll, 1)
        self.refresh()

    @staticmethod
    def _spin(low, high, value, suffix):
        spin = QDoubleSpinBox()
        spin.setRange(low, high)
        spin.setDecimals(2)
        spin.setValue(value)
        spin.setSuffix(suffix)
        spin.setSingleStep(0.5)
        spin.setMinimumWidth(0)
        return spin

    def run_action(self, callback):
        try:
            callback()
        except (ValueError, OSError) as exc:
            self.message.setText(str(exc))
            self.message.setStyleSheet("color:#b91c1c; font-size:16px;")
            return False
        self.message.setText("参数已更新，点击“生成实体”刷新预览。")
        self.message.setStyleSheet("color:#475569; font-size:16px;")
        self.changed.emit()
        return True

    def selected(self):
        item = self.objects.currentItem()
        return self.scene.by_id(item.data(Qt.UserRole)) if item else None

    def refresh(self, identifier=None):
        self._loading = True
        self.objects.clear()
        for node in self.scene.nodes:
            item = QListWidgetItem(f"{node.name}  ·  {KINDS[node.kind]}")
            item.setData(Qt.UserRole, node.id)
            item.setToolTip(f"{node.id}: {', '.join(node.inputs) or '基本对象'}")
            self.objects.addItem(item)
        for combo in (self.root_combo, self.combine_a, self.combine_b):
            previous = combo.currentData()
            combo.clear()
            for node in self.scene.nodes:
                combo.addItem(node.name, node.id)
            choice = self.scene.root if combo is self.root_combo else previous
            index = combo.findData(choice)
            combo.setCurrentIndex(max(index, 0))
        if self.combine_b.count() > 1 and self.combine_b.currentData() == self.combine_a.currentData():
            self.combine_b.setCurrentIndex(1)
        self.cell_spin.setValue(self.scene.cell_size)
        self._loading = False
        index = next((i for i, node in enumerate(self.scene.nodes) if node.id == (identifier or self.scene.root)), -1)
        self.objects.setCurrentRow(index)
        self.select_object(index)

    def select_object(self, _row):
        if self._loading:
            return
        node = self.selected()
        self.editor.setEnabled(node is not None)
        if node is None:
            return
        self.name_edit.setText(node.name)
        labels = {"sphere": ("半径",), "box": ("X 长度", "Y 长度", "Z 长度"),
                  "cylinder": ("半径", "高度（局部 Z）"), "torus": ("主半径", "管半径")}.get(node.kind, ())
        for i, spin in enumerate(self.dimension_fields):
            spin.setVisible(i < len(labels))
            self.form.labelForField(spin).setVisible(i < len(labels))
            if i < len(labels):
                self.form.labelForField(spin).setText(labels[i])
                spin.setAccessibleName(labels[i])
                spin.setValue(node.dimensions[i])
        for fields, values in ((self.position_fields, node.position), (self.rotation_fields, node.rotation)):
            for spin, value in zip(fields, values):
                spin.setValue(value)
        for i, combo in enumerate((self.input_a, self.input_b)):
            combo.clear()
            for other in self.scene.nodes:
                if other.id != node.id:
                    combo.addItem(other.name, other.id)
            combo.setCurrentIndex(combo.findData(node.inputs[i]) if node.inputs else -1)
            combo.setVisible(node.kind in OPERATIONS)
            self.form.labelForField(combo).setVisible(node.kind in OPERATIONS)
        self.blend_spin.setValue(node.blend)
        self.blend_spin.setVisible(node.kind == "smooth_union")
        self.form.labelForField(self.blend_spin).setVisible(node.kind == "smooth_union")
        self.tpms_update.setVisible(node.kind == "tpms")
        self.tpms_label.setVisible(node.kind == "tpms")
        if node.tpms:
            p = node.tpms
            self.tpms_label.setText(f"{p.surface} · {p.size_x:g}×{p.size_y:g}×{p.size_z:g} mm\n"
                f"{p.cells_x}×{p.cells_y}×{p.cells_z} 周期 · {'片层' if p.mode == 'sheet' else '实体'} · 壁厚 {p.thickness:g} mm")

    def add_object(self):
        def action():
            kind = self.kind_combo.currentData()
            defaults = {"sphere": (8,), "box": (16, 16, 16), "cylinder": (6, 20), "torus": (10, 3)}
            args = {"tpms": self.parameters_provider()} if kind == "tpms" else {"dimensions": defaults[kind]}
            node = self.scene.add(kind, **args)
            self.refresh(node.id)
        self.run_action(action)

    def duplicate_object(self):
        def action():
            node = self.selected()
            if node is None:
                raise ValueError("请先选择对象")
            args = {key: getattr(node, key) for key in ("dimensions", "position", "rotation", "inputs", "blend", "tpms")}
            new = self.scene.add(node.kind, **args)
            self.refresh(new.id)
        self.run_action(action)

    def remove_object(self):
        def action():
            node = self.selected()
            if node:
                self.scene.remove(node.id)
                self.refresh()
        self.run_action(action)

    def apply_properties(self):
        def action():
            node = self.selected()
            if node is None:
                raise ValueError("请先选择对象")
            args = dict(name=self.name_edit.text().strip(),
                position=tuple(spin.value() for spin in self.position_fields),
                rotation=tuple(spin.value() for spin in self.rotation_fields), blend=self.blend_spin.value())
            if node.kind in OPERATIONS:
                args["inputs"] = (self.input_a.currentData(), self.input_b.currentData())
            elif node.kind != "tpms":
                args["dimensions"] = tuple(spin.value() for spin in self.dimension_fields[:len(node.dimensions)])
            candidate = replace(node, **args)
            index = self.scene.nodes.index(node)
            self.scene.nodes[index] = candidate
            try:
                self.scene.validate()
            except ValueError:
                self.scene.nodes[index] = node
                raise
            self.refresh(node.id)
        return self.run_action(action)

    def update_tpms(self):
        def action():
            node = self.selected()
            if node and node.kind == "tpms":
                p = self.parameters_provider()
                p.validate()
                if p.tubular_enabled:
                    raise ValueError("组合不支持管状卷绕 TPMS")
                self.scene.nodes[self.scene.nodes.index(node)] = replace(node, tpms=p)
                self.refresh(node.id)
        self.run_action(action)

    def combine(self):
        def action():
            a, b = self.combine_a.currentData(), self.combine_b.currentData()
            if not a or not b or a == b:
                raise ValueError("请选择两个不同的对象")
            old_root = self.scene.root
            node = self.scene.add(self.operation_combo.currentData(), inputs=(a, b), blend=self.new_blend_spin.value())
            try:
                self.scene.validate()
            except ValueError:
                self.scene.nodes.pop()
                self.scene.root = old_root
                raise
            self.refresh(node.id)
        self.run_action(action)

    def change_root(self, _index):
        if not self._loading and self.root_combo.currentData():
            self.scene.root = self.root_combo.currentData()
            self.changed.emit()

    def change_precision(self, value):
        if not self._loading:
            self.scene.cell_size = value
            self.changed.emit()

    def load_demo(self):
        self.scene = demo_scene(self.demo_combo.currentData())
        self.refresh()
        self.message.setText("示例已加载。可修改对象属性，点击“生成实体”查看模型。")
        self.changed.emit()

    def snapshot(self):
        # Commit the displayed editor before generation or persistence.
        if self.selected() is not None and not self.apply_properties():
            raise ValueError(self.message.text())
        self.scene.validate()
        return SolidScene.from_dict(self.scene.to_dict())

    def save_scene(self):
        filename, _ = QFileDialog.getSaveFileName(self, "保存实体建模项目", "solid-model.json", "建模项目 (*.json)")
        if filename:
            def action():
                path = Path(filename)
                self.snapshot().save(path if path.suffix else path.with_suffix(".json"))
            self.run_action(action)

    def load_scene(self):
        filename, _ = QFileDialog.getOpenFileName(self, "打开实体建模项目", "", "建模项目 (*.json)")
        if filename:
            def action():
                self.scene = SolidScene.load(Path(filename))
                self.refresh()
            self.run_action(action)
