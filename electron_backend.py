"""Local JSON-lines worker. stdout is exclusively the Electron RPC protocol.

The Electron main process owns the private transfer directory and file dialogs.
Heavy native work runs here, outside the UI process; cancellation restarts this
worker, so the next request cannot accidentally reuse an old generated model.
"""
from __future__ import annotations

import argparse
from contextlib import redirect_stdout
from dataclasses import asdict, replace
import json
import math
import os
from pathlib import Path
import sys
import tempfile
import uuid

import numpy as np

from tpms_core import (TPMSParameters, MeshResult, generate_tpms,
                       prepare_export_mesh, PreviewMesh)
from libfive_backend import backend_status, generate_libfive_mesh, suggested_cell_size
from solid_model import SolidScene, generate_solid, demo_scene
from gpu_preview import IMPLICIT_FRAGMENT_SOURCE


def parameters(raw: dict) -> TPMSParameters:
    p = TPMSParameters(**raw)
    for key, value in asdict(p).items():
        if isinstance(value, (int, float)) and (not math.isfinite(value) or abs(value) > 10000):
            raise ValueError(f"{key} 数值超出范围")
    for key in ('cells_x', 'cells_y', 'cells_z', 'samples_per_cell'):
        if type(getattr(p, key)) is not int:
            raise ValueError(f"{key} 必须是整数")
    if max(p.cells_x, p.cells_y, p.cells_z) > 32 or p.samples_per_cell > 128:
        raise ValueError("周期数上限 32，采样数上限 128")
    if (p.cells_x * p.samples_per_cell + 3) * (p.cells_y * p.samples_per_cell + 3) * (p.cells_z * p.samples_per_cell + 3) > 16_777_216:
        raise ValueError("采样网格超过 1677 万点，请降低周期数或采样精度")
    p.validate()
    return p


