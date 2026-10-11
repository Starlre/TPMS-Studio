import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import { createValueBlock, ValueEditor } from './ValueBlocks';
import CardMenu from './CardMenu';
import { notebookOrder } from './workflow_drag.mjs';
import { MoreHorizontal, Settings2, Search } from 'lucide-react';
import { valueConsumers } from './node_graph.mjs';
import { Plus, Box, Move3D, Trash2, Undo2, Redo2, ArrowDownToLine, Eye, ChevronRight, ChevronsDownUp, Hash } from 'lucide-react';
import { NODE_KINDS, ARITY, inputOptions, graphErrors, createNode } from './node_graph.mjs';
import { WorkflowDrag, SortHeading, SortHandle, SortButtons, ReferenceOutput, ReferenceInput, DragSource } from './WorkflowDrag';
import { PRIMITIVES } from './primitive_catalog.mjs';

const LABELS = Object.fromEntries(PRIMITIVES.map(item => [item.kind,item.labels]));
const Values = createContext([]);
const Navigate = createContext(() => {});
function Choice({ label, value, options, onChange }) {
  return <label className="field"><span>{label}</span><select aria-label={label} value={value} onChange={e => onChange(e.target.value)}>{options.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>;
}
function Numeric({ label, value, onChange, unit }) {
  return <label className="field"><span>{label}{unit && ` / ${unit}`}</span><input type="number" step="any" aria-label={label} value={value ?? ''} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} /></label>;
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
  return <ReferenceInput target={{ kind: 'number', id: node.id, field: target }} label={label} disabled={disabled} className="parameter-binding"><div className="binding-heading"><span>{label}{unit && ` / ${unit}`}</span><button type="button" disabled={disabled} className={bound ? 'binding-active' : ''} aria-label={`${label}使用表达式`} aria-pressed={bound} onClick={toggle}>fx</button></div>
    <input aria-label={label} disabled={disabled} type={bound ? 'text' : 'number'} step="any" spellCheck={false} value={bound ? node.expressions[target] : value ?? ''}
      onChange={e => bound ? patch({ expressions: { ...node.expressions, [target]: e.target.value } }) : setValue(e.target.value === '' ? '' : Number(e.target.value))} />
    {!!blocks.length && <select aria-label={`${label}参数引用`} disabled={disabled} value={reference ? node.expressions[target] : ''} onChange={e => { const expressions = { ...node.expressions }; if (e.target.value) expressions[target] = e.target.value; else delete expressions[target]; patch({ expressions }); }}><option value="">手动输入 / 自定义 fx</option>{blocks.map(b => <option key={b.id} value={b.symbol}>{b.name} · {b.symbol} · 数值</option>)}</select>}
    {reference && <Reference id={reference.id} kind="number" name={reference.name} onClick={() => navigate(`value:${reference.id}`)} />}
  </ReferenceInput>;
}

function Reference({ id, name, kind = 'body', onClick }) {
  return <DragSource id={id} type={kind} name={name} className={`reference-token reference-${kind}`} aria-label={`定位引用 ${name}`} onClick={onClick}><span>{kind === 'body' ? <Box size={14} aria-hidden="true" /> : kind === 'vector' ? <Move3D size={14} aria-hidden="true" /> : <Hash size={14} aria-hidden="true" />}{kind === 'body' ? '实体' : kind === 'vector' ? '向量' : '数值'}</span><strong>{name}</strong><ChevronRight size={14} aria-hidden="true" /></DragSource>;
}

