import React, { useEffect, useId, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Box, Layers3, FolderOpen, Save, Download, ChevronDown, Sun, Moon, RotateCcw, Scan, ZoomIn, ZoomOut, Copy, CircleHelp, X, Check, LoaderCircle, Activity, Triangle, Workflow } from 'lucide-react';
import Viewport from './Viewport';
import NodeWorkflow from './NodeWorkflow';
import Ribbon from './Ribbon';
import { createValueBlock } from './ValueBlocks';
import { Circle, Cylinder, CircleDot, Move3D, Hash, Variable, Undo2, Redo2, Eye, Scissors, Ruler, SlidersHorizontal, Waves, Grid3X3, GitMerge, GitCompare, Minus, Sparkles } from 'lucide-react';
import InspectionPanel from './InspectionPanel';
import { DEFAULT_SECTION } from './inspection_math.mjs';
import { graphErrors, affectedNodes, createNode, ancestors } from './node_graph.mjs';
import { onlyOrderChanged, sceneSignature as computationalSignature } from './workflow_drag.mjs';
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
  const [inspectorTab, setInspectorTab] = useState('model');
  const [section, setSection] = useState({ ...DEFAULT_SECTION });
  const [inspectionBounds, setInspectionBounds] = useState(null);
  const [measurePoints, setMeasurePoints] = useState([]);
  const [measuring, setMeasuring] = useState(false);
  const [sectionStatus, setSectionStatus] = useState(null);
  const [pickStatus, setPickStatus] = useState('');
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
    if (busyRef.current || next === scene) return;
    sceneHistory.current.undo = [...sceneHistory.current.undo, structuredClone(scene)].slice(-50);
    sceneHistory.current.redo = [];
    if (!onlyOrderChanged(scene, next)) { markChanges(next); invalidate(); }
    setScene(next); setError('');
  }
  function travelHistory(direction) {
    const history = sceneHistory.current;
    if (!history[direction].length || busyRef.current) return;
    history[direction === 'undo' ? 'redo' : 'undo'].push(structuredClone(scene));
    const next = history[direction].pop();
    const stillSelected = next.nodes.some(n => n.id === selected) || (next.value_nodes || []).some(b => `value:${b.id}` === selected);
    if (!onlyOrderChanged(scene, next)) { markChanges(next); invalidate(); }
    setScene(next); setSelected(stillSelected ? selected : next.root); setError('');
  }
  function switchMode(next) { setMode(next); setInspectorTab('model'); invalidate(); }
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
    autoAttempt.current = computationalSignature(scene);
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
  const sceneSignature = computationalSignature(scene);
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
  function duplicateNode() {
    if (!node || scene.nodes.length >= 64) return;
    let i = 1; while (scene.nodes.some(n => n.id === `n${i}`)) i++;
    const copy = { ...structuredClone(node), id: `n${i}`, name: `${node.name} 副本` };
    updateScene({ ...scene, nodes: [...scene.nodes, copy], root: copy.id }); setSelected(copy.id);
  }
  async function preset(value) {
    if (scene.nodes.length && !window.confirm('加载示例将替换当前对象列表。请先保存需要保留的项目。')) return;
    const r = await run('preset', { kind: value });
    if (r) { updateScene(r.scene); setSelected(r.scene.root); setInspectorTab('model'); setMode('nodes'); setMessage('工作流已加载，点击生成工作流查看'); }
  }
  async function saveProject() {
    const r = await run('save_project', { project: { type: 'tpms-electron', version: 1, mode, parameters: p, scene, cfd } });
    if (r && !r.canceled) setMessage(`项目已保存：${r.path}`);
  }
  async function openProject() {
    const r = await run('open_project'); if (!r || r.canceled) return;
    setMode(r.project.mode === 'solid' ? 'nodes' : r.project.mode); setP({ ...DEFAULT, ...r.project.parameters }); setCfd({ ...CFD, ...r.project.cfd });
    sceneHistory.current = { undo: [], redo: [] };
    setNodeStates({}); setValueOutputs({}); setCacheSummary(''); autoAttempt.current = '';
    setScene(r.project.scene || emptyScene()); setSelected(r.project.scene?.root || ''); setInspectorTab('model'); invalidate();
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
  const activeResult = previewResult || result;
  function resetInspection() { setSection({ ...DEFAULT_SECTION }); setMeasurePoints([]); setMeasuring(false); setSectionStatus(null); setPickStatus(''); }
  useEffect(() => { resetInspection(); }, [displayGeometry]);
  function changeSection(next) {
    if (['enabled', 'axis', 'offset', 'positive', 'only', 'fill'].some(key => next[key] !== section[key]) || next.normal !== section.normal) { setMeasurePoints([]); setMeasuring(false); setPickStatus(''); }
    setSection(next);
  }
  function pickedPoint(point) {
    if (!point) { setMeasuring(false); return; }
    point = point.map(value => Number(value.toFixed(6)));
    const next = measurePoints[0] ? [measurePoints[0], point] : [point];
    setMeasurePoints(next); setPickStatus(''); if (next.length === 2) setMeasuring(false);
  }

  function ribbonNode(kind, custom = false) {
    if (busyRef.current || !info?.libfive || scene.nodes.length >= 64) return;
    const next = createNode(scene, kind, p, selected);
    if (custom) { next.tpms = { ...next.tpms, surface: 'Custom' }; next.name = `隐式公式 ${next.id.slice(1)}`; }
    updateScene({ ...scene, nodes: [...scene.nodes, next], root: next.id });
    setSelected(next.id); setMode('nodes'); setInspectorTab('model');
  }
  function ribbonValue(kind) {
    if (busyRef.current || !info || (scene.value_nodes || []).length >= 32) return;
    const block = createValueBlock(scene, kind);
    updateScene({ ...scene, value_nodes: [...(scene.value_nodes || []), block] });
    setSelected(`value:${block.id}`); setMode('nodes'); setInspectorTab('model');
  }
  function tpmsPanel(next) { if (mode !== 'tpms') switchMode('tpms'); setTab(next); }
  const noEntity = busy || !info?.libfive || scene.nodes.length >= 64;
  const noParameter = busy || !info || (scene.value_nodes || []).length >= 32;
  const combination = createNode(scene, 'smooth_union', p, selected);
  const smoothHasTpms = combination.inputs.some(id => scene.nodes.some(n => n.kind === 'tpms' && (n.id === id || ancestors(scene.nodes, id).has(n.id))));
  const ribbonCategories = [
    { id: 'model', label: '建模', workspaces: ['nodes'], groups: [
      { label: '基本实体 · libfive', tools: [['sphere','球体',Circle],['box','长方体',Box],['cylinder','圆柱',Cylinder],['torus','圆环',CircleDot]].map(([kind,label,icon]) => ({ label: `创建${label}`, icon, disabled:noEntity, onClick:() => ribbonNode(kind), hint:'添加节点并展开属性；使用 libfive 内核' })) },
      { label: '布尔与融合', tools: [['union','并集',GitMerge],['intersection','交集',GitCompare],['difference','差集',Minus],['smooth_union','平滑融合',Sparkles]].map(([kind,label,icon]) => ({ label:`添加${label}`, icon, disabled:noEntity || scene.nodes.length < 2 || (kind === 'smooth_union' && smoothHasTpms), onClick:() => ribbonNode(kind), hint:kind === 'smooth_union' && smoothHasTpms ? '平滑融合不支持包含 TPMS 的上游实体' : '选中实体作为 A，在节点内编辑 A/B 引用' })) },
      { label: '节点操作', tools: [
        {label:'独立变换',icon:Move3D,disabled:noEntity || !scene.nodes.length,onClick:() => ribbonNode('transform')},
        {label:'复制实体',icon:Copy,disabled:noEntity || !node,onClick:() => { duplicateNode(); setMode('nodes'); setInspectorTab('model'); }},
        {label:'撤销编辑',icon:Undo2,disabled:busy || !sceneHistory.current.undo.length,onClick:() => travelHistory('undo')},
        {label:'重做编辑',icon:Redo2,disabled:busy || !sceneHistory.current.redo.length,onClick:() => travelHistory('redo')}
      ] }
    ] },
    { id: 'tpms', label: mode === 'nodes' ? 'TPMS 节点' : 'TPMS', groups: [
      { label: 'TPMS 参数编辑', workspaces: ['tpms'], tools: [
        {label:'曲面与尺寸',icon:Layers3,disabled:busy,onClick:() => tpmsPanel('geometry')},
        {label:'壁厚与孔隙率',icon:SlidersHorizontal,disabled:busy,onClick:() => tpmsPanel('structure')},
        {label:'自定义曲面',icon:Variable,disabled:busy,onClick:() => { tpmsPanel('geometry'); update('surface','Custom'); }}
      ] },
      { label: '加入实体工作流', workspaces: ['nodes'], tools: [
        {label:'添加 TPMS',icon:Waves,disabled:noEntity,onClick:() => ribbonNode('tpms'),hint:'将当前 TPMS 参数复制为独立节点'},
        {label:'添加隐式公式',icon:Variable,disabled:noEntity,onClick:() => ribbonNode('tpms',true)}
      ] }
    ] },
    { id: 'values', label: '参数与公式', workspaces: ['nodes'], groups: [
      { label: '设计参数', tools: [['number','数值参数',Hash],['formula','公式参数',Variable],['vector','向量参数',Move3D]].map(([kind,label,icon]) => ({label:`新建${label}`,icon,disabled:noParameter,onClick:() => ribbonValue(kind)})) },
      { label: '参数计算', tools: [{label:'求值全部参数',icon:Activity,disabled:busy || !info || !(scene.value_nodes || []).length,onClick:evaluateValues}] }
    ] },
    { id: 'inspect', label: '检查与测量', groups: [
      { label: '分析工具', tools: [
        {label:'打开剖切工具',icon:Scissors,disabled:!displayGeometry,onClick:() => setInspectorTab('inspection')},
        {label:'开始两点测量',icon:Ruler,disabled:!displayGeometry,onClick:() => { setInspectorTab('inspection'); setMeasurePoints([]); setPickStatus(''); setMeasuring(true); }},
        {label:'查看模型信息',icon:Activity,onClick:() => setInspectorTab('model')}
      ] },
      { label: '显示与视角', tools: [
        {label:'线框显示',icon:Grid3X3,pressed:wireframe,onClick:() => setWireframe(!wireframe)},
        {label:'恢复整体视角',icon:Scan,onClick:() => viewport.current?.fit()},
        ...['X','Y','Z'].map(axis => ({label:`${axis} 方向观察`,icon:Eye,onClick:() => viewport.current?.view(axis)}))
      ] }
    ] },
    { id: 'cfd', label: '仿真与网格', workspaces: ['tpms'], groups: [
      { label: '流体域', tools: [
        {label:'编辑 CFD 参数',icon:SlidersHorizontal,disabled:busy || mode !== 'tpms',onClick:() => setTab('cfd'),hint:mode !== 'tpms' ? '请先切换 TPMS 建模工作区' : '设置体网格与边界层'},
        {label:'显示仿真边界',icon:Waves,disabled:!canCFD,pressed:display === 'region',onClick:showRegion}
      ] },
      { label: '质量与导出', tools: [
        {label:'打开网格质量检查',icon:Triangle,disabled:!canCFD,onClick:() => inspectQuality()},
        {label:'定位低质量单元',icon:Activity,disabled:!canCFD || !quality,pressed:display === 'low',onClick:lowQuality},
        {label:'导出流体体网格',icon:Download,disabled:!canCFD,onClick:() => inspectQuality(true)}
      ] }
    ] }
  ].filter(category => !category.workspaces || category.workspaces.includes(mode))
    .map(category => ({ ...category, groups: category.groups.filter(group => !group.workspaces || group.workspaces.includes(mode)) }));

  return <div className="app-shell">
    <header className="app-header">
      <div className="brand"><Box size={27} aria-hidden="true" /><div><strong>TPMS <span>Studio</span></strong><small>隐式建模工作台</small></div></div>
      <nav className="mode-switch" aria-label="建模工作区"><button className={mode === 'tpms' ? 'selected' : ''} aria-pressed={mode === 'tpms'} disabled={busy} onClick={() => switchMode('tpms')}><Layers3 size={19} aria-hidden="true" />TPMS 建模</button><button className={mode === 'nodes' ? 'selected' : ''} aria-pressed={mode === 'nodes'} disabled={busy} onClick={() => switchMode('nodes')}><Workflow size={19} aria-hidden="true" />实体建模</button></nav>
      <div className="file-actions"><Tool icon={FolderOpen} disabled={busy} onClick={openProject}>打开</Tool><Tool icon={Save} disabled={busy} onClick={saveProject}>保存项目</Tool>
        <details className="export-menu" ref={exportMenu}><summary aria-label="展开导出设置"><Download size={18} aria-hidden="true" />导出<ChevronDown size={15} aria-hidden="true" /></summary><div className="dropdown"><h3>表面模型导出</h3><Select label="导出质量 / 面数" value={exportQuality} onChange={setExportQuality} options={[
          ['original', '原始精度'], ['high', '高质量 · 约 70% 面数'], ['medium', '标准 · 约 40% 面数'], ['low', '轻量 · 约 20% 面数'], ['custom', '自定义目标面数'], ...(info?.libfive && result?.mode === 'tpms' && !result?.parameters?.tubular_enabled ? [['libfive', 'libfive · 重算网格精度']] : [])]} />
          {exportQuality === 'custom' && <Num label="目标三角面数" value={targetFaces} onChange={setTargetFaces} min={1} max={result?.stats.faces} step={1000} />}
          {exportQuality === 'libfive' && <Num label="网格尺寸" value={exportCell} onChange={setExportCell} min={0.001} step={0.05} unit="mm" />}
          <p className="hint">导出使用已生成模型。简化后的实际面数与封闭性会显示在状态栏。</p><button className="primary" disabled={!canModel} onClick={exportModel}><Download size={18} aria-hidden="true" />导出 STL / OBJ / PLY</button><button className="secondary" disabled={!canCFD} onClick={() => { exportMenu.current.open = false; inspectQuality(true); }}>导出 COMSOL 体网格</button></div></details>
        <button className="icon-button" aria-label={theme === 'dark' ? '切换亮色主题' : '切换暗色主题'} title="切换明暗主题" onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>{theme === 'dark' ? <Sun size={20} /> : <Moon size={20} />}</button><button className="icon-button" aria-label="操作说明" onClick={() => setHelp(true)}><CircleHelp size={20} /></button>
      </div>
    </header>
    <Ribbon key={mode} categories={ribbonCategories} />
    <div className={`workspace ${mode === 'nodes' ? 'node-workspace' : ''} ${inspectorTab === 'inspection' ? 'inspection-workspace' : ''}`}>
      <aside className="parameters" aria-label="建模参数">
        <div className="panel-heading"><div><small>{mode === 'nodes' ? '参数化工作流' : '设计输入'}</small><h2>{mode === 'tpms' ? 'TPMS 参数' : '建模节点树'}</h2></div><span className="badge">{mode !== 'tpms' ? 'libfive' : 'mm'}</span></div>
        {mode === 'tpms' && <nav className="panel-tabs" aria-label="参数类别">{[['geometry', '几何'], ['structure', '结构'], ['cfd', 'CFD 网格']].map(([value, label]) => <button key={value} aria-pressed={tab === value} className={tab === value ? 'selected' : ''} onClick={() => setTab(value)}>{label}</button>)}</nav>}
        <div className="panel-scroll" key={mode}><fieldset disabled={busy}>
        {mode === 'nodes' && <NodeWorkflow scene={scene} onChange={updateScene} currentParameters={p} selected={selected} onSelect={setSelected} dirty={dirty} hasResult={!!result && result.mode === 'solid'} busy={busy} available={!!info?.libfive} error={error} reportError={setError} undo={() => travelHistory('undo')} redo={() => travelHistory('redo')} canUndo={sceneHistory.current.undo.length > 0} canRedo={sceneHistory.current.redo.length > 0} loadPreset={preset} nodeStates={nodeStates} valueOutputs={valueOutputs} previewNode={previewNode} evaluateValues={evaluateValues} cacheSummary={cacheSummary} />}
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
        </fieldset></div>
        <div className="generate-footer">{mode === 'nodes' && <><div className="footer-output"><span>最终输出</span><strong>{scene.nodes.find(n => n.id === scene.root)?.name || '未设置'}</strong></div><Toggle label="自动更新输出" value={autoUpdate} disabled={busy} onChange={setAutoUpdate} /></>}<p className="hint">{busy ? '计算中，视口仍可操作' : invalidWorkflow ? '步骤输入有误，请检查上游引用' : dirty ? '参数已修改，生成后更新模型' : mode === 'nodes' ? '展开左侧节点，直接编辑参数与输入' : '参数定义 → 隐式场 → 封闭模型'}</p><button className="primary generate" disabled={!info || busy || (mode !== 'tpms' && (!info.libfive || !scene.nodes.length || invalidWorkflow))} onClick={generate}>{busy ? <LoaderCircle size={20} className="spin" aria-hidden="true" /> : <Layers3 size={20} aria-hidden="true" />}{busy ? '正在计算…' : mode === 'tpms' ? '生成模型' : '生成工作流'}</button>{busy && <button className="cancel" onClick={cancel}>取消计算</button>}</div>
      </aside>
      <main className="model-area" aria-label="三维模型预览">
        <div className="viewport-toolbar"><div className="viewport-title"><span>三维视图</span><small>{display === 'region' ? '仿真边界' : display === 'low' ? '低质量单元' : renderer}</small></div>{mode === 'nodes' ? <span className="viewport-context">{previewResult ? `预览：${previewResult.name}` : result?.mode === 'solid' ? '最终输出' : '等待生成工作流'}</span> : <div className="viewport-actions"><Tool icon={Activity} disabled={!canCFD} title={!canCFD ? '生成 TPMS 模型后可使用' : '计算体单元质量'} onClick={() => inspectQuality()}>网格质量</Tool><Tool icon={Scan} disabled={!canCFD} active={display === 'region'} onClick={showRegion}>仿真区域</Tool><Tool icon={Triangle} disabled={!canCFD || !quality} title={!quality ? '先计算网格质量' : '定位低质量单元'} active={display === 'low'} onClick={lowQuality}>低质量</Tool></div>}</div>
        {error && <div className="error-banner" role="alert"><span>{error}</span><button aria-label="关闭错误提示" onClick={() => setError('')}><X size={18} /></button></div>}
        <div className="viewport"><Viewport ref={viewport} geometry={displayGeometry} parameters={display === 'model' ? activeResult?.parameters : null} shader={info?.shader} theme={theme} implicit={implicit} wireframe={wireframe} onError={setError} onRenderer={setRenderer} section={section} points={measurePoints} measuring={measuring} onBounds={setInspectionBounds} onSectionStatus={setSectionStatus} onPick={pickedPoint} onPickStatus={setPickStatus} />
          {!displayGeometry && !busy && <div className="empty"><Box size={48} strokeWidth={1} aria-hidden="true" /><h2>从参数定义你的模型</h2><p>设置左侧参数，点击“生成模型”开始。</p></div>}
          <div className="view-tools"><button title="等轴测 / 重置视角" aria-label="重置视角" onClick={() => viewport.current?.fit()}><RotateCcw size={19} /></button>{['X', 'Y', 'Z'].map(axis => <button key={axis} aria-label={`${axis} 轴正交方向观察`} onClick={() => viewport.current?.view(axis)}>{axis}</button>)}<button aria-label="放大" onClick={() => viewport.current?.zoom(0.8)}><ZoomIn size={19} /></button><button aria-label="缩小" onClick={() => viewport.current?.zoom(1.25)}><ZoomOut size={19} /></button></div>
          {display === 'region' && <div className="legend"><span><i className="inlet" />入口 · 101</span><span><i className="outlet" />出口 · 102</span><span><i className="walls" />壁面 · 103</span></div>}
          {display === 'low' && <div className="legend">低质量单元：{format(quality?.quality.low_quality_elements)} · 阈值 {quality?.quality.low_quality_threshold}</div>}
          <div className="viewport-caption">{measuring ? '单击选择测量点 · 拖动旋转 · Esc 结束' : '左键旋转 · 右键平移 · 滚轮缩放'}</div>
          {previewResult && <div className="intermediate-note"><span>预览：{previewResult.name} · 导出使用最终输出</span><button type="button" className="secondary" disabled={busy} onClick={returnOutput}>返回最终输出</button></div>}
          {dirty && result && !previewResult && <div className="snapshot-note">当前显示上次生成的模型</div>}
        </div>
        <div className="view-options"><button type="button" className={`tool ${inspectorTab === 'inspection' ? 'active' : ''}`} aria-pressed={inspectorTab === 'inspection'} disabled={!displayGeometry} onClick={() => setInspectorTab(inspectorTab === 'inspection' ? 'model' : 'inspection')}><Scan size={17} aria-hidden="true" />剖切与测量</button><Toggle label="GPU 隐式曲面" value={implicit && !section.enabled && !measuring && !measurePoints.some(Boolean)} disabled={section.enabled || measuring || measurePoints.some(Boolean) || display !== 'model' || !activeResult?.parameters || activeResult.parameters.surface === 'Custom' || activeResult.parameters.tubular_enabled} onChange={setImplicit} /><Toggle label="线框" value={wireframe} onChange={setWireframe} /><span>单位：mm</span></div>
      </main>
      <aside className="inspector" aria-label="模型信息与检查工具"><nav className="inspector-tabs" aria-label="检查器类别">{[['model', '模型信息'], ['inspection', '剖切测量']].map(([id, name]) => <button type="button" key={id} aria-pressed={inspectorTab === id} className={inspectorTab === id ? 'selected' : ''} onClick={() => setInspectorTab(id)}>{name}</button>)}</nav>
        {inspectorTab === 'inspection' && <div className="inspection-scroll"><InspectionPanel section={section} onSection={changeSection} bounds={inspectionBounds} points={measurePoints} onPoints={value => { setMeasurePoints(value); setPickStatus(''); }} measuring={measuring} onMeasuring={value => { setMeasuring(value); setPickStatus(''); }} status={sectionStatus} domain={display === 'region' ? '流体' : display === 'low' ? '单元' : '材料'} pickStatus={pickStatus} available={!!displayGeometry} viewPlane={normal => viewport.current?.viewNormal(normal)} onReset={resetInspection} /></div>}
        <div className="inspector-scroll" hidden={inspectorTab !== 'model'}><div className="result-name"><Box size={28} aria-hidden="true" /><strong>{previewResult ? previewResult.name : activeResult?.mode === 'solid' ? '实体模型' : activeResult?.parameters?.surface || '待生成'}</strong><span>{previewResult ? '中间节点预览' : dirty ? '参数待更新' : activeResult ? '已生成' : '准备就绪'}</span></div>
        <section className="metrics"><h3>几何统计</h3>{[['三角面', format(activeResult?.stats.faces)], ['顶点', format(activeResult?.stats.vertices)], ['体积', `${format(activeResult?.stats.volume, 2)} mm³`], ['表面积', `${format(activeResult?.stats.area, 2)} mm²`], ['孔隙率', activeResult?.stats.porosity != null ? `${format(activeResult.stats.porosity * 100, 2)} %` : '—'], ['封闭性', activeResult ? activeResult.stats.watertight ? '封闭 / 水密' : '未封闭' : '—']].map(([label, value]) => <div className="metric" key={label}><span>{label}</span><strong>{activeResult ? value : '—'}</strong></div>)}</section>
        {activeResult?.stats.bounds && <section className="metrics"><h3>世界坐标范围 / mm</h3>{['X', 'Y', 'Z'].map((axis, i) => <div className="metric" key={axis}><span>{axis}</span><strong>{format(activeResult.stats.bounds[0][i], 2)} ~ {format(activeResult.stats.bounds[1][i], 2)}</strong></div>)}</section>}
        <section className="kernel-info"><h3>建模内核</h3><div><span className={`connection ${info ? 'connected' : ''}`} /><span>Python {info ? '已连接' : '连接中'}</span></div><div><span className={`connection ${info?.libfive ? 'connected' : ''}`} /><span>libfive {info?.libfive ? '可用' : '不可用'}</span></div>{info && !info.libfive && <p className="hint">{info.detail}</p>}<p className="hint">完整计算模型用于导出。视口显示方式不会改变导出几何。</p></section>
        {quality && <section className="metrics"><h3>体网格摘要</h3><div className="metric"><span>体单元</span><strong>{format(quality.elements)}</strong></div><div className="metric"><span>最小雅可比</span><strong>{format(quality.quality.minimum, 4)}</strong></div><button className="secondary full" onClick={() => setQualityDialog(true)}>查看质量报告</button></section>}
      </div></aside>
    </div>
    <footer className="statusbar"><span className={busy ? 'processing' : ''}>{busy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Check size={15} aria-hidden="true" />}</span><span role="status" aria-live="polite">{message}</span><span className="status-right">{renderer} · 本地计算</span></footer>
    <dialog ref={dialogRef} className="modal" onCancel={() => { setHelp(false); setQualityDialog(false); }}><div className="modal-header"><h2>{help ? '操作说明' : '体网格质量报告'}</h2><button className="icon-button" aria-label="关闭对话框" onClick={() => { setHelp(false); setQualityDialog(false); }}><X size={20} /></button></div>
      {help ? <div className="help-copy"><h3>TPMS 建模</h3><p>在几何和结构页设置尺寸、周期、壁厚或孔隙率，然后生成模型。自定义公式支持安全数学表达式；公式变量 x/y/z 使用 mm 坐标。</p><h3>实体建模</h3><p>在统一节点树中添加球、盒、圆柱、圆环或 TPMS，展开节点编辑尺寸、位置与旋转；布尔节点通过输入 A/B 进行组合。指定最终输出并点击“生成工作流”，可进一步加入参数和公式驱动模型。</p><h3>预览与导出</h3><p>内置曲面可使用 GPU 隐式预览；公式、管状 TPMS 和实体组合使用网格预览。顶部导出菜单控制导出质量与目标面数。</p><h3>CFD</h3><p>先生成 TPMS，再计算网格质量或显示仿真区域。COMSOL 导出包含 MSH/BDF、边界 JSON、质量 VTU。组合实体暂不支持 CFD。</p><h3>保存项目</h3><p>项目 JSON 保存 TPMS 参数、实体对象、组合关系和 CFD 设置。原 Qt 实体组合项目也可打开。</p></div> : quality && <><p className="hint">质量指标：{quality.quality.metric} · {format(quality.nodes)} 节点 · {format(quality.elements)} 体单元</p><div className="quality-summary">{[['最小值', quality.quality.minimum], ['5% 分位', quality.quality.percentile_05], ['中位数', quality.quality.median], ['平均值', quality.quality.mean], ['最大值', quality.quality.maximum], ['低质量单元', quality.quality.low_quality_elements]].map(([label, value]) => <div key={label}><span>{label}</span><strong>{format(value, 4)}</strong></div>)}</div><h3>缩放雅可比分布</h3><div className="histogram" aria-label="质量直方图">{quality.quality.histogram_counts.map((count, i, counts) => <div key={i} title={`${quality.quality.histogram_edges[i].toFixed(2)} ~ ${quality.quality.histogram_edges[i + 1].toFixed(2)}：${count} 单元`}><i style={{ height: `${Math.max(1, count / Math.max(1, ...counts) * 130)}px` }} /><span>{quality.quality.histogram_edges[i].toFixed(1)}</span></div>)}</div><details><summary>查看分组统计</summary><table><thead><tr><th>质量区间</th><th>单元数</th></tr></thead><tbody>{quality.quality.histogram_counts.map((count, i) => <tr key={i}><td>{quality.quality.histogram_edges[i].toFixed(2)} ~ {quality.quality.histogram_edges[i + 1].toFixed(2)}</td><td>{format(count)}</td></tr>)}</tbody></table></details><p className="hint">质量报告仅描述体网格，不代表仿真设置已经完成。正式计算仍需进行网格无关性检查。</p></>}
      {help && <div className="help-copy"><h3>节点与参数编辑</h3><p>左侧节点树按“设计参数、建模节点、最终输出”连续排列。点击三角展开节点，直接编辑尺寸、公式与输入；可同时展开多个节点。实体、数值与向量引用标签可点击定位来源。节点内提供预览、复制、删除和设为输出；右侧保留模型信息及剖切测量。顶部分组按钮跳转到相应区域，收起所有节点可恢复概览。左下方自动更新默认关闭，开启后停止编辑 900 ms 更新输出；缓存、撤销/重做和 JSON 项目继续可用。</p></div>}
    </dialog>
  </div>;
}

createRoot(document.getElementById('root')).render(<App />);