class Workbench:
    def __init__(self, transfer: Path, progress=None):
        self.transfer = transfer.resolve()
        self.current = None
        self.cfd = None
        self.region = None
        self.progress = progress or (lambda message: None)

    def geometry(self, vertices, faces, colors=None) -> dict:
        # One binary blob rather than millions of numbers in JSON.
        positions = np.asarray(vertices, dtype='<f4').reshape(-1, 3)
        indices = np.asarray(faces, dtype='<u4').reshape(-1, 3)
        blocks = [positions.tobytes(), indices.tobytes()]
        if colors is not None:
            blocks.append(np.asarray(colors, dtype='<f4').tobytes())
        name = f"{uuid.uuid4().hex}.mesh"
        (self.transfer / name).write_bytes(b''.join(blocks))
        return {"file": name, "vertices": len(positions), "faces": len(indices),
                "colors": colors is not None}

    def generated(self, result, mode: str) -> dict:
        self.current, self.cfd, self.region = result, None, None
        mesh = result.mesh
        stats = {"faces": len(mesh.faces), "vertices": len(mesh.vertices),
                 "volume": abs(float(mesh.volume)), "area": float(mesh.area),
                 "watertight": bool(mesh.is_watertight), "bounds": mesh.bounds.tolist()}
        answer = {"geometry": self.geometry(mesh.vertices, mesh.faces), "stats": stats, "mode": mode}
        if mode == 'tpms':
            stats.update(porosity=result.porosity, removed_components=result.removed_components)
            answer['parameters'] = asdict(result.parameters)
        return answer

    def require_tpms(self):
        if not isinstance(self.current, MeshResult):
            raise ValueError("请先生成 TPMS 模型；实体组合暂不支持 CFD 网格")
        # Use solved parameters of the generated snapshot, never new form values.
        return replace(self.current.parameters, target_porosity=None)

    def dispatch(self, method: str, payload: dict) -> dict:
        if method == 'init':
            available, detail = backend_status()
            return {"libfive": available, "detail": detail, "python": sys.executable,
                    "shader": IMPLICIT_FRAGMENT_SOURCE.replace('#version 330 core', '')}
        if method == 'generate_tpms':
            p = parameters(payload['parameters'])
            self.progress('正在计算隐式场并生成封闭曲面…')
            if payload.get('kernel') == 'libfive':
                result = generate_libfive_mesh(p, float(payload.get('cell_size') or suggested_cell_size(p)))
            else:
                result = generate_tpms(p)
            return self.generated(result, 'tpms')
        if method == 'generate_solid':
            scene = SolidScene.from_dict(payload['scene'])
            for node in scene.nodes:
                if node.tpms:
                    parameters(asdict(node.tpms))
            self.progress('libfive 正在提取布尔组合零等值面…')
            return self.generated(generate_solid(scene), 'solid')
        if method == 'preset':
            if payload.get('kind') not in {'sphere_hole', 'smooth', 'tpms_channel'}:
                raise ValueError('未知示例')
            return {"scene": demo_scene(payload['kind']).to_dict()}
        if method == 'validate_project':
            project = payload['project']
            if project.get('version') != 1 or project.get('type') != 'tpms-electron':
                # Existing solid workspace JSON remains readable.
                return {"project": {"version": 1, "type": "tpms-electron", "mode": "solid",
                                    "scene": SolidScene.from_dict(project).to_dict()}}
            parameters(project['parameters'])
            if project.get('scene', {}).get('nodes'):
                SolidScene.from_dict(project['scene'])
            if project.get('mode') not in {'tpms', 'solid'}:
                raise ValueError('项目建模模式无效')
            from comsol_mesh import CFDMeshOptions
            CFDMeshOptions(**project.get('cfd', {})).validate()
            return {"project": project}
        if method == 'export':
            if self.current is None:
                raise ValueError('计算进程中没有模型，请重新生成')
            path = Path(payload['destination'])
            if path.suffix.lower() not in {'.stl', '.obj', '.ply'}:
                raise ValueError('仅支持 STL、OBJ、PLY')
            quality = payload.get('quality', 'original')
            if quality not in {'original', 'high', 'medium', 'low', 'custom', 'libfive'}:
                raise ValueError('未知导出质量')
            result = self.current
            if quality == 'libfive':
                self.require_tpms()
                result = generate_libfive_mesh(replace(result.parameters, target_porosity=None), float(payload['cell_size']))
                quality = 'original'
            mesh, count, fallback, message = prepare_export_mesh(result, quality, payload.get('target_faces'))
            # Atomic replacement preserves an existing file if meshing/export fails.
            handle, temporary = tempfile.mkstemp(dir=path.parent, suffix=path.suffix)
            os.close(handle)
            try:
                mesh.export(temporary)
                Path(temporary).replace(path)
            finally:
                Path(temporary).unlink(missing_ok=True)
            return {"path": str(path), "faces": count, "fallback": fallback,
                    "watertight": bool(mesh.is_watertight), "message": message}
        if method in {'region', 'cfd', 'quality', 'low_quality'}:
            from comsol_mesh import CFDMeshOptions, generate_simulation_region_preview, export_comsol_fluid_mesh
            p = self.require_tpms()
            options = CFDMeshOptions(**payload.get('options', {}))
            options.validate()
            if method == 'region':
                self.progress('正在识别入口、出口和壁面…')
                preview = generate_simulation_region_preview(p, options)
                return {"geometry": self.geometry(preview.vertices, preview.faces, preview.colors)}
            if method in {'cfd', 'quality'}:
                destination = payload.get('destination') or str(self.transfer / 'quality')
                self.cfd = export_comsol_fluid_mesh(p, destination, options, progress=self.progress)
                r = self.cfd
                return {"quality": asdict(r.quality), "nodes": r.nodes,
                        "elements": r.volume_elements, "tetrahedra": r.tetrahedra, "prisms": r.prisms,
                        "paths": [str(r.msh_path), str(r.bdf_path), str(r.metadata_path), str(r.quality_path)]}
            if self.cfd is None:
                raise ValueError('请先计算网格质量')
            return {"geometry": self.geometry(self.cfd.low_quality_vertices, self.cfd.low_quality_faces)}
        raise ValueError(f'未知命令：{method}')


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--transfer', type=Path, required=True)
    args = parser.parse_args()
    sys.stdin.reconfigure(encoding='utf-8')
    sys.stdout.reconfigure(encoding='utf-8')
    protocol = sys.stdout
    def emit(value):
        protocol.write(json.dumps(value, ensure_ascii=False, allow_nan=False) + '\n')
        protocol.flush()
    worker = Workbench(args.transfer)
    for line in sys.stdin:
        request = {}
        try:
            if len(line) > 2_000_000:
                raise ValueError('请求过大')
            request = json.loads(line)
            worker.progress = lambda message: emit({"id": request['id'], "progress": message})
            # Python library diagnostics cannot corrupt the RPC stream.
            with redirect_stdout(sys.stderr):
                result = worker.dispatch(request['method'], request.get('payload', {}))
            emit({"id": request['id'], "result": result})
        except Exception as exc:
            emit({"id": request.get('id'), "error": str(exc)})


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    main()
