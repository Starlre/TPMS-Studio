import React, { useEffect, useRef, useState, useImperativeHandle, forwardRef } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

function typed(bytes, Type) {
  const buffer = Uint8Array.from(bytes).buffer;
  return new Type(buffer);
}

const Viewport = forwardRef(function Viewport({ geometry, parameters, shader, theme, implicit, wireframe, onError, onRenderer }, ref) {
  const host = useRef();
  const axes = useRef();
  const runtime = useRef();
  const errorCallback = useRef(onError);
  const rendererCallback = useRef(onRenderer);
  errorCallback.current = onError;
  rendererCallback.current = onRenderer;
  const [failed, setFailed] = useState(false);

  useImperativeHandle(ref, () => ({
    fit: () => runtime.current?.fit(),
    view: axis => runtime.current?.view(axis),
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
    let mesh, grid, rayMaterial, rayQuad, maskMesh;
    const maskScene = new THREE.Scene();
    const rayScene = new THREE.Scene();
    const rayCamera = new THREE.Camera();
    let light = false, disposed = false, scheduled = 0, interacting = false, restore;
    let bounds = new THREE.Box3(new THREE.Vector3(-20, -20, -20), new THREE.Vector3(20, 20, 20));
    const inverse = new THREE.Matrix4();
    const size = new THREE.Vector2();
    const axisContext = axes.current.getContext('2d');
    const clearObject = object => { if (object) { object.geometry.dispose(); object.material.dispose(); object.removeFromParent(); } };
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
      if (rayMaterial) {
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
    function fit(axis) {
      const center = bounds.getCenter(new THREE.Vector3());
      const diagonal = Math.max(1, bounds.getSize(new THREE.Vector3()).length());
      const distance = diagonal / (2 * Math.sin(THREE.MathUtils.degToRad(camera.fov / 2))) * Math.max(1, 1 / camera.aspect) * 1.12;
      const direction = axis === 'X' ? new THREE.Vector3(1, 0, 0) : axis === 'Y' ? new THREE.Vector3(0, -1, 0) : axis === 'Z' ? new THREE.Vector3(0, 0.001, 1) : new THREE.Vector3(1, -1.4, 0.95).normalize();
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
      zoom: factor => { camera.position.sub(controls.target).multiplyScalar(factor).add(controls.target); controls.update(); schedule(); },
      setTheme(value) {
        light = value === 'light'; scene.background = new THREE.Color(light ? '#e8eef4' : '#171e27');
        if (mesh && !mesh.material.vertexColors) mesh.material.color.set(light ? '#24708f' : '#69adca');
        if (grid) grid.material.opacity = light ? 0.24 : 0.16;
        if (rayMaterial) rayMaterial.uniforms.u_lightBg.value = light ? 1 : 0;
        schedule();
      },
      setGeometry(value, params, source, useImplicit, wires) {
        disableRay(); clearObject(mesh); clearObject(grid); mesh = null; grid = null;
        if (!value) { schedule(); return; }
        const geometry = new THREE.BufferGeometry();
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
          rendererCallback.current('GPU 隐式曲面');
        } else rendererCallback.current('网格预览');
        fit();
      },
    };
    resize();
    return () => {
      disposed = true; cancelAnimationFrame(scheduled); clearTimeout(restore);
      observer.disconnect(); controls.stopListenToKeyEvents(); controls.dispose();
      clearObject(mesh); clearObject(grid); disableRay();
      renderer.domElement.removeEventListener('webglcontextlost', lost);
      renderer.dispose(); renderer.domElement.remove(); runtime.current = null;
    };
  }, []);

  useEffect(() => { runtime.current?.setTheme(theme); }, [theme]);
  useEffect(() => { runtime.current?.setGeometry(geometry, parameters, shader, implicit, wireframe); }, [geometry, parameters, shader, implicit, wireframe]);
  return <><div className="canvas-host" ref={host}>{failed && <div className="empty"><h2>三维预览不可用</h2><p>请检查显卡驱动后重新启动。建模与导出仍可使用。</p></div>}</div><canvas className="axis-triad" width="112" height="112" ref={axes} aria-label="随视角旋转的 XYZ 三轴方向标" /></>;
});
export default Viewport;
