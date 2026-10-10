import React, { createContext, useContext, useEffect, useRef, useState } from 'react';
import { GripVertical, ArrowUp, ArrowDown, Box, Hash, Move3D } from 'lucide-react';
import { DRAG_MIME, readDrag, notebookOrder, reorderScene, connectReference } from './workflow_drag.mjs';

const Drag = createContext(null);
const typeName = type => type === 'body' ? '实体' : type === 'vector' ? '向量' : '数值';
export function WorkflowDrag({ scene, onChange, busy, reportError, children }) {
  const [payload, setPayload] = useState(null), [message, setMessage] = useState('');
  const current = useRef(null), pointer = useRef(null);
  function end() { current.current = null; pointer.current = null; setPayload(null); }
  useEffect(() => { if (busy) end(); }, [busy]);
  useEffect(() => {
    if (!payload) return;
    let frame;
    const over = e => { pointer.current = { x: e.clientX, y: e.clientY }; };
    const tick = () => {
      const p = pointer.current, pane = document.querySelector('.node-workspace .panel-scroll');
      if (p && pane) {
        const r = pane.getBoundingClientRect();
        if (p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom) {
          const speed = p.y < r.top + 56 ? -Math.ceil((r.top + 56 - p.y) / 4) : p.y > r.bottom - 56 ? Math.ceil((p.y - r.bottom + 56) / 4) : 0;
          if (speed) pane.scrollTop += speed;
        }
      }
      frame = requestAnimationFrame(tick);
    };
    window.addEventListener('dragover', over, true); window.addEventListener('dragend', end); window.addEventListener('drop', end);
    frame = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(frame); window.removeEventListener('dragover', over, true); window.removeEventListener('dragend', end); window.removeEventListener('drop', end); };
  }, [payload]);
  const value = { scene, busy, payload,
    start(e, next) {
      if (busy) { e.preventDefault(); return; }
      e.stopPropagation(); e.dataTransfer.setData(DRAG_MIME, JSON.stringify(next)); e.dataTransfer.effectAllowed = next.action === 'sort' ? 'move' : 'link';
      current.current = next; setPayload(next); setMessage(next.action === 'sort' ? '拖到节点标题的上半部或下半部排序' : `将${typeName(next.type)}引用拖到对应输入框`);
    }, end,
    dropped(e) {
      const data = readDrag(e.dataTransfer);
      return !busy && data && JSON.stringify(data) === JSON.stringify(current.current) ? data : null;
    },
    sort(group, id, anchor, side) {
      if (busy) return;
      const next = reorderScene(scene, group, id, anchor, side);
      if (next !== scene) { onChange(next); setMessage('节点显示顺序已更新，引用关系保持不变'); }
    },
    connect(data, target) {
      if (busy) return;
      const result = connectReference(scene, data, target);
      if (result.error) { reportError(result.error); setMessage(result.error); }
      else if (result.scene !== scene) { onChange(result.scene); setMessage('引用已连接，请更新模型'); }
      else setMessage('此输入已连接该引用');
    }
  };
  return <Drag.Provider value={value}>{children}<p className="workflow-drag-status" role="status" aria-live="polite">{message}</p></Drag.Provider>;
}
export function DragSource({ id, type, name, children, ...props }) {
  const drag = useContext(Drag);
  return <button type="button" {...props} draggable={!drag?.busy} disabled={drag?.busy} title={`拖动${typeName(type)}引用 ${name}`} onDragStart={e => drag?.start(e, { action: 'reference', id, type })} onDragEnd={() => drag?.end()}>{children}</button>;
}
export function ReferenceOutput({ id, type, name, onClick }) {
  const Icon = type === 'body' ? Box : type === 'vector' ? Move3D : Hash;
  return <DragSource id={id} type={type} name={name} className={`reference-output reference-${type}`} aria-label={`拖动${typeName(type)}引用 ${name}`} onClick={onClick}><Icon size={16} aria-hidden="true" /><span>{typeName(type)}</span></DragSource>;
}
export function SortHandle({ group, id, name }) {
  const drag = useContext(Drag);
  function key(e) {
    if (!['ArrowUp', 'ArrowDown'].includes(e.key) || drag.busy) return;
    e.preventDefault(); e.stopPropagation();
    const list = group === 'notebook' ? notebookOrder(drag.scene).map(id => ({ id })) : group === 'body' ? drag.scene.nodes : drag.scene.value_nodes || [], index = list.findIndex(n => n.id === id), other = list[index + (e.key === 'ArrowUp' ? -1 : 1)];
    if (other) drag.sort(group, id, other.id, e.key === 'ArrowUp' ? 'before' : 'after');
  }
  return <button type="button" className="notebook-sort-handle" draggable={!drag.busy} disabled={drag.busy} aria-label={`拖动排序 ${name}`} title="拖动排序；聚焦后按 ↑ / ↓ 移动" onKeyDown={key} onDragStart={e => drag.start(e, { action: 'sort', id, group })} onDragEnd={drag.end}><GripVertical size={16} aria-hidden="true" /></button>;
}
export function SortButtons({ group, id, name }) {
  const drag = useContext(Drag), list = group === 'notebook' ? notebookOrder(drag.scene).map(id => ({ id })) : group === 'body' ? drag.scene.nodes : drag.scene.value_nodes || [], index = list.findIndex(n => n.id === id);
  return <div className="notebook-sort-buttons">{[[-1, '上移', ArrowUp], [1, '下移', ArrowDown]].map(([delta, text, Icon]) => <button key={delta} type="button" className="secondary" disabled={drag.busy || !list[index + delta]} aria-label={`${text}节点 ${name}`} onClick={() => drag.sort(group, id, list[index + delta].id, delta < 0 ? 'before' : 'after')}><Icon size={14} aria-hidden="true" />{text}</button>)}</div>;
}
export function SortHeading({ group, id, children, onContextMenu }) {
  const drag = useContext(Drag), [side, setSide] = useState('');
  const active = drag.payload?.action === 'sort' && drag.payload.group === group && drag.payload.id !== id && !drag.busy;
  return <div draggable={!drag.busy} onContextMenu={onContextMenu} onDragStart={e => { if (e.target.closest('input,select,textarea')) { e.preventDefault(); return; } drag.start(e, { action: 'sort', id, group }); }} onDragEnd={drag.end} className={`notebook-node-heading ${active && side ? `sort-before-${side}` : ''}`} onDragOver={e => {
    if (!active) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'move';
    const r = e.currentTarget.getBoundingClientRect(); setSide(e.clientY < r.top + r.height / 2 ? 'before' : 'after');
  }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setSide(''); }} onDrop={e => {
    if (!active) return;
    e.preventDefault(); e.stopPropagation(); const data = drag.dropped(e);
    if (data) { const r = e.currentTarget.getBoundingClientRect(); drag.sort(group, data.id, id, side || (e.clientY < r.top + r.height / 2 ? 'before' : 'after')); }
    setSide(''); drag.end();
  }}>{children}</div>;
}
export function ReferenceInput({ target, label, disabled = false, className = '', children }) {
  const drag = useContext(Drag), [over, setOver] = useState(false);
  const active = !disabled && !drag?.busy && drag?.payload?.action === 'reference';
  const result = active ? connectReference(drag.scene, drag.payload, target) : null;
  return <div className={`reference-input ${className} ${active ? result.error ? 'drop-unavailable' : 'drop-compatible' : ''} ${active && over ? 'drop-over' : ''}`} data-reference-target={JSON.stringify(target)} onDragOver={e => {
    if (!active) return;
    e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = result.error ? 'none' : 'link'; setOver(true);
  }} onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget)) setOver(false); }} onDrop={e => {
    if (!active) return;
    e.preventDefault(); e.stopPropagation(); const data = drag.dropped(e);
    if (data) drag.connect(data, target);
    setOver(false); drag.end();
  }}>
    {children}
    {active && over && <span className="reference-drop-hint" role="status">{result.error || `松开连接到${label}`}</span>}
  </div>;
}
