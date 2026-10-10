import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { DEFAULT_SECTION, planeNormal, distanceBetween } from './inspection_math.mjs';

function typed(bytes, Type) {
  const buffer = Uint8Array.from(bytes).buffer;
  return new Type(buffer);
}

const Viewport = forwardRef(function Viewport({ geometry, parameters, shader, theme, implicit, wireframe, onError, onRenderer,
  section = DEFAULT_SECTION, points = [], measuring = false, onBounds, onSectionStatus, onPick, onPickStatus }, ref) {
  const host = useRef();
  const axes = useRef();
  const runtime = useRef();
  const distanceTag = useRef();
  const inspectionCallbacks = useRef({});
  inspectionCallbacks.current = { onBounds, onSectionStatus, onPick, onPickStatus };
  const errorCallback = useRef(onError);
  const rendererCallback = useRef(onRenderer);
  errorCallback.current = onError;
  rendererCallback.current = onRenderer;
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    fit: () => runtime.current?.fit(),
    view: axis => runtime.current?.view(axis),
    viewNormal: normal => runtime.current?.viewNormal(normal),
    zoom: factor => runtime.current?.zoom(factor),
  }), []);

  useEffect(() => {
    let renderer;
    try { renderer = new THREE.WebGLRenderer({ antialias: true, stencil: true, powerPreference: 'high-performance' }); }
    catch (e) { setFailed(true); errorCallback.current('无法启动 WebGL 三维预览，请检查显卡驱动。' + e.message); return; }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    renderer.localClippingEnabled = true;
    host.current.appendChild(renderer.domElement);
    renderer.domElement.tabIndex = 0;
    renderer.domElement.setAttribute('aria-label', '三维模型：拖动旋转，滚轮缩放，方向键平移；也可使用视角按钮');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 10000);
    camera.up.set(0, 0, 1);
    camera.position.set(65, -85, 60);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.15;
    controls.listenToKeyEvents(renderer.domElement);
    scene.add(new THREE.HemisphereLight(0xdcecff, 0x25334c, 2.4));
    const key = new THREE.DirectionalLight(0xffffff, 3.5); key.position.set(30, -50, 70); scene.add(key);
    const fill = new THREE.DirectionalLight(0xa3d6ff, 1.7); fill.position.set(-50, 15, 35); scene.add(fill);
    let mesh, grid, rayMaterial, rayQuad, maskMesh, sectionLines, sectionCap, boxHelper;
    const markers = new THREE.Group(); scene.add(markers);
    let activeSection = DEFAULT_SECTION, measurePoints = [], picking = false, worker = null, sectionTimer, sectionId = 0, pickId = 0, lastGeometry;
    let pointerStart = null, currentKey = '';
    const maskScene = new THREE.Scene();
    const rayScene = new THREE.Scene();
    const rayCamera = new THREE.Camera();
    let light = false, disposed = false, scheduled = 0, interacting = false, restore;
    let bounds = new THREE.Box3(new THREE.Vector3(-20, -20, -20), new THREE.Vector3(20, 20, 20));
    const inverse = new THREE.Matrix4();
    const size = new THREE.Vector2();
    const axisContext = axes.current.getContext('2d');
    const clearObject = object => { if (object) { object.geometry.dispose(); object.material.map?.dispose(); object.material.dispose(); object.removeFromParent(); } };
    function clearSection() { clearObject(sectionLines); clearObject(sectionCap); sectionLines = null; sectionCap = null; }
    function updateRendererLabel() { rendererCallback.current(rayMaterial && !activeSection.enabled && !picking && !measurePoints.some(Boolean) ? 'GPU 隐式曲面' : activeSection.enabled ? '剖切网格预览' : '网格预览'); }
    function sectionKey() { return JSON.stringify({ axis: activeSection.axis, normal: activeSection.normal, offset: activeSection.offset }); }
    function createWorker(geometry) {
      worker?.terminate(); clearTimeout(sectionTimer); sectionId++; pickId++;
      worker = new Worker(new URL('./inspection.worker.js', import.meta.url), { type: 'module' });
      const positions = geometry.attributes.position.array.slice(), indices = geometry.index.array.slice();
      worker.postMessage({ type: 'geometry', positions, indices }, [positions.buffer, indices.buffer]);
      worker.onerror = () => { inspectionCallbacks.current.onSectionStatus?.({ error: '截面计算失败，请重新生成模型后重试' }); inspectionCallbacks.current.onPickStatus?.('测量计算失败，请重新生成模型后重试'); };
      worker.onmessage = ({ data }) => {
        if (disposed) return;
        if (data.type === 'section' && data.id === sectionId && activeSection.enabled && data.key === currentKey) {
          clearSection();
          if (data.error) { inspectionCallbacks.current.onSectionStatus?.({ error: data.error }); return; }
          const result = data.result;
          const lineGeometry = new THREE.BufferGeometry(); lineGeometry.setAttribute('position', new THREE.BufferAttribute(result.lines, 3));
          sectionLines = new THREE.LineSegments(lineGeometry, new THREE.LineBasicMaterial({ color: light ? '#9b460d' : '#ffbe7e' })); sectionLines.renderOrder = 3; scene.add(sectionLines);
          const capGeometry = new THREE.BufferGeometry(); capGeometry.setAttribute('position', new THREE.BufferAttribute(result.cap, 3));
          sectionCap = new THREE.Mesh(capGeometry, new THREE.MeshBasicMaterial({ color: light ? '#b96b2c' : '#ffb65f', side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
          sectionCap.visible = activeSection.fill; sectionCap.renderOrder = 2; scene.add(sectionCap);
          // Keep typed geometry buffers out of React state.
          const { lines, cap, ...statistics } = result;
          inspectionCallbacks.current.onSectionStatus?.({ result: statistics }); schedule();
        } else if (data.type === 'pick' && data.id === pickId && picking) {
          inspectionCallbacks.current.onPickStatus?.(data.error || (data.point ? '' : '未选中可见表面，请在模型或已填充切面上单击'));
          if (data.point) inspectionCallbacks.current.onPick?.(data.point);
        }
      };
    }
    function updateInspection() {
      clearTimeout(sectionTimer); clearSection(); sectionId++; pickId++; currentKey = sectionKey();
      let normal;
      try { normal = planeNormal(activeSection); } catch (e) { inspectionCallbacks.current.onSectionStatus?.({ error: e.message }); }
      if (mesh) {
        const signedNormal = normal && new THREE.Vector3(...normal).multiplyScalar(activeSection.positive ? 1 : -1);
        mesh.material.clippingPlanes = activeSection.enabled && normal ? [new THREE.Plane(signedNormal, activeSection.positive ? -activeSection.offset : activeSection.offset)] : [];
        mesh.visible = !(activeSection.enabled && activeSection.only && normal);
      }
      clearObject(boxHelper); boxHelper = null;
      if (activeSection.box && mesh) { boxHelper = new THREE.Box3Helper(bounds, light ? '#986415' : '#ead08b'); scene.add(boxHelper); }
      if (activeSection.enabled && normal && worker && mesh) {
        inspectionCallbacks.current.onSectionStatus?.({ pending: true });
        const id = sectionId, key = currentKey, snapshot = { ...activeSection };
        sectionTimer = setTimeout(() => worker?.postMessage({ type: 'section', id, key, section: snapshot }), 180);
      } else if (!activeSection.enabled) inspectionCallbacks.current.onSectionStatus?.(null);
      updateRendererLabel(); schedule();
    }
    function updateMarkers() {
      for (const child of [...markers.children]) clearObject(child);
      const radius = Math.max(0.01, bounds.getSize(new THREE.Vector3()).length() * 0.009);
      measurePoints.forEach((point, i) => {
        if (!point) return;
        const marker = new THREE.Mesh(new THREE.SphereGeometry(radius, 12, 8), new THREE.MeshBasicMaterial({ color: i ? '#7651bb' : '#ba354a', depthTest: false })); marker.position.set(...point); marker.renderOrder = 10; markers.add(marker);
        const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64;
        const context = canvas.getContext('2d'); context.fillStyle = '#172536'; context.beginPath(); context.arc(32, 32, 30, 0, Math.PI * 2); context.fill(); context.font = 'bold 38px Segoe UI'; context.textAlign = 'center'; context.fillStyle = '#ffffff'; context.fillText(i ? 'B' : 'A', 32, 46);
        const label = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(canvas), depthTest: false })); label.position.copy(marker.position).add(new THREE.Vector3(0, 0, radius * 2)); label.scale.setScalar(radius * 4); label.renderOrder = 11; markers.add(label);
      });
      if (measurePoints[0] && measurePoints[1]) {
        const geometry = new THREE.BufferGeometry().setFromPoints(measurePoints.map(p => new THREE.Vector3(...p)));
        const line = new THREE.Line(geometry, new THREE.LineDashedMaterial({ color: light ? '#713b00' : '#fff09a', dashSize: radius * 2, gapSize: radius, depthTest: false })); line.computeLineDistances(); line.renderOrder = 9; markers.add(line);
      }
      renderer.domElement.style.cursor = picking ? 'crosshair' : ''; updateRendererLabel(); schedule();
    }
    function pointerDown(event) { if (event.button === 0) pointerStart = { x: event.clientX, y: event.clientY, id: event.pointerId }; }
    function pointerUp(event) {
      const start = pointerStart; pointerStart = null;
      if (!picking || !worker || !mesh || !start || start.id !== event.pointerId || Math.hypot(event.clientX - start.x, event.clientY - start.y) > 4) return;
      const rect = renderer.domElement.getBoundingClientRect(), ndc = new THREE.Vector2((event.clientX - rect.left) / rect.width * 2 - 1, -(event.clientY - rect.top) / rect.height * 2 + 1);
      const ray = new THREE.Raycaster(); camera.updateMatrixWorld(); ray.setFromCamera(ndc, camera);
      inspectionCallbacks.current.onPickStatus?.('正在选取表面点…');
      worker.postMessage({ type: 'pick', id: ++pickId, origin: ray.ray.origin.toArray(), direction: ray.ray.direction.toArray(), section: activeSection, key: currentKey });
    }
    function escape(event) { if (event.key === 'Escape') { pointerStart = null; pickId++; inspectionCallbacks.current.onPickStatus?.(''); inspectionCallbacks.current.onPick?.(null); } }
    renderer.domElement.addEventListener('pointerdown', pointerDown);
    renderer.domElement.addEventListener('pointerup', pointerUp);
    window.addEventListener('keydown', escape);
    function drawAxes() {
      axisContext.clearRect(0, 0, 112, 112);
      axisContext.lineWidth = 2.5;
      const inverseRotation = camera.quaternion.clone().invert();
      const directions = [[new THREE.Vector3(1, 0, 0), 'X', '#f07878'], [new THREE.Vector3(0, 1, 0), 'Y', '#53c996'], [new THREE.Vector3(0, 0, 1), 'Z', '#79aaff']];
      directions.map(([vector, label, color]) => [vector.applyQuaternion(inverseRotation), label, color])
        .sort((a, b) => a[0].z - b[0].z).forEach(([v, label, color]) => {
          axisContext.strokeStyle = color; axisContext.fillStyle = color;
          const x = 56 + v.x * 32, y = 58 - v.y * 32;
          axisContext.beginPath(); axisContext.moveTo(56, 58); axisContext.lineTo(x, y); axisContext.stroke();
          axisContext.font = 'bold 16px Segoe UI'; axisContext.textAlign = 'center';
          axisContext.fillText(label, 56 + v.x * 45, 63 - v.y * 45);
        });
    }
    function render() {
      scheduled = 0;
      if (disposed) return;
      const changed = controls.update();
      camera.updateMatrixWorld();
      if (rayMaterial && !activeSection.enabled && !picking && !measurePoints.some(Boolean)) {
        renderer.getDrawingBufferSize(size);
        inverse.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();
        rayMaterial.uniforms.u_invViewProj.value.copy(inverse);
        rayMaterial.uniforms.u_viewport.value.copy(size);
        rayMaterial.uniforms.u_maxSteps.value = interacting ? 80 : 128;
        // A cleaned CPU silhouette excludes components removed by the modeling kernel.
        // It also provides an accurate base if ray stepping misses a thin surface.
        renderer.render(scene, camera);
        renderer.autoClear = false;
        renderer.render(maskScene, camera);
        renderer.render(rayScene, rayCamera);
        renderer.autoClear = true;
      } else { renderer.render(scene, camera); }
      drawAxes();
      if (distanceTag.current) {
        if (measurePoints[0] && measurePoints[1]) {
          const midpoint = new THREE.Vector3(...measurePoints[0]).add(new THREE.Vector3(...measurePoints[1])).multiplyScalar(0.5).project(camera);
          distanceTag.current.hidden = Math.abs(midpoint.x) > 1 || Math.abs(midpoint.y) > 1 || Math.abs(midpoint.z) > 1;
          distanceTag.current.style.left = `${(midpoint.x + 1) / 2 * host.current.clientWidth}px`; distanceTag.current.style.top = `${(1 - midpoint.y) / 2 * host.current.clientHeight}px`;
        } else distanceTag.current.hidden = true;
      }
      if (changed) schedule();
    }
    function schedule() { if (!scheduled && !disposed) scheduled = requestAnimationFrame(render); }
    controls.addEventListener('change', schedule);
    controls.addEventListener('start', () => {
      interacting = true; clearTimeout(restore);
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1)); schedule();
    });
    controls.addEventListener('end', () => {
      restore = setTimeout(() => { interacting = false; renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5)); schedule(); }, 140);
    });
    function resize() {
      const { width, height } = host.current.getBoundingClientRect();
      renderer.setSize(width, height); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); schedule();
    }
    const observer = new ResizeObserver(resize); observer.observe(host.current);
    function fit(axis, normal) {
      const center = bounds.getCenter(new THREE.Vector3());
      const diagonal = Math.max(1, bounds.getSize(new THREE.Vector3()).length());
      const distance = diagonal / (2 * Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * Math.max(1, 1 / camera.aspect) * 1.12;
      const direction = normal ? new THREE.Vector3(...normal).normalize() : axis === 'X' ? new THREE.Vector3(1, 0, 0) : axis === 'Y' ? new THREE.Vector3(0, -1, 0) : axis === 'Z' ? new THREE.Vector3(0, 0.001, 1) : new THREE.Vector3(1, -1.4, 0.95).normalize();
      if (Math.abs(direction.z) > 0.999999) direction.y = 0.001;
      controls.target.copy(center); camera.position.copy(center).addScaledVector(direction, distance);
      camera.near = diagonal / 1000; camera.far = diagonal * 100; camera.updateProjectionMatrix();
      controls.minDistance = diagonal * 0.035; controls.maxDistance = diagonal * 15;
      controls.update(); schedule();
    }
    function disableRay() {
      clearObject(rayQuad); rayQuad = null; rayMaterial = null;
      // maskMesh shares the original geometry; only its material is owned here.
      if (maskMesh) { maskMesh.material.dispose(); maskMesh.removeFromParent(); maskMesh = null; }
    }
    renderer.debug.onShaderError = (_gl, _program, _vs, _fs) => {
      disableRay(); rendererCallback.current('网格预览');
      errorCallback.current('隐式曲面着色器编译失败，已切换到网格预览。'); schedule();
    };
    function lost(event) { event.preventDefault(); errorCallback.current('显卡上下文丢失，请重新打开软件恢复预览。'); }
    renderer.domElement.addEventListener('webglcontextlost', lost);
    runtime.current = {
      fit: () => fit(), view: axis => fit(axis),
      viewNormal: normal => fit(null, normal),
      setSection(value) { activeSection = value; updateInspection(); },
      setMeasurement(value, armed) { measurePoints = value; picking = armed; updateMarkers(); },
      zoom: factor => { camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update(); schedule(); },
      setTheme(value) {
        light = value === 'light'; scene.background = new THREE.Color(light ? '#e8eef4' : '#171e27');
        if (mesh && !mesh.material.vertexColors) mesh.material.color.set(light ? '#24708f' : '#69adca');
        if (grid) grid.material.opacity = light ? 0.24 : 0.16;
        if (rayMaterial) rayMaterial.uniforms.u_lightBg.value = light ? 1 : 0;
        if (sectionLines) sectionLines.material.color.set(light ? '#9b460d' : '#ffbe7e');
        if (sectionCap) sectionCap.material.color.set(light ? '#b96b2c' : '#ffb65f');
        if (boxHelper) boxHelper.material.color.set(light ? '#986415' : '#ead08b');
        updateMarkers();
        schedule();
      },
      setGeometry(value, params, source, useImplicit, wires) {
        disableRay();
        const changed = value !== lastGeometry; lastGeometry = value;
        if (changed) { clearObject(mesh); clearObject(grid); clearSection(); clearObject(boxHelper); mesh = null; grid = null; boxHelper = null; worker?.terminate(); worker = null; clearTimeout(sectionTimer); sectionId++; pickId++; }
        if (!value) { inspectionCallbacks.current.onBounds?.(null); for (const child of [...markers.children]) clearObject(child); schedule(); return; }
        const geometry = changed ? new THREE.BufferGeometry() : mesh.geometry;
        if (changed) {
          geometry.setAttribute('position', new THREE.BufferAttribute(typed(value.positions, Float32Array), 3));
          geometry.setIndex(new THREE.BufferAttribute(typed(value.indices, Uint32Array), 1));
          if (value.colors) geometry.setAttribute('color', new THREE.BufferAttribute(typed(value.colors, Float32Array), 3));
          geometry.computeVertexNormals(); geometry.computeBoundingBox();
          mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: value.colors ? '#ffffff' : (light ? '#24708f' : '#69adca'), roughness: 0.44, metalness: 0.15, side: THREE.DoubleSide, vertexColors: !!value.colors, wireframe: wires }));
          scene.add(mesh);
          if (geometry.boundingBox && !geometry.boundingBox.isEmpty()) bounds.copy(geometry.boundingBox);
          const center = bounds.getCenter(new THREE.Vector3());
          const extent = Math.max(...bounds.getSize(new THREE.Vector3()).toArray());
          grid = new THREE.GridHelper(extent * 2, 20, 0x7f99af, 0x7f99af); grid.rotation.x = Math.PI / 2;
          grid.position.set(center.x, center.y, bounds.min.z - extent * 0.03); grid.material.transparent = true; grid.material.opacity = light ? 0.24 : 0.16; scene.add(grid);
          createWorker(geometry);
          inspectionCallbacks.current.onBounds?.([bounds.min.toArray(), bounds.max.toArray()]);
          updateInspection();
          updateMarkers();
        }
        mesh.material.wireframe = wires;
        const extent = Math.max(...bounds.getSize(new THREE.Vector3()).toArray());
        const surfaces = ['Gyroid', 'Diamond', 'Primitive', 'I-WP', 'Neovius'];
        if (useImplicit && source && params && surfaces.includes(params.surface) && !params.tubular_enabled && !value.colors && !wires) {
          const cell = Math.min(params.size_x / params.cells_x, params.size_y / params.cells_y, params.size_z / params.cells_z);
          rayMaterial = new THREE.RawShaderMaterial({ glslVersion: THREE.GLSL3,
            vertexShader: 'precision highp float; in vec3 position; void main() { gl_Position = vec4(position, 1.0); }',
            fragmentShader: 'precision highp float; precision highp int;\n' + source
              .replaceAll('mix(vec3(0.035,0.055,0.07), vec3(0.975,0.982,0.978), u_lightBg)', 'mix(vec3(0.090,0.118,0.153), vec3(0.910,0.933,0.957), u_lightBg)')
              .replaceAll('frag_color = vec4(bg, 1.0);', 'discard;'),
            uniforms: {
              u_invViewProj: { value: new THREE.Matrix4() }, u_viewport: { value: new THREE.Vector2() },
              u_size: { value: new THREE.Vector3(params.size_x, params.size_y, params.size_z) },
              u_cells: { value: new THREE.Vector3(params.cells_x, params.cells_y, params.cells_z) },
              u_surface: { value: surfaces.indexOf(params.surface) }, u_mode: { value: params.mode === 'sheet' ? 0 : 1 },
              u_thickness: { value: params.thickness }, u_isoLevel: { value: params.iso_level },
              u_gradEnabled: { value: params.gradient_enabled ? 1 : 0 }, u_gradAxis: { value: ['X', 'Y', 'Z'].indexOf(params.gradient_axis) },
              u_gradStart: { value: params.gradient_thickness_start }, u_gradEnd: { value: params.gradient_thickness_end },
              u_lightBg: { value: light ? 1 : 0 }, u_pan: { value: new THREE.Vector3() },
              u_maxSteps: { value: 128 }, u_minStep: { value: Math.max(0.003, cell / 2000) },
              u_maxStep: { value: cell / 9 }, u_maxDist: { value: extent * 100 }, u_eps: { value: Math.max(0.001, cell / 2000) },
            }, depthTest: false, depthWrite: false,
            stencilWrite: true, stencilRef: 1, stencilFunc: THREE.EqualStencilFunc,
          });
          maskMesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ colorWrite: false,
            depthWrite: false, depthTest: false, side: THREE.DoubleSide,
            stencilWrite: true, stencilRef: 1, stencilFunc: THREE.AlwaysStencilFunc,
            stencilZPass: THREE.ReplaceStencilOp }));
          maskScene.add(maskMesh);
          rayQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), rayMaterial); rayQuad.frustumCulled = false; rayScene.add(rayQuad);
        }
        updateRendererLabel();
        if (changed) fit(); else schedule();
      },
    };
    resize();
    return () => {
      disposed = true; cancelAnimationFrame(scheduled); clearTimeout(restore);
      observer.disconnect(); controls.stopListenToKeyEvents(); controls.dispose();
      clearObject(mesh); clearObject(grid); disableRay(); clearSection(); clearObject(boxHelper);
      for (const child of [...markers.children]) clearObject(child);
      worker?.terminate(); clearTimeout(sectionTimer);
      renderer.domElement.removeEventListener('pointerdown', pointerDown); renderer.domElement.removeEventListener('pointerup', pointerUp); window.removeEventListener('keydown', escape);
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose(); renderer.domElement.remove(); runtime.current = null;
    };
  }, []);

  useEffect(() => { runtime.current?.setTheme(theme); }, [theme]);
  useEffect(() => { runtime.current?.setGeometry(geometry, parameters, shader, implicit, wireframe); }, [geometry, parameters, shader, implicit, wireframe]);
  useEffect(() => { runtime.current?.setSection(section); }, [section]);
  useEffect(() => { runtime.current?.setMeasurement(points, measuring); }, [points, measuring]);
  return <><div className="canvas-host" ref={host}>{failed && <div className="empty"><h2>三维预览不可用</h2><p>请检查显卡驱动后重新启动。建模与导出仍可使用。</p></div>}</div><canvas className="axis-triad" width="112" height="112" ref={axes} aria-label="随视角旋转的 XYZ 三轴方向标" /><div className="distance-tag" ref={distanceTag} hidden>{points[0] && points[1] ? `A–B · ${distanceBetween(...points).toFixed(3)} mm` : ''}</div></>;
});
export default Viewport;
