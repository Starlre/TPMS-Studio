"""Verify the published STL, public metadata and editable example agree."""
from pathlib import Path
import hashlib
import json
import numpy as np
import trimesh

root = Path(__file__).resolve().parent.parent
metadata = json.loads((root / 'docs/models/gyroid-flanged-core.metadata.json').read_text(encoding='utf-8'))
file = root / 'docs' / metadata['file']
assert file.stat().st_size == metadata['stl_bytes']
assert hashlib.sha256(file.read_bytes()).hexdigest() == metadata['sha256']
mesh = trimesh.load_mesh(file, process=True)
assert len(mesh.faces) == metadata['faces']
assert len(mesh.vertices) == metadata['vertices']
assert mesh.is_watertight and mesh.is_winding_consistent and mesh.volume > 0
assert len(mesh.split(only_watertight=False)) == metadata['connected_components'] == 1
assert np.allclose(mesh.bounds, metadata['bounds_mm'], atol=1e-5)
assert np.allclose(mesh.extents, metadata['extents_mm'], atol=1e-5)
assert np.isclose(mesh.volume, metadata['volume_mm3'], atol=1e-5, rtol=1e-8)
assert np.isclose(mesh.area, metadata['area_mm2'], atol=1e-5, rtol=1e-8)
original = json.loads((root / 'examples/showcase/gyroid-flanged-core.json').read_text(encoding='utf-8'))
published = json.loads((root / 'docs' / metadata['project']).read_text(encoding='utf-8'))
assert published == original
assert len(published['scene']['nodes']) == 19 and len(published['scene']['value_nodes']) == 3
assert published['scene']['cell_size'] == metadata['cell_size_mm']
print(f"Published double-flange STL verified: {len(mesh.faces):,} faces, {mesh.extents.tolist()} mm, watertight, one component; SHA-256 and editable project match.")
