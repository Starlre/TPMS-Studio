import { ARITY, ancestors, expressionNames, graphErrors } from './node_graph.mjs';

export const DRAG_MIME = 'application/x-tpms-workflow';
export const RESERVED_SYMBOLS = new Set(['pi', 'abs', 'min', 'max', 'sqrt']);
export const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z_0-9]{0,31}$/;

export function readDrag(transfer) {
  try {
    const value = JSON.parse(transfer.getData(DRAG_MIME));
    return value && ['sort', 'reference'].includes(value.action) && typeof value.id === 'string' ? value : null;
  } catch { return null; }
}

export function notebookSections(scene) {
  return Array.isArray(scene?.notebook_sections) ? scene.notebook_sections : [];
}

export function isInlineNode(scene, id) {
  if (!id || scene?.root === id) return false;
  const inlineSet = new Set(Array.isArray(scene?.inline_nodes) ? scene.inline_nodes : []);
  return inlineSet.has(id) && (scene?.nodes || []).some(n => (n.inputs || []).includes(id));
}

export function pruneInlineNodes(scene) {
  const active = (scene?.inline_nodes || []).filter(id => isInlineNode(scene, id));
  return active;
}

export function notebookOrder(scene) {
  const valueIds = (scene.value_nodes || []).map(b => `value:${b.id}`);
  const nodeIds = (scene.nodes || []).filter(n => !isInlineNode(scene, n.id)).map(n => n.id);
  const sectionIds = notebookSections(scene).map(s => `section:${s.id}`);
  const ids = [...valueIds, ...nodeIds, ...sectionIds];
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
    const rank = item => { const idx = next.indexOf(item); return idx === -1 ? Number.MAX_SAFE_INTEGER : idx; };
    return { ...scene, notebook_order: next,
      nodes: [...scene.nodes].sort((a, b) => rank(a.id) - rank(b.id)),
      value_nodes: [...(scene.value_nodes || [])].sort((a, b) => rank(`value:${a.id}`) - rank(`value:${b.id}`)) };
  }
  const key = group === 'body' ? 'nodes' : group === 'value' ? 'value_nodes' : null;
  const list = scene[key] || [];
  if (!key || id === anchor || !list.some(n => n.id === id) || !list.some(n => n.id === anchor)) return scene;
  const next = list.filter(n => n.id !== id);
  next.splice(next.findIndex(n => n.id === anchor) + (side === 'after' ? 1 : 0), 0, list.find(n => n.id === id));
  return next.every((n, i) => n.id === list[i].id) ? scene : { ...scene, [key]: next };
}
// Stable signature ignores display order, sections and inline folding, including after save/open or undo/redo.
export function sceneSignature(scene) {
  const stable = value => Array.isArray(value) ? value.map(stable) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(k => [k, stable(value[k])])) : value;
  const { notebook_order, notebook_sections, inline_nodes, ...geometry } = scene;
  return JSON.stringify(stable({ ...geometry, nodes: [...scene.nodes].sort((a, b) => a.id.localeCompare(b.id)), value_nodes: [...(scene.value_nodes || [])].sort((a, b) => a.id.localeCompare(b.id)) }));
}
export const onlyOrderChanged = (before, after) => sceneSignature(before) === sceneSignature(after);

export function createSection(scene, name = '', insertBeforeId = '') {
  const sections = notebookSections(scene);
  let i = 1;
  while (sections.some(s => s.id === `s${i}`)) i++;
  const section = { id: `s${i}`, name: name.trim() || `章节 ${i}`, note: '', collapsed: false };
  const sectionKey = `section:${section.id}`;
  const order = notebookOrder(scene);
  const idx = insertBeforeId ? order.indexOf(insertBeforeId) : -1;
  if (idx >= 0) order.splice(idx, 0, sectionKey);
  else order.push(sectionKey);
  return { section, scene: { ...scene, notebook_sections: [...sections, section], notebook_order: order } };
}

export function updateSection(scene, sectionId, patch) {
  const sections = notebookSections(scene);
  const next = sections.map(s => s.id === sectionId ? { ...s, ...patch } : s);
  return { ...scene, notebook_sections: next };
}

export function removeSection(scene, sectionId) {
  const sections = notebookSections(scene).filter(s => s.id !== sectionId);
  const sectionKey = `section:${sectionId}`;
  const order = notebookOrder(scene).filter(id => id !== sectionKey);
  const next = { ...scene, notebook_order: order };
  if (sections.length) next.notebook_sections = sections;
  else delete next.notebook_sections;
  return next;
}

export function createInlineInputNode(scene, parentId, slotIndex, node) {
  const parent = (scene.nodes || []).find(n => n.id === parentId);
  if (!parent) throw new Error('父节点不存在');
  const arity = ARITY[parent.kind] || 0;
  if (!Number.isInteger(slotIndex) || slotIndex < 0 || slotIndex >= arity) throw new Error('无效的输入槽位');
  const nextNodes = [...scene.nodes, node].map(n => n.id !== parentId ? n : {
    ...n,
    inputs: Array.from({ length: arity }, (_, i) => i === slotIndex ? node.id : n.inputs[i] || '')
  });
  const base = { ...scene, nodes: nextNodes, inline_nodes: [...new Set([...(scene.inline_nodes || []), node.id])] };
  const pruned = pruneInlineNodes(base);
  const next = { ...base };
  if (pruned.length) next.inline_nodes = pruned; else delete next.inline_nodes;
  return next;
}

