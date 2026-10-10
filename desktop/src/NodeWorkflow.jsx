import React, { useState, useEffect, useRef, createContext, useContext } from 'react';
import ValueBlocks from './ValueBlocks';
import { Plus, Box, Combine, Move3D, Copy, Trash2, Undo2, Redo2, ArrowDownToLine, Eye, ChevronRight, ChevronsDownUp, Hash } from 'lucide-react';
import { NODE_KINDS, ARITY, DIMENSIONS, ancestors, inputOptions, graphErrors, createNode } from './node_graph.mjs';
import { WorkflowDrag, SortHeading, SortHandle, SortButtons, ReferenceOutput, ReferenceInput, DragSource } from './WorkflowDrag';

const LABELS = { sphere: ['半径'], box: ['X 长度', 'Y 长度', 'Z 长度'], cylinder: ['半径', '高度'], torus: ['主半径', '管半径'] };
const Values = createContext([]);
const Navigate = createContext(() => {});
const STATES = { pending: '待更新', evaluating: '计算中', meshing: '提取网格', ready: '已更新', cached: '已缓存', error: '计算失败' };
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

export default function NodeWorkflow({ scene, onChange, currentParameters, selected, onSelect, dirty, hasResult, busy, available, error, reportError, undo, redo, canUndo, canRedo, loadPreset, nodeStates = {}, valueOutputs = {}, previewNode, evaluateValues, cacheSummary }) {
  const [kind, setKind] = useState('sphere');
  const [tab, setTab] = useState('steps');
  const [expanded, setExpanded] = useState(() => new Set(selected ? [selected] : []));
  const [groups, setGroups] = useState({ values: !!scene.value_nodes?.length, steps: true, output: true });
  const entries = useRef(new Map());
  const groupEntries = useRef({});
  const notebook = useRef(null);
  const navigation = useRef(null);
  const refreshNavigation = useRef(() => {});
  const [parameterName, setParameterName] = useState('wall');
  const issues = graphErrors(scene);
  const used = ancestors(scene.nodes, scene.root);
  const params = scene.parameters || {};
  const blocks = scene.value_nodes || [];
  useEffect(() => {
    const content = notebook.current, nav = navigation.current, pane = content?.closest('.panel-scroll');
    if (!pane || !nav) return;
    let frame = 0;
    function sync() {
      frame = 0;
      const sections = ['values', 'steps', 'output'].map(id => ({ id, element: groupEntries.current[id] })).filter(s => s.element?.getClientRects().length);
      if (!sections.length) return;
      const maximum = pane.scrollHeight - pane.clientHeight;
      // When everything fits, retain the explicit click/selection instead of guessing a section.
      if (maximum <= 2) return;
      // Measure below the sticky navigation rather than the outer window.
      const line = Math.max(pane.getBoundingClientRect().top, nav.getBoundingClientRect().bottom) + 8;
      let active = sections[0].id;
      for (const section of sections) if (section.element.getBoundingClientRect().top <= line + 1) active = section.id;
      // The short output section cannot reach the top when the scrollbar ends.
      if (pane.scrollTop >= maximum - 2) active = sections.at(-1).id;
      setTab(old => old === active ? old : active);
    }
    function schedule() { if (!frame) frame = requestAnimationFrame(sync); }
    refreshNavigation.current = schedule;
    pane.addEventListener('scroll', schedule, { passive: true });
    const resize = new ResizeObserver(schedule);
    [pane, content, nav, ...Object.values(groupEntries.current)].forEach(element => { if (element) resize.observe(element); });
    schedule();
    return () => { pane.removeEventListener('scroll', schedule); resize.disconnect(); cancelAnimationFrame(frame); refreshNavigation.current = () => {}; };
  }, []);
  useEffect(() => {
    if (!selected) return;
    const group = selected.startsWith('value:') ? 'values' : 'steps';
    setTab(group); setGroups(old => ({ ...old, [group]: true }));
    setExpanded(old => new Set([...old, selected]));
    const frame = requestAnimationFrame(() => { entries.current.get(selected)?.querySelector('.notebook-node-heading')?.scrollIntoView({ block: 'nearest' }); refreshNavigation.current(); });
    return () => cancelAnimationFrame(frame);
  }, [selected]);
  // Drop removed IDs so adding a later node does not inherit a deleted node's disclosure state.
  useEffect(() => {
    const ids = new Set([...scene.nodes.map(n => n.id), ...blocks.map(b => `value:${b.id}`)]);
    setExpanded(old => [...old].some(id => !ids.has(id)) ? new Set([...old].filter(id => ids.has(id))) : old);
  }, [scene.nodes, blocks]);
  function select(id) {
    onSelect(id);
    if (!id) return;
    const group = id.startsWith('value:') ? 'values' : 'steps';
    setTab(group); setGroups(old => ({ ...old, [group]: true }));
    setExpanded(old => new Set([...old, id]));
    requestAnimationFrame(() => {
      const element = entries.current.get(id);
      element?.querySelector('.notebook-node-heading')?.scrollIntoView({ block: 'nearest' });
      element?.querySelector('.notebook-node-select')?.focus({ preventScroll: true });
      refreshNavigation.current();
    });
  }
  function toggle(id) { setExpanded(old => { const next = new Set(old); if (next.has(id)) next.delete(id); else next.add(id); return next; }); }
  function changeTab(next) {
    setTab(next); setGroups(old => ({ ...old, [next]: true }));
    requestAnimationFrame(() => {
      const section = groupEntries.current[next], pane = notebook.current?.closest('.panel-scroll'), nav = navigation.current;
      if (section && pane && nav) {
        // Use one sticky-header offset; scrollIntoView adds both scroll padding and margin.
        const top = pane.scrollTop + section.getBoundingClientRect().top - pane.getBoundingClientRect().top - nav.getBoundingClientRect().height - 8;
        pane.scrollTo({ top, behavior: 'instant' });
      }
      refreshNavigation.current();
    });
  }
  function patch(id, values) { onChange({ ...scene, nodes: scene.nodes.map(n => n.id === id ? { ...n, ...values } : n) }); }
  function add() {
    if (scene.nodes.length >= 64) return reportError('最多支持 64 个节点');
    const node = createNode(scene, kind, currentParameters, selected);
    onChange({ ...scene, nodes: [...scene.nodes, node], root: node.id }); select(node.id);
  }
  function duplicate(node) {
    if (scene.nodes.length >= 64) return reportError('最多支持 64 个节点');
    const copy = { ...structuredClone(node), id: createNode(scene, node.kind, currentParameters).id, name: `${node.name} 副本` };
    onChange({ ...scene, nodes: [...scene.nodes, copy], root: copy.id }); select(copy.id);
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
  function renderEditor(node) {
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
          return <ReferenceInput className="notebook-input" key={i} target={{ kind: 'body', id: node.id, index: i }} label={ARITY[node.kind] === 1 ? '输入实体' : `输入 ${i === 0 ? 'A' : 'B'}`}><Choice label={ARITY[node.kind] === 1 ? '输入实体' : `输入 ${i === 0 ? 'A' : 'B'}`} value={node.inputs[i] || ''} options={options} onChange={v => patch(node.id, { inputs: Array.from({ length: ARITY[node.kind] }, (_, j) => i === j ? v : node.inputs[j] || '') })} />{input && <Reference id={input.id} name={input.name} onClick={() => select(input.id)} />}</ReferenceInput>;
        })}
        {node.kind === 'difference' && <p className="hint">A 为保留实体，B 为要减去的实体。</p>}
        {LABELS[node.kind]?.map((label, i) => field(`dimensions.${i}`, label, node.dimensions[i]))}
        {node.kind === 'tpms' && <TPMSFields node={node} patch={values => patch(node.id, values)} currentParameters={currentParameters} />}
        {node.kind === 'smooth_union' && field('blend', '融合宽度', node.blend)}
      </section>
      <details key={node.id} className="editor-section editor-transforms" open={node.kind === 'transform' || undefined}><summary>位置与旋转</summary>{vectorSelector('position', '位置')}<div className="triple">{['X', 'Y', 'Z'].map((axis, i) => field(`position.${i}`, `${axis} 位置`, node.position[i]))}</div>{vectorSelector('rotation', '旋转')}<div className="triple">{['X', 'Y', 'Z'].map((axis, i) => field(`rotation.${i}`, `${axis} 旋转`, node.rotation[i], '°'))}</div></details>
      <div className="notebook-actions"><button type="button" className="secondary" disabled={!available || Object.keys(issues).length > 0} aria-label={`预览节点 ${node.name}`} onClick={() => previewNode(node.id)}><Eye size={16} aria-hidden="true" />预览</button><button type="button" className="secondary" disabled={scene.root === node.id || !!issue} onClick={() => onChange({ ...scene, root: node.id })}><ArrowDownToLine size={16} aria-hidden="true" />设为输出</button><button type="button" className="secondary" aria-label={`复制节点 ${node.name}`} disabled={scene.nodes.length >= 64} onClick={() => duplicate(node)}><Copy size={16} aria-hidden="true" />复制</button><button type="button" className="secondary text-danger" aria-label={`删除节点 ${node.name}`} onClick={() => remove(node)}><Trash2 size={16} aria-hidden="true" />删除</button></div>
      <SortButtons group="body" id={node.id} name={node.name} />
    </article></fieldset>;
  }
  function groupHeading(id, title, count) {
    return <h3 className="notebook-group-heading"><button type="button" aria-expanded={groups[id]} aria-controls={`notebook-group-${id}`} onClick={() => setGroups(old => ({ ...old, [id]: !old[id] }))}><ChevronRight size={16} className={groups[id] ? 'expanded' : ''} aria-hidden="true" /><span>{title}</span><small>{count}</small></button></h3>;
  }
  return <Values.Provider value={blocks}><Navigate.Provider value={select}><WorkflowDrag scene={scene} onChange={onChange} busy={busy} reportError={reportError}><div ref={notebook} className="node-workflow workflow-browser notebook" aria-busy={busy}>
    <nav ref={navigation} className="workflow-tabs" aria-label="工作流类别">{[['steps', '建模步骤'], ['values', '设计参数'], ['output', '输出设置']].map(([id, name]) => <button type="button" key={id} aria-current={tab === id ? 'location' : undefined} aria-pressed={tab === id} className={tab === id ? 'selected' : ''} onClick={() => changeTab(id)}>{name}</button>)}</nav>
    <div className="workflow-tools"><span>{scene.nodes.length} 个节点 · {blocks.length} 个参数</span><div><button type="button" aria-label="收起所有节点" title="收起所有节点" onClick={() => setExpanded(new Set())}><ChevronsDownUp size={18} aria-hidden="true" /></button><button type="button" aria-label="撤销节点修改" title="撤销 Ctrl+Z" disabled={!canUndo} onClick={undo}><Undo2 size={18} aria-hidden="true" /></button><button type="button" aria-label="重做节点修改" title="重做 Ctrl+Shift+Z" disabled={!canRedo} onClick={redo}><Redo2 size={18} aria-hidden="true" /></button></div></div>
    <p className="notebook-intro">拖动左侧手柄排序；拖动类型按钮连接输入，点击引用定位来源。</p>
    <section className="notebook-group" ref={element => { groupEntries.current.values = element; }}>
      {groupHeading('values', '设计参数', `${blocks.length} 个`)}
      <div id="notebook-group-values" hidden={!groups.values}>
        <ValueBlocks scene={scene} onChange={onChange} outputs={valueOutputs} selected={selected} onSelect={select} evaluate={evaluateValues} busy={busy} expanded={expanded} onToggle={toggle} register={(id, element) => { if (element) entries.current.set(id, element); else entries.current.delete(id); }} reportError={reportError} />
        <details className="workflow-inputs"><summary>共享常量 <small>{Object.keys(params).length} 个</small></summary>{Object.entries(params).map(([name, val]) => <div className="parameter-row" key={name}><Numeric label={name} value={val} onChange={v => onChange({ ...scene, parameters: { ...params, [name]: v } })} /><button type="button" aria-label={`删除参数 ${name}`} onClick={() => removeParameter(name)}><Trash2 size={16} aria-hidden="true" /></button></div>)}<div className="add-row"><input aria-label="新共享参数名称" placeholder="例如 wall" value={parameterName} onChange={e => setParameterName(e.target.value)} /><button type="button" className="secondary" onClick={addParameter} disabled={!parameterName.trim()}>添加参数</button></div></details>
      </div>
    </section>
    <section className="notebook-group" ref={element => { groupEntries.current.steps = element; }}>
      {groupHeading('steps', '建模节点', `${scene.nodes.length} 个`)}
      <div id="notebook-group-steps" hidden={!groups.steps}>
      <div className="workflow-add"><select aria-label="新节点类型" value={kind} onChange={e => setKind(e.target.value)}><optgroup label="几何定义">{Object.keys(DIMENSIONS).map(k => <option key={k} value={k}>{NODE_KINDS[k]}</option>)}</optgroup><optgroup label="操作步骤">{Object.keys(ARITY).map(k => <option key={k} value={k}>{NODE_KINDS[k]}</option>)}</optgroup></select><button type="button" className="secondary" disabled={!available || scene.nodes.length >= 64} onClick={add}><Plus size={18} aria-hidden="true" />添加节点</button></div>
      {!scene.nodes.length && <div className="workflow-empty"><h3>先添加一个实体</h3><p>然后添加布尔或变换步骤，选择它们的输入。</p><button type="button" className="secondary" disabled={!available} onClick={() => loadPreset('tpms_channel')}>加载圆柱 TPMS 工作流</button></div>}
      <ol className="workflow-steps notebook-nodes" aria-label="建模节点树">{scene.nodes.map((n, index) => {
        const Icon = n.kind === 'transform' ? Move3D : n.inputs.length ? Combine : Box;
        const status = issues[n.id] ? '输入有误' : STATES[nodeStates[n.id]] || (!used.has(n.id) ? '独立步骤' : dirty || !hasResult ? '待生成' : '已生成');
        const open = expanded.has(n.id);
        return <li key={n.id} ref={element => { if (element) entries.current.set(n.id, element); else entries.current.delete(n.id); }} data-node-id={n.id} className={`workflow-step notebook-node ${selected === n.id ? 'selected' : ''} ${issues[n.id] ? 'has-error' : ''} ${scene.root === n.id ? 'is-output' : ''}`}>
          <SortHeading group="body" id={n.id}><SortHandle group="body" id={n.id} name={n.name} /><button type="button" className="notebook-disclosure" aria-label={`${open ? '收起' : '展开'}节点 ${n.name}`} aria-expanded={open} aria-controls={`notebook-node-${n.id}`} onClick={() => toggle(n.id)}><ChevronRight size={16} className={open ? 'expanded' : ''} aria-hidden="true" /></button><button type="button" className="notebook-node-select" aria-label={`选择步骤 ${n.name}`} aria-pressed={selected === n.id} onClick={() => select(n.id)}>
            <span className="step-number">{String(index + 1).padStart(2, '0')}</span><Icon size={18} aria-hidden="true" /><span className="step-text"><strong>{n.name}</strong><small>{NODE_KINDS[n.kind]} · 实体</small></span>{scene.root === n.id && <span className="output-tag">输出</span>}
          </button><ReferenceOutput id={n.id} type="body" name={n.name} onClick={() => select(n.id)} /></SortHeading>
          <div className="notebook-node-summary"><span className="step-status" data-state={issues[n.id] ? 'error' : nodeStates[n.id] || 'pending'}>{status}</span>{n.inputs.length > 0 && <span>{n.inputs.map(id => scene.nodes.find(input => input.id === id)?.name || '未连接').join(n.kind === 'difference' ? ' − ' : ' + ')}</span>}</div>
          <div id={`notebook-node-${n.id}`} hidden={!open}>{open && renderEditor(n)}</div>
        </li>;
      })}</ol>
      <details className="workflow-presets"><summary>示例工作流</summary>{[['sphere_hole', '球体减贯穿孔'], ['smooth', '双球平滑融合'], ['tpms_channel', '圆柱 TPMS 减流道']].map(([id, name]) => <button type="button" key={id} className="secondary full" disabled={!available || busy} onClick={() => loadPreset(id)}>{name}</button>)}</details>
      </div>
    </section>
    <section className="notebook-group notebook-output" ref={element => { groupEntries.current.output = element; }}>
      {groupHeading('output', '最终输出', `${scene.nodes.length ? used.size : 0} 个依赖`)}
      <div id="notebook-group-output" hidden={!groups.output}><ReferenceInput target={{ kind: 'root' }} label="最终输出"><Choice label="输出节点" value={scene.root} options={scene.nodes.length ? scene.nodes.map(n => [n.id, n.name]) : [['', '先添加建模节点']]} onChange={v => onChange({ ...scene, root: v })} />{scene.nodes.find(n => n.id === scene.root) && <Reference id={scene.root} name={scene.nodes.find(n => n.id === scene.root).name} onClick={() => select(scene.root)} />}</ReferenceInput><Numeric label="输出网格尺寸" value={scene.cell_size} unit="mm" onChange={v => onChange({ ...scene, cell_size: v })} /><p className="hint">网格尺寸越小，细节越多；导出使用最终输出，中间预览不会替换它。</p>{cacheSummary && <p className="cache-summary" role="status">{cacheSummary}</p>}</div>
    </section>
  </div></WorkflowDrag></Navigate.Provider></Values.Provider>;
}
