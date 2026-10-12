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

test('shell inputs reject approximate fields and combinations but accept analytic transformed solids', async () => {
  const {createNode,graphErrors} = await import('../src/node_graph.mjs');
  for(const kind of ['tpms','cone','frustum','ellipsoid','union']) {
    const scene={nodes:[],root:''};const body=createNode(scene,kind,{});scene.nodes.push(body);
    const shell=createNode(scene,'shell',{},body.id);scene.nodes.push(shell);
    assert.match(graphErrors(scene)[shell.id],/先对距离函数基本体抽壳/);
  }
  const scene={nodes:[],root:''};const body=createNode(scene,'cylinder',{});scene.nodes.push(body);
  const transform=createNode(scene,'transform',{},body.id);scene.nodes.push(transform);
  const shell=createNode(scene,'shell',{},transform.id);scene.nodes.push(shell);
  assert.deepEqual(graphErrors(scene),{});
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
