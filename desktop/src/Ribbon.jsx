import React, { useRef, useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import RibbonPalette from './RibbonPalette';

// Tool categories are view state; selecting a tab never edits the model.
export default function Ribbon({ categories }) {
  const [active, setActive] = useState(categories[0].id);
  const [collapsed, setCollapsed] = useState(false);
  const [palette,setPalette] = useState(null);
  const tabs = useRef([]);
  const current = categories.find(category => category.id === active);
  function choose(id) { setActive(id); setCollapsed(false); setPalette(null); }
  function keyboard(event, index) {
    let next;
    if (event.key === 'ArrowRight') next = (index + 1) % categories.length;
    if (event.key === 'ArrowLeft') next = (index + categories.length - 1) % categories.length;
    if (event.key === 'Home') next = 0;
    if (event.key === 'End') next = categories.length - 1;
    if (next === undefined) return;
    event.preventDefault(); choose(categories[next].id); tabs.current[next]?.focus();
  }
  return <section className="ribbon" aria-label="顶部功能工具栏">
    <div className="ribbon-heading">
      <div className="ribbon-tabs" role="tablist" aria-label="功能选项卡">
        {categories.map((category, index) => <button key={category.id} ref={el => { tabs.current[index] = el; }}
          type="button" role="tab" id={`ribbon-tab-${category.id}`} aria-controls={`ribbon-panel-${category.id}`}
          aria-selected={active === category.id} tabIndex={active === category.id ? 0 : -1}
          onClick={() => choose(category.id)} onKeyDown={event => keyboard(event, index)}>{category.label}</button>)}
      </div>
      <button type="button" className="ribbon-collapse" aria-label={collapsed ? '展开功能工具栏' : '收起功能工具栏'}
        aria-expanded={!collapsed} aria-controls={`ribbon-panel-${active}`} onClick={() => {setCollapsed(!collapsed);setPalette(null);}}>
        {collapsed ? <ChevronDown size={17} aria-hidden="true" /> : <ChevronUp size={17} aria-hidden="true" />}
        {collapsed ? '展开' : '收起'}
      </button>
    </div>
    {categories.map(category => <div key={category.id} id={`ribbon-panel-${category.id}`} role="tabpanel"
      aria-labelledby={`ribbon-tab-${category.id}`} hidden={collapsed || active !== category.id} tabIndex={0} className="ribbon-panel">
      {category.id === current.id && category.groups.map(group => <section className="ribbon-group" key={group.label} aria-label={group.label}>
        <div className="ribbon-tools">{group.tools.filter(tool => !group.palette || group.common.includes(tool.id)).map(({ id, label, icon: Icon, onClick, disabled, hint, pressed }) =>
          <button key={id || label} type="button" className="ribbon-tool" onClick={onClick} disabled={disabled}
            aria-label={label} aria-pressed={pressed} title={hint || label}>
            <Icon size={23} strokeWidth={1.6} aria-hidden="true" /><span>{label}</span>
          </button>)}</div>
        {group.palette ? <button type="button" className="ribbon-palette-trigger" aria-label="展开基本体选项" aria-expanded={!!palette} aria-controls="basic-body-palette" onClick={event => setPalette(palette ? null : {group,anchor:event.currentTarget})}>基本体<ChevronDown size={14} aria-hidden="true"/></button> : <h3>{group.label}</h3>}
      </section>)}
    </div>)}
    {palette && <RibbonPalette group={current.groups.find(group => group.label === palette.group.label)} anchor={palette.anchor} onClose={() => setPalette(null)}/>}
  </section>;
}
