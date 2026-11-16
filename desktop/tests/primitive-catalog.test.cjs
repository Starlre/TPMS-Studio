const assert = require('node:assert/strict');
const test = require('node:test');

test('new primitive defaults are independent and every dimension supports parameter references',async()=>{
  const {PRIMITIVES} = await import('../src/primitive_catalog.mjs');
  const {createNode,NODE_KINDS} = await import('../src/node_graph.mjs');
  const {connectReference} = await import('../src/workflow_drag.mjs');
  for (const item of PRIMITIVES) {
    const scene={nodes:[],parameters:{},value_nodes:[{id:'p1',kind:'number',symbol:'radius',name:'Radius',value:2}]};
    const node=createNode(scene,item.kind,{});scene.nodes.push(node);scene.root=node.id;
    assert.equal(NODE_KINDS[item.kind],item.name);
    assert.deepEqual(node.dimensions,item.dimensions);
    for (let i=0;i<item.dimensions.length;i++) {
      const result=connectReference(scene,{action:'reference',type:'number',id:'p1'},{kind:'number',id:node.id,field:`dimensions.${i}`});
      assert.ok(result.scene,result.error);assert.equal(result.scene.nodes[0].expressions[`dimensions.${i}`],'radius');
    }
    node.dimensions[0]=999;assert.notEqual(item.dimensions[0],999);
  }
});

test('approximate primitives support smooth fusion even through transforms',async()=>{
  const {createNode,graphErrors} = await import('../src/node_graph.mjs');
  for (const kind of ['cone','frustum','ellipsoid']) {
    const scene={nodes:[]};
    const a=createNode(scene,kind,{});scene.nodes.push(a);
    const b=createNode(scene,'transform',{},a.id);scene.nodes.push(b);
    const c=createNode(scene,'sphere',{});scene.nodes.push(c);
    const smooth=createNode(scene,'smooth_union',{},b.id);smooth.inputs=[b.id,c.id];scene.nodes.push(smooth);
    assert.deepEqual(graphErrors(scene),{});
    for (const operation of ['union','intersection','difference','smooth_difference']) {smooth.kind=operation;assert.deepEqual(graphErrors(scene),{});}
  }
});

test('unified node catalog drives NODE_KINDS, ARITY, DIMENSIONS and inline choices consistently', async () => {
  const { NODE_CATALOG, NODE_SPECS, INLINE_NODE_KINDS } = await import('../src/primitive_catalog.mjs');
  const { NODE_KINDS, ARITY, DIMENSIONS } = await import('../src/node_graph.mjs');
  assert.deepEqual(Object.keys(NODE_KINDS), NODE_CATALOG.map(spec => spec.kind));
  for (const item of INLINE_NODE_KINDS) {
    assert.ok(NODE_SPECS[item.id], `missing NODE_SPECS entry for inline kind ${item.id}`);
    assert.equal(Boolean(ARITY[item.id]), NODE_SPECS[item.id].arity > 0);
    assert.deepEqual(DIMENSIONS[item.id], NODE_SPECS[item.id].dimensions || []);
  }
});

test('imported_solid validates file source, scale bounds and parameter binding', async () => {
  const { createNode, graphErrors } = await import('../src/node_graph.mjs');
  const { connectReference } = await import('../src/workflow_drag.mjs');
  const scene = { nodes: [], parameters: {}, value_nodes: [{ id: 'p1', kind: 'number', symbol: 'scale_k', name: '缩放系数', value: 1.1 }] };
  const imp = createNode(scene, 'imported_solid', {});
  scene.nodes.push(imp); scene.root = imp.id;
  assert.match(graphErrors(scene)[imp.id], /选择.*文件/);
  imp.operation.source = 'shoe.stl';
  assert.deepEqual(graphErrors(scene), {});
  imp.dimensions = [0];
  assert.match(graphErrors(scene)[imp.id], /缩放比例/);
  const bound = connectReference(scene, { action: 'reference', type: 'number', id: 'p1' }, { kind: 'number', id: imp.id, field: 'dimensions.0' });
  assert.ok(bound.scene, bound.error);
  assert.deepEqual(graphErrors(bound.scene), {});
});
