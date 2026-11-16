// The scene is a DAG: card order is presentation, inputs determine computation.
import { PRIMITIVES } from './primitive_catalog.mjs';
export const NODE_KINDS = { sphere: '球体', box: '长方体', cylinder: '圆柱', torus: '圆环', tpms: 'TPMS',
  union: '并集', intersection: '交集', difference: '差集 A−B', smooth_union: '平滑融合', smooth_difference: '平滑差集',
  transform: '变换', shell: '抽壳', offset: '偏置', mirror: '镜像', linear_pattern: '线性阵列', circular_pattern: '圆周阵列' };
export const ARITY = { union: 2, intersection: 2, difference: 2, smooth_union: 2, smooth_difference: 2,
  transform: 1, shell: 1, offset: 1, mirror: 1, linear_pattern: 1, circular_pattern: 1 };
export const APPROXIMATE_PRIMITIVES = new Set(['cone','frustum','ellipsoid']);
export const EXACT_SDF_PRIMITIVES = new Set(['sphere','box','cube','rounded_box','cylinder','rounded_cylinder','capsule','torus']);
export const DIMENSIONS = { sphere: [8], box: [16, 16, 16], cylinder: [6, 24], torus: [10, 3], tpms: [],
  shell: [1], offset: [1], mirror: [], linear_pattern: [3, 1, 1, 16, 16, 16], circular_pattern: [6, 360] };
for (const item of PRIMITIVES) { NODE_KINDS[item.kind] = item.name; DIMENSIONS[item.kind] = item.dimensions; }

function exactSdfSource(nodes, inputId) {
  let source = nodes.find(c => c.id === inputId);
  const seen = new Set();
  while (source?.kind === 'transform' && !seen.has(source.id)) {
    seen.add(source.id);
    source = nodes.find(c => c.id === source.inputs[0]);
  }
  return source && EXACT_SDF_PRIMITIVES.has(source.kind) ? source : null;
}

export function smoothIssueReason(nodes, nodeId) {
  const deps = [...ancestors(nodes, nodeId)];
  if (deps.some(i => nodes.find(c => c.id === i)?.kind === 'tpms')) return 'TPMS 不支持平滑融合，请使用普通布尔运算';
  if (deps.some(i => APPROXIMATE_PRIMITIVES.has(nodes.find(c => c.id === i)?.kind))) return '圆锥、圆台、椭球体暂不支持平滑融合，请使用普通布尔运算';
  if (deps.some(i => ['shell', 'offset'].includes(nodes.find(c => c.id === i)?.kind))) return '操作结果暂不支持平滑融合，请使用普通布尔运算';
  return '';
}

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
    if (['extrude','extrude_cut'].includes(n.kind)) errors[n.id] = '拉伸和切除操作已移除，请使用基本体和布尔差集重新建模';
    else if (!(n.kind in NODE_KINDS)) errors[n.id] = '不支持的节点类型';
    else if (!n.name.trim()) errors[n.id] = '请输入节点名称';
    else if (n.inputs.length !== arity || n.inputs.some(i => !ids.has(i))) errors[n.id] = '请选择完整的上游输入';
    else if (arity === 2 && n.inputs[0] === n.inputs[1]) errors[n.id] = '输入 A 与 B 必须是不同节点';
    else if (n.inputs.some(i => ancestors(scene.nodes, i).has(n.id))) errors[n.id] = '输入会形成循环引用';
    else if (n.kind === 'smooth_union' || n.kind === 'smooth_difference') {
      const reason = smoothIssueReason(scene.nodes, n.id);
      if (reason) errors[n.id] = reason;
    } else if (n.kind === 'shell') {
      if (!exactSdfSource(scene.nodes, n.inputs[0])) errors[n.id] = '先对距离函数基本体抽壳，再做布尔或 TPMS 填充；复杂组合、TPMS、圆锥、圆台、椭球体暂不支持抽壳';
    } else if (n.kind === 'offset') {
      if (!exactSdfSource(scene.nodes, n.inputs[0])) errors[n.id] = '偏置目前支持距离函数基本体及其独立变换';
      else if (!Object.hasOwn(n.expressions || {}, 'dimensions.0') && (!Number.isFinite(n.dimensions?.[0]) || n.dimensions[0] === 0 || Math.abs(n.dimensions[0]) > 500)) errors[n.id] = '偏置距离不能为 0，且绝对值不超过 500 mm';
    } else if (n.kind === 'linear_pattern') {
      const d = n.dimensions || [], expr = n.expressions || {};
      const fixedCounts = [0, 1, 2].every(i => !Object.hasOwn(expr, `dimensions.${i}`));
      if (fixedCounts) {
        if ([0, 1, 2].some(i => !Number.isInteger(d[i]) || d[i] < 1 || d[i] > 32)) errors[n.id] = '线性阵列每轴数量须为 1–32 的整数';
        else if (d[0] * d[1] * d[2] > 64) errors[n.id] = '线性阵列总实例数量不能超过 64 个';
      }
    } else if (n.kind === 'circular_pattern') {
      const d = n.dimensions || [], expr = n.expressions || {};
      if (!Object.hasOwn(expr, 'dimensions.0') && (!Number.isInteger(d[0]) || d[0] < 1 || d[0] > 64)) errors[n.id] = '圆周阵列数量须为 1–64 的整数';
      else if (!Object.hasOwn(expr, 'dimensions.1') && (!Number.isFinite(d[1]) || Math.abs(d[1]) <= 0 || Math.abs(d[1]) > 360)) errors[n.id] = '圆周阵列总角度须在 (0, 360°] 范围内';
    }
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
  if (!(kind in NODE_KINDS)) throw new Error('不支持的节点类型');
  let index = 1;
  while (scene.nodes.some(n => n.id === `n${index}`)) index++;
  const first = scene.nodes.find(n => n.id === selected) || scene.nodes.find(n => n.id === scene.root) || scene.nodes.at(-1);
  const other = scene.nodes.find(n => n.id !== first?.id);
  const opDefaults = kind === 'shell' ? { operation: { opening: 'closed' } }
    : kind === 'mirror' ? { operation: { axis: 'X', keep_original: true } }
    : kind === 'linear_pattern' ? { operation: { centered: false } }
    : kind === 'circular_pattern' ? { operation: { axis: 'Z' } }
    : {};
  return { id: `n${index}`, name: `${NODE_KINDS[kind]} ${index}`, kind,
    dimensions: [...(DIMENSIONS[kind] || [])], position: [0, 0, 0], rotation: [0, 0, 0],
    inputs: ARITY[kind] === 2 ? [first?.id || '', other?.id || ''] : ARITY[kind] === 1 ? [first?.id || ''] : [],
    blend: 2, tpms: kind === 'tpms' ? { ...parameters, tubular_enabled: false } : null, expressions: {},
    ...opDefaults };
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
