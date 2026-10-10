"""Dependency-keyed native expression reuse and bounded per-node mesh caching."""
from __future__ import annotations

from collections import OrderedDict
from dataclasses import asdict
import hashlib
import json
import math

from libfive_backend import NativeKernel, _TreeArena, _Region, _Interval, render_tree_mesh
from solid_model import SolidScene, SolidResult, _scene_tree
from workflow_values import resolve_values


def field_keys(scene: SolidScene) -> dict[str, str]:
    keys = {}
    def visit(identifier):
        if identifier in keys:
            return keys[identifier]
        node = scene.by_id(identifier)
        data = asdict(node)
        for key in ('id', 'name', 'expressions', 'vector_inputs'):
            data.pop(key, None)
        data['inputs'] = [visit(child) for child in node.inputs]
        data['cell_size'] = scene.cell_size
        keys[identifier] = hashlib.sha256(json.dumps(data, sort_keys=True, allow_nan=False).encode()).hexdigest()
        return keys[identifier]
    for node in scene.nodes:
        visit(node.id)
    return keys


class WorkflowEngine:
    def __init__(self, max_mesh_bytes=96 * 1024 * 1024, max_meshes=8, max_fields=192):
        self.kernel = self.arena = None
        self.fields = {}
        self.meshes = OrderedDict()
        self.max_mesh_bytes, self.max_meshes, self.max_fields = max_mesh_bytes, max_meshes, max_fields

    def close(self):
        self.fields.clear()
        if self.arena is not None:
            self.arena.__exit__(None, None, None)
        self.arena = self.kernel = None
        self.meshes.clear()

    def _arena(self):
        if self.arena is None or len(self.fields) >= self.max_fields or len(self.arena.pointers) > 250_000:
            self.fields.clear()
            if self.arena is not None:
                self.arena.__exit__(None, None, None)
            self.kernel = NativeKernel()
            self.arena = _TreeArena(self.kernel)

    def generate(self, snapshot: SolidScene, identifier=None, progress=None):
        snapshot = SolidScene.from_dict(snapshot.to_dict())
        scene = snapshot.resolved()
        scene._validate_concrete()
        target = identifier or scene.root
        scene.by_id(target)
        scene.root = target
        bounds = scene.bounds()
        size = bounds[1] - bounds[0]
        margin = scene.cell_size * 2
        levels = max(0, math.ceil(math.log2((min(size) + 2 * margin) / scene.cell_size)))
        if 8 ** levels > 16_777_216:
            raise ValueError('网格尺寸过小：潜在八叉树超过 1677 万叶节点，请增大网格尺寸')
        if scene.cell_size > min(size) / 4:
            raise ValueError('网格尺寸过粗，请设置不超过最小外形尺寸的四分之一')
        keys = field_keys(scene)
        states, rebuilt, reused = {}, set(), set()
        def report(node_id, state):
            states[node_id] = state
            if state == 'cached': reused.add(node_id)
            elif state == 'ready': rebuilt.add(node_id)
            if progress:
                labels = {'evaluating': '正在更新数学场', 'cached': '结果缓存复用', 'ready': '数学场已更新', 'meshing': '正在提取表面网格'}
                progress({'node_id': node_id, 'state': state, 'message': f"{scene.by_id(node_id).name} · {labels.get(state, state)}"})
        mesh_key = keys[target]
        cached = mesh_key in self.meshes
        if cached:
            mesh = self.meshes.pop(mesh_key)
            self.meshes[mesh_key] = mesh
            def reused_branch(node_id):
                if node_id in states: return
                report(node_id, 'cached')
                for child in scene.by_id(node_id).inputs: reused_branch(child)
            reused_branch(target)
        else:
            self._arena()
            try:
                tree = _scene_tree(self.arena, scene, target, {}, self.fields, keys, report)
                report(target, 'meshing')
                region = _Region(*[_Interval(float(lo - margin), float(hi + margin)) for lo, hi in zip(*bounds)])
                mesh = render_tree_mesh(self.kernel, tree, region, scene.cell_size)
            except Exception:
                report(target, 'error')
                raise
            states[target] = 'ready'
            if progress:
                progress({'node_id': target, 'state': 'ready', 'message': f'{scene.by_id(target).name} · 网格已完成'})
            size_bytes = mesh.vertices.nbytes + mesh.faces.nbytes
            if size_bytes <= self.max_mesh_bytes:
                self.meshes[mesh_key] = mesh
                while len(self.meshes) > self.max_meshes or sum(m.vertices.nbytes + m.faces.nbytes for m in self.meshes.values()) > self.max_mesh_bytes:
                    self.meshes.popitem(last=False)
        _, values = resolve_values(snapshot.parameters, snapshot.value_nodes)
        metadata = {'target': target, 'states': states, 'rebuilt': sorted(rebuilt), 'reused': sorted(reused),
                    'mesh_cached': cached, 'values': values}
        return SolidResult(mesh, snapshot), metadata
