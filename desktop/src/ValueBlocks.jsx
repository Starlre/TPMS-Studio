import React, { useState } from 'react';
import { Plus, Trash2, Hash, Variable, Move3D, ArrowRight } from 'lucide-react';
import { valueConsumers } from './node_graph.mjs';

const names = { number: '数值', formula: '公式', vector: '向量' };
const icons = { number: Hash, formula: Variable, vector: Move3D };
export function ValueEditor({ scene, onChange, selected: block, outputs, reportError, onSelect }) {
  if (!block) return <div className="editor-placeholder"><Variable size={32} aria-hidden="true" /><h3>选择一个设计参数</h3><p>设计参数可同时控制多个建模步骤。</p></div>;
  const blocks = scene.value_nodes || [];
  const consumers = valueConsumers(scene, block);
  function patch(data) { onChange({ ...scene, value_nodes: blocks.map(b => b.id === block.id ? { ...b, ...data } : b) }); }
  function remove() {
    if (consumers.length) return reportError(`参数 ${block.name} 被 ${consumers.map(n => n.name).join('、')} 引用，请先解除引用。`);
    onChange({ ...scene, value_nodes: blocks.filter(b => b.id !== block.id) }); onSelect('');
  }
  return <article data-editor-value-id={block.id}>
    <div className="editor-heading"><small>{names[block.kind]}参数</small><h2>{block.name}</h2></div>
    <section className="editor-section"><h3>参数定义</h3>
      <label className="field"><span>参数名称</span><input aria-label="参数名称" value={block.name} onChange={e => patch({ name: e.target.value })} /></label>
      <label className="field"><span>引用符号</span><input aria-label="引用符号" value={block.symbol} spellCheck={false} onChange={e => patch({ symbol: e.target.value })} /></label>
      {block.kind === 'number' && <label className="field"><span>数值</span><input aria-label="参数数值" type="number" step="any" value={block.value ?? ''} onChange={e => patch({ value: e.target.value === '' ? '' : Number(e.target.value) })} /></label>}
      {block.kind === 'formula' && <label className="field"><span>算术公式</span><input aria-label="参数公式" value={block.expression} spellCheck={false} onChange={e => patch({ expression: e.target.value })} /><small>例如 radius * 2</small></label>}
      {block.kind === 'vector' && <div className="triple">{'XYZ'.split('').map((axis, i) => <label className="field" key={axis}><span>{axis} 分量</span><input aria-label={`向量 ${axis}`} value={block.components[i]} spellCheck={false} onChange={e => patch({ components: block.components.map((v, j) => i === j ? e.target.value : v) })} /></label>)}</div>}
      <output className="parameter-result" aria-label={`${block.name}计算值`}>{outputs[block.id] ? `${outputs[block.id].type === 'vector' ? '向量' : '数值'} = ${JSON.stringify(outputs[block.id].value)}` : '待计算'}</output>
    </section>
    <section className="editor-section"><h3>引用此参数</h3>{consumers.length ? <ul className="parameter-consumers">{consumers.map(n => <li key={n.id}><button type="button" onClick={() => onSelect(scene.nodes.some(g => g.id === n.id) ? n.id : `value:${n.id}`)}>{n.name}<ArrowRight size={16} aria-hidden="true" /></button></li>)}</ul> : <p className="hint">尚未引用。在实体数值字段中选择此参数，或用 fx 输入它的符号。</p>}</section>
    <button type="button" className="secondary text-danger full" aria-label={`删除参数节点 ${block.name}`} onClick={remove}><Trash2 size={16} aria-hidden="true" />删除参数</button>
  </article>;
}

export default function ValueBlocks({ scene, onChange, outputs, selected, onSelect, evaluate, busy }) {
  const [kind, setKind] = useState('number');
  const blocks = scene.value_nodes || [];
  function add() {
    let i = 1;
    const symbols = new Set([...Object.keys(scene.parameters || {}), ...blocks.flatMap(b => [b.symbol, ...'xyz'.split('').map(a => `${b.symbol}_${a}`)])]);
    while (blocks.some(b => b.id === `p${i}`) || symbols.has(`value${i}`)) i++;
    onChange({ ...scene, value_nodes: [...blocks, { id: `p${i}`, name: `${names[kind]} ${i}`, symbol: `value${i}`, kind,
      ...(kind === 'number' ? { value: 4 } : kind === 'formula' ? { expression: '4 * 2' } : { components: [0, 0, 0] }) }] });
    onSelect(`value:p${i}`);
  }
  return <section className="value-blocks" aria-label="参数节点">
    <div className="workflow-add"><select aria-label="新参数节点类型" value={kind} onChange={e => setKind(e.target.value)}>{Object.entries(names).map(([key, name]) => <option key={key} value={key}>{name}参数</option>)}</select><button type="button" className="secondary" disabled={blocks.length >= 32} onClick={add}><Plus size={18} aria-hidden="true" />添加参数节点</button></div>
    {!blocks.length && <div className="workflow-empty"><h3>需要联动时再添加参数</h3><p>简单模型可以直接输入尺寸。多个实体共享数值时，再使用设计参数。</p></div>}
    <ul className="workflow-values" aria-label="设计参数列表">{blocks.map(block => {
      const Icon = icons[block.kind];
      const result = outputs[block.id]?.value;
      const summary = block.kind === 'number' ? block.value : block.kind === 'formula' ? block.expression : `[${block.components.join(', ')}]`;
      return <li key={block.id} data-value-id={block.id} className={selected === `value:${block.id}` ? 'selected' : ''}><button type="button" aria-label={`选择参数 ${block.name}`} aria-pressed={selected === `value:${block.id}`} onClick={() => onSelect(`value:${block.id}`)}><Icon size={18} aria-hidden="true" /><span className="step-text"><strong>{block.name}</strong><small>{names[block.kind]} · {block.symbol}</small><span className="value-summary">{summary}</span></span>{result !== undefined && <output aria-label={`${block.name}计算值`}>{JSON.stringify(result)}</output>}<ArrowRight size={16} className="step-arrow" aria-hidden="true" /></button></li>;
    })}</ul>
    {!!blocks.length && <button type="button" className="secondary full evaluate-values" disabled={busy} onClick={evaluate}>计算参数值</button>}
  </section>;
}
