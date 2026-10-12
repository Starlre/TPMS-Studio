"""STEP reference import: exact CAD metadata and bounded display tessellation."""
from dataclasses import dataclass
import hashlib
import importlib.util
import math
from pathlib import Path
import tempfile

import numpy as np
import trimesh

from solid_model import rotation_matrix

MAX_FILE_BYTES = 128 * 1024 * 1024
MAX_TRIANGLES = 2_000_000
DEFAULT_OPTIONS = {"deflection": .1, "angular_deflection": 20,
                   "position": [0, 0, 0], "rotation": [0, 0, 0]}


def import_status():
    return importlib.util.find_spec("OCP") is not None


def validate_settings(raw):
    if not isinstance(raw, dict) or set(raw) - {"source", "sha256", *DEFAULT_OPTIONS}:
        raise ValueError("STEP 导入设置格式无效")
    source = raw.get("source")
    if not isinstance(source, str) or not source or len(source) > 4096:
        raise ValueError("请选择 STEP 源文件")
    if Path(source).suffix.lower() not in {".step", ".stp"}:
        raise ValueError("仅支持 STEP / STP 文件")
    digest = raw.get("sha256", "")
    if not isinstance(digest, str) or (digest and (len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest))):
        raise ValueError("STEP 文件摘要无效")
    options = {key: raw.get(key, value) for key, value in DEFAULT_OPTIONS.items()}
    for key, low, high in [("deflection", .001, 10), ("angular_deflection", 1, 60)]:
        value = options[key]
        if isinstance(value, bool) or not isinstance(value, (float, int)) or not math.isfinite(value) or not low <= value <= high:
            raise ValueError("曲面偏差须为 0.001–10 mm，角度偏差须为 1–60°")
    for key in ("position", "rotation"):
        value = options[key]
        if not isinstance(value, (list, tuple)) or len(value) != 3 or any(
                isinstance(v, bool) or not isinstance(v, (float, int)) or not math.isfinite(v) or abs(v) > 10000 for v in value):
            raise ValueError("STEP 位置与旋转须为有限 XYZ 数值，绝对值不超过 10000")
        options[key] = list(value)
    return {"source": source, "sha256": digest, **options}


@dataclass
class ImportedCAD:
    mesh: trimesh.Trimesh
    settings: dict
    metadata: dict


