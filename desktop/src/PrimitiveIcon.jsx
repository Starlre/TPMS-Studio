import React, { useId } from 'react';

// Small shaded SVG solids: crisp at any display scale and no image dependencies.
export default function PrimitiveIcon({kind, size = 30, ...props}) {
  const id = useId().replace(/:/g,'');
  const front = `url(#${id}-front)`, top = `url(#${id}-top)`;
  let shape;
  if (['box','cube','rounded_box'].includes(kind)) {
    shape = kind === 'rounded_box' ? <><rect x="7" y="7" width="24" height="26" rx="5" fill={front}/><path d="M9 9 17 4h15l-3 5" fill={top}/></> : <><path d={kind === 'box' ? 'M6 10 23 5 34 10 17 15Z' : 'M6 11 22 5 34 11 18 17Z'} fill={top}/><path d="M6 11 18 17v20L6 31Z" fill={front}/><path d="M18 17 34 11v20l-16 6Z" fill={front}/></>;
  } else if (['cylinder','rounded_cylinder','capsule'].includes(kind)) {
    shape = kind === 'capsule' ? <rect x="10" y="4" width="20" height="33" rx="10" fill={front}/> : <><path d="M9 10v22c0 7 22 7 22 0V10" fill={front}/><ellipse cx="20" cy="10" rx="11" ry="5" fill={top}/>{kind === 'rounded_cylinder' && <path d="M10 29c0 7 20 7 20 0" opacity=".6"/>}</>;
  } else if (['sphere','ellipsoid'].includes(kind)) {
    shape = <ellipse cx="20" cy="21" rx={kind === 'ellipsoid' ? 17 : 15} ry={kind === 'ellipsoid' ? 11 : 15} fill={front}/>;
  } else if (kind === 'cone') {
    shape = <><path d="M20 4 5 32c0 8 30 8 30 0Z" fill={front}/><path d="M5 32c0 7 30 7 30 0"/></>;
  } else if (kind === 'frustum') {
    shape = <><path d="m12 10-7 22c0 8 30 8 30 0l-7-22" fill={front}/><ellipse cx="20" cy="10" rx="8" ry="4" fill={top}/></>;
  } else {
    shape = <><ellipse cx="20" cy="23" rx="17" ry="11" fill={front}/><ellipse cx="20" cy="19" rx="17" ry="11" fill={top}/><ellipse cx="20" cy="19" rx="8" ry="4" fill="var(--panel)"/><path d="M12 19c0-3 16-3 16 0"/></>;
  }
  return <svg width={size} height={size} viewBox="0 0 40 42" fill="none" stroke="var(--primitive-outline, #91a9ba)" strokeWidth=".8" aria-hidden="true" {...props}><defs><linearGradient id={`${id}-front`} x1="0" x2="1" y2=".25"><stop stopColor="var(--primitive-light, #d7e0e7)"/><stop offset="1" stopColor="var(--primitive-shade, #647b8d)"/></linearGradient><linearGradient id={`${id}-top`} x1="0" y1="0" x2=".4" y2="1"><stop stopColor="var(--primitive-light, #d7e0e7)"/><stop offset="1" stopColor="var(--primitive-mid, #a9bbc9)"/></linearGradient></defs>{shape}</svg>;
}
