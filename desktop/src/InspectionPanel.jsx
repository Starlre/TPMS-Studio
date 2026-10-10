import React from 'react';
import { RotateCcw, Ruler, ScanLine } from 'lucide-react';
import { planeNormal, planeRange, distanceBetween } from './inspection_math.mjs';

const number = (value, digits = 3) => Number(value).toLocaleString('zh-CN', { maximumFractionDigits: digits });
export default function InspectionPanel({ section, onSection, bounds, points, onPoints, measuring, onMeasuring,
  status, pickStatus, available, viewPlane, onReset, domain = '材料' }) {
  let normal, error = '', range = [0, 0];
  try { normal = planeNormal(section); if (bounds) range = planeRange(bounds, normal); } catch (e) { error = e.message; }
  const set = patch => onSection({ ...section, ...patch });
  function orientation(patch) {
    const next = { ...section, ...patch };
    try { const r = planeRange(bounds, planeNormal(next)); next.offset = Number(((r[0] + r[1]) / 2).toFixed(6)); } catch { /* The field explains invalid normals. */ }
    onSection(next);
  }
  function coordinate(index, axis, value) {
    if (!Number.isFinite(Number(value))) return;
    const next = [...points], point = [...(next[index] || [0, 0, 0])]; point[axis] = Number(value); next[index] = point;
    onMeasuring(false); onPoints(next);
  }
  const complete = points[0] && points[1], distance = complete ? distanceBetween(...points) : null;
  return <div className="inspection-panel">
    <div className="editor-heading"><small>当前显示模型 · 单位 mm</small><h2>剖切与测量</h2><p className="hint">查看内部结构，测量两点直线距离。操作不改变模型和导出文件。</p></div>
    <fieldset disabled={!available}>
      <section className="editor-section"><h3><ScanLine size={17} aria-hidden="true" />剖切平面</h3>
        <label className="toggle"><input type="checkbox" checked={section.enabled} onChange={e => set({ enabled: e.target.checked })} /><span>启用剖切</span></label>
        {section.enabled && <>
          <label className="field"><span>平面方向</span><select aria-label="平面方向" value={section.axis} onChange={e => orientation({ axis: e.target.value })}>{[['X', 'X · YZ 截面'], ['Y', 'Y · XZ 截面'], ['Z', 'Z · XY 截面'], ['custom', '自定义法向']].map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          {section.axis === 'custom' && <><div className="triple">{['X', 'Y', 'Z'].map((axis, i) => <label className="field" key={axis}><span>法向 {axis}</span><input type="number" step="0.1" aria-invalid={!!error} value={section.normal[i]} onChange={e => orientation({ normal: section.normal.map((v, j) => i === j ? Number(e.target.value) : v) })} /></label>)}</div><p className="hint">法向会归一化；位置是平面到世界原点的有符号距离。</p></>}
          {error && <p className="inspection-warning" role="alert">{error}</p>}
          <label className="field"><span>剖切位置 / mm</span><input type="number" value={section.offset} step="0.1" min={range[0]} max={range[1]} disabled={!!error} onChange={e => { const value = Number(e.target.value); if (Number.isFinite(value)) set({ offset: Math.min(range[1], Math.max(range[0], value)) }); }} /></label>
          <input className="section-slider" type="range" aria-label="剖切位置滑块" disabled={!!error || range[0] === range[1]} min={range[0]} max={range[1]} step={Math.max(0.00001, (range[1] - range[0]) / 1000)} value={section.offset} onChange={e => set({ offset: Number(e.target.value) })} />
          <div className="inspection-range"><span>{number(range[0])}</span><span>{number(range[1])} mm</span></div>
          <div className="inspection-buttons"><button type="button" className="secondary" disabled={!!error} onClick={() => set({ offset: Number(((range[0] + range[1]) / 2).toFixed(6)) })}>居中</button><button type="button" className="secondary" disabled={!!error} onClick={() => viewPlane(normal.map(v => section.positive ? -v : v))}>正对截面</button></div>
          <label className="toggle"><input type="checkbox" checked={section.positive} onChange={e => set({ positive: e.target.checked })} /><span>保留法向正侧</span></label>
          <label className="toggle"><input type="checkbox" checked={section.only} onChange={e => set({ only: e.target.checked })} /><span>仅显示截面</span></label>
          <label className="toggle"><input type="checkbox" checked={section.fill} onChange={e => set({ fill: e.target.checked })} /><span>填充{domain}截面</span></label>
          <div className="section-statistics" role="status" aria-live="polite">{status?.pending ? <p>截面计算中…</p> : status?.error ? <p className="inspection-warning">{status.error}</p> : status?.result ? <>
            <div className="metric"><span>截面{domain}面积</span><strong>{status.result.area === null ? '无法确定' : `${number(status.result.area)} mm²`}</strong></div><div className="metric"><span>{status.result.limited ? '部分轮廓长度' : '截面轮廓总长'}</span><strong>{number(status.result.perimeter)} mm</strong></div><div className="metric"><span>闭合轮廓</span><strong>{status.result.loops}</strong></div>
            {status.result.warning && <p className="inspection-warning">{status.result.warning}</p>}{status.result.segments === 0 && <p className="hint">此平面未穿过模型，移动位置查看截面。</p>}
          </> : <p className="hint">剖切显示使用网格；橙色表示材料切面，孔隙保持空白。</p>}</div>
        </>}
      </section>
      <section className="editor-section"><h3>外形尺寸</h3><label className="toggle"><input type="checkbox" checked={section.box} onChange={e => set({ box: e.target.checked })} /><span>显示包围盒</span></label>
        {bounds && ['X', 'Y', 'Z'].map((axis, i) => <div className="metric" key={axis}><span>{axis} 尺寸</span><strong>{number(bounds[1][i] - bounds[0][i])} mm</strong></div>)}
      </section>
      <section className="editor-section"><h3><Ruler size={17} aria-hidden="true" />两点测量</h3><p className="hint">点击开始后，在模型或已填充切面单击 A、B 两点。拖动仍旋转；Esc 结束选点。</p>
        <div className="inspection-buttons"><button type="button" className="secondary" aria-pressed={measuring} onClick={() => { if (measuring) onMeasuring(false); else { onPoints([]); onMeasuring(true); } }}>{measuring ? '结束选点' : '开始两点测量'}</button><button type="button" className="secondary" onClick={() => { onPoints([]); onMeasuring(false); }}>清除</button></div>
        <p className="measurement-hint" role="status" aria-live="polite">{pickStatus || (measuring ? points[0] ? '请选择 B 点' : '请选择 A 点' : complete ? '两点测量完成' : '也可手动输入 A、B 坐标')}</p>
        {[0, 1].map(index => <div className="measurement-point" key={index}><h4>{index === 0 ? 'A 点' : 'B 点'} / mm</h4><div className="triple">{['X', 'Y', 'Z'].map((axis, i) => <label className="field" key={axis}><span>{axis}</span><input type="number" step="0.1" aria-label={`${index === 0 ? 'A' : 'B'} 点 ${axis}`} value={points[index]?.[i] ?? ''} onChange={e => coordinate(index, i, e.target.value)} /></label>)}</div></div>)}
        {complete && <div className="measurement-result" role="status"><span>直线距离</span><output>{number(distance)} mm</output><div>{['X', 'Y', 'Z'].map((axis, i) => <span key={axis}>Δ{axis} {number(Math.abs(points[1][i] - points[0][i]))} mm</span>)}</div></div>}
        <p className="hint">结果基于当前三角网格；手动坐标可定义空间任意点。直线距离不是壁厚、孔径或沿面距离。</p>
      </section>
      <button type="button" className="secondary full inspection-reset" onClick={onReset}><RotateCcw size={16} aria-hidden="true" />恢复完整模型并清除测量</button>
    </fieldset>
    {!available && <p className="hint">先生成模型，再使用剖切与测量。</p>}
  </div>;
}
