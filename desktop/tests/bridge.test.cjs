const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { PythonBridge } = require('../bridge.cjs');
const root = path.resolve(process.env.TPMS_PROJECT_ROOT || path.join(__dirname, '../..'));

test('real Python/libfive IPC: mesh, region, export, error recovery and cancellation', { timeout: 120000 }, async t => {
  const progress = [];
  const bridge = new PythonBridge(root, message => progress.push(message));
  t.after(() => bridge.close());
  const init = await bridge.call('init');
  assert.equal(init.libfive, true);
  assert.match(init.shader, /evalMap/);
  const p = { size_x: 12, size_y: 12, size_z: 12, cells_x: 1, cells_y: 1, cells_z: 1, thickness: 1.2, samples_per_cell: 24 };
  const generated = await bridge.call('generate_tpms', { parameters: p });
  assert.equal(generated.mode, 'tpms');
  assert.equal(generated.stats.watertight, true);
  assert.ok(generated.stats.faces > 1000);
  assert.equal(generated.geometry.positions.byteLength, generated.stats.vertices * 12);
  assert.equal(generated.geometry.indices.byteLength, generated.stats.faces * 12);
  assert.ok(generated.stats.porosity > 0 && generated.stats.porosity < 1);
  const region = await bridge.call('region', { options: { surface_samples_per_cell: 24 } });
  assert.equal(region.geometry.positions.byteLength, region.geometry.colors.byteLength);
  const destination = path.join(bridge.transfer, '导出验证.stl');
  const exported = await bridge.call('export', { destination, quality: 'original' });
  assert.equal(exported.faces, generated.stats.faces);
  assert.equal((await fs.stat(destination)).size, 84 + 50 * exported.faces);
  await assert.rejects(bridge.call('generate_tpms', { parameters: { ...p, samples_per_cell: 512 } }), /上限/);
  const preset = await bridge.call('preset', { kind: 'sphere_hole' });
  const solid = await bridge.call('generate_solid', { scene: preset.scene });
  assert.equal(solid.mode, 'solid');
  assert.equal(solid.stats.watertight, true);
  await assert.rejects(bridge.call('region'), /实体组合暂不支持/);
  assert.ok(progress.length > 0);
  const controlled = await bridge.call('generate_tpms', { parameters: { ...p, target_porosity: 0.7 } });
  assert.ok(Math.abs(controlled.stats.porosity - 0.7) < 0.05);
  assert.ok(controlled.parameters.thickness !== p.thickness);
  const nativeTPMS = await bridge.call('generate_tpms', { parameters: { ...p,
    gradient_enabled: true, gradient_axis: 'Z', gradient_thickness_start: 1, gradient_thickness_end: 2 }, kernel: 'libfive', cell_size: 0.4 });
  assert.equal(nativeTPMS.stats.watertight, true);
  const pending = bridge.call('generate_tpms', { parameters: { ...p, samples_per_cell: 96 } });
  const rejected = assert.rejects(pending, /取消/);
  // Let request be enqueued, then terminate native computation.
  await new Promise(resolve => setTimeout(resolve, 20));
  bridge.cancel(); await rejected;
  assert.equal((await bridge.call('init')).libfive, true);
  await assert.rejects(bridge.call('export', { destination, quality: 'original' }), /没有模型/);
});