function TPMSFields({ node, patch, currentParameters }) {
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
    <div className="triple">{['x', 'y', 'z'].map(axis => field(`size_${axis}`, `${axis.toUpperCase()} 尺寸`))}</div>
    {p.surface !== 'Custom' && <div className="triple">{['x', 'y', 'z'].map(axis => field(`cells_${axis}`, `${axis.toUpperCase()} 周期`, ''))}</div>}
    <Choice label="结构模式" value={p.mode} onChange={v => change('mode', v)} options={[[ 'sheet', '片层结构' ], [ 'solid', '实体结构' ]]} />
    <label className="toggle"><input type="checkbox" checked={p.target_porosity !== null} onChange={e => change('target_porosity', e.target.checked ? 0.7 : null)} /><span>按目标孔隙率反求参数</span></label>
    {p.target_porosity !== null ? field('target_porosity', '目标孔隙率', '0–1') : p.mode === 'sheet' ? !p.gradient_enabled && field('thickness', '壁厚') : field('iso_level', '等值面偏移', '')}
    {p.mode === 'sheet' && <label className="toggle"><input type="checkbox" checked={p.gradient_enabled} onChange={e => change('gradient_enabled', e.target.checked)} /><span>梯度壁厚</span></label>}
    {p.gradient_enabled && <><Choice label="梯度方向" value={p.gradient_axis} onChange={v => change('gradient_axis', v)} options={['X', 'Y', 'Z'].map(k => [k, k])} /><div className="double">{field('gradient_thickness_start', '起始壁厚')}{field('gradient_thickness_end', '结束壁厚')}</div></>}
    {field('samples_per_cell', '每周期采样数', '')}
    <button type="button" className="secondary full" onClick={() => patch({ tpms: { ...currentParameters, tubular_enabled: false }, expressions: Object.fromEntries(Object.entries(node.expressions || {}).filter(([key]) => !key.startsWith('tpms.'))) })}>使用当前 TPMS 参数</button>
  </>;
}

