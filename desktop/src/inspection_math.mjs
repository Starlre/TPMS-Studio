import { ShapeUtils, Vector2 } from 'three';

export const DEFAULT_SECTION = { enabled: false, axis: 'Z', normal: [1, 1, 1], offset: 0,
  positive: false, only: false, fill: true, box: false };
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const subtract = (a, b) => a.map((v, i) => v - b[i]);
export function distanceBetween(a, b) { return Math.hypot(...subtract(a, b)); }
export function planeNormal(section) {
  const n = section.axis === 'custom' ? section.normal : ['X', 'Y', 'Z'].map(axis => +(section.axis === axis));
  if (!n || n.length !== 3 || !n.every(Number.isFinite)) throw new Error('法向量需要三个有限数字');
  const length = Math.hypot(...n);
  if (length < 1e-12) throw new Error('法向量不能为零，请修改 X/Y/Z 分量');
  return n.map(v => v / length);
}
export function planeRange(bounds, normal) {
  const corners = Array.from({ length: 8 }, (_, mask) => normal.reduce((s, v, i) => s + v * bounds[(mask >> i) & 1][i], 0));
  return [Math.min(...corners), Math.max(...corners)];
}
export function visiblePoint(point, section, tolerance = 1e-7) {
  if (!section?.enabled) return true;
  const signed = dot(point, planeNormal(section)) - section.offset;
  return section.positive ? signed >= -tolerance : signed <= tolerance;
}
function inside(point, polygon) {
  let result = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i], b = polygon[j];
    if ((a.y > point.y) !== (b.y > point.y) && point.x < (b.x - a.x) * (point.y - a.y) / (b.y - a.y) + a.x) result = !result;
  }
  return result;
}

