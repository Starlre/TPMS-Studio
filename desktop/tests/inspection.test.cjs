const { test } = require('node:test');
const assert = require('node:assert/strict');

async function helpers() { return { ...(await import('../src/inspection_math.mjs')), THREE: await import('three') }; }
function arrays(THREE, size, offset = [0, 0, 0]) {
  const geometry = new THREE.BoxGeometry(...size); geometry.translate(...offset);
  return { positions: geometry.attributes.position.array, indices: geometry.index.array };
}
test('translated axis and arbitrary plane: true material area, perimeter and world-coordinate picking', async () => {
  const { THREE, sectionMesh, pickMeshPoint, planeNormal, planeRange, distanceBetween, DEFAULT_SECTION } = await helpers();
  const mesh = arrays(THREE, [10, 8, 6], [20, -3, 7]);
  const section = { ...DEFAULT_SECTION, enabled: true, axis: 'Z', offset: 7 };
  const result = sectionMesh(mesh.positions, mesh.indices, section);
  assert.equal(result.open, 0); assert.equal(result.loops, 1);
  assert.ok(Math.abs(result.area - 80) < 1e-6); assert.ok(Math.abs(result.perimeter - 36) < 1e-6);
  const capHit = pickMeshPoint(mesh.positions, mesh.indices, [20, -3, 30], [0, 0, -1], section, result.cap);
  assert.ok(distanceBetween(capHit, [20, -3, 7]) < 1e-7);
  const noCap = pickMeshPoint(mesh.positions, mesh.indices, [20, -3, 30], [0, 0, -1], { ...section, fill: false }, result.cap);
  assert.ok(distanceBetween(noCap, [20, -3, 4]) < 1e-7); // Hidden front surface must never be measured.
  const n = planeNormal({ axis: 'custom', normal: [1, 1, 0] });
  const range = planeRange([[15, -7, 4], [25, 1, 10]], n);
  assert.ok(Math.abs(range[0] - 8 / Math.sqrt(2)) < 1e-7);
  const diagonal = sectionMesh(mesh.positions, mesh.indices, { ...section, axis: 'custom', normal: [1, 1, 0], offset: 17 / Math.sqrt(2) });
  assert.ok(Math.abs(diagonal.area - 48 * Math.sqrt(2)) < 1e-5);
  assert.equal(distanceBetween([0, 0, 0], [3, 4, 12]), 13);
});
test('nested section loops leave holes empty, and open cuts never invent a filled face', async () => {
  const { THREE, sectionMesh, pickMeshPoint, DEFAULT_SECTION } = await helpers();
  const outer = arrays(THREE, [10, 10, 10]), inner = arrays(THREE, [6, 6, 6]);
  const positions = new Float32Array([...outer.positions, ...inner.positions]);
  const indices = new Uint32Array([...outer.indices, ...Array.from(inner.indices, n => n + outer.positions.length / 3)]);
  const section = { ...DEFAULT_SECTION, enabled: true, axis: 'Z', only: true };
  const result = sectionMesh(positions, indices, section);
  assert.equal(result.loops, 2); assert.equal(result.area, 64); assert.equal(result.perimeter, 64);
  assert.equal(pickMeshPoint(positions, indices, [0, 0, 20], [0, 0, -1], section, result.cap), null);
  assert.deepEqual(pickMeshPoint(positions, indices, [4, 0, 20], [0, 0, -1], section, result.cap), [4, 0, 0]);
  const open = sectionMesh(new Float32Array([-1, 0, -1, 1, 0, -1, 0, 0, 1]), new Uint32Array([0, 1, 2]), section);
  assert.equal(open.area, null); assert.equal(open.cap.length, 0); assert.equal(open.open, 1);
});
test('boundary, missed and reversed cuts; invalid normals are rejected', async () => {
  const { THREE, sectionMesh, pickMeshPoint, planeNormal, DEFAULT_SECTION } = await helpers();
  const mesh = arrays(THREE, [10, 10, 10]);
  const section = { ...DEFAULT_SECTION, enabled: true, axis: 'Z', offset: 0, fill: false, positive: true };
  assert.deepEqual(pickMeshPoint(mesh.positions, mesh.indices, [0, 0, -20], [0, 0, 1], section), [0, 0, 5]);
  const boundary = sectionMesh(mesh.positions, mesh.indices, { ...section, offset: 5 });
  assert.equal(boundary.area, 100); assert.equal(boundary.loops, 1);
  const outside = sectionMesh(mesh.positions, mesh.indices, { ...section, offset: 6 });
  assert.equal(outside.segments, 0); assert.equal(outside.area, 0);
  assert.throws(() => planeNormal({ axis: 'custom', normal: [0, 0, 0] }), /不能为零/);
  assert.throws(() => planeNormal({ axis: 'custom', normal: [NaN, 0, 1] }), /有限数字/);
});
