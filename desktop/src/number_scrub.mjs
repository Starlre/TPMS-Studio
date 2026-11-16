export function startNumberScrub(event, { value, onChange, min = -Infinity, max = Infinity, step = 0.1, decimals = null, disabled = false }) {
  if (disabled || event.button !== 0) return;
  const startX = event.clientX;
  const startValue = Number.isFinite(Number(value)) ? Number(value) : 0;
  const baseStep = Number.isFinite(Number(step)) && Number(step) > 0 ? Number(step) : 0.1;
  let moved = false;
  const move = moveEvent => {
    const dx = moveEvent.clientX - startX;
    if (!moved && Math.abs(dx) < 4) return;
    moved = true;
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    const effectiveStep = moveEvent.shiftKey ? baseStep * 0.1 : baseStep;
    const digits = decimals ?? Math.min(6, Math.max(0, (String(effectiveStep).split('.')[1] || '').length));
    const raw = startValue + Math.round(dx / 6) * effectiveStep;
    const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, raw));
    onChange(Number(clamped.toFixed(digits)));
  };
  const up = () => {
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    if (moved) {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
}
