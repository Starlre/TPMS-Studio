// One catalog drives creation defaults, node editors and the basic-body palette.
export const PRIMITIVES = [
  {kind:'box', name:'长方体', dimensions:[16,16,16], labels:['X 长度','Y 长度','Z 长度'], hint:'XYZ 外形长度；位置为中心'},
  {kind:'cube', name:'立方体', dimensions:[16], labels:['边长'], hint:'一个边长同时控制 XYZ'},
  {kind:'rounded_box', name:'圆角方盒', dimensions:[16,20,12,2], labels:['X 长度','Y 长度','Z 长度','圆角半径'], hint:'外形长度保持不变；圆角小于最短边的一半'},
  {kind:'cylinder', name:'圆柱', dimensions:[6,24], labels:['半径','高度'], hint:'局部 Z 轴；高度含两端平面'},
  {kind:'rounded_cylinder', name:'圆角圆柱', dimensions:[6,24,2], labels:['半径','高度','圆角半径'], hint:'外径和总高度保持不变；端面与侧面圆角过渡'},
  {kind:'capsule', name:'胶囊体', dimensions:[6,24], labels:['半径','总高度'], hint:'局部 Z 轴；总高度含两端半球且不小于直径'},
  {kind:'sphere', name:'球体', dimensions:[8], labels:['半径'], hint:'半径控制球体大小；位置为球心'},
  {kind:'cone', name:'圆锥', dimensions:[8,20], labels:['底面半径','高度'], hint:'局部 Z 轴；尖端位于 +Z，底面位于 −Z'},
  {kind:'frustum', name:'圆台', dimensions:[8,4,20], labels:['底面半径','顶面半径','高度'], hint:'底面位于 −Z，顶面位于 +Z'},
  {kind:'ellipsoid', name:'椭球体', dimensions:[10,6,8], labels:['X 半轴','Y 半轴','Z 半轴'], hint:'输入半轴长度，外形尺寸为半轴的两倍'},
  {kind:'torus', name:'圆环', dimensions:[10,3], labels:['主半径','管半径'], hint:'位于局部 XY 平面；主半径必须大于管半径'},
];
export const COMMON_PRIMITIVES = ['box','sphere','cylinder','torus'];
