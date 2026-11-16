import React, { useState, useEffect, useRef, useMemo, createContext, useContext } from 'react';
import { createValueBlock, ValueEditor } from './ValueBlocks';
import CardMenu from './CardMenu';
import {
  notebookOrder, notebookSections, isInlineNode, pruneInlineNodes,
  createSection, updateSection, removeSection, createInlineInputNode,
  promoteInlineNode, demoteToInlineNode
} from './workflow_drag.mjs';
import { MoreHorizontal, Settings2, Search, FolderPlus, Folder, FolderOpen, ArrowUpRight, Minimize2, MessageSquarePlus } from 'lucide-react';
import { valueConsumers, APPROXIMATE_PRIMITIVES } from './node_graph.mjs';
import { Plus, Box, Move3D, Trash2, Undo2, Redo2, ArrowDownToLine, Eye, ChevronRight, ChevronsDownUp, Hash } from 'lucide-react';
import { NODE_KINDS, ARITY, inputOptions, graphErrors, createNode } from './node_graph.mjs';
import { WorkflowDrag, SortHeading, SortHandle, SortButtons, ReferenceOutput, ReferenceInput, DragSource } from './WorkflowDrag';
import { PRIMITIVES } from './primitive_catalog.mjs';
import { useNodeState } from './ui_status.mjs';

const OPERATION_KINDS = new Set(['shell', 'offset', 'mirror', 'linear_pattern', 'circular_pattern', 'tpms_infill']);
const INLINE_CREATION_KINDS = [
  ...PRIMITIVES.map(p => ({ id: p.kind, name: p.name, group: '基本体' })),
  { id: 'tpms', name: 'TPMS', group: '场/结构' },
  { id: 'tpms_infill', name: 'TPMS 填充', group: '操作' },
  { id: 'union', name: '并集', group: '布尔' },
  { id: 'intersection', name: '交集', group: '布尔' },
  { id: 'difference', name: '差集', group: '布尔' },
  { id: 'smooth_union', name: '平滑融合', group: '布尔' },
  { id: 'smooth_difference', name: '平滑差集', group: '布尔' },
  { id: 'transform', name: '变换', group: '操作' },
  { id: 'shell', name: '抽壳', group: '操作' },
  { id: 'offset', name: '偏置', group: '操作' },
  { id: 'mirror', name: '镜像', group: '操作' },
  { id: 'linear_pattern', name: '线性阵列', group: '操作' },
  { id: 'circular_pattern', name: '圆周阵列', group: '操作' }
];