// Work on the exact display mesh in a worker. Endpoints on shared indexed edges
// are reused; coordinate welding also handles seams with duplicated vertices.
export function sectionMesh(positions, indices, section) {
  const n = planeNormal(section), offset = section.offset;
  if (!Number.isFinite(offset)) throw new Error('剖切位置需要有限数字');
  const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i++) { const a = i % 3; min[a] = Math.min(min[a], positions[i]); max[a] = Math.max(max[a], positions[i]); }
  const eps = Math.max(1e-9, distanceBetween(min, max) * 1e-7);
  const vertex = id => [positions[id * 3], positions[id * 3 + 1], positions[id * 3 + 2]];
  const nodes = [], weld = new Map(), intersections = new Map(), segments = [], edges = new Set();
  function nodeAt(point) {
    const key = point.map(v => Math.round(v / eps)).join(',');
    if (!weld.has(key)) { weld.set(key, nodes.length); nodes.push(point); }
    return weld.get(key);
  }
  let limited = false;
  for (let i = 0; i < indices.length; i += 3) {
    const ids = [indices[i], indices[i + 1], indices[i + 2]], vertices = ids.map(vertex);
    const d = vertices.map(p => dot(n, p) - offset);
    if (d.every(v => v > eps) || d.every(v => v < -eps) || d.every(v => Math.abs(v) <= eps)) continue;
    const hits = new Set();
    for (let j = 0; j < 3; j++) {
      const k = (j + 1) % 3;
      if (Math.abs(d[j]) <= eps) hits.add(nodeAt(vertices[j]));
      if (d[j] * d[k] < 0 && Math.abs(d[j]) > eps && Math.abs(d[k]) > eps) {
        const key = ids[j] < ids[k] ? `${ids[j]}:${ids[k]}` : `${ids[k]}:${ids[j]}`;
        if (!intersections.has(key)) {
          const t = d[j] / (d[j] - d[k]);
          intersections.set(key, nodeAt(vertices[j].map((v, a) => v + t * (vertices[k][a] - v))));
        }
        hits.add(intersections.get(key));
      }
    }
    if (hits.size !== 2) continue;
    const [a, b] = hits, key = a < b ? `${a}:${b}` : `${b}:${a}`;
    if (!edges.has(key) && distanceBetween(nodes[a], nodes[b]) > eps) { edges.add(key); segments.push([a, b]); }
    if (segments.length > 200000) { limited = true; break; }
  }
  const linePositions = new Float32Array(segments.flatMap(pair => pair.flatMap(id => nodes[id])));
  const adjacency = new Map();
  for (const [a, b] of segments) { if (!adjacency.has(a)) adjacency.set(a, []); if (!adjacency.has(b)) adjacency.set(b, []); adjacency.get(a).push(b); adjacency.get(b).push(a); }
  const visited = new Set(), loops = []; let open = 0;
  for (const start of adjacency.keys()) {
    if (visited.has(start)) continue;
    const component = [], pending = [start]; let closed = true;
    while (pending.length) { const id = pending.pop(); if (visited.has(id)) continue; visited.add(id); component.push(id); const next = adjacency.get(id); if (next.length !== 2) closed = false; for (const child of next) if (!visited.has(child)) pending.push(child); }
    if (!closed || component.length < 3) { open++; continue; }
    const loop = [start]; let previous = start, current = adjacency.get(start)[0];
    while (current !== start && loop.length <= component.length) { loop.push(current); const next = adjacency.get(current).find(id => id !== previous); previous = current; current = next; }
    if (current === start && loop.length === component.length) loops.push(loop.map(id => nodes[id])); else open++;
  }
  const axis = Math.abs(n[2]) < 0.9 ? [0, 0, 1] : [0, 1, 0];
  const u0 = cross(axis, n), length = Math.hypot(...u0), u = u0.map(v => v / length), v = cross(n, u);
  const origin = n.map(value => value * offset);
  const polygons = loops.map(loop => loop.map(p => new Vector2(dot(subtract(p, origin), u), dot(subtract(p, origin), v))));
  const areas = polygons.map(p => Math.abs(ShapeUtils.area(p)));
  const parents = polygons.map((polygon, i) => {
    let parent = -1;
    for (let j = 0; j < polygons.length; j++) if (areas[j] > areas[i] + eps * eps && inside(polygon[0], polygons[j]) && (parent < 0 || areas[j] < areas[parent])) parent = j;
    return parent;
  });
  const depths = parents.map((_, i) => { let depth = 0, parent = parents[i]; while (parent !== -1) { depth++; parent = parents[parent]; } return depth; });
  const cap = []; let area = 0;
  // An open/ambiguous section is shown as lines only: do not invent solid fill.
  if (!open && !limited) {
    for (let i = 0; i < polygons.length; i++) {
      area += depths[i] % 2 ? -areas[i] : areas[i];
      if (depths[i] % 2) continue;
      const children = polygons.filter((_, j) => parents[j] === i && depths[j] === depths[i] + 1);
      const points = [polygons[i], ...children].flat();
      for (const triangle of ShapeUtils.triangulateShape(polygons[i], children)) for (const id of triangle) cap.push(...origin.map((value, a) => value + points[id].x * u[a] + points[id].y * v[a]));
    }
  }
  const perimeter = segments.reduce((sum, [a, b]) => sum + distanceBetween(nodes[a], nodes[b]), 0);
  return { lines: linePositions, cap: new Float32Array(cap), area: open || limited ? null : Math.max(0, area), perimeter,
    loops: loops.length, segments: segments.length, open, limited,
    warning: limited ? '截面超过 20 万线段，仅显示部分轮廓，请降低模型精度' : open ? '截面存在开放或分叉轮廓，仅显示轮廓，无法可靠计算面积' : '' };
}

function rayTriangle(origin, direction, a, b, c) {
  const e1 = subtract(b, a), e2 = subtract(c, a), p = cross(direction, e2), determinant = dot(e1, p);
  if (Math.abs(determinant) < 1e-15) return Infinity;
  const inverse = 1 / determinant, t = subtract(origin, a), u = dot(t, p) * inverse;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const q = cross(t, e1), v = dot(direction, q) * inverse;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  const distance = dot(e2, q) * inverse;
  return distance >= 0 ? distance : Infinity;
}
export function pickMeshPoint(positions, indices, origin, direction, section, cap = null) {
  let nearest = Infinity, hit = null;
  function consider(a, b, c, cutFace = false) {
    const t = rayTriangle(origin, direction, a, b, c);
    if (!Number.isFinite(t) || t >= nearest) return;
    const point = origin.map((value, i) => value + t * direction[i]);
    if (!cutFace && (section?.only && section.enabled || !visiblePoint(point, section))) return;
    nearest = t; hit = point;
  }
  const vertex = id => Array.from(positions.subarray(id * 3, id * 3 + 3));
  if (!(section?.enabled && section.only)) for (let i = 0; i < indices.length; i += 3) consider(vertex(indices[i]), vertex(indices[i + 1]), vertex(indices[i + 2]));
  if (section?.enabled && section.fill && cap) for (let i = 0; i < cap.length; i += 9) consider(Array.from(cap.subarray(i, i + 3)), Array.from(cap.subarray(i + 3, i + 6)), Array.from(cap.subarray(i + 6, i + 9)), true);
  return hit;
}
