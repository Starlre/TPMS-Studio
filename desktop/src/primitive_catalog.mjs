// Single source of truth for workflow primitives, booleans, feature operations,
// node defaults, editor metadata and Ribbon tool wiring.
export const PRIMITIVES = [
  { kind: 'box', name: '长方体', dimensions: [16, 16, 16], labels: ['X 长度', 'Y 长度', 'Z 长度'], hint: 'XYZ 外形长度；位置为中心' },
  { kind: 'cube', name: '立方体', dimensions: [16], labels: ['边长'], hint: '一个边长同时控制 XYZ' },
  { kind: 'rounded_box', name: '圆角方盒', dimensions: [16, 20, 12, 2], labels: ['X 长度', 'Y 长度', 'Z 长度', '圆角半径'], hint: '外形长度保持不变；圆角小于最短边的一半' },
  { kind: 'cylinder', name: '圆柱', dimensions: [6, 24], labels: ['半径', '高度'], hint: '局部 Z 轴；高度含两端平面' },
  { kind: 'rounded_cylinder', name: '圆角圆柱', dimensions: [6, 24, 2], labels: ['半径', '高度', '圆角半径'], hint: '外径和总高度保持不变；端面与侧面圆角过渡' },
  { kind: 'capsule', name: '胶囊体', dimensions: [6, 24], labels: ['半径', '总高度'], hint: '局部 Z 轴；总高度含两端半球且不小于直径' },
  { kind: 'sphere', name: '球体', dimensions: [8], labels: ['半径'], hint: '半径控制球体大小；位置为球心' },
  { kind: 'cone', name: '圆锥', dimensions: [8, 20], labels: ['底面半径', '高度'], hint: '局部 Z 轴；尖端位于 +Z，底面位于 −Z' },
  { kind: 'frustum', name: '圆台', dimensions: [8, 4, 20], labels: ['底面半径', '顶面半径', '高度'], hint: '底面位于 −Z，顶面位于 +Z' },
  { kind: 'ellipsoid', name: '椭球体', dimensions: [10, 6, 8], labels: ['X 半轴', 'Y 半轴', 'Z 半轴'], hint: '输入半轴长度，外形尺寸为半轴的两倍' },
  { kind: 'torus', name: '圆环', dimensions: [10, 3], labels: ['主半径', '管半径'], hint: '位于局部 XY 平面；主半径必须大于管半径' },
];
export const COMMON_PRIMITIVES = ['box', 'sphere', 'cylinder', 'torus'];

export const BOOLEAN_OPS = [
  { kind: 'union', name: '并集', nodeName: '并集', arity: 2, category: 'boolean', inlineGroup: '布尔', iconKey: 'GitMerge' },
  { kind: 'intersection', name: '交集', nodeName: '交集', arity: 2, category: 'boolean', inlineGroup: '布尔', iconKey: 'GitCompare' },
  { kind: 'difference', name: '差集', nodeName: '差集 A−B', arity: 2, category: 'boolean', inlineGroup: '布尔', iconKey: 'Minus' },
  { kind: 'smooth_union', name: '平滑融合', nodeName: '平滑融合', arity: 2, category: 'boolean', inlineGroup: '布尔', iconKey: 'Sparkles' },
  { kind: 'smooth_difference', name: '平滑差集', nodeName: '平滑差集', arity: 2, category: 'boolean', inlineGroup: '布尔', iconKey: 'MinusCircle' },
];

export const FEATURE_OPS = [
  { kind: 'transform', name: '变换', ribbonLabel: '独立变换', arity: 1, dimensions: [], category: 'operation', inlineGroup: '操作', placement: 'node', iconKey: 'Move3D' },
  { kind: 'shell', name: '抽壳', arity: 1, dimensions: [1], operation: { opening: 'closed' }, category: 'operation', inlineGroup: '操作', placement: 'palette', iconKey: 'Box', hint: '向内、向外或对称等壁厚抽壳，支持多向开口与任意上游实体' },
  { kind: 'offset', name: '偏置', arity: 1, dimensions: [1], category: 'operation', inlineGroup: '操作', placement: 'feature', iconKey: 'Expand', hint: '对基本体或组合做等距膨胀或收缩' },
  { kind: 'mirror', name: '镜像', arity: 1, dimensions: [], operation: { axis: 'X', keep_original: true }, category: 'operation', inlineGroup: '操作', placement: 'feature', iconKey: 'FlipHorizontal2', hint: '沿坐标平面对称镜像复制或翻转' },
  { kind: 'linear_pattern', name: '线性阵列', arity: 1, dimensions: [3, 1, 1, 16, 16, 16], operation: { centered: false }, category: 'operation', inlineGroup: '操作', placement: 'feature', iconKey: 'LayoutGrid', hint: '按 XYZ 数量与步距生成多份阵列' },
  { kind: 'circular_pattern', name: '圆周阵列', arity: 1, dimensions: [6, 360], operation: { axis: 'Z' }, category: 'operation', inlineGroup: '操作', placement: 'feature', iconKey: 'RefreshCw', hint: '绕 X/Y/Z 轴按数量与总角度圆周阵列' },
  { kind: 'tpms_infill', name: 'TPMS 填充', arity: 1, dimensions: [8, 0, 0], operation: { openings: [] }, needsTpms: true, category: 'operation', inlineGroup: '操作', placement: 'feature', iconKey: 'Waves', hint: '按选中实体外形一键填充 TPMS，可选保留外蒙皮与开口面' },
];

export const FIELD_NODES = [
  { kind: 'tpms', name: 'TPMS', arity: 0, dimensions: [], needsTpms: true, category: 'tpms', inlineGroup: '场/结构' },
];

export const NODE_CATALOG = [
  ...PRIMITIVES.map(item => ({ ...item, nodeName: item.name, arity: 0, category: 'primitive', inlineGroup: '基本体' })),
  ...FIELD_NODES.map(item => ({ ...item, nodeName: item.name })),
  ...BOOLEAN_OPS.map(item => ({ ...item, dimensions: [] })),
  ...FEATURE_OPS.map(item => ({ ...item, nodeName: item.name })),
];

export const NODE_SPECS = Object.fromEntries(NODE_CATALOG.map(item => [item.kind, item]));

export const INLINE_NODE_KINDS = [
  ...PRIMITIVES.map(item => ({ id: item.kind, name: item.name, group: '基本体' })),
  { id: 'tpms', name: 'TPMS', group: '场/结构' },
  { id: 'tpms_infill', name: 'TPMS 填充', group: '操作' },
  ...BOOLEAN_OPS.map(item => ({ id: item.kind, name: item.name, group: '布尔' })),
  ...FEATURE_OPS.filter(item => item.kind !== 'tpms_infill').map(item => ({ id: item.kind, name: item.name, group: '操作' })),
];

export const MESH_PRESETS = [[0.6, '快速'], [0.3, '标准'], [0.15, '精细']];
