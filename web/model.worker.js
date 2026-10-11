import { STLLoader } from 'three/addons/loaders/STLLoader.js';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { createDisplayGeometry } from '../desktop/src/display_geometry.mjs';
import { sectionMesh, pickMeshPoint } from '../desktop/src/inspection_math.mjs';

let positions, indices, cut = null, cutKey = '';
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'prepare') {
      const parsed = new STLLoader().parse(data.buffer);
      // STL stores independent triangles. Reconstruct shared vertices only at
      // float precision before computing crease normals on this verified model.
      parsed.deleteAttribute('normal');
      const source = mergeVertices(parsed, 1e-6);
      positions = source.attributes.position.array; indices = new Uint32Array(source.index.array);
      const display = createDisplayGeometry(source);
      const answer = { type: 'prepared', positions: display.attributes.position.array,
        normals: display.attributes.normal.array, indices: display.index.array, faces: indices.length / 3,
        vertices: positions.length / 3, bounds: [display.boundingBox.min.toArray(), display.boundingBox.max.toArray()] };
      const transfers = [...new Set([answer.positions.buffer, answer.normals.buffer, answer.indices.buffer])];
      // Smooth models can share the input position attribute. Retain it for
      // inspection rather than transferring and detaching the worker's copy.
      if (answer.positions.buffer === positions.buffer) { answer.positions = answer.positions.slice(); transfers[transfers.indexOf(positions.buffer)] = answer.positions.buffer; }
      self.postMessage(answer, transfers);
      display.dispose(); source.dispose(); parsed.dispose(); return;
    }
    if (!positions) throw new Error('模型尚未准备完成');
    if (data.type === 'section') {
      cut = sectionMesh(positions, indices, data.section); cutKey = data.key;
      const result = { ...cut, cap: cut.cap.slice() };
      self.postMessage({ type: 'section', id: data.id, key: data.key, result }, [result.lines.buffer, result.cap.buffer]);
    } else if (data.type === 'pick') {
      const point = pickMeshPoint(positions, indices, data.origin, data.direction, data.section, cutKey === data.key ? cut?.cap : null);
      self.postMessage({ type: 'pick', id: data.id, point });
    }
  } catch (error) { self.postMessage({ type: data.type === 'prepare' ? 'prepared' : data.type, id: data.id, key: data.key, error: error.message }); }
};
