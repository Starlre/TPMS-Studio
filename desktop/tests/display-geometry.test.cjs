const test = require('node:test');
const assert = require('node:assert/strict');
const THREE = require('three');

function trianglePositions(geometry) {
  const p = geometry.attributes.position;
  return Array.from(geometry.index.array).flatMap(v => [p.getX(v), p.getY(v), p.getZ(v)]);
}

test('a shared cylinder rim keeps planar caps and smooth sides without moving triangles', async () => {
  const { mergeVertices } = await import('three/addons/utils/BufferGeometryUtils.js');
  const { createDisplayGeometry } = await import('../src/display_geometry.mjs');
  const original = new THREE.CylinderGeometry(8, 8, 6, 64);
  original.deleteAttribute('normal'); original.deleteAttribute('uv');
  const source = mergeVertices(original);
  const before = trianglePositions(source), oldIndices = source.index.array.slice();
  const display = createDisplayGeometry(source), p = display.attributes.position, n = display.attributes.normal;
  assert.deepEqual(trianglePositions(display), before);
  assert.deepEqual(source.index.array, oldIndices);
  for (let k = 0; k < display.index.count; k += 3) {
    const ids = Array.from(display.index.array.slice(k, k + 3));
    const ys = ids.map(v => p.getY(v));
    const cap = ys.every(y => y === 3) || ys.every(y => y === -3);
    for (const v of ids) {
      assert.ok(Math.abs(Math.hypot(n.getX(v), n.getY(v), n.getZ(v)) - 1) < 1e-5);
      if (cap) assert.ok(Math.abs(n.getY(v) - Math.sign(ys[0])) < 1e-5, 'cap normals must be planar to the rim');
      else {
        assert.ok(Math.abs(n.getY(v)) < 1e-5, 'sides must not borrow the cap normal');
        const radius = Math.hypot(p.getX(v), p.getZ(v));
        assert.ok((n.getX(v) * p.getX(v) + n.getZ(v) * p.getZ(v)) / radius > 0.998);
      }
    }
  }
});

test('sphere shading stays smooth and a sub-micron gap is never welded', async () => {
  const { createDisplayGeometry } = await import('../src/display_geometry.mjs');
  const sphere = new THREE.SphereGeometry(10, 64, 32), display = createDisplayGeometry(sphere);
  const p = display.attributes.position, n = display.attributes.normal;
  for (const v of display.index.array) assert.ok((p.getX(v) * n.getX(v) + p.getY(v) * n.getY(v) + p.getZ(v) * n.getZ(v)) / 10 > 0.998);
  const close = new THREE.BufferGeometry();
  close.setAttribute('position', new THREE.Float32BufferAttribute([0,0,0, 1,0,0, 0,1,0, 0,0,0.000001, 1,0,0.000001, 0,1,0.000001], 3));
  close.setIndex([0,1,2, 3,5,4]);
  const sheets = createDisplayGeometry(close);
  assert.equal(sheets.attributes.normal.getZ(0), 1);
  assert.equal(sheets.attributes.normal.getZ(3), -1);
  assert.deepEqual(trianglePositions(sheets), trianglePositions(close));
});

test('implicit preview eligibility includes only supported TPMS fields', async () => {
  const { supportsImplicitPreview } = await import('../src/display_geometry.mjs');
  assert.equal(supportsImplicitPreview(null), false);
  assert.equal(supportsImplicitPreview({ surface: 'Custom' }), false);
  assert.equal(supportsImplicitPreview({ surface: 'Gyroid', tubular_enabled: true }), false);
  assert.equal(supportsImplicitPreview({ surface: 'Gyroid', tubular_enabled: false }), true);
});