const LABELS = Object.fromEntries(PRIMITIVES.map(item => [item.kind,item.labels]));
const Values = createContext([]);
const Navigate = createContext(() => {});
// B1：节点计算状态徽标文案（与 workflow_engine.py 上报的 state 一一对应）
const NODE_STATES = { pending: '待更新', evaluating: '计算中', meshing: '计算中', cached: '缓存复用', ready: '已完成', error: '失败' };
// B1：徽标单独订阅外部状态 store，进度推送只刷新本徽标，不重渲染整个节点列表
function NodeStateBadge({ id }) {
  const state = useNodeState(id);
  const badge = useRef(null);
  const processing = state === 'evaluating' || state === 'meshing';
  // 计算中的节点把 aria-busy 同步到所属卡片，读屏可感知该节点正在更新
  useEffect(() => {
    const card = badge.current?.closest('.card-node');
    if (!card) return;
    if (processing) card.setAttribute('aria-busy', 'true');
    else card.removeAttribute('aria-busy');
  }, [processing]);
  const label = NODE_STATES[state];
  if (!label) return null;
  return <span ref={badge} className="node-state-badge" data-state={state}>{processing && <i className="node-state-spinner" aria-hidden="true" />}{label}</span>;
}
function Choice({ label, value, options, onChange }) {
  return <label className="field"><span>{label}</span><select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{options.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>;
}
function scrubNumeric(event, { value, onChange, step = 1, disabled = false }) {
  if (disabled || event.button !== 0) return;
  const startX = event.clientX;
  const startValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  let moved = false;
  const move = moveEvent => {
    const dx = moveEvent.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    const effectiveStep = moveEvent.shiftKey ? step * 0.1 : step;
    const raw = startValue + Math.round(dx / 6) * effectiveStep;
    onChange(Number(raw.toFixed(4)));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (moved) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}

function cardSummaryText(n, isValue, scene) {
  if (!n) return '';
  if (isValue) {
    if (n.kind === 'number') return `${n.symbol || 'val'} = ${n.value ?? 0}`;
    if (n.kind === 'formula') return `${n.symbol || 'fx'} = ${n.expression || ''}`;
    if (n.kind === 'vector') return `${n.symbol || 'vec'} = [${(n.components || [0, 0, 0]).join(', ')}]`;
    return '';
  }
  if (n.kind === 'offset') return `${(n.dimensions?.[0] ?? 0) >= 0 ? '+' : ''}${n.dimensions?.[0] ?? 1} mm`;
  if (n.kind === 'mirror') return `${n.operation?.axis || 'X'} 镜像${n.operation?.keep_original !== false ? ' · 对称' : ''}`;
  if (n.kind === 'linear_pattern') return `${n.dimensions?.[0] ?? 3}×${n.dimensions?.[1] ?? 1}×${n.dimensions?.[2] ?? 1} 阵列`;
  if (n.kind === 'circular_pattern') return `${n.operation?.axis || 'Z'}轴 ${n.dimensions?.[0] ?? 6} 份`;
  if (n.kind === 'tpms_infill') return `${n.tpms?.surface || 'Gyroid'} · ${n.dimensions?.[0] ?? 8}mm${Number(n.dimensions?.[1] ?? 0) > 0 ? ` · 外皮 ${n.dimensions[1]}mm` : ' · 纯填充'}`;
  if (ARITY[n.kind]) {
    const names = (n.inputs || []).filter(Boolean).map(id => scene.nodes.find(x => x.id === id)?.name || id);
    return names.length ? names.join(n.kind === 'difference' || n.kind === 'smooth_difference' ? ' − ' : ' · ') : '未连接输入';
  }
  if (n.kind === 'tpms') return `${n.tpms?.surface || 'Gyroid'} · ${n.tpms?.size_x ?? 40}×${n.tpms?.size_y ?? 40}×${n.tpms?.size_z ?? 40}`;
  if (n.kind === 'sphere') return `Ø ${(Number(n.dimensions?.[0] ?? 0) * 2).toFixed(1).replace(/\.0$/, '')} mm`;
  if (n.kind === 'cylinder') return `R${n.dimensions?.[0] ?? 0} · H${n.dimensions?.[1] ?? 0}`;
  if (n.kind === 'box') return `${(n.dimensions || []).slice(0, 3).join('×')} mm`;
  if (n.kind === 'transform') return `平移 ${(n.position || [0, 0, 0]).join(', ')}`;
  if (n.dimensions?.length) return `${n.dimensions.slice(0, 2).join('×')}`;
  return NODE_KINDS[n.kind] || '';
}

function Numeric({ label, value, onChange, unit }) {
  return <label className="field"><span className="scrub-label" title="左右拖动微调数值（按住 Shift 精细微调）" onMouseDown={e => scrubNumeric(e, { value, onChange, step: 0.1 })}>{label}{unit && ` / ${unit}`}</span><input type="number" step="any" aria-label={label} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} /></label>;
}

function ParameterField({ node, target, label, value, unit = 'mm', patch, disabled = false }) {
  const blocks = useContext(Values).filter(b => b.kind !== 'vector');
  const navigate = useContext(Navigate);
  const reference = blocks.find(b => b.symbol === node.expressions?.[target]);
  const bound = Object.hasOwn(node.expressions || {}, target);
  function setValue(next) {
    const parts = target.split('.');
    if (parts[0] === 'tpms') patch({ tpms: { ...node.tpms, [parts[1]]: next } });
    else if (parts.length === 2) patch({ [parts[0]]: node[parts[0]].map((v, i) => i === Number(parts[1]) ? next : v) });
    else patch({ [target]: next });
  }
  function toggle() {
    const expressions = { ...node.expressions };
    if (bound) delete expressions[target]; else expressions[target] = String(value ?? 0);
    patch({ expressions });
  }
  const canScrub = !bound && !disabled;
  return <ReferenceInput target={{ kind: 'number', id: node.id, field: target }} label={label} disabled={disabled} className="parameter-binding"><div className="binding-heading"><span className={canScrub ? 'scrub-label' : ''} title={canScrub ? '左右拖动微调数值（按住 Shift 精细微调）' : undefined} onMouseDown={canScrub ? e => scrubNumeric(e, { value, onChange: setValue, step: unit === '°' ? 1 : 0.5 }) : undefined}>{label}{unit && ` / ${unit}`}</span><button type="button" disabled={disabled} className={bound ? 'binding-active' : ''} aria-label={`${label}使用表达式`} aria-pressed={bound} onClick={toggle}>fx</button></div>
    <input aria-label={label} disabled={disabled} type={bound ? 'text' : 'number'} step="any" spellCheck={false} value={bound ? node.expressions[target] : value ?? ''}
      onChange={e => bound ? patch({ expressions: { ...node.expressions, [target]: e.target.value } }) : setValue(e.target.value === '' ? '' : Number(e.target.value))} />
    {!!blocks.length && <select aria-label={`${label}参数引用`} disabled={disabled} value={reference ? node.expressions[target] : ''} onChange={e => { const expressions = { ...node.expressions }; if (e.target.value) expressions[target] = e.target.value; else delete expressions[target]; patch({ expressions }); }}><option value="">手动输入 / 自定义 fx</option>{blocks.map(b => <option key={b.id} value={b.symbol}>{b.name} · {b.symbol} · 数值</option>)}</select>}
    {reference && <Reference id={reference.id} kind="number" name={reference.name} onClick={() => navigate(`value:${reference.id}`)} />}
  </ReferenceInput>;
}

function Reference({ id, name, kind = 'body', onClick }) {
  return <DragSource id={id} type={kind} name={name} className={`reference-token reference-${kind}`} aria-label={`定位引用 ${name}`} onClick={onClick}><span>{kind === 'body' ? <Box size={14} aria-hidden="true" /> : kind === 'vector' ? <Move3D size={14} aria-hidden="true" /> : <Hash size={14} aria-hidden="true" />}{kind === 'body' ? '实体' : kind === 'vector' ? '向量' : '数值'}</span><strong>{name}</strong><ChevronRight size={14} aria-hidden="true" /></DragSource>;
}

function OpeningsGrid({ openings, onToggle, label = '多方向开口' }) {
  return <div className="shell-openings-grid" role="group" aria-label={label}>{['+X', '-X', '+Y', '-Y', '+Z', '-Z'].map(face =>
    <button type="button" key={face} aria-pressed={openings.includes(face)} onClick={() => onToggle(face)}>{face}</button>)}</div>;
}

function TPMSFields({ node, patch, currentParameters, infill = false }) {
  const p = node.tpms;
  function change(key, value) {
    const next = { ...p, [key]: value };
    const expressions = { ...node.expressions };
    if (key === 'gradient_enabled' && value) { next.target_porosity = null; delete expressions['tpms.target_porosity']; }
    if (key === 'target_porosity' && value !== null) next.gradient_enabled = false;
    if (key === 'mode' && value === 'solid') next.gradient_enabled = false;
    patch({ tpms: next, expressions });
  }
  const field = (key, label, unit = 'mm') => <ParameterField key={key} node={node} target={`tpms.${key}`} label={label} value={p[key]} unit={unit} patch={patch} />;
  return <>
    <Choice label="曲面类型" value={p.surface} onChange={v => change('surface', v)} options={['Gyroid', 'Diamond', 'Primitive', 'I-WP', 'Neovius', 'Custom'].map(k => [k, k === 'Custom' ? '自定义公式' : k])} />
    {p.surface === 'Custom' && <label className="field"><span>隐式函数 f(x,y,z)</span><textarea aria-label="节点隐式函数" rows={3} value={p.formula} onChange={e => change('formula', e.target.value)} /><small>x/y/z 为 mm 坐标；沿用安全数学公式语法。</small></label>}
    {infill ? <p className="hint">外轮廓尺寸与空间位置自动匹配上游实体包围盒。</p> : <>
      <div className="triple">{['x', 'y', 'z'].map(axis => field(`size_${axis}`, `${axis.toUpperCase()} 尺寸`))}</div>
      {p.surface !== 'Custom' && <div className="triple">{['x', 'y', 'z'].map(axis => field(`cells_${axis}`, `${axis.toUpperCase()} 周期`, ''))}</div>}
    </>}
    <Choice label="结构模式" value={p.mode} onChange={v => change('mode', v)} options={[[ 'sheet', '片层结构' ], [ 'solid', '实体结构' ]]} />
    <label className="toggle"><input type="checkbox" checked={p.target_porosity !== null} onChange={e => change('target_porosity', e.target.checked ? 0.7 : null)} /><span>按目标孔隙率反求参数</span></label>
    {p.target_porosity !== null ? field('target_porosity', '目标孔隙率', '0–1') : p.mode === 'sheet' ? !p.gradient_enabled && field('thickness', '壁厚') : field('iso_level', '等值面偏移', '')}
    {p.mode === 'sheet' && <label className="toggle"><input type="checkbox" checked={p.gradient_enabled} onChange={e => change('gradient_enabled', e.target.checked)} /><span>梯度壁厚</span></label>}
    {p.gradient_enabled && <><Choice label="梯度方向" value={p.gradient_axis} onChange={v => change('gradient_axis', v)} options={['X', 'Y', 'Z'].map(k => [k, k])} /><div className="double">{field('gradient_thickness_start', '起始壁厚')}{field('gradient_thickness_end', '结束壁厚')}</div></>}
    {field('samples_per_cell', '每周期采样数', '')}
    <button type="button" className="secondary full" onClick={() => patch({ tpms: { ...currentParameters, tubular_enabled: false }, expressions: Object.fromEntries(Object.entries(node.expressions || {}).filter(([key]) => !key.startsWith('tpms.'))) })}>使用当前 TPMS 参数</button>
  </>;
}

export default function NodeWorkflow({ scene, onChange, currentParameters, selected, onSelect, dirty, busy, inputsLocked = false, available, error, reportError, undo, redo, canUndo, canRedo, loadPreset, valueOutputs = {}, previewNode, evaluateValues, cacheSummary, activePreviewNode, allEntities, hiddenEntities = [], toggleEntity }) {
  const [expanded, setExpanded] = useState(() => new Set(selected ? [selected] : []));
  const [nestedOpened, setNestedOpened] = useState(new Set());
  const [slotPicker, setSlotPicker] = useState(null), [slotQuery, setSlotQuery] = useState('');
  const [adding, setAdding] = useState(false), [query, setQuery] = useState('');
  const [settings, setSettings] = useState(false), [menu, setMenu] = useState(null);
  const [editingSection, setEditingSection] = useState(null), [noteOpened, setNoteOpened] = useState(() => new Set());
  const entries = useRef(new Map()), addButton = useRef(null);
  const [parameterName, setParameterName] = useState('wall');
  // 性能：节点图错误检查需要递归遍历祖先链，按场景缓存，避免父级重渲染时重复计算
  const issues = useMemo(() => graphErrors(scene), [scene]);
  const params = scene.parameters || {}, blocks = scene.value_nodes || [];
  const sections = useMemo(() => notebookSections(scene), [scene]);
  const sectionById = useMemo(() => new Map(sections.map(s => [s.id, s])), [sections]);
  const order = useMemo(() => notebookOrder(scene), [scene]);
  const orderMeta = useMemo(() => {
    const ownerOf = new Map();
    const statsOf = new Map();
    let activeSection = null;
    for (const id of order) {
      if (id.startsWith('section:')) {
        const sid = id.slice(8);
        activeSection = sectionById.get(sid) || null;
        if (activeSection) statsOf.set(sid, { count: 0, hasError: false, hasOutput: false });
      } else {
        ownerOf.set(id, activeSection);
        if (activeSection) {
          const stat = statsOf.get(activeSection.id);
          stat.count += 1;
          if (!id.startsWith('value:') && issues[id]) stat.hasError = true;
          if (scene.root === id) stat.hasOutput = true;
        }
      }
    }
    return { ownerOf, statsOf };
  }, [order, sectionById, issues, scene.root]);
  function findHostChain(targetId) {
    if (!targetId || targetId.startsWith('value:') || !isInlineNode(scene, targetId)) return null;
    const queue = [[targetId]];
    const seen = new Set([targetId]);
    while (queue.length) {
      const chain = queue.shift();
      const head = chain[0];
      if (!isInlineNode(scene, head) && chain.length > 1) return chain;
      if (chain.length > 4) continue;
      for (const parent of scene.nodes) {
        if ((parent.inputs || []).includes(head) && !seen.has(parent.id)) {
          seen.add(parent.id);
          queue.push([parent.id, ...chain]);
        }
      }
    }
    return null;
  }
  useEffect(() => {
    if (!selected) return;
    const chain = findHostChain(selected);
    if (chain) {
      const topId = chain[0];
      setExpanded(old => new Set([...old, topId]));
      setNestedOpened(old => {
        const next = new Set(old);
        const path = [];
        for (let k = 0; k < chain.length - 1; k++) {
          const parent = scene.nodes.find(n => n.id === chain[k]);
          const slot = (parent?.inputs || []).indexOf(chain[k + 1]);
          if (slot >= 0) next.add([...path, chain[k], slot, chain[k + 1]].join('/'));
          path.push(chain[k]);
        }
        return next;
      });
      const frame = requestAnimationFrame(() => entries.current.get(topId)?.querySelector('.notebook-node-heading')?.scrollIntoView({ block: 'nearest' }));
      return () => cancelAnimationFrame(frame);
    }
    setExpanded(old => new Set([...old, selected]));
    const frame = requestAnimationFrame(() => entries.current.get(selected)?.querySelector('.notebook-node-heading')?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  useEffect(() => {
    const ids = new Set(order);
    setExpanded(old => [...old].some(id => !ids.has(id)) ? new Set([...old].filter(id => ids.has(id))) : old);
  }, [scene.nodes, blocks, sections]);
  function commitScene(next) {
    const pruned = pruneInlineNodes(next);
    const cleaned = { ...next };
    if (pruned.length) cleaned.inline_nodes = pruned;
    else delete cleaned.inline_nodes;
    onChange(cleaned);
  }
  function select(id) {
    onSelect(id);
    if (!id) return;
    const owner = orderMeta.ownerOf.get(id);
    if (owner?.collapsed) onChange(updateSection(scene, owner.id, { collapsed: false }));
    setExpanded(old => new Set([...old, id]));
    requestAnimationFrame(() => {
      const heading = entries.current.get(id)?.querySelector('.notebook-node-heading');
      heading?.scrollIntoView({ block: 'nearest' });
      heading?.querySelector('.notebook-node-select')?.focus({ preventScroll: true });
    });
  }
  function toggle(id) { setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function showMenu(event, id) {
    event.preventDefault();
    const anchor = event.currentTarget, rect = anchor.getBoundingClientRect();
    setMenu({ id, anchor, x: event.type === 'contextmenu' ? event.clientX : rect.right, y: event.type === 'contextmenu' ? event.clientY : rect.bottom });
  }
  function patch(id, values) { commitScene({ ...scene, nodes: scene.nodes.map(n => n.id === id ? { ...n, ...values } : n) }); }
  function addSection(insertBeforeId = '') {
    const created = createSection(scene, '', insertBeforeId);
    onChange(created.scene);
    setEditingSection(created.section.id);
    setAdding(false); setQuery('');
  }
  function add(kind, value = false, section = false) {
    if (section) { addSection(); return; }
    if (value) {
      if (blocks.length >= 32) return reportError('最多支持 32 个参数节点');
      const block = createValueBlock(scene, kind), id = `value:${block.id}`;
      onChange({ ...scene, value_nodes: [...blocks, block], notebook_order: [...order, id] });
      select(id); setAdding(false); setQuery(''); return;
    }
    if (scene.nodes.length >= 64) return reportError('最多支持 64 个节点');
    const node = createNode(scene, kind, currentParameters, selected);
    onChange({ ...scene, nodes: [...scene.nodes, node], root: node.id, notebook_order: [...order, node.id] }); select(node.id); setAdding(false); setQuery('');
  }
  function addInline(parentId, slotIndex, path, kind) {
    if (scene.nodes.length >= 64) return reportError('最多支持 64 个节点');
    const child = createNode(scene, kind, currentParameters, '');
    if (ARITY[kind]) child.inputs = Array.from({ length: ARITY[kind] }, () => '');
    const next = createInlineInputNode(scene, parentId, slotIndex, child);
    const key = [...path, parentId, slotIndex, child.id].join('/');
    commitScene(next);
    setNestedOpened(old => new Set([...old, key]));
    setSlotPicker(null); setSlotQuery('');
  }
  function promoteToTop(childId, beforeParentId) {
    const next = promoteInlineNode(scene, childId, beforeParentId);
    onChange(next);
    select(childId);
  }
  function demoteToSlot(childId) {
    const res = demoteToInlineNode(scene, childId);
    if (res.error) return reportError(res.error);
    if (selected === childId) {
      const host = scene.nodes.find(n => (n.inputs || []).includes(childId));
      if (host) onSelect(host.id);
    }
    commitScene(res.scene);
  }
  function duplicate(node) {
    if (scene.nodes.length >= 64) return reportError('最多支持 64 个节点');
    const copy = { ...structuredClone(node), id: createNode(scene, node.kind, currentParameters).id, name: `${node.name} 副本` };
    onChange({ ...scene, nodes: [...scene.nodes, copy], root: copy.id, notebook_order: [...order, copy.id] }); select(copy.id);
  }
  function remove(node) {
    const children = scene.nodes.filter(n => n.inputs.includes(node.id));
    if (children.length) return reportError(`${node.name} 被 ${children.map(n => n.name).join('、')} 引用，请先更换输入或删除下游节点。`);
    const nodes = scene.nodes.filter(n => n.id !== node.id);
    commitScene({ ...scene, nodes, root: scene.root === node.id ? nodes.at(-1)?.id || '' : scene.root });
    if (selected === node.id) select(nodes.at(-1)?.id || '');
  }
  function addParameter() {
    const name = parameterName.trim();
    if (!/^[A-Za-z_][A-Za-z_0-9]{0,31}$/.test(name) || ['pi', 'abs', 'min', 'max', 'sqrt'].includes(name)) return reportError('参数名须为英文标识符，不能使用 pi/abs/min/max/sqrt');
    if (Object.hasOwn(params, name)) return reportError('共享参数名称已存在');
    if (Object.keys(params).length >= 32) return reportError('最多支持 32 个共享参数');
    onChange({ ...scene, parameters: { ...params, [name]: 1 } }); setParameterName('');
  }
  function removeParameter(name) {
    const referenced = [...scene.nodes, ...(scene.value_nodes || [])].filter(n => [...Object.values(n.expressions || {}), n.expression, ...(n.components || [])].some(v => String(v).match(/[A-Za-z_][A-Za-z_0-9]*/g)?.includes(name)));
    if (referenced.length) return reportError(`参数 ${name} 被 ${referenced.map(n => n.name).join('、')} 引用，请先移除表达式。`);
    onChange({ ...scene, parameters: Object.fromEntries(Object.entries(params).filter(([key]) => key !== name)) });
  }
  function isSlotCompatible(_parentKind, _childKind) {
    return true;
  }
  function renderEditor(node, path = []) {
    const options = [['', '选择上游实体…'], ...inputOptions(scene.nodes, node.id).map(n => [n.id, n.name])];
    const issue = issues[node.id] || (error.includes(`节点 ${node.name} /`) ? error : '');
    const vectors = blocks.filter(b => b.kind === 'vector');
    const field = (target, label, val, unit) => <ParameterField key={target} disabled={!!node.vector_inputs?.[target.split('.')[0]]} node={node} target={target} label={label} value={val} unit={unit} patch={values => patch(node.id, values)} />;
    function vectorSelector(target, label) {
    if (!vectors.length && !node.vector_inputs?.[target]) return null;
    const reference = vectors.find(b => b.id === node.vector_inputs?.[target]);
    return <ReferenceInput target={{ kind: 'vector', id: node.id, field: target }} label={`${label}向量`}><Choice label={`${label}向量引用`} value={node.vector_inputs?.[target] || ''} options={[['', '手动 XYZ / 分量 fx'], ...vectors.map(b => [b.id, `${b.name} · ${b.symbol}`])]} onChange={id => {
      const vector_inputs = { ...node.vector_inputs };
      if (id) vector_inputs[target] = id; else delete vector_inputs[target];
      patch(node.id, { vector_inputs, expressions: Object.fromEntries(Object.entries(node.expressions || {}).filter(([key]) => !id || !key.startsWith(target + '.'))) });
    }} />{reference && <Reference id={reference.id} kind="vector" name={reference.name} onClick={() => select(`value:${reference.id}`)} />}</ReferenceInput>;
  }
    return <fieldset disabled={inputsLocked} className="selected-editor notebook-editor" aria-busy={busy}><article data-editor-node-id={node.id}>
      {issue && <p className="node-error" role="alert">{issue}</p>}
      <section className="editor-section"><label className="field"><span>节点名称</span><input aria-label="节点名称" value={node.name} onChange={e => patch(node.id, { name: e.target.value })} /></label>
        {ARITY[node.kind] && Array.from({ length: ARITY[node.kind] }, (_, i) => {
          const input = scene.nodes.find(n => n.id === node.inputs[i]);
          const nestedKey = [...path, node.id, i, input?.id].join('/');
          const slotId = [...path, node.id, i].join(':');
          const childInline = input ? isInlineNode(scene, input.id) : false;
          const pickerOpen = slotPicker === slotId;
          const slotMatches = INLINE_CREATION_KINDS.filter(k => k.name.toLowerCase().includes(slotQuery.trim().toLowerCase()));
          return <ReferenceInput className="notebook-input" key={i} target={{ kind: 'body', id: node.id, index: i }} label={ARITY[node.kind] === 1 ? '输入实体' : `输入 ${i === 0 ? 'A' : 'B'}`}><Choice label={ARITY[node.kind] === 1 ? '输入实体' : `输入 ${i === 0 ? 'A' : 'B'}`} value={node.inputs[i] || ''} options={options} onChange={v => patch(node.id, { inputs: Array.from({ length: ARITY[node.kind] }, (_, j) => i === j ? v : node.inputs[j] || '') })} />
            <div className="slot-actions">
              {input && <Reference id={input.id} name={input.name} onClick={() => {
                if (childInline) setNestedOpened(old => new Set([...old, nestedKey]));
                else select(input.id);
              }} />}
              {childInline && <span className="inline-badge">内嵌子块</span>}
              {path.length < 3 && <button type="button" className="slot-create-trigger" disabled={inputsLocked || !available || scene.nodes.length >= 64} aria-expanded={pickerOpen} onClick={() => { setSlotPicker(old => old === slotId ? null : slotId); setSlotQuery(''); }}><Plus size={13} aria-hidden="true" />{input ? '替换新建' : '就地新建'}</button>}
            </div>
            {pickerOpen && <div className="slot-inline-picker" role="region" aria-label="就地新建子块" onKeyDown={e => { if (e.key === 'Escape') { e.stopPropagation(); setSlotPicker(null); } }}>
              <label className="slot-picker-search"><Search size={14} aria-hidden="true" /><input autoFocus aria-label="筛选子块类型" placeholder="筛选基本体 / 操作…" value={slotQuery} onChange={e => setSlotQuery(e.target.value)} /></label>
              <div className="slot-picker-grid">{slotMatches.map(item => {
                const ok = isSlotCompatible(node.kind, item.id);
                return <button type="button" key={item.id} disabled={!ok || scene.nodes.length >= 64} title={ok ? `就地创建 ${item.name}` : `${NODE_KINDS[node.kind]}暂不支持此上游类型`} onClick={() => addInline(node.id, i, path, item.id)}>{item.name}</button>;
              })}{!slotMatches.length && <span className="hint">无匹配类型</span>}</div>
            </div>}
            {input && path.length < 3 && ![...path, node.id].includes(input.id) && <details className="nested-reference" open={nestedOpened.has(nestedKey)} onToggle={e => { const open = e.currentTarget.open; setNestedOpened(old => { if (old.has(nestedKey) === open) return old; const next = new Set(old); if (open) next.add(nestedKey); else next.delete(nestedKey); return next; }); }}><summary>展开 {input.name}</summary>{nestedOpened.has(nestedKey) && <div className="nested-editor"><div className="nested-toolbar">{childInline ? <button type="button" className="secondary nested-promote" onClick={() => promoteToTop(input.id, path[0] || node.id)}><ArrowUpRight size={13} aria-hidden="true" />提升为独立卡片</button> : scene.root !== input.id && <button type="button" className="secondary nested-demote" onClick={() => demoteToSlot(input.id)}><Minimize2 size={13} aria-hidden="true" />转为内嵌子块</button>}</div>{renderEditor(input, [...path, node.id])}</div>}</details>}
          </ReferenceInput>;
        })}
        {(node.kind === 'difference' || node.kind === 'smooth_difference') && <p className="hint">{node.kind === 'smooth_difference' ? 'A 为保留实体，B 为带平滑圆角过渡的减除实体。' : 'A 为保留实体，B 为要减去的实体。'}</p>}
        {LABELS[node.kind]?.map((label, i) => field(`dimensions.${i}`, label, node.dimensions[i]))}
        {PRIMITIVES.find(item => item.kind === node.kind)?.hint && <p className="hint">{PRIMITIVES.find(item => item.kind === node.kind).hint}</p>}
        {node.kind === 'tpms' && <TPMSFields node={node} patch={values => patch(node.id, values)} currentParameters={currentParameters} />}
        {(node.kind === 'smooth_union' || node.kind === 'smooth_difference') && <>
          {field('blend', '融合宽度', node.blend)}
          <p className="hint">支持与基本体、圆锥/圆台/椭球、抽壳/偏置及 TPMS 平滑过渡；对薄壁抽壳体建议融合宽度不超过壁厚的 1.5 倍。</p>
        </>}
        {node.kind === 'shell' && (() => {
          const op = node.operation || {};
          const hasMulti = Array.isArray(op.openings);
          const openingSelect = hasMulti ? 'custom' : (op.opening || 'closed');
          const activeOpenings = hasMulti ? op.openings : (op.opening && op.opening !== 'closed' ? [op.opening] : []);
          const toggleFace = face => {
            const next = activeOpenings.includes(face) ? activeOpenings.filter(f => f !== face) : [...activeOpenings, face];
            patch(node.id, { operation: { ...op, opening: 'closed', openings: next } });
          };
          return <>
            {field('dimensions.0', '壳体壁厚', node.dimensions[0])}
            <Choice label="抽壳方向" value={op.direction || 'inward'} options={[['inward', '向内抽壳（保持外表面）'], ['outward', '向外包壳（保持内腔）'], ['symmetric', '两侧对称抽壳']]} onChange={direction => patch(node.id, { operation: { ...op, direction } })} />
            <Choice label="开口方向" value={openingSelect} options={[["closed","封闭壳体"], ...['+X','-X','+Y','-Y','+Z','-Z'].map(axis => [axis, `${axis} 方向开口`]), ["custom", "多方向组合开口…"]]} onChange={val => {
              if (val === 'custom') patch(node.id, { operation: { ...op, opening: 'closed', openings: activeOpenings.length ? activeOpenings : ['+Z', '-Z'] } });
              else { const nextOp = { ...op, opening: val }; delete nextOp.openings; patch(node.id, { operation: nextOp }); }
            }} />
            {hasMulti && <OpeningsGrid openings={activeOpenings} onToggle={toggleFace} label="多方向开口" />}
            <p className="hint">支持向内、向外及对称等壁厚抽壳与多方向组合开口；支持所有基本体、圆锥/圆台/椭球、布尔组合与 TPMS。网格尺寸不超过壁厚的一半。</p>
          </>;
        })()}
        {node.kind === 'offset' && <>
          {field('dimensions.0', '偏置距离', node.dimensions[0])}
          <p className="hint">正值向外加厚扩边，负值向内收缩；支持任意基本体、布尔组合与 TPMS。</p>
        </>}
        {node.kind === 'mirror' && <>
          <Choice label="镜像平面" value={node.operation?.axis || 'X'} options={[['X', 'YZ 平面（沿 X 翻转）'], ['Y', 'XZ 平面（沿 Y 翻转）'], ['Z', 'XY 平面（沿 Z 翻转）']]} onChange={axis => patch(node.id, { operation: { ...node.operation, axis } })} />
          <label className="toggle"><input type="checkbox" checked={node.operation?.keep_original !== false} onChange={e => patch(node.id, { operation: { ...node.operation, keep_original: e.target.checked } })} /><span>保留原实体（对称合并）</span></label>
          <p className="hint">按世界原点对应的坐标平面对称镜像，兼容实体、组合布尔和 TPMS。</p>
        </>}
        {node.kind === 'linear_pattern' && <>
          <div className="triple">{['X', 'Y', 'Z'].map((axis, i) => field(`dimensions.${i}`, `${axis} 数量`, node.dimensions[i], ''))}</div>
          <div className="triple">{['X', 'Y', 'Z'].map((axis, i) => field(`dimensions.${i + 3}`, `${axis} 间距`, node.dimensions[i + 3], 'mm'))}</div>
          <label className="toggle"><input type="checkbox" checked={!!node.operation?.centered} onChange={e => patch(node.id, { operation: { ...node.operation, centered: e.target.checked } })} /><span>以原位置居中对称阵列</span></label>
          <p className="hint">每轴数量 1–32，总实例数不超过 64；支持与参数/公式联动。</p>
        </>}
        {node.kind === 'circular_pattern' && <>
          <Choice label="旋转轴" value={node.operation?.axis || 'Z'} options={[['Z', '绕 Z 轴'], ['X', '绕 X 轴'], ['Y', '绕 Y 轴']]} onChange={axis => patch(node.id, { operation: { ...node.operation, axis } })} />
          <div className="double">{field('dimensions.0', '阵列数量', node.dimensions[0], '')}{field('dimensions.1', '总角度', node.dimensions[1], '°')}</div>
          <p className="hint">绕局部原点指定轴旋转复制；总角度 360° 时均匀铺满整圈，小于 360° 时按圆弧均匀分布。</p>
        </>}
        {node.kind === 'tpms_infill' && (() => {
          const expr = node.expressions || {};
          const skinOn = Object.hasOwn(expr, 'dimensions.1') || Number(node.dimensions?.[1] ?? 0) > 0;
          const infillOpenings = Array.isArray(node.operation?.openings) ? node.operation.openings : [];
          const toggleInfillFace = face => {
            const next = infillOpenings.includes(face) ? infillOpenings.filter(f => f !== face) : [...infillOpenings, face];
            patch(node.id, { operation: { ...node.operation, openings: next } });
          };
          const toggleSkin = enabled => {
            const nextExpr = { ...expr };
            if (!enabled) { delete nextExpr['dimensions.1']; delete nextExpr['dimensions.2']; }
            patch(node.id, {
              dimensions: [node.dimensions[0], enabled ? 1.2 : 0, enabled ? 0.5 : 0],
              operation: { ...node.operation, openings: enabled ? (infillOpenings.length ? infillOpenings : ['+Z', '-Z']) : [] },
              expressions: nextExpr,
            });
          };
          return <>
            {field('dimensions.0', '单胞尺寸', node.dimensions[0])}
            <label className="toggle"><input type="checkbox" checked={skinOn} onChange={e => toggleSkin(e.target.checked)} /><span>保留外蒙皮外壳（向内抽壳 + 内芯填充）</span></label>
            {skinOn && <>
              <div className="double">
                {field('dimensions.1', '外蒙皮壁厚', node.dimensions[1])}
                {field('dimensions.2', '接壁平滑融合', node.dimensions[2])}
              </div>
              <div className="field"><span>外壳开口面</span><span className="hint">不选则为全封闭夹芯</span></div>
              <OpeningsGrid openings={infillOpenings} onToggle={toggleInfillFace} label="外壳开口面" />
            </>}
            {node.tpms && <TPMSFields node={node} patch={values => patch(node.id, values)} currentParameters={currentParameters} infill />}
          </>;
        })()}
      </section>
      <details key={node.id} className="editor-section editor-transforms" open={node.kind === 'transform' || undefined}><summary>位置与旋转</summary>{vectorSelector('position', '位置')}<div className="triple">{['X', 'Y', 'Z'].map((axis, i) => field(`position.${i}`, `${axis} 位置`, node.position[i]))}</div>{vectorSelector('rotation', '旋转')}<div className="triple">{['X', 'Y', 'Z'].map((axis, i) => field(`rotation.${i}`, `${axis} 旋转`, node.rotation[i], '°'))}</div></details>
    </article></fieldset>;
  }
  function removeValue(block) {
    const consumers = valueConsumers(scene, block);
    if (consumers.length) return reportError(`参数 ${block.name} 被 ${consumers.map(n => n.name).join('、')} 引用，请先解除引用。`);
    onChange({ ...scene, value_nodes: blocks.filter(b => b.id !== block.id) });
    if (selected === `value:${block.id}`) select('');
  }
  function duplicateValue(block) {
    if (blocks.length >= 32) return reportError('最多支持 32 个参数节点');
    const fresh = createValueBlock(scene, block.kind);
    const copy = { ...structuredClone(block), id: fresh.id, symbol: fresh.symbol, name: `${block.name} 副本` };
    onChange({ ...scene, value_nodes: [...blocks, copy], notebook_order: [...order, `value:${copy.id}`] });
    select(`value:${copy.id}`);
  }
  const menuSection = menu?.id?.startsWith('section:') ? sectionById.get(menu.id.slice(8)) : null;
  const menuNode = scene.nodes.find(n => n.id === menu?.id);
  const menuValue = blocks.find(b => `value:${b.id}` === menu?.id);
  const creations = [
    ...Object.entries(NODE_KINDS).map(([id, name]) => ({ id, name: id === 'difference' ? '差集' : name, value: false, section: false, group: ARITY[id] ? '操作' : '实体' })),
    ...[['number', '数值参数'], ['formula', '公式参数'], ['vector', '向量参数']].map(([id, name]) => ({ id, name, value: true, section: false, group: '参数' })),
    { id: 'section', name: '章节分组', value: false, section: true, group: '组织' }
  ].filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <Values.Provider value={blocks}><Navigate.Provider value={select}><WorkflowDrag scene={scene} onChange={onChange} busy={busy} reportError={reportError}><div className="node-workflow workflow-browser notebook card-workflow" aria-busy={busy}>
    {!!order.length && <div className="workflow-tools card-tools"><div><button type="button" aria-label="收起所有节点" title="收起所有节点" onClick={() => setExpanded(new Set())}><ChevronsDownUp size={18} aria-hidden="true" /></button><button type="button" aria-label="新建章节" title="新建章节分组" disabled={busy} onClick={() => addSection()}><FolderPlus size={18} aria-hidden="true" /></button><button type="button" aria-label="撤销节点修改" title="撤销 Ctrl+Z" disabled={!canUndo} onClick={undo}><Undo2 size={18} aria-hidden="true" /></button><button type="button" aria-label="重做节点修改" title="重做 Ctrl+Shift+Z" disabled={!canRedo} onClick={redo}><Redo2 size={18} aria-hidden="true" /></button></div><button type="button" aria-label="输出设置" aria-expanded={settings} onClick={() => setSettings(old => !old)}><Settings2 size={18} aria-hidden="true" />设置</button></div>}
    {settings && <section className="card-settings" aria-label="输出设置">
      <ReferenceInput target={{ kind: 'root' }} label="最终输出"><Choice label="输出节点" value={scene.root} options={scene.nodes.length ? scene.nodes.map(n => [n.id, n.name]) : [['', '先添加建模节点']]} onChange={v => commitScene({ ...scene, root: v })} /></ReferenceInput>
      <Numeric label="输出网格尺寸" value={scene.cell_size} unit="mm" onChange={v => onChange({ ...scene, cell_size: v })} />
      {/* B4②：网格精度是互斥单选，改用 aria-current */}
      <div className="mesh-presets" role="group" aria-label="网格精度预设">{[[0.6, '快速'], [0.3, '标准'], [0.15, '精细']].map(([size, name]) => <button type="button" key={size} disabled={busy} aria-current={scene.cell_size === size ? 'true' : undefined} onClick={() => onChange({ ...scene, cell_size: size })}>{name}<small>{size} mm</small></button>)}</div>
      <p className="hint">尺寸越小，圆弧和细节越精细，计算量与文件大小增加。修改后重新生成工作流；旧项目保留原精度。全部实体布局使用独立精度，导出使用最终输出。</p>
      {!!blocks.length && <button type="button" className="secondary full evaluate-values" disabled={busy} onClick={evaluateValues}>计算参数值</button>}
      <details className="workflow-inputs"><summary>共享常量 <small>{Object.keys(params).length} 个</small></summary>{Object.entries(params).map(([name, val]) => <div className="parameter-row" key={name}><Numeric label={name} value={val} onChange={v => onChange({ ...scene, parameters: { ...params, [name]: v } })} /><button type="button" aria-label={`删除参数 ${name}`} onClick={() => removeParameter(name)}><Trash2 size={16} aria-hidden="true" /></button></div>)}<div className="add-row"><input aria-label="新共享参数名称" placeholder="例如 wall" value={parameterName} onChange={e => setParameterName(e.target.value)} /><button type="button" className="secondary" onClick={addParameter} disabled={!parameterName.trim()}>添加参数</button></div></details>
      <details className="workflow-presets"><summary>示例工作流</summary>{[['sphere_hole', '球体减贯穿孔'], ['smooth', '双球平滑融合'], ['tpms_channel', '圆柱 TPMS 减流道']].map(([id, name]) => <button type="button" key={id} className="secondary full" disabled={!available || busy} onClick={() => loadPreset(id)}>{name}</button>)}</details>
      {cacheSummary && <p className="cache-summary" role="status">{cacheSummary}</p>}
    </section>}
    <ol className="notebook-nodes card-list" aria-label="建模节点树">{order.map(id => {
      if (id.startsWith('section:')) {
        const sec = sectionById.get(id.slice(8));
        if (!sec) return null;
        const stats = orderMeta.statsOf.get(sec.id) || { count: 0, hasError: false, hasOutput: false };
        const showNote = noteOpened.has(sec.id) || !!sec.note?.trim();
        return <li key={id} data-section-id={sec.id} className={`notebook-section-item ${sec.collapsed ? 'collapsed' : ''}`}>
          <SortHeading group="notebook" id={id} onContextMenu={e => showMenu(e, id)}>
            <SortHandle group="notebook" id={id} name={sec.name} />
            <button type="button" className="notebook-disclosure" aria-label={`${sec.collapsed ? '展开' : '收起'}章节 ${sec.name}`} aria-expanded={!sec.collapsed} onClick={() => onChange(updateSection(scene, sec.id, { collapsed: !sec.collapsed }))}><ChevronRight size={16} className={sec.collapsed ? '' : 'expanded'} aria-hidden="true" /></button>
            <span className="section-icon" aria-hidden="true">{sec.collapsed ? <Folder size={15} /> : <FolderOpen size={15} />}</span>
            {editingSection === sec.id ? <input autoFocus aria-label="章节名称" className="section-title-input" value={sec.name} onChange={e => onChange(updateSection(scene, sec.id, { name: e.target.value }))} onBlur={() => setEditingSection(null)} onKeyDown={e => { if (['Enter', 'Escape'].includes(e.key)) setEditingSection(null); }} />
              : <button type="button" className="section-title-btn" title="双击或点击重命名章节" onDoubleClick={() => setEditingSection(sec.id)} onClick={() => onChange(updateSection(scene, sec.id, { collapsed: !sec.collapsed }))}><strong>{sec.name}</strong></button>}
            <span className="section-badges">
              <small className="section-count">{stats.count} 项</small>
              {sec.collapsed && stats.hasOutput && <small className="section-output-pill">含输出</small>}
              {sec.collapsed && stats.hasError && <small className="section-error-pill">待修正</small>}
            </span>
            <button type="button" className="section-action-btn" title="添加或编辑章节注释" aria-label={`编辑章节 ${sec.name} 注释`} onClick={() => setNoteOpened(old => { const next = new Set(old); if (next.has(sec.id)) next.delete(sec.id); else next.add(sec.id); return next; })}><MessageSquarePlus size={15} aria-hidden="true" /></button>
            <button type="button" className="card-menu-trigger" aria-label={`章节操作 ${sec.name}`} aria-expanded={menu?.id === id} onClick={e => showMenu(e, id)}><MoreHorizontal size={18} aria-hidden="true" /></button>
          </SortHeading>
          {showNote && <div className="section-note-wrap"><textarea aria-label={`章节 ${sec.name} 注释`} rows={2} placeholder="记录本章节建模思路、壁厚约束或工艺备注…" value={sec.note || ''} onChange={e => onChange(updateSection(scene, sec.id, { note: e.target.value }))} /></div>}
        </li>;
      }
      if (orderMeta.ownerOf.get(id)?.collapsed) return null;
      const value = id.startsWith('value:'), n = value ? blocks.find(b => `value:${b.id}` === id) : scene.nodes.find(b => b.id === id);
      const open = expanded.has(id), issue = !value && issues[id];
      const type = value ? n.kind === 'vector' ? '向量' : n.kind === 'formula' ? '公式' : '数值' : NODE_KINDS[n.kind];
      const category = value ? `value-${n.kind}` : n.kind === 'tpms' ? 'tpms' : OPERATION_KINDS.has(n.kind) ? 'operation' : ARITY[n.kind] ? 'boolean' : 'primitive';
      const summary = !open && !issue ? cardSummaryText(n, value, scene) : '';
      const highlightLinks = enter => {
        for (const el of entries.current.values()) el.classList.remove('is-upstream', 'is-downstream');
        if (!enter || value) return;
        for (const up of (n.inputs || [])) entries.current.get(up)?.classList.add('is-upstream');
        for (const other of scene.nodes) if (other.inputs?.includes(id)) entries.current.get(other.id)?.classList.add('is-downstream');
      };
      return <li key={id} ref={el => { if (el) entries.current.set(id, el); else entries.current.delete(id); }} data-node-id={value ? undefined : id} data-value-id={value ? n.id : undefined} data-category={category} className={`notebook-node card-node ${selected === id ? 'selected' : ''} ${issue ? 'has-error' : ''} ${!value && scene.root === id ? 'is-output' : ''}`} onPointerEnter={() => highlightLinks(true)} onPointerLeave={() => highlightLinks(false)}>
        <SortHeading group="notebook" id={id} onContextMenu={e => showMenu(e, id)}>
          <SortHandle group="notebook" id={id} name={n.name} />
          <button type="button" className="notebook-disclosure" aria-label={`${open ? '收起' : '展开'}${value ? '参数' : '节点'} ${n.name}`} aria-expanded={open} aria-controls={`card-${id}`} onClick={() => toggle(id)}><ChevronRight size={16} className={open ? 'expanded' : ''} aria-hidden="true" /></button>
          <button type="button" className="notebook-node-select" aria-label={`选择${value ? '参数' : '步骤'} ${n.name}`} aria-pressed={selected === id} title={type} onClick={() => select(id)}><strong>{n.name}</strong>{!value && scene.root === id && <ArrowDownToLine size={14} aria-label="最终输出" />}</button>
          {summary && <span className="card-inline-meta" aria-hidden="true">{summary}</span>}
          {/* B1：节点状态徽标（待更新 / 计算中 / 缓存复用 / 已完成 / 失败），进度状态经 store 订阅刷新 */}
          {!value && <NodeStateBadge id={id} />}
          {!value && <button type="button" className="card-preview" aria-label={allEntities ? `${hiddenEntities.includes(id) ? '显示' : '隐藏'}实体 ${n.name}` : `预览节点 ${n.name}`} aria-pressed={allEntities ? !hiddenEntities.includes(id) : activePreviewNode === id} disabled={!available || busy || !!issue} onClick={() => allEntities ? toggleEntity(id) : previewNode(id)}><Eye size={17} aria-hidden="true" /></button>}
          <ReferenceOutput id={n.id} type={value ? n.kind === 'vector' ? 'vector' : 'number' : 'body'} name={n.name} onClick={() => select(id)} />
          <button type="button" className="card-menu-trigger" aria-label={`节点操作 ${n.name}`} aria-expanded={menu?.id === id} onClick={e => showMenu(e, id)}><MoreHorizontal size={18} aria-hidden="true" /></button>
        </SortHeading>
        {issue && !open && <p className="node-error" role="alert">{issue}</p>}
        <div id={`card-${id}`} hidden={!open}>{open && (value ? <fieldset disabled={inputsLocked} className="selected-editor notebook-editor"><ValueEditor inline compact scene={scene} onChange={onChange} selected={n} outputs={valueOutputs} reportError={reportError} onSelect={select} /></fieldset> : renderEditor(n))}</div>
      </li>;
    })}</ol>
    <button ref={addButton} type="button" className="card-add" aria-expanded={adding} disabled={busy} onClick={() => { setAdding(old => !old); setQuery(''); }}><Plus size={19} aria-hidden="true" />新节点</button>
    {adding && <section className="node-picker" aria-label="创建节点" onKeyDown={e => { if (e.key === 'Escape') { setAdding(false); addButton.current?.focus(); } }}><label className="node-search"><Search size={17} aria-hidden="true" /><input autoFocus aria-label="搜索节点" placeholder="搜索实体、操作或参数…" value={query} onChange={e => setQuery(e.target.value)} /></label>{['实体', '操作', '参数', '组织'].map(group => <div key={group}>{creations.some(item => item.group === group) && <h3>{group}</h3>}{creations.filter(item => item.group === group).map(item => <button type="button" key={item.id} disabled={busy || (!item.value && !item.section && !available) || (item.value ? blocks.length >= 32 : !item.section && scene.nodes.length >= 64)} onClick={() => add(item.id, item.value, item.section)}>{item.name}</button>)}</div>)}{!creations.length && <p className="hint">没有匹配的节点</p>}<details className="workflow-presets"><summary>从示例开始</summary>{[['sphere_hole', '球体减贯穿孔'], ['smooth', '双球平滑融合'], ['tpms_channel', '圆柱 TPMS 减流道']].map(([id, name]) => <button type="button" key={id} disabled={!available || busy} onClick={() => { setAdding(false); loadPreset(id); }}>{name}</button>)}</details></section>}
    {menu && (menuNode || menuValue || menuSection) && <CardMenu position={menu} onClose={() => setMenu(null)}>{menuNode ? <>
      <button type="button" disabled={busy || !!issues[menuNode.id] || !available} onClick={() => { previewNode(menuNode.id); setMenu(null); }}>单独预览</button>
      <button type="button" disabled={busy || !!issues[menuNode.id] || scene.root === menuNode.id} onClick={() => { commitScene({ ...scene, root: menuNode.id }); setMenu(null); }}>设为输出</button>
      {scene.root !== menuNode.id && (scene.nodes || []).some(n => (n.inputs || []).includes(menuNode.id)) && <button type="button" disabled={busy} onClick={() => { demoteToSlot(menuNode.id); setMenu(null); }}>内嵌到引用处</button>}
      <button type="button" disabled={busy || scene.nodes.length >= 64} onClick={() => { duplicate(menuNode); setMenu(null); }}>复制节点</button>
      <button type="button" className="text-danger" disabled={busy} onClick={() => { remove(menuNode); setMenu(null); }}>删除节点</button>
    </> : menuValue ? <>
      <button type="button" disabled={busy || blocks.length >= 32} onClick={() => { duplicateValue(menuValue); setMenu(null); }}>复制参数</button>
      <button type="button" className="text-danger" disabled={busy} onClick={() => { removeValue(menuValue); setMenu(null); }}>删除参数</button>
    </> : <>
      <button type="button" disabled={busy} onClick={() => { setEditingSection(menuSection.id); setMenu(null); }}>重命名章节</button>
      <button type="button" disabled={busy} onClick={() => { setNoteOpened(old => new Set([...old, menuSection.id])); setMenu(null); }}>编辑注释</button>
      <button type="button" className="text-danger" disabled={busy} onClick={() => { onChange(removeSection(scene, menuSection.id)); setMenu(null); }}>删除章节（保留节点）</button>
    </>}<SortButtons group="notebook" id={menu.id} name={(menuNode || menuValue || menuSection).name} /></CardMenu>}
  </div></WorkflowDrag></Navigate.Provider></Values.Provider>;
}
