const controls = 'button, a, input, textarea, select, [contenteditable], [role="slider"]';
const maximum = viewport => Math.max(0, viewport.scrollHeight - viewport.clientHeight);
const canScroll = (viewport, delta) => delta > 0 ? viewport.scrollTop < maximum(viewport) - 1 : delta < 0 && viewport.scrollTop > 1;
const scrollBy = (viewport, delta) => { viewport.scrollTop = Math.max(0, Math.min(maximum(viewport), viewport.scrollTop + delta)); };

export function createShowcaseWeightScroll({ panel, viewport, isActive }) {
    let gesture = null;
    const nativeTarget = target => viewport.contains(target) || Boolean(target.closest?.(controls));
    const reset = () => { gesture = null; };
    const start = event => {
        reset();
        if (!isActive() || event.touches.length !== 1 || nativeTarget(event.target)) return;
        const touch = event.touches[0];
        gesture = { ID: touch.identifier, x: touch.clientX, y: touch.clientY, lastY: touch.clientY, claimed: false };
    };
    const move = event => {
        if (!gesture) return;
        const touch = [...event.touches].find(touch => touch.identifier === gesture.ID);
        if (!isActive() || !touch || event.touches.length !== 1 || !event.cancelable) { reset(); return; }
        if (!gesture.claimed) {
            const dx = Math.abs(touch.clientX - gesture.x), dy = gesture.y - touch.clientY;
            if (Math.max(dx, Math.abs(dy)) < 6) return;
            if (dx >= Math.abs(dy) || !canScroll(viewport, dy)) { reset(); return; }
            gesture.claimed = true;
        }
        // Only the non-scrollable heading/gutters need forwarding; list content keeps native scrolling.
        event.preventDefault();
        scrollBy(viewport, gesture.lastY - touch.clientY);
        gesture.lastY = touch.clientY;
    };
    const wheel = event => {
        if (!isActive() || nativeTarget(event.target) || !event.cancelable || event.ctrlKey || event.metaKey
            || event.shiftKey || Math.abs(event.deltaX) >= Math.abs(event.deltaY)) return;
        const delta = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientHeight : 1);
        if (!canScroll(viewport, delta)) return;
        event.preventDefault(); scrollBy(viewport, delta);
    };
    panel.addEventListener('touchstart', start, { passive: true });
    panel.addEventListener('touchmove', move, { passive: false });
    panel.addEventListener('touchend', reset, { passive: true });
    panel.addEventListener('touchcancel', reset, { passive: true });
    panel.addEventListener('wheel', wheel, { passive: false });
    return { reset, destroy() {
        reset();
        panel.removeEventListener('touchstart', start); panel.removeEventListener('touchmove', move);
        panel.removeEventListener('touchend', reset); panel.removeEventListener('touchcancel', reset);
        panel.removeEventListener('wheel', wheel);
    } };
}
