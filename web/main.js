import './style.css';
import './native.css';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { planeNormal, planeRange, distanceBetween } from '../desktop/src/inspection_math.mjs';
import { createWorkbench } from './workbench.js';

const $ = id => document.getElementById(id);
const number = (value, digits = 2) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
const status = text => { $('status').textContent = text; };
const icon = name => `<svg class="icon" aria-hidden="true"><use href="#i-${name}"/></svg>`;
const row = (label, value) => {
  const wrap = document.createElement('div'), dt = document.createElement('dt'), dd = document.createElement('dd');
  dt.textContent = label; dd.textContent = value; wrap.append(dt, dd); return wrap;
};
document.querySelectorAll('svg.icon').forEach(svg => svg.setAttribute('aria-hidden', 'true'));
$('cut-axis').setAttribute('aria-label','平面方向');
$('cut-offset').setAttribute('aria-label','剖切位置');
for (const [id, label] of [['normal-x','法向量 X'],['normal-y','法向量 Y'],['normal-z','法向量 Z']]) $(id).setAttribute('aria-label',label);
document.querySelectorAll('#inspection-info input,#inspection-info select').forEach(input => { input.disabled = true; });

function showInspector(inspection = false) {
  $('model-info').hidden = inspection; $('inspection-info').hidden = !inspection;
  for (const [id, active] of [['info-model-tab', !inspection], ['info-inspection-tab', inspection]]) {
    $(id).classList.toggle('selected', active); $(id).setAttribute('aria-pressed', String(active));
  }
  if (matchMedia('(max-width:700px)').matches) {
    $('info-panel').classList.add('mobile-open'); $('info-toggle').setAttribute('aria-expanded', 'true');
    $('node-panel').classList.remove('mobile-open'); $('nodes-toggle').setAttribute('aria-expanded', 'false');
  }
}
const workbench = createWorkbench(showInspector);
const rotateButton = document.createElement('button'); rotateButton.id = 'auto-rotate';
rotateButton.className = 'model-control view-option-button'; rotateButton.disabled = true;
rotateButton.setAttribute('aria-pressed','false'); rotateButton.innerHTML = `${icon('rotate')}<span>自动旋转</span>`;
document.querySelector('.view-options').append(rotateButton);
$('help-toggle').onclick = () => $('help-dialog').showModal();
$('help-close').onclick = () => $('help-dialog').close();
$('info-model-tab').onclick = () => showInspector(false);
$('info-inspection-tab').onclick = () => showInspector(true);
for (const [button, panel, other] of [['nodes-toggle','node-panel','info-panel'], ['info-toggle','info-panel','node-panel']]) {
  $(button).onclick = () => {
    const open = $(panel).classList.toggle('mobile-open'); $(button).setAttribute('aria-expanded', String(open));
    $(other).classList.remove('mobile-open'); $(other === 'node-panel' ? 'nodes-toggle' : 'info-toggle').setAttribute('aria-expanded', 'false');
  };
}
document.querySelectorAll('[data-close]').forEach(button => { button.onclick = () => {
  $(button.dataset.close).classList.remove('mobile-open');
  $(button.dataset.close === 'node-panel' ? 'nodes-toggle' : 'info-toggle').setAttribute('aria-expanded','false');
}; });
$('ribbon-collapse').onclick = () => {
  const hidden = !$('ribbon-panel').hidden; $('ribbon-panel').hidden = hidden;
  $('ribbon-collapse').setAttribute('aria-expanded', String(!hidden)); $('ribbon-collapse').textContent = hidden ? '展开工具栏' : '收起工具栏';
};
$('retry').onclick = () => location.reload();

