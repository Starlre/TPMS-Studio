// The scene is a DAG: card order is presentation, inputs determine computation.
export const NODE_KINDS = { sphere: '球体', box: '长方体', cylinder: '圆柱', torus: '圆环', tpms: 'TPMS',
  union: '并集', intersection: '交集', difference: '差集 A−B', smooth_union: '平滑融合', transform: '变换' };
export const ARITY = { union: 2, intersection: 2, difference: 2, smooth_union: 2, transform: 1 };
export const DIMENSIONS = { sphere: [8], box: [16, 16, 16], cylinder: [6, 24], torus: [10, 3], tpms: [] };

export function ancestors(nodes, id, seen = new Set()) {
  if (seen.has(id)) return seen;
  seen.add(id);
  for (const input of nodes.find(n => n.id === id)?.inputs || []) ancestors(nodes, input, seen);
  return seen;
}

export function inputOptions(nodes, id) {
  return nodes.filter(n => n.id !== id && !ancestors(nodes, n.id).has(id));
}

export function graphErrors(scene) {
  const errors = {};
  const ids = new Set(scene.nodes.map(n => n.id));
  for (const n of scene.nodes) {
    const arity = ARITY[n.kind] || 0;
    if (!(n.kind in NODE_KINDS)) errors[n.id] = '不支持的节点类型';
    else if (!n.name.trim()) errors[n.id] = '请输入节点名称';
    else if (n.inputs.length !== arity || n.inputs.some(i => !ids.has(i))) errors[n.id] = '请选择完整的上游输入';
    else if (arity === 2 && n.inputs[0] === n.inputs[1]) errors[n.id] = '输入 A 与 B 必须是不同节点';
    else if (n.inputs.some(i => ancestors(scene.nodes, i).has(n.id))) errors[n.id] = '输入会形成循环引用';
    else if (n.kind === 'smooth_union' && [...ancestors(scene.nodes, n.id)].some(i => scene.nodes.find(c => c.id === i)?.kind === 'tpms')) errors[n.id] = 'TPMS 不支持平滑融合，请使用普通布尔运算';
  }
  return errors;
}

export function orderedNodes(nodes) {
  const seen = new Set(), result = [];
  function visit(n) {
    if (!n || seen.has(n.id)) return;
    seen.add(n.id);
    for (const id of n.inputs) visit(nodes.find(child => child.id === id));
    result.push(n);
  }
  nodes.forEach(visit);
  return result;
}

export function createNode(scene, kind, parameters, selected) {
  let index = 1;
  while (scene.nodes.some(n => n.id === `n${index}`)) index++;
  const first = scene.nodes.find(n => n.id === selected) || scene.nodes.find(n => n.id === scene.root) || scene.nodes.at(-1);
  const other = scene.nodes.find(n => n.id !== first?.id);
  return { id: `n${index}`, name: `${NODE_KINDS[kind]} ${index}`, kind,
    dimensions: [...(DIMENSIONS[kind] || [8])], position: [0, 0, 0], rotation: [0, 0, 0],
    inputs: ARITY[kind] === 2 ? [first?.id || '', other?.id || ''] : ARITY[kind] === 1 ? [first?.id || ''] : [],
    blend: 2, tpms: kind === 'tpms' ? { ...parameters, tubular_enabled: false } : null, expressions: {} };
}

export const expressionNames = text => String(text).match(/[A-Za-z_][A-Za-z_0-9]*/g) || [];
const exportsOf = block => block.kind === 'vector' ? [block.symbol, ...'xyz'.split('').map(a => `${block.symbol}_${a}`)] : [block.symbol];
const comparable = node => { const { name, ...rest } = node; return JSON.stringify(rest); };

// Conservative symbol dependency analysis; native hashes determine actual reuse.
export function affectedNodes(before, after) {
  if (before.cell_size !== after.cell_size) return new Set(after.nodes.map(n => n.id));
  const symbols = new Set(), changedBlocks = new Set(), affected = new Set();
  for (const key of new Set([...Object.keys(before.parameters || {}), ...Object.keys(after.parameters || {})])) {
    if (before.parameters?.[key] !== after.parameters?.[key]) symbols.add(key);
  }
  const oldBlocks = before.value_nodes || [], blocks = after.value_nodes || [];
  for (const block of [...oldBlocks, ...blocks]) {
    const previous = oldBlocks.find(b => b.id === block.id), next = blocks.find(b => b.id === block.id);
    if (!previous || !next || comparable(previous) !== comparable(next)) {
      changedBlocks.add(block.id); exportsOf(block).forEach(s => symbols.add(s));
    }
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const block of blocks) {
      const inputs = block.kind === 'vector' ? block.components : [block.expression];
      if (!changedBlocks.has(block.id) && inputs.some(v => expressionNames(v).some(s => symbols.has(s)))) {
        changedBlocks.add(block.id); exportsOf(block).forEach(s => symbols.add(s)); changed = true;
      }
    }
  }
  for (const node of after.nodes) {
    const previous = before.nodes.find(n => n.id === node.id);
    if (!previous || comparable(previous) !== comparable(node) ||
      Object.values(node.expressions || {}).some(v => expressionNames(v).some(s => symbols.has(s))) ||
      Object.values(node.vector_inputs || {}).some(id => changedBlocks.has(id))) affected.add(node.id);
  }
  changed = true;
  while (changed) {
    changed = false;
    for (const node of after.nodes) if (!affected.has(node.id) && node.inputs.some(id => affected.has(id))) {
      affected.add(node.id); changed = true;
    }
  }
  return affected;
}

export function valueConsumers(scene, block) {
  const symbols = exportsOf(block);
  return [...scene.nodes, ...(scene.value_nodes || []).filter(b => b.id !== block.id)].filter(n =>
    Object.values(n.vector_inputs || {}).includes(block.id) ||
    [...Object.values(n.expressions || {}), n.expression, ...(n.components || [])].some(v => expressionNames(v).some(s => symbols.includes(s))));
}
