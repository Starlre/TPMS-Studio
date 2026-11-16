const test = require('node:test');
const assert = require('node:assert/strict');

test('operation nodes bind selected sources, have independent parameters and invalidate downstream', async () => {
  const {createNode,graphErrors,affectedNodes} = await import('../src/node_graph.mjs');
  const scene = {nodes:[],root:'',cell_size:.3};
  const body = createNode(scene,'box',{});scene.nodes.push(body);
  const shell = createNode(scene,'shell',{},body.id);scene.nodes.push(shell);
  const cut = createNode(scene,'transform',{},shell.id);scene.nodes.push(cut);scene.root=cut.id;
  assert.deepEqual(shell.inputs,[body.id]);assert.deepEqual(cut.inputs,[shell.id]);
  assert.deepEqual(shell.operation,{opening:'closed'});assert.equal(cut.operation,undefined);
  assert.deepEqual(graphErrors(scene),{});
  const changed = structuredClone(scene);changed.nodes[1].operation.opening='+Z';
  assert.deepEqual([...affectedNodes(scene,changed)],[shell.id,cut.id]);
  assert.equal(scene.nodes[1].operation.opening,'closed');
  changed.nodes[2].inputs=[cut.id];assert.match(graphErrors(changed)[cut.id],/循环/);
});

test('shell and offset accept approximate primitives, combinations and TPMS while guarding excessive fanout', async () => {
  const { createNode, graphErrors } = await import('../src/node_graph.mjs');
  for (const kind of ['tpms', 'cone', 'frustum', 'ellipsoid']) {
    const scene = { nodes: [], root: '' };
    const body = createNode(scene, kind, {});
    scene.nodes.push(body);
    const shell = createNode(scene, 'shell', {}, body.id);
    scene.nodes.push(shell);
    assert.deepEqual(graphErrors(scene), {});
  }
  const bscene = { nodes: [], root: '' };
  const bx = createNode(bscene, 'box', {}); bscene.nodes.push(bx);
  const cy = createNode(bscene, 'cylinder', {}); bscene.nodes.push(cy);
  const un = createNode(bscene, 'union', {}, bx.id); un.inputs = [bx.id, cy.id]; bscene.nodes.push(un);
  const sh = createNode(bscene, 'shell', {}, un.id); bscene.nodes.push(sh);
  assert.deepEqual(graphErrors(bscene), {});

  const heavy = { nodes: [], root: '' };
  const cn = createNode(heavy, 'cone', {}); heavy.nodes.push(cn);
  const pat = createNode(heavy, 'linear_pattern', {}, cn.id); pat.dimensions = [6, 6, 1, 14, 14, 14]; heavy.nodes.push(pat);
  const pat2 = createNode(heavy, 'circular_pattern', {}, pat.id); pat2.dimensions = [2, 180]; heavy.nodes.push(pat2);
  const hsh = createNode(heavy, 'shell', {}, pat2.id); heavy.nodes.push(hsh);
  assert.match(graphErrors(heavy)[hsh.id], /扇出/);
});

test('removed operations cannot be created and legacy nodes have explicit errors', async () => {
  const {createNode,graphErrors,NODE_KINDS} = await import('../src/node_graph.mjs');
  for (const kind of ['extrude','extrude_cut']) {
    const scene={nodes:[],root:''};
    assert.equal(NODE_KINDS[kind],undefined);
    assert.throws(()=>createNode(scene,kind,{}),/不支持/);
    scene.nodes.push({id:'old',name:'旧操作',kind,inputs:[]});
    assert.match(graphErrors(scene).old,/拉伸和切除操作已移除/);
  }
});

test('new P0 feature nodes expose valid defaults, arity and upstream validation', async () => {
  const { createNode, graphErrors, affectedNodes, ARITY } = await import('../src/node_graph.mjs');
  const scene = { nodes: [], root: '' };
  const cyl = createNode(scene, 'cylinder', {});
  scene.nodes.push(cyl);
  for (const kind of ['offset', 'mirror', 'linear_pattern', 'circular_pattern']) {
    assert.equal(ARITY[kind], 1);
    const node = createNode(scene, kind, {}, cyl.id);
    scene.nodes.push(node);
    assert.deepEqual(graphErrors(scene), {});
  }
  const box = createNode(scene, 'box', {});
  scene.nodes.push(box);
  const sdiff = createNode(scene, 'smooth_difference', {}, box.id);
  sdiff.inputs = [box.id, cyl.id];
  scene.nodes.push(sdiff);
  assert.deepEqual(graphErrors(scene), {});

  // Invalid offset = 0 and linear total > 64 are caught immediately in graphErrors.
  const bad = structuredClone(scene);
  bad.nodes[1].dimensions = [0];
  bad.nodes[3].dimensions = [10, 10, 1, 10, 10, 10];
  const errs = graphErrors(bad);
  assert.match(errs[bad.nodes[1].id], /偏置/);
  assert.match(errs[bad.nodes[3].id], /64/);

  // Smooth difference respects smooth incompatibility just like smooth union.
  const tpmsScene = { nodes: [box] };
  const tpms = createNode(tpmsScene, 'tpms', {});
  tpmsScene.nodes.push(tpms);
  const sdiff2 = createNode(tpmsScene, 'smooth_difference', {});
  sdiff2.inputs = [tpms.id, box.id];
  tpmsScene.nodes.push(sdiff2);
  assert.match(graphErrors(tpmsScene)[sdiff2.id], /TPMS/);
  assert.ok(affectedNodes(scene, bad).has(bad.nodes[1].id));
});
