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

test('approximate primitives are blocked from smooth fusion even through transforms',async()=>{
  const {createNode,graphErrors} = await import('../src/node_graph.mjs');
  for (const kind of ['cone','frustum','ellipsoid']) {
    const scene={nodes:[]};
    const a=createNode(scene,kind,{});scene.nodes.push(a);
    const b=createNode(scene,'transform',{},a.id);scene.nodes.push(b);
    const c=createNode(scene,'sphere',{});scene.nodes.push(c);
    const smooth=createNode(scene,'smooth_union',{},b.id);smooth.inputs=[b.id,c.id];scene.nodes.push(smooth);
    assert.match(graphErrors(scene)[smooth.id],/平滑融合/);
    for (const operation of ['union','intersection','difference']) {smooth.kind=operation;assert.deepEqual(graphErrors(scene),{});}
  }
});
