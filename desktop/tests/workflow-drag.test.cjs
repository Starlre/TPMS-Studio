const { test } = require('node:test');
const assert = require('node:assert/strict');
const scene = () => ({ version: 1, root: 'n4', cell_size: 0.5, parameters: {}, value_nodes: [
  { id: 'p1', kind: 'number', name: '半径', symbol: 'radius', value: 4 },
  { id: 'p2', kind: 'formula', name: '直径', symbol: 'diameter', expression: 'radius * 2' },
  { id: 'p3', kind: 'vector', name: '位移', symbol: 'offset', components: ['diameter', 0, 0] }
], nodes: [
  { id: 'n1', kind: 'sphere', name: '球', dimensions: [4], position: [0, 0, 0], inputs: [], expressions: {} },
  { id: 'n2', kind: 'cylinder', name: '孔', dimensions: [1, 10], inputs: [] },
  { id: 'n3', kind: 'difference', name: '差集', inputs: ['n1', 'n2'] },
  { id: 'n4', kind: 'transform', name: '输出', position: [0, 0, 0], rotation: [0, 0, 0], inputs: ['n3'] }
] });
const ref = (type, id) => ({ action: 'reference', type, id });

test('display reorder is persistent data but not a geometry edit, with stable histories', async () => {
  const { reorderScene, onlyOrderChanged, sceneSignature } = await import('../src/workflow_drag.mjs');
  const { affectedNodes } = await import('../src/node_graph.mjs');
  const before = scene(), next = reorderScene(before, 'body', 'n4', 'n1');
  assert.deepEqual(next.nodes.map(n => n.id), ['n4', 'n1', 'n2', 'n3']);
  assert.equal(next.root, 'n4'); assert.deepEqual(next.nodes[0].inputs, ['n3']);
  assert.equal(onlyOrderChanged(before, next), true); assert.equal(affectedNodes(before, next).size, 0);
  const values = reorderScene(next, 'value', 'p3', 'p1'); assert.equal(sceneSignature(values), sceneSignature(before));
  assert.deepEqual(reorderScene(values, 'body', 'n4', 'n3', 'after').nodes, before.nodes);
  assert.equal(reorderScene(before, 'body', 'missing', 'n1'), before);
  assert.equal(reorderScene(before, 'body', 'n1', 'n2', 'before'), before);
  assert.equal(onlyOrderChanged(before, { ...before, root: 'n1' }), false);
  assert.equal(onlyOrderChanged(before, { ...before, value_nodes: [{ ...before.value_nodes[0], value: 9 }, ...before.value_nodes.slice(1)] }), false);
});
test('mixed notebook ordering stays independent of computation and ignores stale display IDs', async () => {
  const { notebookOrder, reorderScene, onlyOrderChanged } = await import('../src/workflow_drag.mjs');
  const before = scene();
  before.notebook_order = ['n1', 'value:p1', 'n2', 'value:p2', 'n3', 'n4', 'value:p3', 'missing', 'n1'];
  const next = reorderScene(before, 'notebook', 'n4', 'value:p1');
  assert.deepEqual(notebookOrder(next), ['n1', 'n4', 'value:p1', 'n2', 'value:p2', 'n3', 'value:p3']);
  assert.equal(onlyOrderChanged(before, next), true);
  assert.equal(next.root, before.root);
  assert.deepEqual(next.nodes.find(n => n.id === 'n4').inputs, ['n3']);
  assert.equal(reorderScene(before, 'notebook', 'absent', 'n1'), before);
});
test('body links reject cycles, duplicate inputs, missing sources and TPMS smooth unions atomically', async () => {
  const { connectReference } = await import('../src/workflow_drag.mjs'); const before = scene(), original = JSON.stringify(before);
  for (const [target, source, text] of [
    [{ kind: 'body', id: 'n4', index: 0 }, 'n4', /循环/],
    [{ kind: 'body', id: 'n3', index: 0 }, 'n4', /循环/],
    [{ kind: 'body', id: 'n3', index: 1 }, 'n1', /不同/],
    [{ kind: 'body', id: 'n3', index: 1 }, 'missing', /不存在/]
  ]) assert.match(connectReference(before, ref('body', source), target).error, text);
  assert.equal(JSON.stringify(before), original);
  const next = connectReference(before, ref('body', 'n2'), { kind: 'body', id: 'n4', index: 0 }).scene;
  assert.deepEqual(next.nodes[3].inputs, ['n2']); assert.deepEqual(before.nodes[3].inputs, ['n3']);
  assert.equal(connectReference(before, ref('body', 'n1'), { kind: 'root' }).scene.root, 'n1');
  const mixed = scene(); mixed.nodes[0].kind = 'tpms'; mixed.nodes[2].kind = 'smooth_union'; mixed.nodes[2].inputs = ['', ''];
  assert.match(connectReference(mixed, ref('body', 'n1'), { kind: 'body', id: 'n3', index: 0 }).error, /TPMS/);
});
test('typed links set scalar/vector bindings and enforce value graph cycles and symbol conflicts', async () => {
  const { connectReference } = await import('../src/workflow_drag.mjs'); const before = scene();
  const scalar = { kind: 'number', id: 'n1', field: 'dimensions.0' }, vector = { kind: 'vector', id: 'n4', field: 'position' };
  assert.equal(connectReference(before, ref('number', 'p2'), scalar).scene.nodes[0].expressions['dimensions.0'], 'diameter');
  assert.match(connectReference(before, ref('vector', 'p3'), scalar).error, /数值/);
  assert.match(connectReference(before, ref('body', 'n1'), vector).error, /向量/);
  assert.match(connectReference(before, ref('vector', 'p1'), vector).error, /类型/);
  before.nodes[3].expressions = { 'position.0': 'radius', 'rotation.0': 'radius' };
  const next = connectReference(before, ref('vector', 'p3'), vector).scene;
  assert.equal(next.nodes[3].vector_inputs.position, 'p3'); assert.deepEqual(next.nodes[3].expressions, { 'rotation.0': 'radius' });
  assert.match(connectReference(next, ref('number', 'p1'), { kind: 'number', id: 'n4', field: 'position.0' }).error, /解除/);
  assert.equal(connectReference(before, ref('number', 'p1'), { kind: 'value-expression', id: 'p2' }).scene.value_nodes[1].expression, 'radius');
  assert.match(connectReference(before, ref('number', 'p2'), { kind: 'value-expression', id: 'p2' }).error, /循环/);
  // A vector-component alias can close a cycle through a scalar formula.
  before.value_nodes.push({ id: 'p4', kind: 'formula', name: '分量', symbol: 'other', expression: 'offset_x' });
  assert.match(connectReference(before, ref('number', 'p4'), { kind: 'value-component', id: 'p3', index: 0 }).error, /循环/);
  before.value_nodes[0].symbol = 'diameter'; assert.match(connectReference(before, ref('number', 'p2'), scalar).error, /冲突/);
});
test('external, malformed or sorting drag data cannot become a reference', async () => {
  const { readDrag, connectReference } = await import('../src/workflow_drag.mjs');
  for (const text of ['', '{', '{}', 'null', '{"action":"file","id":"n1"}']) assert.equal(readDrag({ getData: () => text }), null);
  assert.match(connectReference(scene(), { action: 'sort', id: 'n1' }, { kind: 'root' }).error, /类型按钮/);
});
