const { test } = require('node:test');
const assert = require('node:assert/strict');

test('references are acyclic, topologically ordered and output-scoped', async () => {
  const { createNode, graphErrors, inputOptions, orderedNodes, ancestors } = await import('../src/node_graph.mjs');
  const scene = { nodes: [], root: '', parameters: {} };
  for (const kind of ['sphere', 'cylinder', 'difference', 'transform']) {
    const node = createNode(scene, kind, {}, scene.root);
    scene.nodes.push(node); scene.root = node.id;
  }
  assert.deepEqual(graphErrors(scene), {});
  assert.deepEqual(orderedNodes([...scene.nodes].reverse()).map(n => n.id), ['n2', 'n1', 'n3', 'n4']);
  assert.equal(inputOptions(scene.nodes, 'n3').some(n => n.id === 'n4'), false);
  assert.equal(ancestors(scene.nodes, 'n4').size, 4);
  scene.nodes[2].inputs[0] = 'n4';
  assert.match(graphErrors(scene).n3, /循环/);
  scene.nodes[2].inputs = ['n1', 'n1'];
  assert.match(graphErrors(scene).n3, /不同/);
  scene.nodes[2].inputs = ['n1', 'missing'];
  assert.match(graphErrors(scene).n3, /上游/);
});

test('smooth_union and smooth_difference support TPMS and transforms while guarding heavy fanout', async () => {
  const { graphErrors } = await import('../src/node_graph.mjs');
  const nodes = [
    { id: 'n1', name: 'TPMS', kind: 'tpms', inputs: [] },
    { id: 'n2', name: '变换', kind: 'transform', inputs: ['n1'] },
    { id: 'n3', name: '球体', kind: 'sphere', inputs: [] },
    { id: 'n4', name: '融合', kind: 'smooth_union', inputs: ['n2', 'n3'] },
  ];
  assert.deepEqual(graphErrors({ nodes }), {});
  const heavy = [
    { id: 's', name: '球', kind: 'sphere', inputs: [] },
    { id: 'p1', name: '阵列1', kind: 'linear_pattern', dimensions: [8, 8, 1, 10, 10, 10], inputs: ['s'] },
    { id: 'p2', name: '阵列2', kind: 'circular_pattern', dimensions: [2, 180], inputs: ['p1'] },
    { id: 'b', name: '盒', kind: 'box', inputs: [] },
    { id: 'u', name: '平滑差集', kind: 'smooth_difference', inputs: ['p2', 'b'] },
  ];
  assert.match(graphErrors({ nodes: heavy }).u, /扇出/);
});