function showProject(project) {
  const scene = project.scene, names = new Map(scene.nodes.map(node => [node.id, node.name]));
  const tpmsNode = scene.nodes.find(node => node.kind === 'tpms');
  const p = tpmsNode?.tpms || project.parameters;
  const addField = (host,label,value) => {
    const field = document.createElement('label'); field.className = 'field'; field.textContent = label;
    const input = document.createElement('input'); input.value = value; input.readOnly = true; input.title = '界面展示模式：参数修改请使用桌面 App';
    field.append(input); $(host).append(field);
  };
  addField('tpms-geometry-fields','曲面类型',p.surface);
  for (const axis of ['x','y','z']) {
    addField('tpms-geometry-fields',`${axis.toUpperCase()} 尺寸 / mm`,p[`size_${axis}`]);
    addField('tpms-geometry-fields',`${axis.toUpperCase()} 周期数`,p[`cells_${axis}`]);
  }
  addField('tpms-structure-fields','结构模式',p.mode === 'sheet' ? '片层结构' : '实体结构');
  const wall = scene.value_nodes.find(node => node.symbol === 'wall');
  addField('tpms-structure-fields','壁厚 / mm',wall?.value ?? p.thickness);
  addField('tpms-structure-fields','等值面偏移',p.iso_level);
  addField('tpms-structure-fields','生成精度 / mm',scene.cell_size);
  $('design-parameters').replaceChildren(...scene.value_nodes.map(parameter => row(parameter.name.replace(' / mm',''), `${parameter.value} mm`)));
  $('root-name').textContent = names.get(scene.root);
  const kindNames = { tpms:'TPMS', cylinder:'圆柱', box:'盒体', sphere:'球体', torus:'圆环',
    union:'并集', intersection:'交集', difference:'差集', transform:'变换', smooth_union:'融合' };
  const cards = scene.nodes.map(node => {
    const card = document.createElement('details'); card.className = `node-card${node.id === scene.root ? ' root' : ''}`;
    card.dataset.nodeId = node.id;
    const summary = document.createElement('summary'); summary.innerHTML = icon('chevron');
    const title = document.createElement('span'); title.textContent = node.name;
    const type = document.createElement('small'); type.textContent = kindNames[node.kind] || node.kind;
    summary.append(title, type); card.append(summary);
    const fields = document.createElement('dl'); fields.className = 'node-fields';
    node.inputs.forEach((input, i) => fields.append(row(`输入 ${node.inputs.length === 1 ? '' : i ? 'B' : 'A'}`, names.get(input))));
    if (!node.inputs.length && node.kind !== 'tpms') fields.append(row('尺寸 / mm', node.dimensions.map(v => number(v)).join(' × ')));
    if (node.tpms) {
      fields.append(row('曲面与周期', `${node.tpms.surface} · ${node.tpms.cells_x} × ${node.tpms.cells_y} × ${node.tpms.cells_z}`));
      fields.append(row('域尺寸 / mm', [node.tpms.size_x,node.tpms.size_y,node.tpms.size_z].join(' × ')));
      fields.append(row('片层壁厚', `${node.tpms.thickness} mm`));
    }
    if (node.position.some(value => value !== 0)) fields.append(row('位置 / mm', node.position.join(', ')));
    if (node.rotation.some(value => value !== 0)) fields.append(row('旋转 / °', node.rotation.join(', ')));
    for (const [field, expression] of Object.entries(node.expressions || {})) fields.append(row(field === 'tpms.thickness' ? '壁厚表达式' : '参数表达式', expression));
    if (node.id === scene.root) fields.append(row('输出', '最终实体 · 下载 STL'));
    card.append(fields); return card;
  });
  $('node-list').replaceChildren(...cards);
}

function showMetadata(metadata) {
  $('triangle-count').textContent = number(metadata.faces, 0); $('vertex-count').textContent = number(metadata.vertices, 0);
  $('volume').textContent = `${number(metadata.volume_mm3)} mm³`; $('area').textContent = `${number(metadata.area_mm2)} mm²`;
  $('watertight').textContent = metadata.watertight ? '封闭 / 水密' : '开放网格';
  $('cell-size').textContent = `${metadata.cell_size_mm} mm`; $('file-size').textContent = `${number(metadata.stl_bytes / 1024 / 1024, 2)} MB`;
  $('bounds').replaceChildren(...['X','Y','Z'].map((axis, i) => row(axis, `${number(metadata.bounds_mm[0][i])} ~ ${number(metadata.bounds_mm[1][i])}`)));
  $('download-stl').href = `${metadata.file}?v=${metadata.sha256.slice(0,12)}`;
  $('download-stl').download = metadata.download_name;
}

