import { ARITY, ancestors, expressionNames, graphErrors } from './node_graph.mjs';

export const DRAG_MIME = 'application/x-tpms-workflow';
export function readDrag(transfer) {
  try {
    const value = JSON.parse(transfer.getData(DRAG_MIME));
    return value && ['sort', 'reference'].includes(value.action) && typeof value.id === 'string' ? value : null;
  } catch { return null; }
}
export function notebookOrder(scene) {
  const ids = [...(scene.value_nodes || []).map(b => `value:${b.id}`), ...scene.nodes.map(n => n.id)];
  const saved = Array.isArray(scene.notebook_order) ? scene.notebook_order : [];
  return [...new Set([...saved.filter(id => ids.includes(id)), ...ids])];
}
export function reorderScene(scene, group, id, anchor, side = 'before') {
  if (group === 'notebook') {
    const list = notebookOrder(scene);
    if (id === anchor || !list.includes(id) || !list.includes(anchor)) return scene;
    const next = list.filter(item => item !== id);
    next.splice(next.indexOf(anchor) + (side === 'after' ? 1 : 0), 0, id);
    if (next.every((item, i) => item === list[i])) return scene;
    return { ...scene, notebook_order: next,
      nodes: [...scene.nodes].sort((a, b) => next.indexOf(a.id) - next.indexOf(b.id)),
      value_nodes: [...(scene.value_nodes || [])].sort((a, b) => next.indexOf(`value:${a.id}`) - next.indexOf(`value:${b.id}`)) };
  }
  const key = group === 'body' ? 'nodes' : group === 'value' ? 'value_nodes' : null;
  const list = scene[key] || [];
  if (!key || id === anchor || !list.some(n => n.id === id) || !list.some(n => n.id === anchor)) return scene;
  const next = list.filter(n => n.id !== id);
  next.splice(next.findIndex(n => n.id === anchor) + (side === 'after' ? 1 : 0), 0, list.find(n => n.id === id));
  return next.every((n, i) => n.id === list[i].id) ? scene : { ...scene, [key]: next };
}
// Stable signature ignores display order, including after save/open or undo/redo.
export function sceneSignature(scene) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  const { notebook_order, ...geometry } = scene;
  return JSON.stringify(stable({ ...geometry, nodes: [...scene.nodes].sort((a, b) => a.id.localeCompare(b.id)), value_nodes: [...(scene.value_nodes || [])].sort((a, b) => a.id.localeCompare(b.id)) }));
}
export const onlyOrderChanged = (before, after) => sceneSignature(before) === sceneSignature(after);

