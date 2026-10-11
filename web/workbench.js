// Same workspace categories, tool labels and grouping as the desktop Ribbon.
// This presentation shell never modifies the downloaded project or mesh.
import { PRIMITIVES, COMMON_PRIMITIVES } from '../desktop/src/primitive_catalog.mjs';
import { createPrimitivePalette, primitiveIcon } from './primitive-palette.js';
const $ = id => document.getElementById(id);
const desktopHint = '界面展示模式：创建、编辑和重新计算请使用桌面 App';
const tool = (label, icon, attributes = {}) => ({ label, icon, ...attributes });
const group = (label, tools) => ({ label, tools });
const categories = [
  { id:'model', label:'建模', modes:['nodes'], groups:[
    {...group('基本体',PRIMITIVES.map(item => tool(`创建${item.name}`,null,{primitive:item.kind}))),palette:true},
    group('布尔与融合', [['并集','merge'],['交集','intersection'],['差集','minus'],['平滑融合','sparkles']].map(([label,icon]) => tool(`添加${label}`,icon))),
    group('节点操作', [tool('独立变换','move'),tool('复制实体','copy'),tool('撤销编辑','undo'),tool('重做编辑','redo')]),
  ]},
  { id:'tpms', label:'TPMS', groups:[], modeGroups:{
    nodes:[group('加入实体工作流',[tool('添加 TPMS','wave'),tool('添加隐式公式','formula')])],
    tpms:[group('TPMS 参数编辑',[tool('曲面与尺寸','layers',{navigate:'geometry'}),tool('壁厚与孔隙率','sliders',{navigate:'structure'}),tool('自定义曲面','formula')])],
  }},
  { id:'values', label:'参数与公式', modes:['nodes'], groups:[
    group('设计参数',[tool('新建数值参数','hash'),tool('新建公式参数','formula'),tool('新建向量参数','move')]),
    group('参数计算',[tool('求值全部参数','activity')]),
  ]},
  { id:'inspect', label:'检查与测量', groups:[
    group('分析工具',[tool('打开剖切工具','scan',{action:'section'}),tool('开始两点测量','ruler',{action:'measure'}),tool('查看模型信息','activity',{action:'info'})]),
    group('显示与视角',[tool('线框显示','grid',{action:'wire',pressed:false}),tool('恢复整体视角','scan',{action:'fit'}),...['X','Y','Z'].map(axis => tool(`${axis} 方向观察`,'eye',{view:axis}))]),
  ]},
  { id:'cfd', label:'仿真与网格', modes:['tpms'], groups:[
    group('流体域',[tool('编辑 CFD 参数','sliders'),tool('显示仿真边界','wave')]),
    group('质量与导出',[tool('打开网格质量检查','activity'),tool('定位低质量单元','activity'),tool('导出流体体网格','download')]),
  ]},
];