export function promoteInlineNode(scene, nodeId, beforeParentId = '') {
  const inline = (scene.inline_nodes || []).filter(id => id !== nodeId);
  const temp = { ...scene };
  if (inline.length) temp.inline_nodes = inline; else delete temp.inline_nodes;
  const order = notebookOrder(temp).filter(id => id !== nodeId);
  const idx = beforeParentId ? order.indexOf(beforeParentId) : -1;
  if (idx >= 0) order.splice(idx, 0, nodeId);
  else order.push(nodeId);
  return { ...temp, notebook_order: order };
}

export function demoteToInlineNode(scene, nodeId) {
  if (scene.root === nodeId) return { error: '当前最终输出节点不能内嵌隐藏，请先切换输出节点' };
  const hasParent = (scene.nodes || []).some(n => (n.inputs || []).includes(nodeId));
  if (!hasParent) return { error: '该节点尚未被下游引用，内嵌后将不可见' };
  const next = { ...scene, inline_nodes: [...new Set([...(scene.inline_nodes || []), nodeId])] };
  if (Array.isArray(next.notebook_order)) next.notebook_order = next.notebook_order.filter(id => id !== nodeId);
  return { scene: next };
}

function sourceOf(scene, payload) {
  if (payload?.action !== 'reference') throw new Error('请从节点的类型按钮拖动引用');
  const source = payload.type === 'body' ? scene.nodes.find(n => n.id === payload.id) : (scene.value_nodes || []).find(n => n.id === payload.id);
  if (!source || (payload.type !== 'body' && payload.type !== (source.kind === 'vector' ? 'vector' : 'number'))) throw new Error('引用来源已不存在或类型已改变');
  return source;
}
function checkSymbols(scene) {
  const owners = new Map(Object.keys(scene.parameters || {}).map(k => [k, 'constant']));
  for (const b of scene.value_nodes || []) {
    if (!IDENTIFIER_RE.test(b.symbol) || RESERVED_SYMBOLS.has(b.symbol)) throw new Error('请先设置有效的参数引用符号');
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
function replaceIdentifier(text, mapping) {
  if (typeof text !== 'string' || !text.trim()) return text;
  return text.replace(/[A-Za-z_][A-Za-z_0-9]*/g, token => mapping.get(token) ?? token);
}
export function renameValueSymbol(scene, blockId, rawNext) {
  try {
    const nextSymbol = String(rawNext ?? '').trim();
    const blocks = scene.value_nodes || [];
    const block = blocks.find(b => b.id === blockId);
    if (!block) return { error: '参数节点已不存在' };
    if (nextSymbol === block.symbol) return { scene, updatedCount: 0 };
    if (!IDENTIFIER_RE.test(nextSymbol) || RESERVED_SYMBOLS.has(nextSymbol)) {
      return { error: '引用符号须为英文标识符，且不能使用 pi/abs/min/max/sqrt' };
    }
    const candidateBlocks = blocks.map(b => b.id === blockId ? { ...b, symbol: nextSymbol } : b);
    checkSymbols({ ...scene, value_nodes: candidateBlocks });
    const oldSymbol = block.symbol || '';
    const mapping = new Map();
    if (IDENTIFIER_RE.test(oldSymbol)) {
      mapping.set(oldSymbol, nextSymbol);
      if (block.kind === 'vector') {
        for (const axis of 'xyz') mapping.set(`${oldSymbol}_${axis}`, `${nextSymbol}_${axis}`);
      }
    }
    let updatedCount = 0;
    const rewrite = text => {
      if (!mapping.size || typeof text !== 'string') return text;
      const replaced = replaceIdentifier(text, mapping);
      if (replaced !== text) updatedCount++;
      return replaced;
    };
    const nextNodes = (scene.nodes || []).map(node => {
      if (!node.expressions || !Object.keys(node.expressions).length) return node;
      let changed = false;
      const expressions = Object.fromEntries(Object.entries(node.expressions).map(([key, expr]) => {
        const nextExpr = rewrite(expr);
        if (nextExpr !== expr) changed = true;
        return [key, nextExpr];
      }));
      return changed ? { ...node, expressions } : node;
    });
    const nextValueNodes = candidateBlocks.map(b => {
      if (b.id === blockId) return b;
      if (b.kind === 'formula') {
        const expression = rewrite(b.expression);
        return expression !== b.expression ? { ...b, expression } : b;
      }
      if (b.kind === 'vector' && Array.isArray(b.components)) {
        let changed = false;
        const components = b.components.map(comp => {
          const nextComp = rewrite(comp);
          if (nextComp !== comp) changed = true;
          return nextComp;
        });
        return changed ? { ...b, components } : b;
      }
      return b;
    });
    const nextScene = { ...scene, nodes: nextNodes, value_nodes: nextValueNodes };
    checkValueCycles(nextScene);
    return { scene: nextScene, updatedCount };
  } catch (error) {
    return { error: error.message };
  }
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