class StepImporter:
    def __init__(self):
        self.shape = None
        self.digest = ""
        self.metadata = {}

    def load(self, raw, progress=lambda message: None):
        settings = validate_settings(raw)
        if not import_status():
            raise ValueError("STEP 导入需要 OpenCascade：请安装 requirements-step.txt 中的依赖并重启软件")
        source = Path(settings["source"])
        if not source.is_file():
            raise ValueError("STEP 源文件不存在，请重新导入；项目只保存文件引用")
        if not 0 < source.stat().st_size <= MAX_FILE_BYTES:
            raise ValueError("STEP 文件为空或超过 128 MiB")
        data = source.read_bytes()
        if len(data) > MAX_FILE_BYTES:
            raise ValueError("STEP 文件超过 128 MiB")
        digest = hashlib.sha256(data).hexdigest()
        if settings["sha256"] and settings["sha256"] != digest:
            raise ValueError("STEP 源文件已改变，请通过导入入口重新选择文件")
        progress("正在读取 STEP 曲面与拓扑…")
        from OCP.STEPControl import STEPControl_Reader
        from OCP.IFSelect import IFSelect_RetDone
        from OCP.BRepCheck import BRepCheck_Analyzer
        from OCP.BRepGProp import BRepGProp
        from OCP.GProp import GProp_GProps
        from OCP.TopExp import TopExp
        from OCP.TopTools import TopTools_IndexedMapOfShape
        from OCP.TopAbs import TopAbs_SOLID, TopAbs_FACE
        from OCP.TColStd import TColStd_SequenceOfAsciiString
        from OCP.Message import Message, Message_PrinterOStream
        # Native diagnostics must not enter the worker's JSON-lines stdout.
        Message.DefaultMessenger_s().RemovePrinters(Message_PrinterOStream.get_type_descriptor_s())
        if digest != self.digest or self.shape is None:
            reader = STEPControl_Reader()
            # ASCII temporary name also works with older OCCT builds on Windows.
            with tempfile.TemporaryDirectory(prefix="tpms-step-") as directory:
                snapshot = Path(directory) / "source.step"
                snapshot.write_bytes(data)
                if reader.ReadFile(str(snapshot)) != IFSelect_RetDone:
                    raise ValueError("STEP 文件无法读取，请检查文件内容与格式")
                reader.SetSystemLengthUnit(1.0)  # OCCT output coordinates in mm.
                units, angles, solid_angles = (TColStd_SequenceOfAsciiString() for _ in range(3))
                reader.FileUnits(units, angles, solid_angles)
                if reader.TransferRoots() < 1:
                    raise ValueError("STEP 文件没有可显示的曲面或实体")
                shape = reader.OneShape()
            if shape.IsNull() or not BRepCheck_Analyzer(shape).IsValid():
                raise ValueError("STEP 拓扑无效，无法可靠显示")
            solids, faces = TopTools_IndexedMapOfShape(), TopTools_IndexedMapOfShape()
            TopExp.MapShapes_s(shape, TopAbs_SOLID, solids)
            TopExp.MapShapes_s(shape, TopAbs_FACE, faces)
            if not faces.Extent():
                raise ValueError("STEP 不含曲面；仅有曲线或点的文件暂不支持")
            area, volume = GProp_GProps(), GProp_GProps()
            BRepGProp.SurfaceProperties_s(shape, area)
            BRepGProp.VolumeProperties_s(shape, volume, True)
            metadata = {"solids": solids.Extent(), "cad_faces": faces.Extent(),
                        "source_units": [units.Value(i).ToCString() for i in range(1, units.Length()+1)],
                        "units": "mm", "cad_area": abs(area.Mass()),
                        "cad_volume": abs(volume.Mass()) if solids.Extent() else None}
            self.shape, self.digest, self.metadata = shape, digest, metadata
        progress("正在生成 STEP 显示网格…")
        mesh = self.tessellate(settings)
        metadata = {**self.metadata, "name": source.name, "bytes": len(data), "sha256": digest}
        settings.update(source=str(source.resolve()), sha256=digest)
        return ImportedCAD(mesh, settings, metadata)

    def tessellate(self, options):
        from OCP.BRepMesh import BRepMesh_IncrementalMesh
        from OCP.BRepTools import BRepTools
        from OCP.BRep import BRep_Tool
        from OCP.TopExp import TopExp_Explorer
        from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
        from OCP.TopoDS import TopoDS
        from OCP.TopLoc import TopLoc_Location
        BRepTools.Clean_s(self.shape)
        mesher = BRepMesh_IncrementalMesh(self.shape, options["deflection"], False,
                                         math.radians(options["angular_deflection"]), False)
        if not mesher.IsDone():
            raise ValueError("STEP 曲面离散失败，请放宽预览精度")
        vertices, triangles = [], []
        explorer = TopExp_Explorer(self.shape, TopAbs_FACE)
        while explorer.More():
            face = TopoDS.Face_s(explorer.Current())
            location = TopLoc_Location()
            triangulation = BRep_Tool.Triangulation_s(face, location)
            if triangulation is None or triangulation.NbTriangles() == 0:
                raise ValueError("部分 STEP 面无法离散，请检查源文件")
            if len(triangles) + triangulation.NbTriangles() > MAX_TRIANGLES:
                raise ValueError("显示网格超过 200 万面，请增大曲面/角度偏差")
            offset = len(vertices)
            transform = location.Transformation()
            for i in range(1, triangulation.NbNodes()+1):
                p = triangulation.Node(i).Transformed(transform)
                vertices.append((p.X(), p.Y(), p.Z()))
            for i in range(1, triangulation.NbTriangles()+1):
                a, b, c = triangulation.Triangle(i).Get()
                if face.Orientation() == TopAbs_REVERSED:
                    b, c = c, b
                triangles.append((offset+a-1, offset+b-1, offset+c-1))
            explorer.Next()
        mesh = trimesh.Trimesh(vertices=vertices, faces=triangles, process=False)
        if not len(mesh.faces) or not np.isfinite(mesh.vertices).all():
            raise ValueError("STEP 没有有效显示网格")
        # Weld face seams without reorienting inner cavity boundaries.
        mesh.merge_vertices(digits_vertex=9)
        mesh.remove_unreferenced_vertices()
        matrix = np.eye(4)
        matrix[:3, :3] = rotation_matrix(options["rotation"])
        matrix[:3, 3] = options["position"]
        mesh.apply_transform(matrix)
        return mesh
