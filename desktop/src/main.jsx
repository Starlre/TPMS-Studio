import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Layers3, FolderOpen, Save, Download, ChevronDown, Sun, Moon, RotateCcw, Scan, ZoomIn, ZoomOut, Plus, Trash2, Copy, Combine, CircleHelp, X, Check, LoaderCircle, Activity, Triangle, Grid3X3, Workflow } from 'lucide-react';
import Viewport from './Viewport';
import NodeWorkflow from './NodeWorkflow';
import { graphErrors, NODE_KINDS, affectedNodes } from './node_graph.mjs';
import './style.css';

const DEFAULT = { surface: 'Gyroid', mode: 'sheet', size_x: 40, size_y: 40, size_z: 40,
  cells_x: 2, cells_y: 2, cells_z: 2, thickness: 1.2, iso_level: 0, samples_per_cell: 64,
  target_porosity: null, formula: 'sin(x)*cos(y) + sin(y)*cos(z) + sin(z)*cos(x)',
  gradient_enabled: false, gradient_axis: 'Z', gradient_thickness_start: 1, gradient_thickness_end: 5,
  tubular_enabled: false, tubular_inner_radius: 10 };
const CFD = { flow_axis: 'X', element_size: 1.5, surface_samples_per_cell: 32,
  boundary_layer_enabled: false, boundary_layer_layers: 3, boundary_layer_first_height: 0.05, boundary_layer_growth: 1.2,
  end_refinement_enabled: true, end_refinement_distance: 2, end_refinement_size_factor: 0.5,
  curvature_refinement_enabled: true, curvature_points: 18, low_quality_threshold: 0.2 };
const KINDS = NODE_KINDS;
const DIMS = { sphere: [8], box: [16, 16, 16], cylinder: [6, 24], torus: [10, 3], tpms: [] };
const LABELS = { sphere: ['半径'], box: ['X 长度', 'Y 长度', 'Z 长度'], cylinder: ['半径', '高度'], torus: ['主半径', '管半径'] };
const emptyScene = () => ({ version: 1, nodes: [], root: '', cell_size: 0.6, parameters: {}, value_nodes: [] });
const format = (n, digits = 0) => Number(n ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: digits });

function Num({ label, value, onChange, unit, min, max, step = 0.1, disabled = false }) {
  const id = useId();
  return <label className="field" htmlFor={id}><span>{label}</span><div className="input-wrap"><input id={id} type="number" aria-label={label} aria-description={unit ? `单位 ${unit}` : undefined} value={value} min={min} max={max} step={step} disabled={disabled} onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />{unit && <span className="unit" aria-hidden="true">{unit}</span>}</div></label>;
}
function Select({ label, value, onChange, options, disabled }) {
  const id = useId();
  return <label className="field" htmlFor={id}><span>{label}</span><select id={id} aria-label={label} value={value} disabled={disabled} onChange={e => onChange(e.target.value)}>{options.map(option => { const [val, text] = Array.isArray(option) ? option : [option, option]; return <option key={val} value={val}>{text}</option>; })}</select></label>;
}
function Toggle({ label, value, onChange, disabled }) {
  return <label className="toggle"><input type="checkbox" checked={value} disabled={disabled} onChange={e => onChange(e.target.checked)} /><span>{label}</span></label>;
}
function Section({ title, children, hint }) {
  return <section className="section"><h3>{title}</h3>{children}{hint && <p className="hint">{hint}</p>}</section>;
}
function Tool({ icon: Icon, children, onClick, disabled, title, active }) {
  return <button type="button" className={`tool ${active ? 'active' : ''}`} onClick={onClick} disabled={disabled} title={title}>{Icon && <Icon size={18} aria-hidden="true" />}{children}</button>;
}

