const { test } = require('node:test');
const assert = require('node:assert/strict');

test('typed parameter changes invalidate consumers and downstream, preserving unrelated branches', async () => {
  const { affectedNodes, valueConsumers } = await import('../src/node_graph.mjs');
  const scene = { cell_size: 0.5, parameters: { wall: 1 }, value_nodes: [
    { id: 'p1', name: '数值', symbol: 'radius', kind: 'number', value: 4 },
    { id: 'p2', name: '公式', symbol: 'diameter', kind: 'formula', expression: 'radius * 2' },
    { id: 'p3', name: '向量', symbol: 'offset', kind: 'vector', components: ['diameter', 0, 0] },
  ], nodes: [
    { id: 'n1', name: '球', inputs: [], expressions: { 'dimensions.0': 'diameter' } },
    { id: 'n2', name: '盒', inputs: [], expressions: {} },
    { id: 'n3', name: '差集', inputs: ['n1', 'n2'] },
    { id: 'n4', name: '变换', inputs: ['n3'], vector_inputs: { position: 'p3' } },
    { id: 'n5', name: '其他', inputs: [], expressions: { 'position.0': 'offset_x' } },
  ] };
  const next = structuredClone(scene); next.value_nodes[0].value = 5;
  assert.deepEqual([...affectedNodes(scene, next)].sort(), ['n1', 'n3', 'n4', 'n5']);
  assert.deepEqual(valueConsumers(scene, scene.value_nodes[2]).map(n => n.id), ['n4', 'n5']);
  const rename = structuredClone(scene); rename.nodes[0].name = '新名称'; rename.value_nodes[0].name = '新名称';
  assert.equal(affectedNodes(scene, rename).size, 0);
  assert.equal(affectedNodes(scene, { ...scene, cell_size: 0.25 }).size, 5);
  const geometry = structuredClone(scene); geometry.nodes[1].dimensions = [2, 2, 2];
  assert.deepEqual([...affectedNodes(scene, geometry)], ['n2', 'n3', 'n4']);
});
