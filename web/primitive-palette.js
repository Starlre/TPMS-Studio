import { PRIMITIVES } from '../desktop/src/primitive_catalog.mjs';

let iconIndex = 0;
// Shaded SVG geometry matches the desktop PrimitiveIcon; no runtime images.
export function primitiveIcon(kind,size = 30) {
  const id = `web-primitive-${iconIndex++}`, front = `url(#${id}-front)`, top = `url(#${id}-top)`;
  let shape;
  if (['box','cube','rounded_box'].includes(kind)) {
    shape = kind === 'rounded_box' ? `<rect x="7" y="7" width="24" height="26" rx="5" fill="${front}"/><path d="M9 9 17 4h15l-3 5" fill="${top}"/>` : `<path d="${kind==='box'?'M6 10 23 5 34 10 17 15Z':'M6 11 22 5 34 11 18 17Z'}" fill="${top}"/><path d="M6 11 18 17v20L6 31Z" fill="${front}"/><path d="M18 17 34 11v20l-16 6Z" fill="${front}"/>`;
  } else if (['cylinder','rounded_cylinder','capsule'].includes(kind)) {
    shape = kind === 'capsule' ? `<rect x="10" y="4" width="20" height="33" rx="10" fill="${front}"/>` : `<path d="M9 10v22c0 7 22 7 22 0V10" fill="${front}"/><ellipse cx="20" cy="10" rx="11" ry="5" fill="${top}"/>${kind==='rounded_cylinder'?'<path d="M10 29c0 7 20 7 20 0" opacity=".6"/>':''}`;
  } else if (['sphere','ellipsoid'].includes(kind)) {
    shape = `<ellipse cx="20" cy="21" rx="${kind==='ellipsoid'?17:15}" ry="${kind==='ellipsoid'?11:15}" fill="${front}"/>`;
  } else if (kind === 'cone') {
    shape = `<path d="M20 4 5 32c0 8 30 8 30 0Z" fill="${front}"/><path d="M5 32c0 7 30 7 30 0"/>`;
  } else if (kind === 'frustum') {
    shape = `<path d="m12 10-7 22c0 8 30 8 30 0l-7-22" fill="${front}"/><ellipse cx="20" cy="10" rx="8" ry="4" fill="${top}"/>`;
  } else {
    shape = `<ellipse cx="20" cy="23" rx="17" ry="11" fill="${front}"/><ellipse cx="20" cy="19" rx="17" ry="11" fill="${top}"/><ellipse cx="20" cy="19" rx="8" ry="4" fill="var(--panel)"/><path d="M12 19c0-3 16-3 16 0"/>`;
  }
  return `<svg width="${size}" height="${size}" viewBox="0 0 40 42" fill="none" stroke="var(--primitive-outline, #91a9ba)" stroke-width=".8" aria-hidden="true"><defs><linearGradient id="${id}-front" x1="0" x2="1" y2=".25"><stop stop-color="var(--primitive-light, #d7e0e7)"/><stop offset="1" stop-color="var(--primitive-shade, #647b8d)"/></linearGradient><linearGradient id="${id}-top" x1="0" y1="0" x2=".4" y2="1"><stop stop-color="var(--primitive-light, #d7e0e7)"/><stop offset="1" stop-color="var(--primitive-mid, #a9bbc9)"/></linearGradient></defs>${shape}</svg>`;
}

export function createPrimitivePalette() {
  const panel = document.createElement('section'); panel.id = 'basic-body-palette'; panel.className = 'ribbon-palette';
  panel.setAttribute('aria-label','基本体选项'); panel.hidden = true;
  panel.innerHTML = '<header><h3>基本体</h3><button type="button" class="icon-button" aria-label="关闭基本体选项"><svg class="icon" aria-hidden="true"><use href="#i-close"/></svg></button></header><div class="palette-items"></div><footer>界面展示模式 · 创建实体请使用桌面 App</footer>';
  let anchor;
  const close = (focus = false) => {
    panel.hidden = true; anchor?.setAttribute('aria-expanded','false');
    if (focus && anchor?.isConnected) anchor.focus({preventScroll:true});
  };
  for (const item of PRIMITIVES) {
    const button = document.createElement('button'); button.className = 'palette-item'; button.setAttribute('aria-label',`创建${item.name}`);
    button.setAttribute('aria-disabled','true'); button.title = `${item.hint}；创建请使用桌面 App`;
    button.innerHTML = `${primitiveIcon(item.kind,26)}<span>${item.name}</span>`;
    // Focus remains available to inspect the options. Never mutate the scene.
    button.onclick = () => { document.getElementById('status').textContent = `${item.name} · 界面展示选项，创建与计算请使用桌面 App。`; };
    panel.querySelector('.palette-items').append(button);
  }
  panel.querySelector('header button').onclick = () => close(true);
  panel.onkeydown = event => {
    if (event.key === 'Escape') {event.preventDefault();event.stopPropagation();close(true);return;}
    if (event.key === 'Tab') {close();return;}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key)) return;
    event.preventDefault(); const buttons = [...panel.querySelectorAll('.palette-item')], index = buttons.indexOf(document.activeElement);
    buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length-1 : (index+(event.key==='ArrowUp'?-1:1)+buttons.length)%buttons.length].focus();
  };
  document.body.append(panel);
  document.addEventListener('pointerdown',event => {if (!panel.hidden && !panel.contains(event.target) && !anchor?.contains(event.target)) close();});
  document.addEventListener('workbenchpaletteclose',()=>close());
  document.getElementById('ribbon-collapse').addEventListener('click',()=>close());
  window.addEventListener('resize',()=>close());
  const open = button => {
    if (!panel.hidden && anchor === button) {close();return;}
    anchor = button; panel.hidden = false; anchor.setAttribute('aria-expanded','true');
    const target = anchor.getBoundingClientRect(), rect = panel.getBoundingClientRect();
    panel.style.left = `${Math.max(8,Math.min(target.left,innerWidth-rect.width-8))}px`;
    panel.style.top = `${Math.max(8,Math.min(target.bottom+4,innerHeight-rect.height-8))}px`;
    panel.querySelector('.palette-item').focus({preventScroll:true});
  };
  return {open,close};
}