export function createWorkbench(showInspector) {
  const palette = createPrimitivePalette();
  let mode = 'nodes', active = 'model';
  const panels = new Map(), tabs = new Map();
  const shown = () => categories.filter(category => !category.modes || category.modes.includes(mode));
  const enablePanel = id => {
    palette.close();
    active = id;
    $('ribbon-panel').hidden = false;
    $('ribbon-collapse').setAttribute('aria-expanded','true'); $('ribbon-collapse').textContent = '收起工具栏';
    for (const [key,panel] of panels) panel.hidden = key !== id;
    for (const [key,tab] of tabs) {
      tab.classList.toggle('selected',key === id); tab.setAttribute('aria-selected',String(key === id)); tab.tabIndex = key === id ? 0 : -1;
    }
    if (id === 'inspect') showInspector(true);
    if (id === 'values') {
      document.querySelector('.parameter-card').open = true;
      document.querySelector('.parameter-card').scrollIntoView({block:'nearest'});
    }
  };
  function render() {
    panels.clear(); tabs.clear(); $('ribbon-tabs').replaceChildren(); $('ribbon-panel').replaceChildren();
    for (const category of shown()) {
      const tab = document.createElement('button'); tab.id = `ribbon-tab-${category.id}`;
      tab.setAttribute('role','tab'); tab.setAttribute('aria-controls',`ribbon-panel-${category.id}`);
      tab.textContent = category.id === 'tpms' && mode === 'nodes' ? 'TPMS 节点' : category.label;
      tab.onclick = () => enablePanel(category.id);
      tab.onkeydown = event => {
        const list = [...tabs.values()], index = list.indexOf(tab);
        const next = event.key === 'ArrowRight' ? (index+1)%list.length : event.key === 'ArrowLeft' ? (index+list.length-1)%list.length : event.key === 'Home' ? 0 : event.key === 'End' ? list.length-1 : null;
        if (next === null) return;
        event.preventDefault(); list[next].click(); list[next].focus();
      };
      tabs.set(category.id,tab); $('ribbon-tabs').append(tab);
      const panel = document.createElement('div'); panel.id = `ribbon-panel-${category.id}`; panel.className = 'ribbon-panel'; panel.tabIndex = 0;
      panel.setAttribute('role','tabpanel'); panel.setAttribute('aria-labelledby',tab.id);
      for (const definition of category.modeGroups?.[mode] || category.groups) {
        const section = document.createElement('section'); section.className = 'ribbon-group'; section.setAttribute('aria-label',definition.label);
        const tools = document.createElement('div'); tools.className = 'ribbon-tools';
        for (const item of definition.tools.filter(item => !definition.palette || COMMON_PRIMITIVES.includes(item.primitive))) {
          const button = document.createElement('button'); button.className = 'ribbon-tool'; button.setAttribute('aria-label',item.label);
          button.innerHTML = `${item.primitive ? primitiveIcon(item.primitive,32) : `<svg class="icon" aria-hidden="true"><use href="#i-${item.icon}"/></svg>`}<span>${item.label}</span>`;
          if (item.action) button.dataset.action = item.action;
          if (item.view) button.dataset.view = item.view;
          if (item.pressed !== undefined) button.setAttribute('aria-pressed',String(item.pressed));
          if (item.action || item.view) {
            button.classList.add('model-control'); button.disabled = !$('viewport').dataset.loaded;
          } else if (item.navigate) {
            button.onclick = () => $(`tpms-${item.navigate}`).scrollIntoView({block:'nearest'});
          } else { button.disabled = true; button.title = desktopHint; }
          tools.append(button);
        }
        const label = document.createElement(definition.palette?'button':'h3'); label.textContent = definition.label;
        if (definition.palette) {
          label.className='ribbon-palette-trigger';label.type='button';label.setAttribute('aria-label','展开基本体选项');label.setAttribute('aria-expanded','false');label.setAttribute('aria-controls','basic-body-palette');
          label.insertAdjacentHTML('beforeend','<svg class="icon" aria-hidden="true"><use href="#i-chevron"/></svg>');
          label.onclick=()=>palette.open(label);
        }
        section.append(tools,label); panel.append(section);
      }
      panels.set(category.id,panel); $('ribbon-panel').append(panel);
    }
    enablePanel(active);
  }
  function switchMode(next) {
    palette.close();
    mode = next; active = next === 'nodes' ? 'model' : 'tpms';
    for (const value of ['nodes','tpms']) { $(`mode-${value}`).classList.toggle('selected',value === mode); $(`mode-${value}`).setAttribute('aria-pressed',String(value === mode)); }
    $('node-project').hidden = mode !== 'nodes'; $('tpms-project').hidden = mode !== 'tpms';
    $('node-panel-title').textContent = mode === 'nodes' ? '实体节点' : 'TPMS 参数';
    $('node-panel-badge').textContent = mode === 'nodes' ? 'libfive' : 'Gyroid';
    render();
    // Inform renderer listeners that the toolbar DOM has changed.
    document.dispatchEvent(new Event('workbenchchange'));
  }
  $('mode-nodes').onclick = () => switchMode('nodes'); $('mode-tpms').onclick = () => switchMode('tpms');
  render();
  return { inspect:() => enablePanel('inspect') };
}
