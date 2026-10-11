import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';

export default function RibbonPalette({group, anchor, onClose}) {
  const ref = useRef(null);
  const [point,setPoint] = useState({left:8,top:8});
  useLayoutEffect(() => {
    const button = anchor.getBoundingClientRect(), panel = ref.current.getBoundingClientRect();
    setPoint({left:Math.max(8,Math.min(button.left,innerWidth-panel.width-8)),top:Math.max(8,Math.min(button.bottom+4,innerHeight-panel.height-8))});
    ref.current.querySelector('.palette-item:not(:disabled)')?.focus({preventScroll:true});
  },[anchor]);
  useEffect(() => {
    const close = () => onClose();
    const outside = event => { if (!ref.current?.contains(event.target) && !anchor.contains(event.target)) close(); };
    document.addEventListener('pointerdown',outside); window.addEventListener('resize',close);
    return () => {document.removeEventListener('pointerdown',outside); window.removeEventListener('resize',close);};
  },[anchor,onClose]);
  const keyboard = event => {
    if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();onClose();anchor.focus();return;}
    if (event.key === 'Tab') {onClose();return;}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    const buttons = [...ref.current.querySelectorAll('.palette-item:not(:disabled)')];
    if (!buttons.length) return;
    event.preventDefault(); const index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index+(event.key === 'ArrowUp' ? -1 : 1)+buttons.length)%buttons.length].focus();
  };
  return createPortal(<section id="basic-body-palette" className="ribbon-palette" aria-label="基本体选项" style={point} ref={ref} onKeyDown={keyboard}>
    <header><h3>基本体</h3><button type="button" className="icon-button" aria-label="关闭基本体选项" onClick={() => {onClose();anchor.focus();}}><X size={17} aria-hidden="true"/></button></header>
    <div className="palette-items">{group.tools.map(({id,label,icon:Icon,onClick,disabled,hint}) => <button type="button" className="palette-item" key={id || label} disabled={disabled} title={hint || label} aria-label={label} onClick={() => {onClick();onClose();}}><Icon size={26} aria-hidden="true"/><span>{label.replace(/^创建/,'')}</span></button>)}</div>
    <footer>选择基本体，创建可编辑的参数节点</footer>
  </section>,document.body);
}