function App() {
  const [mode, setMode] = useState('tpms');
  const [tab, setTab] = useState('geometry');
  const [p, setP] = useState(DEFAULT);
  const [cfd, setCfd] = useState(CFD);
  const [scene, setScene] = useState(emptyScene);
  const sceneHistory = useRef({ undo: [], redo: [] });
  const [selected, setSelected] = useState('');
  const [editorHost, setEditorHost] = useState(null);
  const [inspectorTab, setInspectorTab] = useState('properties');
  const [kind, setKind] = useState('sphere');
  const [operation, setOperation] = useState('difference');
  const [a, setA] = useState(''); const [b, setB] = useState(''); const [blend, setBlend] = useState(2);
  const [kernel, setKernel] = useState('mesh'); const [cell, setCell] = useState(0.4);
  const [info, setInfo] = useState(null);
  const [busy, setBusy] = useState(false); const busyRef = useRef(false);
  const [message, setMessage] = useState('正在连接本地建模内核…');
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [previewResult, setPreviewResult] = useState(null);
  const [nodeStates, setNodeStates] = useState({});
  const [valueOutputs, setValueOutputs] = useState({});
  const [cacheSummary, setCacheSummary] = useState('');
  const [autoUpdate, setAutoUpdate] = useState(false);
  const autoAttempt = useRef('');
  const [displayGeometry, setDisplayGeometry] = useState(null);
  const [display, setDisplay] = useState('model');
  const [quality, setQuality] = useState(null); const [qualityDialog, setQualityDialog] = useState(false);
  const [help, setHelp] = useState(false);
  const [theme, setTheme] = useState(localStorage.getItem('tpms-theme') || 'dark');
  const [implicit, setImplicit] = useState(true); const [wireframe, setWireframe] = useState(false);
  const [renderer, setRenderer] = useState('网格预览');
  const [exportQuality, setExportQuality] = useState('original');
  const [targetFaces, setTargetFaces] = useState(100000);
  const [exportCell, setExportCell] = useState(0.3);
  const [dirty, setDirty] = useState(false);
  const viewport = useRef(); const exportMenu = useRef(); const dialogRef = useRef();
  const initialised = useRef(false);

  useEffect(() => {
    const unsubscribe = window.tpms.onProgress(event => {
      // IPC progress may arrive after a cached request has already completed.
      if (!busyRef.current) return;
      if (typeof event === 'string') setMessage(event);
      else { setMessage(event.message); if (event.node_id) setNodeStates(old => ({ ...old, [event.node_id]: event.state })); }
    });
    if (!initialised.current) {
      initialised.current = true;
      window.tpms.request('init').then(setInfo).catch(e => { setError(e.message); setMessage('内核连接失败'); });
    }
    return unsubscribe;
  }, []);
  useEffect(() => {
    document.documentElement.dataset.theme = theme; localStorage.setItem('tpms-theme', theme);
  }, [theme]);
  useEffect(() => {
    if (qualityDialog || help) dialogRef.current?.showModal(); else dialogRef.current?.close();
  }, [qualityDialog, help]);
  async function run(method, payload = {}) {
    if (busyRef.current) return null;
    busyRef.current = true; setBusy(true); setError(''); setMessage('正在处理…');
    try { return await window.tpms.request(method, payload); }
    catch (e) { setError(e.message.replace(/^Error invoking remote method '[^']+': Error: /, '')); setMessage('操作未完成，请检查设置'); return null; }
    finally { busyRef.current = false; setBusy(false); }
  }
  function invalidate() {
    setDirty(true); setQuality(null); setPreviewResult(null);
    if (previewResult) { setDisplayGeometry(result?.geometry || null); setDisplay('model'); }
  }
  function markChanges(next) {
    const affected = affectedNodes(scene, next);
    setNodeStates(old => Object.fromEntries(next.nodes.map(n => [n.id, affected.has(n.id) ? 'pending' : old[n.id] || 'pending'])));
    setValueOutputs({}); setCacheSummary('');
  }
  function update(key, value) {
    setP(old => {
      const next = { ...old, [key]: value };
      if (key === 'gradient_enabled' && value) next.target_porosity = null;
      if (key === 'target_porosity' && value !== null) next.gradient_enabled = false;
      if (key === 'mode' && value === 'solid') next.gradient_enabled = false;
      return next;
    }); invalidate();
  }
  function updateScene(next) {
    sceneHistory.current.undo = [...sceneHistory.current.undo, structuredClone(scene)].slice(-50);
    sceneHistory.current.redo = [];
    markChanges(next); setScene(next); setError(''); invalidate();
  }
  function travelHistory(direction) {
    const history = sceneHistory.current;
    if (!history[direction].length || busyRef.current) return;
    history[direction === 'undo' ? 'redo' : 'undo'].push(structuredClone(scene));
    const next = history[direction].pop();
    const stillSelected = next.nodes.some(n => n.id === selected) || (next.value_nodes || []).some(b => `value:${b.id}` === selected);
    markChanges(next); setScene(next); setSelected(stillSelected ? selected : next.root); setInspectorTab('properties'); setError(''); invalidate();
  }
  function updateNode(patch) { updateScene({ ...scene, nodes: scene.nodes.map(n => n.id === selected ? { ...n, ...patch } : n) }); }
  function switchMode(next) { setMode(next); if (next === 'nodes') setInspectorTab('properties'); invalidate(); }
  const canModel = !!result && !dirty && !busy;
  const canCFD = canModel && result.mode === 'tpms';
  const workflowErrors = mode === 'tpms' ? {} : graphErrors(scene);
  const invalidWorkflow = Object.keys(workflowErrors).length > 0;
  function acceptWorkflow(r) {
    if (!r.workflow) return;
    setNodeStates(old => ({ ...old, ...r.workflow.states })); setValueOutputs(r.workflow.values);
    setCacheSummary(r.workflow.mesh_cached ? '输出网格缓存命中，无需重新提取网格' : `更新 ${r.workflow.rebuilt.length} 个数学场 · 复用 ${r.workflow.reused.length} 个数学场`);
  }
  async function generate() {
    if (busyRef.current) return;
    autoAttempt.current = JSON.stringify(scene);
    if (mode !== 'tpms' && invalidWorkflow) { setError('节点输入有误，请检查功能卡片中的上游引用。'); return; }
    const r = await run(mode === 'tpms' ? 'generate_tpms' : 'generate_solid', mode === 'tpms' ? { parameters: p, kernel, cell_size: cell } : { scene });
    if (r) { acceptWorkflow(r); setPreviewResult(null); setResult(r); setDisplayGeometry(r.geometry); setDisplay('model'); setDirty(false); setQuality(null);
      setMessage(`模型已生成 · ${format(r.stats.faces)} 个三角面 · ${r.stats.watertight ? '封闭曲面' : '非封闭曲面'}`); }
  }
  async function previewNode(id) {
    const r = await run('preview_node', { scene, node_id: id });
    if (r) { acceptWorkflow(r); setInspectorTab('model'); setPreviewResult({ ...r, node_id: id, name: scene.nodes.find(n => n.id === id)?.name }); setDisplayGeometry(r.geometry); setDisplay('model'); setMessage('中间节点预览已更新，导出仍使用最终输出'); }
  }
  function returnOutput() { setPreviewResult(null); setDisplayGeometry(result?.geometry || null); setDisplay('model'); }
  async function evaluateValues() {
    const r = await run('evaluate_values', { scene });
    if (r) { setValueOutputs(r.values); setMessage('参数值计算完成'); }
  }
  const sceneSignature = JSON.stringify(scene);
  useEffect(() => {
    if (!autoUpdate || mode !== 'nodes' || !info?.libfive || !dirty || busy || !scene.nodes.length || invalidWorkflow || autoAttempt.current === sceneSignature) return;
    const timer = setTimeout(() => generate(), 900);
    return () => clearTimeout(timer);
  }, [autoUpdate, mode, info, dirty, busy, invalidWorkflow, sceneSignature]);
  async function cancel() {
    autoAttempt.current = sceneSignature;
    await window.tpms.request('cancel'); setPreviewResult(null); setNodeStates({}); setCacheSummary(''); setValueOutputs({}); setResult(null); setDisplayGeometry(null); setQuality(null); setDirty(true); setMessage('已取消计算，请重新生成');
  }
  useEffect(() => {
    if (info && !result && !dirty && !busy && info.python) generate();
    // Generate once after connecting; subsequent edits require explicit generation.
  }, [info]);
  const node = scene.nodes.find(n => n.id === selected);
  function addNode() {
    if (scene.nodes.length >= 64) { setError('最多支持 64 个对象'); return; }
    let i = 1; while (scene.nodes.some(n => n.id === `n${i}`)) i++;
    const n = { id: `n${i}`, kind, name: `${KINDS[kind]} ${i}`, dimensions: DIMS[kind], position: [0, 0, 0], rotation: [0, 0, 0], inputs: [], blend: 2, tpms: kind === 'tpms' ? { ...p } : null };
    updateScene({ ...scene, nodes: [...scene.nodes, n], root: n.id }); setSelected(n.id); setA(a || n.id); setB(n.id);
  }
  function combine() {
    if (!a || !b || a === b || !scene.nodes.some(n => n.id === a) || !scene.nodes.some(n => n.id === b)) { setError('请选择两个不同的建模对象 A 和 B'); return; }
    if (scene.nodes.length >= 64) { setError('最多支持 64 个对象'); return; }
    let i = 1; while (scene.nodes.some(n => n.id === `n${i}`)) i++;
    const n = { id: `n${i}`, kind: operation, name: `${KINDS[operation]} ${i}`, dimensions: [8], position: [0, 0, 0], rotation: [0, 0, 0], inputs: [a, b], blend, tpms: null };
    updateScene({ ...scene, nodes: [...scene.nodes, n], root: n.id }); setSelected(n.id); setA(n.id);
  }
  function removeNode() {
    const dependents = scene.nodes.filter(n => n.inputs.includes(selected));
    if (dependents.length) { setError(`对象被 ${dependents.map(n => n.name).join('、')} 引用，请先删除对应组合。`); return; }
    const nodes = scene.nodes.filter(n => n.id !== selected);
    updateScene({ ...scene, nodes, root: scene.root === selected ? (nodes.at(-1)?.id || '') : scene.root });
    setSelected(nodes.at(-1)?.id || ''); setA(''); setB('');
  }
  function duplicateNode() {
    if (!node || scene.nodes.length >= 64) return;
    let i = 1; while (scene.nodes.some(n => n.id === `n${i}`)) i++;
    const copy = { ...structuredClone(node), id: `n${i}`, name: `${node.name} 副本` };
    updateScene({ ...scene, nodes: [...scene.nodes, copy], root: copy.id }); setSelected(copy.id);
  }
  async function preset(value) {
    if (scene.nodes.length && !window.confirm('加载示例将替换当前对象列表。请先保存需要保留的项目。')) return;
    const r = await run('preset', { kind: value });
    if (r) { updateScene(r.scene); setSelected(r.scene.root); setInspectorTab('properties'); setA(r.scene.nodes[0].id); setB(r.scene.nodes[1].id); setMessage(mode === 'nodes' ? '工作流已加载，点击生成工作流查看' : '示例已加载，点击生成实体查看'); }
  }
  async function saveProject() {
    const r = await run('save_project', { project: { type: 'tpms-electron', version: 1, mode, parameters: p, scene, cfd } });
    if (r && !r.canceled) setMessage(`项目已保存：${r.path}`);
  }
  async function openProject() {
    const r = await run('open_project'); if (!r || r.canceled) return;
    setMode(r.project.mode); setP({ ...DEFAULT, ...r.project.parameters }); setCfd({ ...CFD, ...r.project.cfd });
    sceneHistory.current = { undo: [], redo: [] };
    setNodeStates({}); setValueOutputs({}); setCacheSummary(''); autoAttempt.current = '';
    setScene(r.project.scene || emptyScene()); setSelected(r.project.scene?.root || ''); setInspectorTab('properties'); invalidate();
    setMessage('项目已打开，点击生成模型更新预览');
  }
  async function exportModel() {
    exportMenu.current.open = false;
    const r = await run('export', { quality: exportQuality, target_faces: exportQuality === 'custom' ? targetFaces : undefined, cell_size: exportCell });
    if (r && !r.canceled) setMessage(`已导出 ${format(r.faces)} 面 · ${r.message} · ${r.watertight ? '封闭' : '非封闭，请检查'} · ${r.path}`);
  }
  async function showRegion() {
    if (display === 'region') { setDisplay('model'); setDisplayGeometry(result.geometry); return; }
    const r = await run('region', { options: cfd });
    if (r) { setDisplay('region'); setDisplayGeometry(r.geometry); setMessage('仿真区域：入口 101 / 出口 102 / 壁面 103'); }
  }
  async function inspectQuality(exportFiles = false) {
    if (quality && !exportFiles) { setQualityDialog(true); return; }
    const r = await run(exportFiles ? 'cfd' : 'quality', { options: cfd });
    if (r && !r.canceled) { setQuality(r); setQualityDialog(true); setMessage(exportFiles ? `COMSOL 网格已导出：${r.paths[0]}` : '体网格质量分析完成'); }
  }
  async function lowQuality() {
    if (display === 'low') { setDisplay('model'); setDisplayGeometry(result.geometry); return; }
    const r = await run('low_quality'); if (r) { setDisplay('low'); setDisplayGeometry(r.geometry); setMessage(`低质量单元：${format(quality.quality.low_quality_elements)}`); }
  }
  useEffect(() => {
    const keyboard = event => {
      const editing = event.target instanceof HTMLElement && (event.target.matches('input,textarea,select') || event.target.isContentEditable);
      if (mode === 'nodes' && !editing && (event.ctrlKey || event.metaKey) && ['z', 'y'].includes(event.key.toLowerCase())) {
        event.preventDefault(); travelHistory(event.shiftKey || event.key.toLowerCase() === 'y' ? 'redo' : 'undo');
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'o') {
        event.preventDefault(); if (!busy) openProject();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
        event.preventDefault(); if (!busy) { if (event.shiftKey && canModel) exportModel(); else if (!event.shiftKey) saveProject(); }
      } else if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault(); if (!busy && info && (mode === 'tpms' || (info.libfive && scene.nodes.length))) generate();
      }
    };
    window.addEventListener('keydown', keyboard);
    return () => window.removeEventListener('keydown', keyboard);
  });
  function changeCfd(key, value) { setCfd(old => ({ ...old, [key]: value })); setQuality(null); if (result) { setDisplay('model'); setDisplayGeometry(result.geometry); } }
  const pv = (key, label, props = {}) => <Num label={label} value={p[key]} onChange={v => update(key, v)} {...props} />;
  const cv = (key, label, props = {}) => <Num label={label} value={cfd[key]} onChange={v => changeCfd(key, v)} {...props} />;
  const objects = scene.nodes.map(n => [n.id, n.name]);
  const activeResult = previewResult || result;

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><Box size={27} aria-hidden="true" /><div><strong>TPMS <span>Studio</span></strong><small>隐式建模工作台</small></div></div>
      <nav className="mode-switch" aria-label="建模工作区"><button className={mode === 'tpms' ? 'selected' : ''} aria-pressed={mode === 'tpms'} disabled={busy} onClick={() => switchMode('tpms')}><Layers3 size={19} aria-hidden="true" />TPMS 建模</button><button className={mode === 'solid' ? 'selected' : ''} aria-pressed={mode === 'solid'} disabled={busy} onClick={() => switchMode('solid')}><Combine size={19} aria-hidden="true" />实体组合</button><button className={mode === 'nodes' ? 'selected' : ''} aria-pressed={mode === 'nodes'} disabled={busy} onClick={() => switchMode('nodes')}><Workflow size={19} aria-hidden="true" />节点建模</button></nav>
      <div className="file-actions"><Tool icon={FolderOpen} disabled={busy} onClick={openProject}>打开</Tool><Tool icon={Save} disabled={busy} onClick={saveProject}>保存项目</Tool>
        <details className="export-menu" ref={exportMenu}><summary aria-label="展开导出设置"><Download size={18} aria-hidden="true" />导出<ChevronDown size={15} aria-hidden="true" /></summary><div className="dropdown"><h3>表面模型导出</h3><Select label="导出质量 / 面数" value={exportQuality} onChange={setExportQuality} options={[
          ['original', '原始精度'], ['high', '高质量 · 约 70% 面数'], ['medium', '标准 · 约 40% 面数'], ['low', '轻量 · 约 20% 面数'], ['custom', '自定义目标面数'], ...(info?.libfive && result?.mode === 'tpms' && !result?.parameters?.tubular_enabled ? [['libfive', 'libfive · 重算网格精度']] : [])]} />
          {exportQuality === 'custom' && <Num label="目标三角面数" value={targetFaces} onChange={setTargetFaces} min={1} max={result?.stats.faces} step={1000} />}
          {exportQuality === 'libfive' && <Num label="网格尺寸" value={exportCell} onChange={setExportCell} min={0.001} step={0.05} unit="mm" />}
          <p className="hint">导出使用已生成模型。简化后的实际面数与封闭性会显示在状态栏。</p><button className="primary" disabled={!canModel} onClick={exportModel}><Download size={18} aria-hidden="true" />导出 STL / OBJ / PLY</button><button className="secondary" disabled={!canCFD} onClick={() => { exportMenu.current.open = false; inspectQuality(true); }}>导出 COMSOL 体网格</button></div></details>
        <button className="icon-button" aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'} title="切换明暗主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}</button><button className="icon-button" aria-label="操作说明" onClick={() => setHelp(true)}><CircleHelp size={20} /></button>
      </div>
    </header>
    <div className={`workspace ${mode === 'nodes' ? 'node-workspace' : ''}`}>
      <aside className="parameters" aria-label="建模参数">
        <div className="panel-heading"><div><small>{mode === 'nodes' ? '工作流' : '设计输入'}</small><h2>{mode === 'tpms' ? 'TPMS 参数' : mode === 'nodes' ? '节点建模' : '实体与组合'}</h2></div><span className="badge">{mode !== 'tpms' ? 'libfive' : 'mm'}</span></div>
        {mode === 'tpms' && <nav className="panel-tabs" aria-label="参数类别">{[['geometry', '几何'], ['structure', '结构'], ['cfd', 'CFD 网格']].map(([value, label]) => <button key={value} aria-pressed={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{label}</button>)}</nav>}
        <div className="panel-scroll" key={mode}><fieldset disabled={busy}>
        {mode === 'nodes' && <NodeWorkflow scene={scene} onChange={updateScene} currentParameters={p} selected={selected} onSelect={setSelected} dirty={dirty} hasResult={!!result && result.mode === 'solid'} busy={busy} available={!!info?.libfive} error={error} reportError={setError} undo={() => travelHistory('undo')} redo={() => travelHistory('redo')} canUndo={sceneHistory.current.undo.length > 0} canRedo={sceneHistory.current.redo.length > 0} loadPreset={preset} nodeStates={nodeStates} valueOutputs={valueOutputs} previewNode={previewNode} evaluateValues={evaluateValues} cacheSummary={cacheSummary} editorHost={editorHost} showProperties={() => setInspectorTab('properties')} />}
        {mode === 'tpms' && tab === 'geometry' && <>
          <Section title="曲面定义"><Select label="曲面类型" value={p.surface} onChange={v => update('surface', v)} options={['Gyroid', 'Diamond', 'Primitive', 'I-WP', 'Neovius', ['Custom', '自定义公式']]} />
            {p.surface === 'Custom' && <label className="field"><span>隐式函数 f(x,y,z)</span><textarea aria-label="隐式函数 f(x,y,z)" value={p.formula} onChange={e => update('formula', e.target.value)} rows={5} spellCheck={false} /><span className="hint">x/y/z 为 mm 坐标。可用 sin、cos、sqrt、abs、min、max 和 gyroid、diamond、primitive、i_wp、neovius；片层取 f=0 附近。</span></label>}
            {p.surface !== 'Custom' && <div className="formula-display">{({ Gyroid: 'sin(x)cos(y) + sin(y)cos(z) + sin(z)cos(x)', Diamond: 'sin(x)sin(y)sin(z) + sin(x)cos(y)cos(z) + cos(x)sin(y)cos(z) + cos(x)cos(y)sin(z)', Primitive: 'cos(x) + cos(y) + cos(z)', 'I-WP': '2(cx·cy + cy·cz + cz·cx) − cos(2x) − cos(2y) − cos(2z)', Neovius: '3(cx + cy + cz) + 4cx·cy·cz' })[p.surface]}<small>内置公式使用归一化周期坐标</small></div>}
          </Section>
          <Section title="外形尺寸"><div className="triple">{['x', 'y', 'z'].map(axis => <React.Fragment key={axis}>{pv(`size_${axis}`, axis.toUpperCase(), { unit: 'mm', min: 0.1, max: 2000, step: 1 })}</React.Fragment>)}</div></Section>
          {p.surface !== 'Custom' && <Section title="周期数量"><div className="triple">{['x', 'y', 'z'].map(axis => <React.Fragment key={axis}>{pv(`cells_${axis}`, axis.toUpperCase(), { min: 1, max: 32, step: 1 })}</React.Fragment>)}</div><p className="hint">每周期尺寸：{format(p.size_x / p.cells_x, 2)} × {format(p.size_y / p.cells_y, 2)} × {format(p.size_z / p.cells_z, 2)} mm</p></Section>}
          <Section title="管状卷绕"><Toggle label="将 TPMS 卷绕为圆环管" value={p.tubular_enabled} onChange={v => { update('tubular_enabled', v); if (v) { setKernel('mesh'); changeCfd('flow_axis', 'Z'); } }} />{p.tubular_enabled && pv('tubular_inner_radius', '内半径', { unit: 'mm', min: 0.1 })}</Section>
        </>}
        {mode === 'tpms' && tab === 'structure' && <>
          <Section title="结构定义"><Select label="结构模式" value={p.mode} onChange={v => update('mode', v)} options={[['sheet', '片层结构'], ['solid', '实体结构']]} />{p.mode === 'sheet' ? pv('thickness', '壁厚', { unit: 'mm', min: 0.01, max: 20, disabled: p.target_porosity !== null || p.gradient_enabled }) : pv('iso_level', '等值面偏移', { disabled: p.target_porosity !== null })}</Section>
          <Section title="孔隙率控制"><Toggle label="按目标孔隙率反求参数" value={p.target_porosity !== null} onChange={v => update('target_porosity', v ? 0.7 : null)} />{p.target_porosity !== null && <Num label="目标孔隙率" value={Number((p.target_porosity * 100).toFixed(2))} onChange={v => update('target_porosity', v / 100)} min={1} max={99} step={1} unit="%" />}<p className="hint">使用现有孔隙率求解器；生成后在右侧查看实际值。</p></Section>
          <Section title="梯度壁厚"><Toggle label="沿单轴线性渐变" value={p.gradient_enabled} disabled={p.mode !== 'sheet'} onChange={v => update('gradient_enabled', v)} />{p.gradient_enabled && <><Select label="梯度方向" value={p.gradient_axis} onChange={v => update('gradient_axis', v)} options={['X', 'Y', 'Z']} /><div className="double">{pv('gradient_thickness_start', '起始壁厚', { unit: 'mm', min: 0.01, max: 20 })}{pv('gradient_thickness_end', '结束壁厚', { unit: 'mm', min: 0.01, max: 20 })}</div></>}</Section>
          <Section title="生成精度"><Select label="建模内核" value={kernel} onChange={v => { setKernel(v); invalidate(); }} options={[[ 'mesh', '连续场 · Marching Cubes' ], ...(info?.libfive && !p.tubular_enabled ? [['libfive', 'libfive · Dual Contouring']] : [])]} />{pv('samples_per_cell', '每周期采样数', { min: 8, max: 128, step: 8 })}{kernel === 'libfive' && <Num label="libfive 网格尺寸" value={cell} onChange={v => { setCell(v); invalidate(); }} min={0.001} step={0.05} unit="mm" />}<p className="hint">精度控制计算曲面；预览独立使用 GPU 渲染。</p></Section>
        </>}
        {mode === 'tpms' && tab === 'cfd' && <>
          <Section title="流体体网格"><Select label="流动方向" value={cfd.flow_axis} onChange={v => changeCfd('flow_axis', v)} options={p.tubular_enabled ? ['Z'] : ['X', 'Y', 'Z']} />{cv('element_size', '体单元尺寸', { unit: 'mm', min: 0.01 })}{cv('surface_samples_per_cell', '流体表面采样数', { min: 16, max: 96, step: 8 })}</Section>
          <Section title="棱柱边界层"><Toggle label="生成棱柱边界层" value={cfd.boundary_layer_enabled} onChange={v => changeCfd('boundary_layer_enabled', v)} />{cfd.boundary_layer_enabled && <>{cv('boundary_layer_layers', '层数', { min: 1, max: 12, step: 1 })}{cv('boundary_layer_first_height', '首层高度', { unit: 'mm', min: 0.001, step: 0.01 })}{cv('boundary_layer_growth', '增长率', { min: 1, max: 2, step: 0.1 })}</>}</Section>
          <Section title="局部加密"><Toggle label="入口 / 出口局部加密" value={cfd.end_refinement_enabled} onChange={v => changeCfd('end_refinement_enabled', v)} />{cfd.end_refinement_enabled && <>{cv('end_refinement_distance', '加密距离', { unit: 'mm', min: 0.01 })}{cv('end_refinement_size_factor', '尺寸系数', { min: 0.1, max: 1 })}</>}<Toggle label="曲率自适应" value={cfd.curvature_refinement_enabled} onChange={v => changeCfd('curvature_refinement_enabled', v)} />{cfd.curvature_refinement_enabled && cv('curvature_points', '曲率采样点', { min: 6, max: 60, step: 1 })}</Section>
          <Section title="质量判定">{cv('low_quality_threshold', '低质量阈值', { min: 0.01, max: 0.9, step: 0.01 })}<p className="hint">缩放雅可比用于筛选低质量单元。导出 MSH、BDF、边界 JSON 和 VTU；物理场需在 COMSOL 中设置。</p></Section>
        </>}
        {mode === 'solid' && <>
          <Section title="添加实体"><div className="add-row"><select aria-label="新建实体类型" value={kind} onChange={e => setKind(e.target.value)}>{Object.keys(DIMS).map(k => <option key={k} value={k}>{KINDS[k]}</option>)}</select><button className="secondary" disabled={!info?.libfive} onClick={addNode}><Plus size={18} aria-hidden="true" />添加</button></div><p className="hint">添加 TPMS 时复制当前 TPMS 参数。实体组合使用 libfive。</p></Section>
          <Section title={`对象树 · ${scene.nodes.length}`}><div className="object-tree">{scene.nodes.length === 0 && <p className="hint">添加基本体或加载下面的建模示例。</p>}{scene.nodes.map(n => <button key={n.id} className={selected === n.id ? 'selected' : ''} aria-pressed={selected === n.id} onClick={() => setSelected(n.id)}><span className="node-icon">{n.inputs.length ? <Combine size={17} /> : <Box size={17} />}</span><span>{n.name}<small>{n.inputs.length ? n.inputs.join(' → ') : KINDS[n.kind]}</small></span>{scene.root === n.id && <span className="output-tag">输出</span>}</button>)}</div>{node && <div className="node-actions"><button className="secondary" onClick={duplicateNode} disabled={scene.nodes.length >= 64}><Copy size={15} aria-hidden="true" />复制对象</button><button className="text-danger" onClick={removeNode}><Trash2 size={15} aria-hidden="true" />删除选中对象</button></div>}</Section>
          {node && <Section title="对象属性">{(Object.keys(node.expressions || {}).length > 0 || Object.keys(node.vector_inputs || {}).length > 0) && <><p className="hint">此对象含参数引用，请在节点属性中编辑。</p><button className="secondary full" onClick={() => switchMode('nodes')}>进入节点属性编辑</button></>}<fieldset disabled={Object.keys(node.expressions || {}).length > 0 || Object.keys(node.vector_inputs || {}).length > 0}><label className="field"><span>名称</span><input value={node.name} onChange={e => updateNode({ name: e.target.value })} /></label>{LABELS[node.kind]?.map((label, i) => <Num key={`${node.id}-${i}`} label={label} value={node.dimensions[i]} min={0.01} max={2000} unit="mm" onChange={v => updateNode({ dimensions: node.dimensions.map((d, j) => i === j ? v : d) })} />)}
            {node.kind === 'tpms' && <><p className="hint">{node.tpms?.surface} · {node.tpms?.size_x} × {node.tpms?.size_y} × {node.tpms?.size_z} mm</p><button className="secondary" onClick={() => updateNode({ tpms: { ...p } })}>使用当前 TPMS 参数</button></>}
            {node.kind === 'smooth_union' && <Num label="融合宽度" value={node.blend} unit="mm" min={0.001} onChange={v => updateNode({ blend: v })} />}
            <h4>位置 / mm</h4><div className="triple">{['X', 'Y', 'Z'].map((label, i) => <Num key={label} label={label} value={node.position[i]} step={1} onChange={v => updateNode({ position: node.position.map((d, j) => i === j ? v : d) })} />)}</div><h4>旋转 / °</h4><div className="triple">{['X', 'Y', 'Z'].map((label, i) => <Num key={label} label={label} value={node.rotation[i]} step={5} onChange={v => updateNode({ rotation: node.rotation.map((d, j) => i === j ? v : d) })} />)}</div>
          </fieldset></Section>}
          <Section title="布尔与融合"><Select label="运算" value={operation} onChange={setOperation} options={['union', 'intersection', 'difference', 'smooth_union'].map(k => [k, KINDS[k]])} /><Select label="对象 A" value={a} onChange={setA} options={[['', '请选择'], ...objects]} /><Select label="对象 B" value={b} onChange={setB} options={[['', '请选择'], ...objects]} />{operation === 'smooth_union' && <Num label="融合宽度" value={blend} onChange={setBlend} min={0.001} max={100} unit="mm" />}<button className="secondary full" onClick={combine} disabled={scene.nodes.length < 2}><Combine size={18} aria-hidden="true" />创建组合</button><p className="hint">差集保留 A 并减去 B。平滑融合仅支持基本实体。</p></Section>
          <Section title="输出与精度"><Select label="最终输出对象" value={scene.root} onChange={v => updateScene({ ...scene, root: v })} options={objects.length ? objects : [['', '请添加对象']]} /><Num label="网格尺寸" value={scene.cell_size} onChange={v => updateScene({ ...scene, cell_size: v })} unit="mm" min={0.001} step={0.1} /></Section>
          <Section title="建模示例"><div className="presets">{[['sphere_hole', '球体减贯穿孔'], ['smooth', '双球平滑融合'], ['tpms_channel', '圆柱 TPMS 减流道']].map(([value, label]) => <button key={value} className="secondary" disabled={!info?.libfive} onClick={() => preset(value)}>{label}</button>)}</div></Section>
        </>}
        </fieldset></div>
        <div className="generate-footer">{mode === 'nodes' && <><div className="footer-output"><span>最终输出</span><strong>{scene.nodes.find(n => n.id === scene.root)?.name || '未设置'}</strong></div><Toggle label="自动更新输出" value={autoUpdate} disabled={busy} onChange={setAutoUpdate} /></>}<p className="hint">{busy ? '计算中，视口仍可操作' : invalidWorkflow ? '步骤输入有误，请检查上游引用' : dirty ? '参数已修改，生成后更新模型' : mode === 'nodes' ? '选择步骤，在右侧编辑属性' : mode === 'solid' ? '数学函数组合 → 封闭实体曲面' : '参数定义 → 隐式场 → 封闭模型'}</p><button className="primary generate" disabled={!info || busy || (mode !== 'tpms' && (!info.libfive || !scene.nodes.length || invalidWorkflow))} onClick={generate}>{busy ? <LoaderCircle size={20} className="spin" aria-hidden="true" /> : <Layers3 size={20} aria-hidden="true" />}{busy ? '正在计算…' : mode === 'tpms' ? '生成模型' : mode === 'nodes' ? '生成工作流' : '生成实体'}</button>{busy && <button className="cancel" onClick={cancel}>取消计算</button>}</div>
      </aside>
      <main className="model-area" aria-label="三维模型预览">
        <div className="viewport-toolbar"><div className="viewport-title"><span>三维视图</span><small>{display === 'region' ? '仿真边界' : display === 'low' ? '低质量单元' : renderer}</small></div>{mode === 'nodes' ? <span className="viewport-context">{previewResult ? `预览：${previewResult.name}` : result?.mode === 'solid' ? '最终输出' : '等待生成工作流'}</span> : <div className="viewport-actions"><Tool icon={Activity} disabled={!canCFD} title={!canCFD ? '生成 TPMS 模型后可使用' : '计算体单元质量'} onClick={() => inspectQuality()}>网格质量</Tool><Tool icon={Scan} disabled={!canCFD} active={display === 'region'} onClick={showRegion}>仿真区域</Tool><Tool icon={Triangle} disabled={!canCFD || !quality} title={!quality ? '先计算网格质量' : '定位低质量单元'} active={display === 'low'} onClick={lowQuality}>低质量</Tool></div>}</div>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={18} /></button></div>}
        <div className="viewport"><Viewport ref={viewport} geometry={displayGeometry} parameters={display === 'model' ? activeResult?.parameters : null} shader={info?.shader} theme={theme} implicit={implicit} wireframe={wireframe} onError={setError} onRenderer={setRenderer} />
          {!displayGeometry && !busy && <div className="empty"><Box size={48} strokeWidth={1} aria-hidden="true" /><h2>从参数定义你的模型</h2><p>设置左侧参数，点击“生成模型”开始。</p></div>}
          <div className="view-tools"><button title="等轴测 / 重置视角" aria-label="重置视角" onClick={() => viewport.current?.fit()}><RotateCcw size={19} /></button>{['X', 'Y', 'Z'].map(axis => <button key={axis} aria-label={`${axis} 轴正交方向观察`} onClick={() => viewport.current?.view(axis)}>{axis}</button>)}<button aria-label="放大" onClick={() => viewport.current?.zoom(0.8)}><ZoomIn size={19} /></button><button aria-label="缩小" onClick={() => viewport.current?.zoom(1.25)}><ZoomOut size={19} /></button></div>
          {display === 'region' && <div className="legend"><span><i className="inlet" />入口 · 101</span><span><i className="outlet" />出口 · 102</span><span><i className="walls" />壁面 · 103</span></div>}
          {display === 'low' && <div className="legend">低质量单元：{format(quality?.quality.low_quality_elements)} · 阈值 {quality?.quality.low_quality_threshold}</div>}
          <div className="viewport-caption">左键旋转 · 右键平移 · 滚轮缩放</div>
          {previewResult && <div className="intermediate-note"><span>预览：{previewResult.name} · 导出使用最终输出</span><button type="button" className="secondary" disabled={busy} onClick={returnOutput}>返回最终输出</button></div>}
          {dirty && result && !previewResult && <div className="snapshot-note">当前显示上次生成的模型</div>}
        </div>
        <div className="view-options"><Toggle label="GPU 隐式曲面" value={implicit} disabled={display !== 'model' || !activeResult?.parameters || activeResult.parameters.surface === 'Custom' || activeResult.parameters.tubular_enabled} onChange={setImplicit} /><Toggle label="线框" value={wireframe} onChange={setWireframe} /><span>单位：mm</span></div>
      </main>
      <aside className="inspector" aria-label={mode === 'nodes' ? '属性与模型信息' : '模型信息'}>{mode === 'nodes' ? <nav className="inspector-tabs" aria-label="检查器类别">{[['properties', '节点属性'], ['model', '模型信息']].map(([id, name]) => <button type="button" key={id} aria-pressed={inspectorTab === id} className={inspectorTab === id ? 'selected' : ''} onClick={() => setInspectorTab(id)}>{name}</button>)}</nav> : <div className="panel-heading"><h2>模型信息</h2><Grid3X3 size={19} aria-hidden="true" /></div>}
        {mode === 'nodes' && <div className="property-host" ref={setEditorHost} hidden={inspectorTab !== 'properties'} />}
        <div className="inspector-scroll" hidden={mode === 'nodes' && inspectorTab !== 'model'}><div className="result-name"><Box size={28} aria-hidden="true" /><strong>{previewResult ? previewResult.name : activeResult?.mode === 'solid' ? '组合实体' : activeResult?.parameters?.surface || '待生成'}</strong><span>{previewResult ? '中间节点预览' : dirty ? '参数待更新' : activeResult ? '已生成' : '准备就绪'}</span></div>
        <section className="metrics"><h3>几何统计</h3>{[['三角面', format(activeResult?.stats.faces)], ['顶点', format(activeResult?.stats.vertices)], ['体积', `${format(activeResult?.stats.volume, 2)} mm³`], ['表面积', `${format(activeResult?.stats.area, 2)} mm²`], ['孔隙率', activeResult?.stats.porosity != null ? `${format(activeResult.stats.porosity * 100, 2)} %` : '—'], ['封闭性', activeResult ? activeResult.stats.watertight ? '封闭 / 水密' : '未封闭' : '—']].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{activeResult ? value : '—'}</strong></div>)}</section>
        {activeResult?.stats.bounds && <section className="metrics"><h3>世界坐标范围 / mm</h3>{['X', 'Y', 'Z'].map((axis, i) => <div className="metric" key={axis}><span>{axis}</span><strong>{format(activeResult.stats.bounds[0][i], 2)} ~ {format(activeResult.stats.bounds[1][i], 2)}</strong></div>)}</section>}
        <section className="kernel-info"><h3>建模内核</h3><div><span className={`connection ${info ? 'connected' : ''}`} /><span>Python {info ? '已连接' : '连接中'}</span></div><div><span className={`connection ${info?.libfive ? 'connected' : ''}`} /><span>libfive {info?.libfive ? '可用' : '不可用'}</span></div>{info && !info.libfive && <p className="hint">{info.detail}</p>}<p className="hint">完整计算模型用于导出。视口显示方式不会改变导出几何。</p></section>
        {quality && <section className="metrics"><h3>体网格摘要</h3><div className="metric"><span>体单元</span><strong>{format(quality.elements)}</strong></div><div className="metric"><span>最小雅可比</span><strong>{format(quality.quality.minimum, 4)}</strong></div><button className="secondary full" onClick={() => setQualityDialog(true)}>查看质量报告</button></section>}
      </div></aside>
    </div>
    <footer className="statusbar"><span className={busy ? 'processing' : ''}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</span><span role="status" aria-live="polite">{message}</span><span className="status-right">{renderer} · 本地计算</span></footer>
    <dialog ref={dialogRef} className="modal" onCancel={() => { setHelp(false); setQualityDialog(false); }}><div className="modal-header"><h2>{help ? '操作说明' : '体网格质量报告'}</h2><button className="icon-button" aria-label="关闭对话框" onClick={() => { setHelp(false); setQualityDialog(false); }}><X size={20} /></button></div>
      {help ? <div className="help-copy"><h3>TPMS 建模</h3><p>在几何和结构页设置尺寸、周期、壁厚或孔隙率，然后生成模型。自定义公式支持安全数学表达式；公式变量 x/y/z 使用 mm 坐标。</p><h3>实体组合</h3><p>添加球、盒、圆柱、圆环或 TPMS。设置位置与旋转，选择 A/B 创建并集、交集或差集，指定最终输出对象后生成实体。</p><h3>预览与导出</h3><p>内置曲面可使用 GPU 隐式预览；公式、管状 TPMS 和实体组合使用网格预览。顶部导出菜单控制导出质量与目标面数。</p><h3>CFD</h3><p>先生成 TPMS，再计算网格质量或显示仿真区域。COMSOL 导出包含 MSH/BDF、边界 JSON、质量 VTU。组合实体暂不支持 CFD。</p><h3>保存项目</h3><p>项目 JSON 保存 TPMS 参数、实体对象、组合关系和 CFD 设置。原 Qt 实体组合项目也可打开。</p></div> : quality && <><p className="hint">质量指标：{quality.quality.metric} · {format(quality.nodes)} 节点 · {format(quality.elements)} 体单元</p><div className="quality-summary">{[['最小值', quality.quality.minimum], ['5% 分位', quality.quality.percentile_05], ['中位数', quality.quality.median], ['平均值', quality.quality.mean], ['最大值', quality.quality.maximum], ['低质量单元', quality.quality.low_quality_elements]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{format(value, 4)}</strong></div>)}</div><h3>缩放雅可比分布</h3><div className="histogram" aria-label="质量直方图">{quality.quality.histogram_counts.map((count, i, counts) => <div key={i} title={`${quality.quality.histogram_edges[i].toFixed(2)} ~ ${quality.quality.histogram_edges[i + 1].toFixed(2)}：${count} 单元`}><i style={{ height: `${Math.max(1, count / Math.max(1, ...counts) * 130)}px` }} /><span>{quality.quality.histogram_edges[i].toFixed(1)}</span></div>)}</div><details><summary>查看分组统计</summary><table><thead><tr><th>质量区间</th><th>单元数</th></tr></thead><tbody>{quality.quality.histogram_counts.map((count, i) => <tr key={i}><td>{quality.quality.histogram_edges[i].toFixed(2)} ~ {quality.quality.histogram_edges[i + 1].toFixed(2)}</td><td>{format(count)}</td></tr>)}</tbody></table></details><p className="hint">质量报告仅描述体网格，不代表仿真设置已经完成。正式计算仍需进行网格无关性检查。</p></>}
      {help && <div className="help-copy"><h3>节点式参数化建模</h3><p>左侧“建模步骤”显示实体和输入关系；选中一步，在右侧“节点属性”编辑。“设计参数”单独管理数值、公式、向量，选中后可查看引用者并跳转；简单模型直接填写尺寸即可。“输出设置”选择最终实体与网格尺寸。右侧“预览此步骤”查看中间实体并切到模型信息，导出保持最终输出。左下方自动更新默认关闭，开启后停止编辑 900 ms 更新输出；未改变的场和近期网格可复用缓存。撤销/重做保留最近 50 步，JSON 保存参数与引用。</p></div>}
    </dialog>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
