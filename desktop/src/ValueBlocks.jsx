import React, { useEffect, useState } from 'react';
import { Variable, ArrowRight, Trash2, Check } from 'lucide-react';
import { valueConsumers } from './node_graph.mjs';
import { SortButtons, ReferenceInput } from './WorkflowDrag';
import { renameValueSymbol } from './workflow_drag.mjs';

const names = { number: '数值', formula: '公式', vector: '向量' };
export function createValueBlock(scene, kind) {
  const blocks = scene.value_nodes || [];
  let i = 1;
  const symbols = new Set([...Object.keys(scene.parameters || {}), ...blocks.flatMap(b => [b.symbol, ...'xyz'.split('').map(a => `${b.symbol}_${a}`)])]);
  while (blocks.some(b => b.id === `p${i}`) || symbols.has(`value${i}`)) i++;
  return { id: `p${i}`, name: `${names[kind]} ${i}`, symbol: `value${i}`, kind,
    ...(kind === 'number' ? { value: 4 } : kind === 'formula' ? { expression: '4 * 2' } : { components: [0, 0, 0] }) };
}
export function ValueEditor({ scene, onChange, selected: block, outputs, reportError, onSelect, inline = false, compact = false }) {
  const [symbolDraft, setSymbolDraft] = useState(block?.symbol || '');
  const [symbolError, setSymbolError] = useState('');
  useEffect(() => {
    setSymbolDraft(block?.symbol || '');
    setSymbolError('');
  }, [block?.id, block?.symbol]);
  if (!block) return <div className="editor-placeholder"><Variable size={32} aria-hidden="true" /><h3>选择一个设计参数</h3><p>设计参数可同时控制多个建模步骤。</p></div>;
  const blocks = scene.value_nodes || [];
  const consumers = valueConsumers(scene, block);
  function patch(data) { onChange({ ...scene, value_nodes: blocks.map(b => b.id === block.id ? { ...b, ...data } : b) }); }
  function commitSymbol(nextVal = symbolDraft) {
    if (nextVal === block.symbol) { setSymbolError(''); return; }
    const result = renameValueSymbol(scene, block.id, nextVal);
    if (result.error) { setSymbolError(result.error); reportError?.(result.error); return; }
    setSymbolError('');
    if (result.scene !== scene) onChange(result.scene);
  }
  function remove() {
    if (consumers.length) return reportError(`参数 ${block.name} 被 ${consumers.map(n => n.name).join('、')} 引用，请先解除引用。`);
    onChange({ ...scene, value_nodes: blocks.filter(b => b.id !== block.id) }); onSelect('');
  }
  const hasConsumers = consumers.length > 0;
  const dirtySymbol = hasConsumers && symbolDraft !== block.symbol;
  return <article data-editor-value-id={block.id}>
    {!inline && <div className="editor-heading"><small>{names[block.kind]}参数</small><h2>{block.name}</h2></div>}
    <section className="editor-section">{!compact && <h3>参数定义</h3>}
      <label className="field"><span>参数名称</span><input aria-label="参数名称" value={block.name} onChange={e => patch({ name: e.target.value })} /></label>
      <label className="field"><span>引用符号</span>
        <input aria-label="引用符号" value={hasConsumers ? symbolDraft : block.symbol} spellCheck={false}
          onChange={e => {
            const v = e.target.value;
            setSymbolDraft(v); setSymbolError('');
            if (!hasConsumers) patch({ symbol: v });
          }}
          onBlur={() => { if (hasConsumers && symbolDraft !== block.symbol) commitSymbol(symbolDraft); }}
          onKeyDown={e => {
            if (!hasConsumers) return;
            if (e.key === 'Enter') { e.preventDefault(); commitSymbol(symbolDraft); }
            else if (e.key === 'Escape') { e.preventDefault(); setSymbolDraft(block.symbol); setSymbolError(''); }
          }} />
        {hasConsumers && !dirtySymbol && <small className="hint">重命名时按 Enter 或失焦，自动同步更新 {consumers.length} 处下游引用。</small>}
      </label>
      {dirtySymbol && <div className="symbol-sync-row"><button type="button" className="secondary inline-sync-btn" onMouseDown={e => e.preventDefault()} onClick={() => commitSymbol(symbolDraft)}><Check size={14} aria-hidden="true" />应用并同步 {consumers.length} 处引用</button></div>}
      {symbolError && <p className="node-error" role="alert">{symbolError}</p>}
      {block.kind === 'number' && <label className="field"><span>数值</span><input aria-label="参数数值" type="number" step="any" value={block.value ?? ''} onChange={e => patch({ value: e.target.value === '' ? '' : Number(e.target.value) })} /></label>}
      {block.kind === 'formula' && <ReferenceInput target={{ kind: 'value-expression', id: block.id }} label="参数公式"><label className="field"><span>算术公式</span><input aria-label="参数公式" value={block.expression} spellCheck={false} onChange={e => patch({ expression: e.target.value })} /><small>例如 radius * 2；拖入数值引用会替换公式。</small></label></ReferenceInput>}
      {block.kind === 'vector' && <div className="triple">{'XYZ'.split('').map((axis, i) => <ReferenceInput key={axis} target={{ kind: 'value-component', id: block.id, index: i }} label={`向量 ${axis}`}><label className="field"><span>{axis} 分量</span><input aria-label={`向量 ${axis}`} value={block.components[i]} spellCheck={false} onChange={e => patch({ components: block.components.map((v, j) => i === j ? e.target.value : v) })} /></label></ReferenceInput>)}</div>}
      <output className="parameter-result" aria-label={`${block.name}计算值`}>{outputs[block.id] ? `${outputs[block.id].type === 'vector' ? '向量' : '数值'} = ${JSON.stringify(outputs[block.id].value)}` : '待计算'}</output>
    </section>
    <details className="editor-section"><summary>引用此参数</summary>{consumers.length ? <ul className="parameter-consumers">{consumers.map(n => <li key={n.id}><button type="button" onClick={() => onSelect(scene.nodes.some(g => g.id === n.id) ? n.id : `value:${n.id}`)}>{n.name}<ArrowRight size={16} aria-hidden="true" /></button></li>)}</ul> : <p className="hint">尚未引用。在实体数值字段中选择此参数，或用 fx 输入它的符号。</p>}</details>
    {!compact && <button type="button" className="secondary text-danger full" aria-label={`删除参数节点 ${block.name}`} onClick={remove}><Trash2 size={16} aria-hidden="true" />删除参数</button>}
    {inline && !compact && <SortButtons group="value" id={block.id} name={block.name} />}
  </article>;
}
// B7：原先这里有一个未被任何模块引用的 ValueBlocks 默认导出组件（卡片列表已由 NodeWorkflow 统一渲染），已删除。