class ModelViewer {
  constructor() {
    this.host = $('viewport'); this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(38,1,0.05,10000); this.camera.up.set(0,0,1);
    this.renderer = new THREE.WebGLRenderer({ antialias:true, powerPreference:'high-performance' });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5)); this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.2;
    this.renderer.localClippingEnabled = true;
    const canvas = this.renderer.domElement; canvas.tabIndex = 0;
    canvas.setAttribute('aria-label','Gyroid 双法兰三维预览：拖动旋转，滚轮缩放，右键或方向键平移'); this.host.append(canvas);
    this.controls = new OrbitControls(this.camera, canvas); this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.15; this.controls.listenToKeyEvents(canvas); this.controls.autoRotateSpeed = 1;
    this.scene.add(new THREE.HemisphereLight(0xeeeeee,0x333333,2.4));
    const key = new THREE.DirectionalLight(0xffffff,3.5); key.position.set(30,-50,70); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xffffff,1.7); fill.position.set(-50,15,35); this.scene.add(fill);
    this.section = { enabled:false, axis:'Y', normal:[1,0,1], offset:0, positive:false, only:false, fill:true };
    this.sectionId = 0; this.pickId = 0; this.points = []; this.measuring = false; this.requestId = 0;
    this.markers = new THREE.Group(); this.scene.add(this.markers);
    this.controls.addEventListener('change', () => this.schedule());
    this.controls.addEventListener('start', () => { clearTimeout(this.restore); this.renderer.setPixelRatio(Math.min(devicePixelRatio,1)); this.schedule(); });
    this.controls.addEventListener('end', () => { this.restore = setTimeout(() => { this.renderer.setPixelRatio(Math.min(devicePixelRatio,1.5)); this.schedule(); },140); });
    canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); this.failure('显卡上下文丢失，请重新加载页面。'); });
    let start;
    canvas.addEventListener('pointerdown', event => { if (event.button === 0) start = [event.clientX,event.clientY,event.pointerId]; });
    canvas.addEventListener('pointerup', event => {
      const previous = start; start = null;
      if (!this.measuring || !previous || previous[2] !== event.pointerId || Math.hypot(event.clientX-previous[0],event.clientY-previous[1]) > 4) return;
      const rect = canvas.getBoundingClientRect(), ray = new THREE.Raycaster(); this.camera.updateMatrixWorld();
      ray.setFromCamera(new THREE.Vector2((event.clientX-rect.left)/rect.width*2-1, -(event.clientY-rect.top)/rect.height*2+1), this.camera);
      this.worker.postMessage({type:'pick',id:++this.pickId,key:JSON.stringify(this.section),section:this.section,origin:ray.ray.origin.toArray(),direction:ray.ray.direction.toArray()});
      status('正在选择可见表面点…');
    });
    this.observer = new ResizeObserver(() => this.resize()); this.observer.observe(this.host);
    this.worker = new Worker(new URL('./model.worker.js',import.meta.url),{type:'module'});
    this.worker.onmessage = ({data}) => this.message(data);
    this.worker.onerror = () => this.failure('模型处理失败，请重新加载页面。');
    this.setTheme(true); this.resize();
  }
  clearObject(object) { if (object) { object.removeFromParent(); object.geometry.dispose(); object.material.dispose(); } }
  failure(message) {
    $('loading').hidden = false; $('loading-title').textContent = '模型加载失败'; $('loading-title').classList.add('error');
    $('loading-detail').textContent = message; $('loading-progress').hidden = true; $('retry').hidden = false;
    status(message); this.failLoad?.(new Error(message));
    document.querySelectorAll('.model-control').forEach(button => { button.disabled = true; });
  }
  async prepare(buffer) {
    return new Promise((resolve,reject) => { this.loaded = resolve; this.failLoad = reject; this.worker.postMessage({type:'prepare',buffer},[buffer]); });
  }
  message(data) {
    if (data.type === 'prepared') {
      if (data.error) { this.failure(data.error); return; }
      const geometry = new THREE.BufferGeometry(); geometry.setAttribute('position',new THREE.BufferAttribute(data.positions,3));
      geometry.setAttribute('normal',new THREE.BufferAttribute(data.normals,3)); geometry.setIndex(new THREE.BufferAttribute(data.indices,1));
      this.mesh = new THREE.Mesh(geometry,new THREE.MeshStandardMaterial({color:this.light ? 0x777777 : 0x999999,roughness:0.44,metalness:0.15,side:THREE.DoubleSide}));
      this.scene.add(this.mesh); this.bounds = new THREE.Box3(new THREE.Vector3(...data.bounds[0]),new THREE.Vector3(...data.bounds[1]));
      this.diagonal = this.bounds.getSize(new THREE.Vector3()).length();
      const extent = Math.max(...this.bounds.getSize(new THREE.Vector3()).toArray()), center = this.bounds.getCenter(new THREE.Vector3());
      this.grid = new THREE.GridHelper(extent*2,20,0x7f99af,0x7f99af); this.grid.rotation.x = Math.PI/2;
      this.grid.position.set(center.x,center.y,this.bounds.min.z-extent*0.03); this.grid.material.transparent = true; this.grid.material.opacity = 0.16;
      this.scene.add(this.grid); this.fit(); this.syncRange(); this.loaded(data); return;
    }
    if (data.type === 'section' && data.id === this.sectionId && this.section.enabled) {
      this.clearCut();
      if (data.error) { $('section-message').textContent = data.error; $('section-message').classList.add('error'); return; }
      const result = data.result;
      const line = new THREE.BufferGeometry(); line.setAttribute('position',new THREE.BufferAttribute(result.lines,3));
      this.cutLines = new THREE.LineSegments(line,new THREE.LineBasicMaterial({color:this.light ? 0x9b460d : 0xffbe7e})); this.cutLines.renderOrder = 3; this.scene.add(this.cutLines);
      const cap = new THREE.BufferGeometry(); cap.setAttribute('position',new THREE.BufferAttribute(result.cap,3));
      this.cutCap = new THREE.Mesh(cap,new THREE.MeshBasicMaterial({color:this.light ? 0xb96b2c : 0xffb65f,side:THREE.DoubleSide,polygonOffset:true,polygonOffsetFactor:-1,polygonOffsetUnits:-1}));
      this.cutCap.renderOrder = 2; this.cutCap.visible = this.section.fill; this.scene.add(this.cutCap);
      $('section-message').textContent = result.warning || '截面已更新。剖切不改变下载模型。'; $('section-message').classList.toggle('error',!!result.warning);
      $('section-statistics').replaceChildren(row('截面面积',result.area === null ? '无法可靠计算' : `${number(result.area)} mm²`),row('轮廓总长',`${number(result.perimeter)} mm`),row('闭合轮廓',number(result.loops,0)));
      this.host.dataset.sectionReady = String(data.id); this.schedule();
    } else if (data.type === 'pick' && data.id === this.pickId && this.measuring) {
      if (data.error || !data.point) { status(data.error || '未选中可见表面，请在模型表面单击。'); return; }
      this.points.push(data.point); this.updateMarkers();
      if (this.points.length === 2) { this.armMeasurement(false); status(`A–B 距离：${number(distanceBetween(...this.points),3)} mm`); }
      else status('已选择 A 点，请选择 B 点。');
    }
  }
  setTheme(light) {
    this.light = light; document.documentElement.dataset.theme = light ? 'light' : 'dark';
    this.scene.background = new THREE.Color(light ? '#cce6e1' : '#234443');
    if (this.mesh) this.mesh.material.color.set(light ? '#777777' : '#999999');
    document.querySelector('meta[name="theme-color"]').content = light ? '#bedbd8' : '#172c2d';
    if (this.grid) this.grid.material.opacity = light ? 0.24 : 0.16;
    if (this.cutCap) this.cutCap.material.color.set(light ? '#b96b2c' : '#ffb65f');
    if (this.cutLines) this.cutLines.material.color.set(light ? '#9b460d' : '#ffbe7e');
    $('theme-toggle').setAttribute('aria-pressed',String(light));
    $('theme-toggle').setAttribute('aria-label',light ? '切换暗色主题' : '切换亮色主题'); $('theme-toggle').title = light ? '切换暗色主题' : '切换亮色主题';
    this.schedule();
  }
  resize() {
    const {width,height} = this.host.getBoundingClientRect();
    this.renderer.setSize(width,height,false); this.camera.aspect = width/Math.max(1,height); this.camera.updateProjectionMatrix(); this.schedule();
  }
  fit(axis,normal) {
    if (!this.mesh) return;
    const center = this.bounds.getCenter(new THREE.Vector3());
    const direction = normal ? new THREE.Vector3(...normal).normalize() : axis === 'X' ? new THREE.Vector3(1,0,0) : axis === 'Y' ? new THREE.Vector3(0,-1,0) : axis === 'Z' ? new THREE.Vector3(0,0.001,1) : new THREE.Vector3(1,-1.4,0.95).normalize();
    if (Math.abs(direction.z)>0.999999) direction.y = 0.001;
    const distance = this.diagonal/(2*Math.sin(THREE.MathUtils.degToRad(this.camera.fov/2)))*Math.max(1,1/this.camera.aspect)*1.08;
    this.camera.position.copy(center).addScaledVector(direction,distance); this.controls.target.copy(center);
    this.camera.near = this.diagonal/1000; this.camera.far = this.diagonal*100; this.camera.updateProjectionMatrix();
    this.controls.minDistance = this.diagonal*0.035; this.controls.maxDistance = this.diagonal*15; this.controls.update(); this.schedule();
  }
  setWire(value) { if (!this.mesh) return; this.mesh.material.wireframe = value; $('wireframe').checked = value; document.querySelector('[data-action=wire]').setAttribute('aria-pressed',String(value)); this.schedule(); }
  clearCut() { this.clearObject(this.cutCap); this.clearObject(this.cutLines); this.cutCap = this.cutLines = null; }
  syncRange() {
    if (!this.bounds) return;
    const normal = planeNormal(this.section), range = planeRange([this.bounds.min.toArray(),this.bounds.max.toArray()],normal);
    $('cut-slider').min = range[0]; $('cut-slider').max = range[1]; $('cut-slider').value = this.section.offset;
  }
  setSection(next) {
    try { planeNormal(next); if (!Number.isFinite(next.offset)) throw new Error('剖切位置需要有效数字'); }
    catch (error) { $('section-message').textContent = error.message; $('section-message').classList.add('error'); return; }
    this.section = next; this.sectionId++; this.pickId++; clearTimeout(this.sectionTimer); this.clearCut(); this.clearMeasurement();
    delete this.host.dataset.sectionReady; $('section-statistics').replaceChildren();
    $('cut-enabled').checked = next.enabled; $('section-toggle').checked = next.enabled; $('cut-offset').value = next.offset; this.syncRange();
    $('normal-fields').hidden = next.axis !== 'custom'; $('renderer-label').textContent = next.enabled ? '剖切网格预览' : '网格预览';
    if (!this.mesh) return;
    const normal = new THREE.Vector3(...planeNormal(next)).multiplyScalar(next.positive ? 1 : -1);
    this.mesh.material.clippingPlanes = next.enabled ? [new THREE.Plane(normal,next.positive ? -next.offset : next.offset)] : [];
    this.mesh.visible = !(next.enabled && next.only);
    if (next.enabled) {
      $('section-message').textContent = '正在计算材料截面…'; $('section-message').classList.remove('error');
      this.sectionTimer = setTimeout(() => this.worker.postMessage({type:'section',id:this.sectionId,key:JSON.stringify(this.section),section:this.section}),180);
    } else { $('section-message').textContent = '剖切只改变查看状态，下载仍为完整模型。'; $('section-message').classList.remove('error'); }
    this.schedule();
  }
  clearMeasurement() {
    this.points = []; this.pickId++; this.armMeasurement(false); this.updateMarkers();
  }
  armMeasurement(armed) {
    this.measuring = armed; $('measure-start').setAttribute('aria-pressed',String(armed)); $('measure-start').textContent = armed ? '结束选点（Esc）' : '选择 A / B 点';
    this.renderer.domElement.style.cursor = armed ? 'crosshair' : '';
    $('viewport-caption').textContent = armed ? '单击选择测量点 · 拖动旋转 · Esc 结束' : '左键旋转 · 右键平移 · 滚轮缩放';
    this.schedule();
  }
  updateMarkers() {
    for (const child of [...this.markers.children]) this.clearObject(child);
    const radius = (this.diagonal || 1)*0.008;
    this.points.forEach((point,i) => {
      const marker = new THREE.Mesh(new THREE.SphereGeometry(radius,12,8),new THREE.MeshBasicMaterial({color:i ? '#7651bb' : '#ba354a',depthTest:false}));
      marker.position.set(...point); marker.renderOrder = 10; this.markers.add(marker);
    });
    if (this.points.length === 2) {
      const line = new THREE.BufferGeometry().setFromPoints(this.points.map(point => new THREE.Vector3(...point)));
      const marker = new THREE.Line(line,new THREE.LineBasicMaterial({color:this.light ? '#713b00' : '#fff09a',depthTest:false})); marker.renderOrder = 9; this.markers.add(marker);
      $('measurement').replaceChildren(row('A 点 / mm',this.points[0].map(v => number(v,3)).join(', ')),row('B 点 / mm',this.points[1].map(v => number(v,3)).join(', ')),row('直线距离',`${number(distanceBetween(...this.points),3)} mm`));
      $('distance-tag').textContent = `A–B · ${number(distanceBetween(...this.points),3)} mm`;
    } else $('measurement').replaceChildren(row('距离',this.points.length ? '请选 B 点' : '未选择'));
    this.schedule();
  }
  schedule() { if (!this.disposed && !this.requestId && !document.hidden) this.requestId = requestAnimationFrame(() => this.render()); }
  render() {
    this.requestId = 0; const changed = this.controls.update(); this.camera.updateMatrixWorld(); this.renderer.render(this.scene,this.camera);
    const canvas = $('orientation-gizmo'), ctx = canvas.getContext('2d'); ctx.clearRect(0,0,224,224); ctx.lineWidth = 5;
    const inverse = this.camera.quaternion.clone().invert();
    [[new THREE.Vector3(1,0,0),'X',this.light ? '#b42318' : '#f07878'],[new THREE.Vector3(0,1,0),'Y',this.light ? '#167447' : '#53c996'],[new THREE.Vector3(0,0,1),'Z',this.light ? '#175cd3' : '#79aaff']]
      .map(([v,label,color]) => [v.applyQuaternion(inverse),label,color]).sort((a,b) => a[0].z-b[0].z).forEach(([v,label,color]) => {
        ctx.strokeStyle = ctx.fillStyle = color; ctx.beginPath(); ctx.moveTo(112,116); ctx.lineTo(112+v.x*64,116-v.y*64); ctx.stroke();
        ctx.font = 'bold 32px Segoe UI'; ctx.textAlign = 'center'; ctx.fillText(label,112+v.x*90,126-v.y*90);
      });
    $('distance-tag').hidden = this.points.length !== 2;
    if (this.points.length === 2) {
      const mid = new THREE.Vector3(...this.points[0]).add(new THREE.Vector3(...this.points[1])).multiplyScalar(0.5).project(this.camera);
      $('distance-tag').hidden = Math.abs(mid.x)>1 || Math.abs(mid.y)>1 || Math.abs(mid.z)>1;
      $('distance-tag').style.left = `${(mid.x+1)/2*this.host.clientWidth}px`; $('distance-tag').style.top = `${(1-mid.y)/2*this.host.clientHeight}px`;
    }
    if (changed || this.controls.autoRotate) this.schedule();
  }
  dispose() {
    this.disposed = true; cancelAnimationFrame(this.requestId); clearTimeout(this.sectionTimer); clearTimeout(this.restore);
    this.worker.terminate(); this.observer.disconnect(); this.controls.dispose(); this.controls.stopListenToKeyEvents();
    this.clearCut(); this.clearObject(this.mesh); this.clearObject(this.grid);
    for (const marker of [...this.markers.children]) this.clearObject(marker);
    this.renderer.dispose();
  }
}

