"""Read actual UI exports and publish environment-free geometry evidence."""
from pathlib import Path
import argparse
import json
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--project', type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument('--exports', type=Path, nargs='+', required=True, help='Directories containing the UI-exported STL files')
    parser.add_argument('--examples', type=Path, default=Path('examples/showcase'))
    parser.add_argument('--output', type=Path, default=Path('examples/showcase/geometry-report.json'))
    args = parser.parse_args()
    sys.path.insert(0, str(args.project.resolve()))
    import trimesh
    from solid_model import SolidScene
    records = []
    projects = [
        ('gyroid-flanged-core', args.examples / 'gyroid-flanged-core.json', 'examples/showcase/gyroid-flanged-core.json'),
        ('perforated-ring-sphere', args.examples / 'perforated-ring-sphere.json', 'examples/showcase/perforated-ring-sphere.json'),
        ('eight-petal-flower', args.project / 'examples/parametric-flower/eight-petal-flower.json', 'examples/parametric-flower/eight-petal-flower.json')]
    for name, project_file, public_file in projects:
        mesh_file = next((folder / (name + '.stl') for folder in args.exports if (folder / (name + '.stl')).is_file()), None)
        if mesh_file is None:
            raise ValueError(f'Missing actual UI export: {name}.stl')
        raw = json.loads(project_file.read_text(encoding='utf-8'))
        scene = SolidScene.from_dict(raw['scene'])
        mesh = trimesh.load_mesh(mesh_file, process=True)
        if not mesh.is_watertight or not mesh.is_winding_consistent or mesh.volume <= 0:
            raise ValueError(f'{name}: failed watertight/winding/positive-volume validation')
        records.append({'project': public_file, 'geometry_nodes': len(scene.nodes), 'value_nodes': len(scene.value_nodes),
            'cell_size_mm': scene.cell_size, 'faces': len(mesh.faces), 'vertices': len(mesh.vertices),
            'bounds_mm': mesh.bounds.round(6).tolist(), 'extents_mm': mesh.extents.round(6).tolist(),
            'volume_mm3': round(float(mesh.volume), 6), 'area_mm2': round(float(mesh.area), 6),
            'watertight': bool(mesh.is_watertight), 'winding_consistent': bool(mesh.is_winding_consistent),
            'connected_components': len(mesh.split(only_watertight=False)), 'stl_bytes': mesh_file.stat().st_size})
        print(f"{name}: {records[-1]['faces']} faces; watertight; {records[-1]['connected_components']} components", flush=True)
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({'description': 'Actual original-quality STL exports read back from the desktop application. Defaults only; no manufacturing or simulation validation.',
                                     'units': 'mm', 'models': records}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


if __name__ == '__main__':
    main()
