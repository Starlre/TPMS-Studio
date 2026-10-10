import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Shared by context-click and the visible overflow button; normal buttons stay keyboard usable.
export default function CardMenu({ position, onClose, children }) {
  const ref = useRef(null);
  const [point, setPoint] = useState({ left: position.x, top: position.y });
  useLayoutEffect(() => {
    const rect = ref.current.getBoundingClientRect();
    setPoint({ left: Math.max(8, Math.min(position.x - rect.width, innerWidth - rect.width - 8)),
      top: Math.max(8, Math.min(position.y, innerHeight - rect.height - 8)) });
    ref.current.querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
  }, [position]);
  useEffect(() => {
    const outside = e => { if (!ref.current?.contains(e.target) && !position.anchor.contains(e.target)) onClose(); };
    const key = e => {
      if (e.key === 'Escape') { e.preventDefault(); onClose(); position.anchor.focus(); }
      if (['ArrowDown', 'ArrowUp', 'Home', 'End', 'Tab'].includes(e.key)) {
        const buttons = [...ref.current.querySelectorAll('button:not(:disabled)')], index = buttons.indexOf(document.activeElement);
        if (!buttons.length) return;
        e.preventDefault();
        const next = e.key === 'Home' ? 0 : e.key === 'End' ? buttons.length - 1 : (index + (e.key === 'ArrowUp' || e.shiftKey ? -1 : 1) + buttons.length) % buttons.length;
        buttons[next].focus();
      }
    };
    const close = () => onClose();
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', key);
    window.addEventListener('resize', close); document.querySelector('.node-workspace .panel-scroll')?.addEventListener('wheel', close, { passive: true });
    return () => {
      document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', key);
      window.removeEventListener('resize', close); document.querySelector('.node-workspace .panel-scroll')?.removeEventListener('wheel', close);
    };
  }, [position, onClose]);
  return createPortal(<div ref={ref} role="group" aria-label="节点操作菜单" className="card-context-menu" style={point}>{children}</div>, document.body);
}
