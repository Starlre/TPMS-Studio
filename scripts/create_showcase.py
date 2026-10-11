"""Create editable gallery projects using existing modeling operators.

Usage: python scripts/create_showcase.py --output examples/showcase
"""
from dataclasses import asdict
from pathlib import Path
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--output', type=Path, default=Path('examples/showcase'))
    args = parser.parse_args()
    sys.path.insert(0, str(args.project.resolve()))
    from solid_model import SolidScene, SolidNode
    from tpms_core import TPMSParameters

    def parameter(identifier, name, symbol, value):
        return {'id': identifier, 'name': name, 'kind': 'number', 'symbol': symbol, 'value': value}

    def save(scene, filename):
        raw = scene.to_dict()
        raw['notebook_order'] = [f"value:{p['id']}" for p in scene.value_nodes] + [n.id for n in scene.nodes]
        project = {'type': 'tpms-electron', 'version': 1, 'mode': 'nodes',
                   'parameters': asdict(TPMSParameters()), 'cfd': {}, 'scene': raw}
        args.output.mkdir(parents=True, exist_ok=True)
        path = args.output / filename
        path.write_text(json.dumps(project, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        print(f'{filename}: {len(scene.nodes)} geometry nodes, {len(scene.value_nodes)} parameters', flush=True)

    scene = SolidScene(cell_size=0.4, value_nodes=[
        parameter('p1', '点阵壁厚 / mm', 'wall', 1.4),
        parameter('p2', '法兰半径 / mm', 'flange_radius', 23),
        parameter('p3', '轴向流道半径 / mm', 'bore_radius', 4)])
    def add(kind, name, **kwargs):
        node = SolidNode(id=f'n{len(scene.nodes) + 1}', name=name, kind=kind, **kwargs)
        scene.nodes.append(node)
        scene.root = node.id
        return node
    field = add('tpms', 'Gyroid · 三周期片层', tpms=TPMSParameters(
        size_x=36, size_y=36, size_z=32, cells_x=3, cells_y=3, cells_z=3,
        thickness=1.4, samples_per_cell=32), expressions={'tpms.thickness': 'wall'})
    domain = add('cylinder', '圆柱裁剪域', dimensions=(15, 32))
    core = add('intersection', '圆柱形点阵芯', inputs=(field.id, domain.id))
    outer = add('cylinder', '下法兰外柱', dimensions=(23, 6), position=(0, 0, -17),
                expressions={'dimensions.0': 'flange_radius'})
    inner = add('cylinder', '下法兰内孔', dimensions=(13, 8), position=(0, 0, -17))
    flange = add('difference', '下法兰环', inputs=(outer.id, inner.id))
    top = add('transform', '上法兰 · 共享下法兰', inputs=(flange.id,), position=(0, 0, 34))
    assembly = add('union', '点阵芯与下法兰', inputs=(core.id, flange.id))
    assembly = add('union', '双法兰点阵主体', inputs=(assembly.id, top.id))
    holes = []
    for i, (x, y) in enumerate([(18, 0), (0, 18), (-18, 0), (0, -18)], 1):
        holes.append(add('cylinder', f'安装孔 {i}', dimensions=(2.3, 48), position=(x, y, 0)))
    hole_group = holes[0]
    for i, hole in enumerate(holes[1:], 2):
        hole_group = add('union', f'合并安装孔 1–{i}', inputs=(hole_group.id, hole.id))
    assembly = add('difference', '双法兰减四孔', inputs=(assembly.id, hole_group.id))
    bore = add('cylinder', '贯穿轴向流道', dimensions=(4, 48), expressions={'dimensions.0': 'bore_radius'})
    add('difference', 'Gyroid 双法兰 · 最终实体', inputs=(assembly.id, bore.id))
    save(scene, 'gyroid-flanged-core.json')

    scene = SolidScene(cell_size=0.4, value_nodes=[
        parameter('p1', '球壳外半径 / mm', 'radius', 19),
        parameter('p2', '球壳壁厚 / mm', 'wall', 2.5),
        parameter('p3', '三向开孔半径 / mm', 'bore_radius', 9)])
    outer = add('sphere', '外球', dimensions=(19,), expressions={'dimensions.0': 'radius'})
    inner = add('sphere', '内球 · 共享壁厚', dimensions=(16.5,), expressions={'dimensions.0': 'radius - wall'})
    shell = add('difference', '空心球壳', inputs=(outer.id, inner.id))
    ring = add('torus', '赤道加强环', dimensions=(18, 2.8), expressions={'dimensions.0': 'radius - 1'})
    assembly = add('union', '球壳与加强环', inputs=(shell.id, ring.id))
    bore_x = add('cylinder', 'X 向贯穿流道', dimensions=(9, 50), rotation=(0, 90, 0),
                 expressions={'dimensions.0': 'bore_radius'})
    bore_y = add('cylinder', 'Y 向贯穿流道', dimensions=(9, 50), rotation=(90, 0, 0),
                 expressions={'dimensions.0': 'bore_radius'})
    bore_z = add('cylinder', 'Z 向贯穿流道', dimensions=(9, 50), expressions={'dimensions.0': 'bore_radius'})
    channels = add('union', 'XY 贯穿流道', inputs=(bore_x.id, bore_y.id))
    channels = add('union', 'XYZ 三向贯穿流道', inputs=(channels.id, bore_z.id))
    add('difference', '三向开孔球壳 · 最终实体', inputs=(assembly.id, channels.id))
    save(scene, 'perforated-ring-sphere.json')


if __name__ == '__main__':
    main()