let viewer;
const controller = new AbortController();
async function start() {
  viewer = new ModelViewer();
  $('theme-toggle').onclick = () => viewer.setTheme(!viewer.light);
  const response = await fetch('models/gyroid-flanged-core.metadata.json',{signal:controller.signal,cache:'no-cache'});
  if (!response.ok) throw new Error('无法读取模型信息。');
  const metadata = await response.json(); showMetadata(metadata);
  const projectResponse = await fetch(`${metadata.project}?v=${metadata.sha256.slice(0,12)}`,{signal:controller.signal});
  if (!projectResponse.ok) throw new Error('无法读取建模项目。'); showProject(await projectResponse.json());
  $('loading-detail').textContent = `正在下载 ${number(metadata.stl_bytes/1024/1024)} MB STL…`;
  const modelResponse = await fetch($('download-stl').href,{signal:controller.signal});
  if (!modelResponse.ok) throw new Error('模型文件未能下载，请稍后重试。');
  let buffer;
  if (modelResponse.body?.getReader) {
    const reader = modelResponse.body.getReader(), chunks = []; let bytes = 0;
    while (true) { const {done,value} = await reader.read(); if (done) break; chunks.push(value); bytes += value.length;
      $('loading-progress').value = Math.min(100,bytes/metadata.stl_bytes*100); $('loading-detail').textContent = `已接收 ${number(bytes/1024/1024,1)} / ${number(metadata.stl_bytes/1024/1024,1)} MB`;
    }
    const joined = new Uint8Array(bytes); let offset = 0; for (const chunk of chunks) { joined.set(chunk,offset); offset += chunk.length; } buffer = joined.buffer;
  } else buffer = await modelResponse.arrayBuffer();
  if (buffer.byteLength !== metadata.stl_bytes) throw new Error('模型文件大小与发布记录不一致，请重新加载。');
  if (crypto.subtle) {
    const digest = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',buffer)),byte => byte.toString(16).padStart(2,'0')).join('');
    if (digest !== metadata.sha256) throw new Error('模型校验不一致，请清除缓存后重新加载。');
  }
  $('loading-title').textContent = '正在准备三维曲面'; $('loading-detail').textContent = '生成平滑法线与锐边，保留原始模型精度…'; $('loading-progress').removeAttribute('value');
  const result = await viewer.prepare(buffer);
  if (result.faces !== metadata.faces) throw new Error('模型面数与发布记录不一致。');
  viewer.host.dataset.loaded = 'true'; viewer.host.dataset.faces = String(result.faces); viewer.host.dataset.sha256 = metadata.sha256;
  $('loading').hidden = true; document.querySelectorAll('.model-control').forEach(button => { button.disabled = false; });
  for (const id of ['wireframe','grid-toggle','section-toggle']) $(id).disabled = false;
  document.querySelectorAll('#inspection-info input,#inspection-info select').forEach(input => { input.disabled = false; });
  status(`模型已加载 · ${number(result.faces,0)} 个三角面 · 原始精度 0.4 mm`);
  function bindWorkbench() {
  document.querySelectorAll('[data-action]').forEach(button => { button.onclick = () => {
    if (button.dataset.action === 'fit') viewer.fit();
    else if (button.dataset.action === 'wire') viewer.setWire(!viewer.mesh.material.wireframe);
    else if (button.dataset.action === 'section') { showInspector(true); viewer.setSection({...viewer.section,enabled:true}); }
    else if (button.dataset.action === 'measure') { showInspector(true); viewer.clearMeasurement(); viewer.armMeasurement(true); }
    else if (button.dataset.action === 'info') showInspector(false);
  }; });
  document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => viewer.fit(button.dataset.view); });
  document.querySelector('[data-action=wire]').setAttribute('aria-pressed',String(viewer.mesh.material.wireframe));
  }
  bindWorkbench(); document.addEventListener('workbenchchange',bindWorkbench);
  document.querySelectorAll('[data-zoom]').forEach(button => { button.onclick = () => { viewer.camera.position.sub(viewer.controls.target).multiplyScalar(Number(button.dataset.zoom)).add(viewer.controls.target); viewer.controls.update(); viewer.schedule(); }; });
  $('auto-rotate').onclick = () => { const enabled = !viewer.controls.autoRotate; viewer.controls.autoRotate = enabled; $('auto-rotate').setAttribute('aria-pressed',String(enabled)); $('auto-rotate').querySelector('span').textContent = enabled ? '停止旋转' : '自动旋转'; viewer.schedule(); };
  $('theme-toggle').onclick = () => viewer.setTheme(!viewer.light);
  $('wireframe').onchange = event => viewer.setWire(event.target.checked);
  $('grid-toggle').onchange = event => { viewer.grid.visible = event.target.checked; viewer.schedule(); };
  for (const id of ['section-toggle','cut-enabled']) $(id).onchange = event => { if (event.target.checked) showInspector(true); viewer.setSection({...viewer.section,enabled:event.target.checked}); };
  $('cut-axis').onchange = event => viewer.setSection({...viewer.section,axis:event.target.value,offset:0});
  for (const id of ['normal-x','normal-y','normal-z']) $(id).oninput = () => viewer.setSection({...viewer.section,normal:['normal-x','normal-y','normal-z'].map(axis => $(axis).value === '' ? NaN : Number($(axis).value))});
  $('cut-offset').oninput = event => viewer.setSection({...viewer.section,offset:event.target.value === '' ? NaN : Number(event.target.value)});
  $('cut-slider').oninput = event => viewer.setSection({...viewer.section,offset:Number(event.target.value)});
  for (const [id,key] of [['cut-positive','positive'],['cut-fill','fill'],['cut-only','only']]) $(id).onchange = event => viewer.setSection({...viewer.section,[key]:event.target.checked});
  $('cut-center').onclick = () => { const range = planeRange([viewer.bounds.min.toArray(),viewer.bounds.max.toArray()],planeNormal(viewer.section)); viewer.setSection({...viewer.section,offset:(range[0]+range[1])/2}); };
  $('cut-front').onclick = () => viewer.fit(null,planeNormal(viewer.section));
  $('measure-start').onclick = () => { if (viewer.measuring) viewer.armMeasurement(false); else { viewer.clearMeasurement(); viewer.armMeasurement(true); status('请选择模型表面的 A 点。'); } };
  $('inspection-reset').onclick = () => { for (const [id,value] of [['cut-positive',false],['cut-only',false],['cut-fill',true]]) $(id).checked = value; viewer.setSection({...viewer.section,enabled:false,only:false,fill:true,positive:false}); status('已恢复完整模型并清除测量。'); };
}
start().catch(error => {
  if (error.name === 'AbortError') return;
  if (viewer) viewer.failure(error.message);
  else { $('loading-title').textContent = '三维预览不可用'; $('loading-detail').textContent = '请检查浏览器的 WebGL 支持。仍可下载模型或项目。'; $('loading-progress').hidden = true; $('retry').hidden = false; status('无法启动 WebGL 预览。'); }
});
document.addEventListener('visibilitychange',() => viewer?.schedule());
window.addEventListener('keydown',event => { if (event.key === 'Escape') { viewer?.armMeasurement(false); if (viewer) viewer.pickId++; for (const panel of ['node-panel','info-panel']) $(panel).classList.remove('mobile-open'); $('nodes-toggle').setAttribute('aria-expanded','false'); $('info-toggle').setAttribute('aria-expanded','false'); } });
window.addEventListener('pagehide',() => { controller.abort(); viewer?.dispose(); });