function sourceOf(scene, payload) {
  if (payload?.action !== 'reference') throw new Error('请从节点的类型按钮拖动引用');
  const source = payload.type === 'body' ? scene.nodes.find(n => n.id === payload.id) : (scene.value_nodes || []).find(n => n.id === payload.id);
  if (!source || (payload.type !== 'body' && payload.type !== (source.kind === 'vector' ? 'vector' : 'number'))) throw new Error('引用来源已不存在或类型已改变');
  return source;
}
function checkSymbols(scene) {
  const owners = new Map(Object.keys(scene.parameters || {}).map(k => [k, 'constant']));
  for (const b of scene.value_nodes || []) {
    if (!/^[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(b.symbol) || ['pi', 'abs', 'min', 'max', 'sqrt'].includes(b.symbol)) throw new Error('请先设置有效的参数引用符号');
    const exports = b.kind === 'vector' ? [b.symbol, ...'xyz'.split('').map(a => `${b.symbol}_${a}`)] : [b.symbol];
    for (const symbol of exports) {
      if (owners.has(symbol)) throw new Error(`参数符号冲突：${symbol}`);
      owners.set(symbol, b.id);
    }
  }
  return owners;
}
function checkValueCycles(scene) {
  const owners = checkSymbols(scene), blocks = scene.value_nodes || [], visiting = new Set(), done = new Set();
  function visit(id) {
    if (visiting.has(id)) throw new Error('连接会形成参数循环引用');
    if (done.has(id)) return;
    const b = blocks.find(n => n.id === id);
    if (!b) return;
    visiting.add(id);
    for (const text of b.kind === 'vector' ? b.components : [b.expression]) for (const symbol of expressionNames(text)) visit(owners.get(symbol));
    visiting.delete(id); done.add(id);
  }
  blocks.forEach(b => visit(b.id));
}
const numericTPMS = new Set(['size_x', 'size_y', 'size_z', 'cells_x', 'cells_y', 'cells_z', 'thickness', 'iso_level', 'target_porosity', 'gradient_thickness_start', 'gradient_thickness_end', 'samples_per_cell']);
export function connectReference(scene, payload, target) {
  try {
    const source = sourceOf(scene, payload);
    const expected = ['body', 'root'].includes(target.kind) ? 'body' : target.kind === 'vector' ? 'vector' : 'number';
    if (payload.type !== expected) throw new Error(`类型不匹配：此处需要${expected === 'body' ? '实体' : expected === 'vector' ? '向量' : '数值'}引用`);
    if (expected !== 'body') checkSymbols(scene);
    if (target.kind === 'root') return { scene: scene.root === source.id ? scene : { ...scene, root: source.id } };
    if (target.kind === 'value-expression' || target.kind === 'value-component') {
      const block = (scene.value_nodes || []).find(b => b.id === target.id);
      if (!block || (target.kind === 'value-expression' ? block.kind !== 'formula' : block.kind !== 'vector' || !Number.isInteger(target.index) || target.index < 0 || target.index > 2)) throw new Error('参数输入已不存在');
      const patch = target.kind === 'value-expression' ? { expression: source.symbol } : { components: block.components.map((v, i) => i === target.index ? source.symbol : v) };
      const next = { ...scene, value_nodes: scene.value_nodes.map(b => b.id === block.id ? { ...b, ...patch } : b) };
      checkValueCycles(next);
      return { scene: Object.entries(patch).every(([k, v]) => JSON.stringify(block[k]) === JSON.stringify(v)) ? scene : next };
    }
    const node = scene.nodes.find(n => n.id === target.id);
    if (!node) throw new Error('目标节点已不存在');
    let patch;
    if (target.kind === 'body') {
      const arity = ARITY[node.kind] || 0;
      if (!Number.isInteger(target.index) || target.index < 0 || target.index >= arity) throw new Error('该节点没有此实体输入');
      if (ancestors(scene.nodes, source.id).has(node.id)) throw new Error('连接会形成循环引用，不能引用自身或下游');
      if (node.inputs.some((id, i) => i !== target.index && id === source.id)) throw new Error('输入 A 与 B 必须是不同节点');
      patch = { inputs: Array.from({ length: arity }, (_, i) => i === target.index ? source.id : node.inputs[i] || '') };
    } else if (target.kind === 'vector') {
      if (!['position', 'rotation'].includes(target.field)) throw new Error('该字段不接受向量');
      patch = { vector_inputs: { ...node.vector_inputs, [target.field]: source.id }, expressions: Object.fromEntries(Object.entries(node.expressions || {}).filter(([k]) => !k.startsWith(target.field + '.'))) };
    } else if (target.kind === 'number') {
      const [field, component] = (target.field || '').split('.');
      const valid = ['dimensions', 'position', 'rotation'].includes(field) ? /^\d$/.test(component || '') && Number(component) < node[field]?.length : field === 'tpms' ? !!node.tpms && numericTPMS.has(component) : target.field === 'blend' && node.kind === 'smooth_union';
      if (!valid) throw new Error('该字段不接受数值引用');
      if (node.vector_inputs?.[field]) throw new Error('请先解除整向量引用，再连接单个分量');
      patch = { expressions: { ...node.expressions, [target.field]: source.symbol } };
    } else throw new Error('不支持的引用目标');
    const next = { ...scene, nodes: scene.nodes.map(n => n.id === node.id ? { ...n, ...patch } : n) };
    if (target.kind === 'body') {
      const previous = graphErrors(scene);
      for (const [id, error] of Object.entries(graphErrors(next))) if (error !== '请选择完整的上游输入' && previous[id] !== error) throw new Error(error);
      // Check incomplete smooth unions as well as downstream unions masked by other errors.
      for (const n of next.nodes) if (n.kind === 'smooth_union' && [...ancestors(next.nodes, n.id)].some(id => next.nodes.find(b => b.id === id)?.kind === 'tpms')) throw new Error('TPMS 不支持平滑融合，请使用普通布尔运算');
    }
    return { scene: Object.entries(patch).every(([k, v]) => JSON.stringify(node[k]) === JSON.stringify(v)) ? scene : next };
  } catch (error) { return { error: error.message }; }
}
