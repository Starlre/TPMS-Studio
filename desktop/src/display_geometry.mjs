import { BufferGeometry, BufferAttribute } from 'three';

export const IMPLICIT_SURFACES = ['Gyroid', 'Diamond', 'Primitive', 'I-WP', 'Neovius'];
export const supportsImplicitPreview = parameters => !!parameters &&
  IMPLICIT_SURFACES.includes(parameters.surface) && !parameters.tubular_enabled;

// Smooth by corner angle, splitting only vertices whose incident faces cross a
// crease. Use source indices, never a coordinate weld: nearby thin walls stay
// separate. Positions and triangle winding remain exactly as generated.
export function createDisplayGeometry(source, creaseAngle = Math.PI / 6) {
  if (!source.index) throw new Error('Display geometry requires indexed triangles');
  const positions = source.getAttribute('position'), indices = source.index.array;
  const vertices = positions.count, faces = indices.length / 3;
  const faceNormals = new Float32Array(faces * 3);
  const weights = new Float32Array(indices.length);
  const counts = new Uint32Array(vertices);
  const offsets = new Uint32Array(vertices + 1);
  const accumulated = new Float64Array(vertices * 3);
  for (const v of indices) counts[v]++;
  for (let v = 0; v < vertices; v++) offsets[v + 1] = offsets[v] + counts[v];
  const cursor = offsets.slice(0, vertices), incident = new Uint32Array(indices.length);
  for (let k = 0; k < indices.length; k++) incident[cursor[indices[k]]++] = k;
  for (let f = 0; f < faces; f++) {
    const k = f * 3, a = indices[k], b = indices[k + 1], c = indices[k + 2];
    const ax = positions.getX(a), ay = positions.getY(a), az = positions.getZ(a);
    const ux = positions.getX(b) - ax, uy = positions.getY(b) - ay, uz = positions.getZ(b) - az;
    const vx = positions.getX(c) - ax, vy = positions.getY(c) - ay, vz = positions.getZ(c) - az;
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const length = Math.hypot(nx, ny, nz);
    if (length === 0) continue;
    faceNormals[k] = nx / length; faceNormals[k + 1] = ny / length; faceNormals[k + 2] = nz / length;
    for (let corner = 0; corner < 3; corner++) {
      const v = indices[k + corner], p = indices[k + (corner + 1) % 3], q = indices[k + (corner + 2) % 3];
      const ex = positions.getX(p) - positions.getX(v), ey = positions.getY(p) - positions.getY(v), ez = positions.getZ(p) - positions.getZ(v);
      const dx = positions.getX(q) - positions.getX(v), dy = positions.getY(q) - positions.getY(v), dz = positions.getZ(q) - positions.getZ(v);
      const denominator = Math.hypot(ex, ey, ez) * Math.hypot(dx, dy, dz);
      const angle = denominator ? Math.acos(Math.max(-1, Math.min(1, (ex * dx + ey * dy + ez * dz) / denominator))) : 0;
      weights[k + corner] = angle;
      for (let axis = 0; axis < 3; axis++) accumulated[v * 3 + axis] += faceNormals[k + axis] * angle;
    }
  }
  const normals = new Float32Array(vertices * 3);
  for (let v = 0; v < vertices; v++) {
    const length = Math.hypot(accumulated[v * 3], accumulated[v * 3 + 1], accumulated[v * 3 + 2]) || 1;
    for (let axis = 0; axis < 3; axis++) normals[v * 3 + axis] = accumulated[v * 3 + axis] / length;
  }
  const resultIndices = new Uint32Array(indices), extraVertices = [], extraNormals = [];
  const splitGroups = new Map(), cosine = Math.cos(creaseAngle);
  const creased = new Uint8Array(vertices);
  for (let v = 0; v < vertices; v++) {
    outer: for (let i = offsets[v]; i < offsets[v + 1]; i++) {
      const a = Math.floor(incident[i] / 3) * 3;
      for (let j = i + 1; j < offsets[v + 1]; j++) {
        const b = Math.floor(incident[j] / 3) * 3;
        if (weights[incident[i]] && weights[incident[j]] &&
          faceNormals[a] * faceNormals[b] + faceNormals[a + 1] * faceNormals[b + 1] + faceNormals[a + 2] * faceNormals[b + 2] < cosine - 1e-6) {
          creased[v] = 1; break outer;
        }
      }
    }
  }
  for (let k = 0; k < indices.length; k++) {
    const v = indices[k], f = Math.floor(k / 3) * 3;
    if (!creased[v]) continue;
    let x = 0, y = 0, z = 0, rejected = false, group = '';
    for (let j = offsets[v]; j < offsets[v + 1]; j++) {
      const corner = incident[j], other = Math.floor(corner / 3) * 3;
      const dot = faceNormals[f] * faceNormals[other] + faceNormals[f + 1] * faceNormals[other + 1] + faceNormals[f + 2] * faceNormals[other + 2];
      if (dot < cosine - 1e-6 && weights[corner] > 0) { rejected = true; continue; }
      const weight = weights[corner];
      x += faceNormals[other] * weight; y += faceNormals[other + 1] * weight; z += faceNormals[other + 2] * weight;
      group += `${other},`;
    }
    if (!rejected) continue;
    const key = `${v}:${group}`;
    let index = splitGroups.get(key);
    if (index === undefined) {
      index = vertices + extraVertices.length; splitGroups.set(key, index);
      extraVertices.push(v);
      const length = Math.hypot(x, y, z) || 1;
      extraNormals.push(x / length, y / length, z / length);
    }
    resultIndices[k] = index;
  }
  const result = new BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    if (name === 'normal') continue;
    if (!extraVertices.length) { result.setAttribute(name, attribute); continue; }
    const array = new attribute.array.constructor((vertices + extraVertices.length) * attribute.itemSize);
    array.set(attribute.array);
    extraVertices.forEach((v, i) => array.set(attribute.array.subarray(v * attribute.itemSize, (v + 1) * attribute.itemSize), (vertices + i) * attribute.itemSize));
    result.setAttribute(name, new BufferAttribute(array, attribute.itemSize, attribute.normalized));
  }
  const resultNormals = new Float32Array(normals.length + extraNormals.length);
  resultNormals.set(normals); resultNormals.set(extraNormals, normals.length);
  result.setAttribute('normal', new BufferAttribute(resultNormals, 3));
  result.setIndex(new BufferAttribute(resultIndices, 1));
  result.computeBoundingBox();
  return result;
}