export default function NodeWorkflow({ scene, onChange, currentParameters, selected, onSelect, dirty, hasResult, busy, available, error, reportError, undo, redo, canUndo, canRedo, loadPreset, nodeStates = {}, valueOutputs = {}, previewNode, evaluateValues, cacheSummary, activePreviewNode, allEntities, hiddenEntities = [], toggleEntity }) {
  const [expanded, setExpanded] = useState(() => new Set(selected ? [selected] : []));
  const [nestedOpened, setNestedOpened] = useState(new Set());
  const [adding, setAdding] = useState(false), [query, setQuery] = useState('');
  const [settings, setSettings] = useState(false), [menu, setMenu] = useState(null);
  const entries = useRef(new Map()), addButton = useRef(null);
  const [parameterName, setParameterName] = useState('wall');
  const issues = graphErrors(scene), params = scene.parameters || {}, blocks = scene.value_nodes || [];
  const order = notebookOrder(scene);
  useEffect(() => {
    if (!selected) return;
    setExpanded(old => new Set([...old, selected]));
    const frame = requestAnimationFrame(() => entries.current.get(selected)?.querySelector('.notebook-node-heading')?.scrollIntoView({ block: 'nearest' }));
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  useEffect(() => {
    const ids = new Set(order);
    setExpanded(old => [...old].some(id => !ids.has(id)) ? new Set([...old].filter(id => ids.has(id))) : old);
  }, [scene.nodes, blocks]);
  function select(id) {
    onSelect(id);
    if (!id) return;
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
  function patch(id, values) { onChange({ ...scene, nodes: scene.nodes.map(n => n.id === id ? { ...n, ...values } : n) }); }
  function add(kind, value = false) {
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
  function duplicate(node) {
    if (scene.nodes.length >= 64) return reportError('最多支持 64 个节点');
    const copy = { ...structuredClone(node), id: createNode(scene, node.kind, currentParameters).id, name: `${node.name} 副本` };
    onChange({ ...scene, nodes: [...scene.nodes, copy], root: copy.id, notebook_order: [...order, copy.id] }); select(copy.id);
  }
  function remove(node) {
    const children = scene.nodes.filter(n => n.inputs.includes(node.id));
    if (children.length) return reportError(`${node.name} 被 ${children.map(n => n.name).join('、')} 引用，请先更换输入或删除下游节点。`);
    const nodes = scene.nodes.filter(n => n.id !== node.id);
    onChange({ ...scene, nodes, root: scene.root === node.id ? nodes.at(-1)?.id || '' : scene.root });
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
    return <fieldset disabled={busy} className="selected-editor notebook-editor" aria-busy={busy}><article data-editor-node-id={node.id}>
      {issue && <p className="node-error" role="alert">{issue}</p>}
      <section className="editor-section"><label className="field"><span>节点名称</span><input aria-label="节点名称" value={node.name} onChange={e => patch(node.id, { name: e.target.value })} /></label>
        {ARITY[node.kind] && Array.from({ length: ARITY[node.kind] }, (_, i) => {
          const input = scene.nodes.find(n => n.id === node.inputs[i]);
          const nestedKey = [...path, node.id, i, input?.id].join('/');
          return <ReferenceInput className="notebook-input" key={i} target={{ kind: 'body', id: node.id, index: i }} label={ARITY[node.kind] === 1 ? '输入实体' : `输入 ${i === 0 ? 'A' : 'B'}`}><Choice label={ARITY[node.kind] === 1 ? '输入实体' : `输入 ${i === 0 ? 'A' : 'B'}`} value={node.inputs[i] || ''} options={options} onChange={v => patch(node.id, { inputs: Array.from({ length: ARITY[node.kind] }, (_, j) => i === j ? v : node.inputs[j] || '') })} />{input && <><Reference id={input.id} name={input.name} onClick={() => select(input.id)} />{path.length < 3 && ![...path, node.id].includes(input.id) && <details className="nested-reference" open={nestedOpened.has(nestedKey)} onToggle={e => { const open = e.currentTarget.open; setNestedOpened(old => { if (old.has(nestedKey) === open) return old; const next = new Set(old); if (open) next.add(nestedKey); else next.delete(nestedKey); return next; }); }}><summary>展开 {input.name}</summary>{nestedOpened.has(nestedKey) && <div className="nested-editor">{renderEditor(input, [...path, node.id])}</div>}</details>}</>}</ReferenceInput>;
        })}
        {node.kind === 'difference' && <p className="hint">A 为保留实体，B 为要减去的实体。</p>}
        {LABELS[node.kind]?.map((label, i) => field(`dimensions.${i}`, label, node.dimensions[i]))}
        {PRIMITIVES.find(item => item.kind === node.kind)?.hint && <p className="hint">{PRIMITIVES.find(item => item.kind === node.kind).hint}</p>}
        {node.kind === 'tpms' && <TPMSFields node={node} patch={values => patch(node.id, values)} currentParameters={currentParameters} />}
        {node.kind === 'smooth_union' && field('blend', '融合宽度', node.blend)}
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
  const menuNode = scene.nodes.find(n => n.id === menu?.id);
  const menuValue = blocks.find(b => `value:${b.id}` === menu?.id);
  const creations = [
    ...Object.entries(NODE_KINDS).map(([id, name]) => ({ id, name: id === 'difference' ? '差集' : name, value: false, group: ARITY[id] ? '操作' : '实体' })),
    ...[['number', '数值参数'], ['formula', '公式参数'], ['vector', '向量参数']].map(([id, name]) => ({ id, name, value: true, group: '参数' }))
  ].filter(item => item.name.toLowerCase().includes(query.trim().toLowerCase()));
  return <Values.Provider value={blocks}><Navigate.Provider value={select}><WorkflowDrag scene={scene} onChange={onChange} busy={busy} reportError={reportError}><div className="node-workflow workflow-browser notebook card-workflow" aria-busy={busy}>
    {!!order.length && <div className="workflow-tools card-tools"><div><button type="button" aria-label="收起所有节点" title="收起所有节点" onClick={() => setExpanded(new Set())}><ChevronsDownUp size={18} aria-hidden="true" /></button><button type="button" aria-label="撤销节点修改" title="撤销 Ctrl+Z" disabled={!canUndo} onClick={undo}><Undo2 size={18} aria-hidden="true" /></button><button type="button" aria-label="重做节点修改" title="重做 Ctrl+Shift+Z" disabled={!canRedo} onClick={redo}><Redo2 size={18} aria-hidden="true" /></button></div><button type="button" aria-label="输出设置" aria-expanded={settings} onClick={() => setSettings(old => !old)}><Settings2 size={18} aria-hidden="true" />设置</button></div>}
    {settings && <section className="card-settings" aria-label="输出设置">
      <ReferenceInput target={{ kind: 'root' }} label="最终输出"><Choice label="输出节点" value={scene.root} options={scene.nodes.length ? scene.nodes.map(n => [n.id, n.name]) : [['', '先添加建模节点']]} onChange={v => onChange({ ...scene, root: v })} /></ReferenceInput>
      <Numeric label="输出网格尺寸" value={scene.cell_size} unit="mm" onChange={v => onChange({ ...scene, cell_size: v })} />
      <div className="mesh-presets" role="group" aria-label="网格精度预设">{[[0.6, '快速'], [0.3, '标准'], [0.15, '精细']].map(([size, name]) => <button type="button" key={size} disabled={busy} aria-pressed={scene.cell_size === size} onClick={() => onChange({ ...scene, cell_size: size })}>{name}<small>{size} mm</small></button>)}</div>
      <p className="hint">尺寸越小，圆弧和细节越精细，计算量与文件大小增加。修改后重新生成工作流；旧项目保留原精度。全部实体布局使用独立精度，导出使用最终输出。</p>
      {!!blocks.length && <button type="button" className="secondary full evaluate-values" disabled={busy} onClick={evaluateValues}>计算参数值</button>}
      <details className="workflow-inputs"><summary>共享常量 <small>{Object.keys(params).length} 个</small></summary>{Object.entries(params).map(([name, val]) => <div className="parameter-row" key={name}><Numeric label={name} value={val} onChange={v => onChange({ ...scene, parameters: { ...params, [name]: v } })} /><button type="button" aria-label={`删除参数 ${name}`} onClick={() => removeParameter(name)}><Trash2 size={16} aria-hidden="true" /></button></div>)}<div className="add-row"><input aria-label="新共享参数名称" placeholder="例如 wall" value={parameterName} onChange={e => setParameterName(e.target.value)} /><button type="button" className="secondary" onClick={addParameter} disabled={!parameterName.trim()}>添加参数</button></div></details>
      <details className="workflow-presets"><summary>示例工作流</summary>{[['sphere_hole', '球体减贯穿孔'], ['smooth', '双球平滑融合'], ['tpms_channel', '圆柱 TPMS 减流道']].map(([id, name]) => <button type="button" key={id} className="secondary full" disabled={!available || busy} onClick={() => loadPreset(id)}>{name}</button>)}</details>
      {cacheSummary && <p className="cache-summary" role="status">{cacheSummary}</p>}
    </section>}
    <ol className="notebook-nodes card-list" aria-label="建模节点树">{order.map(id => {
      const value = id.startsWith('value:'), n = value ? blocks.find(b => `value:${b.id}` === id) : scene.nodes.find(b => b.id === id);
      const open = expanded.has(id), issue = !value && issues[id];
      const type = value ? n.kind === 'vector' ? '向量' : n.kind === 'formula' ? '公式' : '数值' : NODE_KINDS[n.kind];
      return <li key={id} ref={el => { if (el) entries.current.set(id, el); else entries.current.delete(id); }} data-node-id={value ? undefined : id} data-value-id={value ? n.id : undefined} className={`notebook-node card-node ${selected === id ? 'selected' : ''} ${issue ? 'has-error' : ''}`}>
        <SortHeading group="notebook" id={id} onContextMenu={e => showMenu(e, id)}>
          <SortHandle group="notebook" id={id} name={n.name} />
          <button type="button" className="notebook-disclosure" aria-label={`${open ? '收起' : '展开'}${value ? '参数' : '节点'} ${n.name}`} aria-expanded={open} aria-controls={`card-${id}`} onClick={() => toggle(id)}><ChevronRight size={16} className={open ? 'expanded' : ''} aria-hidden="true" /></button>
          <button type="button" className="notebook-node-select" aria-label={`选择${value ? '参数' : '步骤'} ${n.name}`} aria-pressed={selected === id} title={type} onClick={() => select(id)}><strong>{n.name}</strong>{!value && scene.root === id && <ArrowDownToLine size={14} aria-label="最终输出" />}</button>
          {!value && <button type="button" className="card-preview" aria-label={allEntities ? `${hiddenEntities.includes(id) ? '显示' : '隐藏'}实体 ${n.name}` : `预览节点 ${n.name}`} aria-pressed={allEntities ? !hiddenEntities.includes(id) : activePreviewNode === id} disabled={!available || busy || !!issue} onClick={() => allEntities ? toggleEntity(id) : previewNode(id)}><Eye size={17} aria-hidden="true" /></button>}
          <ReferenceOutput id={n.id} type={value ? n.kind === 'vector' ? 'vector' : 'number' : 'body'} name={n.name} onClick={() => select(id)} />
          <button type="button" className="card-menu-trigger" aria-label={`节点操作 ${n.name}`} aria-expanded={menu?.id === id} onClick={e => showMenu(e, id)}><MoreHorizontal size={18} aria-hidden="true" /></button>
        </SortHeading>
        {issue && !open && <p className="node-error" role="alert">{issue}</p>}
        <div id={`card-${id}`} hidden={!open}>{open && (value ? <fieldset disabled={busy} className="selected-editor notebook-editor"><ValueEditor inline compact scene={scene} onChange={onChange} selected={n} outputs={valueOutputs} reportError={reportError} onSelect={select} /></fieldset> : renderEditor(n))}</div>
      </li>;
    })}</ol>
    <button ref={addButton} type="button" className="card-add" aria-expanded={adding} disabled={busy} onClick={() => { setAdding(old => !old); setQuery(''); }}><Plus size={19} aria-hidden="true" />新节点</button>
    {adding && <section className="node-picker" aria-label="创建节点" onKeyDown={e => { if (e.key === 'Escape') { setAdding(false); addButton.current?.focus(); } }}><label className="node-search"><Search size={17} aria-hidden="true" /><input autoFocus aria-label="搜索节点" placeholder="搜索实体、操作或参数…" value={query} onChange={e => setQuery(e.target.value)} /></label>{['实体', '操作', '参数'].map(group => <div key={group}>{creations.some(item => item.group === group) && <h3>{group}</h3>}{creations.filter(item => item.group === group).map(item => <button type="button" key={item.id} disabled={busy || (!item.value && !available) || (item.value ? blocks.length >= 32 : scene.nodes.length >= 64)} onClick={() => add(item.id, item.value)}>{item.name}</button>)}</div>)}{!creations.length && <p className="hint">没有匹配的节点</p>}<details className="workflow-presets"><summary>从示例开始</summary>{[['sphere_hole', '球体减贯穿孔'], ['smooth', '双球平滑融合'], ['tpms_channel', '圆柱 TPMS 减流道']].map(([id, name]) => <button type="button" key={id} disabled={!available || busy} onClick={() => { setAdding(false); loadPreset(id); }}>{name}</button>)}</details></section>}
    {menu && (menuNode || menuValue) && <CardMenu position={menu} onClose={() => setMenu(null)}>{menuNode ? <>
      <button type="button" disabled={busy || !!issues[menuNode.id] || !available} onClick={() => { previewNode(menuNode.id); setMenu(null); }}>单独预览</button>
      <button type="button" disabled={busy || !!issues[menuNode.id] || scene.root === menuNode.id} onClick={() => { onChange({ ...scene, root: menuNode.id }); setMenu(null); }}>设为输出</button>
      <button type="button" disabled={busy || scene.nodes.length >= 64} onClick={() => { duplicate(menuNode); setMenu(null); }}>复制节点</button>
      <button type="button" className="text-danger" disabled={busy} onClick={() => { remove(menuNode); setMenu(null); }}>删除节点</button>
    </> : <>
      <button type="button" disabled={busy || blocks.length >= 32} onClick={() => { duplicateValue(menuValue); setMenu(null); }}>复制参数</button>
      <button type="button" className="text-danger" disabled={busy} onClick={() => { removeValue(menuValue); setMenu(null); }}>删除参数</button>
    </>}<SortButtons group="notebook" id={menu.id} name={(menuNode || menuValue).name} /></CardMenu>}
  </div></WorkflowDrag></Navigate.Provider></Values.Provider>;
}
