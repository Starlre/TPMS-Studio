import { sectionMesh, pickMeshPoint } from './inspection_math.mjs';
let positions, indices, cut = null, cutKey = '';
self.onmessage = ({ data }) => {
  try {
    if (data.type === 'geometry') { positions = data.positions; indices = data.indices; cut = null; cutKey = ''; return; }
    if (!positions) return;
    if (data.type === 'section') {
      cut = sectionMesh(positions, indices, data.section); cutKey = data.key;
      // Keep one cap copy for surface picking; transfer the render buffers.
      const answer = { ...cut, cap: cut.cap.slice() };
      self.postMessage({ type: 'section', id: data.id, key: data.key, result: answer }, [answer.lines.buffer, answer.cap.buffer]);
    } else if (data.type === 'pick') {
      const point = pickMeshPoint(positions, indices, data.origin, data.direction, data.section, cutKey === data.key ? cut?.cap : null);
      self.postMessage({ type: 'pick', id: data.id, point });
    }
  } catch (error) { self.postMessage({ type: data.type, id: data.id, error: error.message }); }
};
