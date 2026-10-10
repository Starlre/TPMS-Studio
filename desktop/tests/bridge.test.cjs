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
  const legacy = { type:'tpms-electron', version:1, mode:'solid', parameters:p,
    scene:{...preset.scene, parameters:{radius:8},
      value_nodes:[{id:'p1',kind:'vector',name:'位移',symbol:'offset',components:[3,0,0]}],
      nodes:preset.scene.nodes.map((node,index) => index === 0 ? {...node,expressions:{'dimensions.0':'radius'},vector_inputs:{position:'p1'}} : node) },
    cfd:{} };
  const migrated = (await bridge.call('validate_project', {project:legacy})).project;
  assert.equal(migrated.mode,'nodes');
  assert.deepEqual(migrated.scene,legacy.scene);
  const raw = (await bridge.call('validate_project', {project:legacy.scene})).project;
  assert.equal(raw.mode,'nodes');
  assert.equal(raw.scene.root,legacy.scene.root);
  assert.deepEqual(raw.scene.value_nodes,legacy.scene.value_nodes);
  assert.deepEqual(raw.scene.nodes[0].expressions,legacy.scene.nodes[0].expressions);
  assert.deepEqual(raw.scene.nodes[0].vector_inputs,legacy.scene.nodes[0].vector_inputs);
  assert.equal((await bridge.call('validate_project', {project:{...legacy,mode:'tpms'}})).project.mode,'tpms');
  assert.equal((await bridge.call('validate_project', {project:{...legacy,mode:'nodes'}})).project.mode,'nodes');
  await assert.rejects(bridge.call('validate_project', {project:{...legacy,mode:'unknown'}}), /建模模式无效/);
  const solid = await bridge.call('generate_solid', { scene: preset.scene });
  assert.equal(solid.mode, 'solid');
  assert.equal(solid.stats.watertight, true);
  const exportBeforeLayout = path.join(bridge.transfer, 'before-layout.stl');
  await bridge.call('export', { destination: exportBeforeLayout });
  const incomplete = { ...preset.scene.nodes[2], id: 'unfinished', name: '未完成布尔', inputs: ['', ''] };
  const layoutScene = { ...preset.scene, nodes: [...preset.scene.nodes.map((node, i) =>
    i === 1 ? { ...node, position: [30, 0, 0] } : node), incomplete] };
  const layout = await bridge.call('preview_scene', { scene: layoutScene });
  assert.equal(layout.objects.length, 3);
  assert.match(layout.errors.unfinished, /输入|引用/);
  for (const object of layout.objects) {
    assert.equal(object.geometry.positions.byteLength, object.stats.vertices * 12);
    assert.equal(object.geometry.indices.byteLength, object.stats.faces * 12);
  }
  assert.ok(layout.objects.find(object => object.id === preset.scene.nodes[1].id).stats.bounds[0][0] > 20);
  const exportAfterLayout = path.join(bridge.transfer, 'after-layout.stl');
  await bridge.call('export', { destination: exportAfterLayout });
  assert.deepEqual(await fs.readFile(exportAfterLayout), await fs.readFile(exportBeforeLayout));
  assert.equal((await fs.readdir(bridge.transfer)).filter(file => file.endsWith('.mesh')).length, 0);
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
