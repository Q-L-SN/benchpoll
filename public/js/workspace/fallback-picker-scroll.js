export function fallbackScrollEdges({ firstLeft, lastRight, left, right }) {
    return { left: firstLeft < left - 1, right: lastRight > right + 1 };
}

export function sequentialScrollStep({ delta, top, height, visible, index, count }) {
    const maximum = Math.max(0, height - visible);
    const nextTop = Math.max(0, Math.min(maximum, top + delta));
    if (Math.abs(nextTop - top) > .5) return { kind: 'vertical', top: nextTop };
    const next = Math.max(0, Math.min(count - 1, index + Math.sign(delta)));
    return next !== index ? { kind: 'column', index: next } : { kind: 'boundary' };
}

export function createFallbackPickerScroll({ shell, viewport, track, previous, next }) {
    let horizontalUntil = 0;
    const mobile = window.matchMedia('(max-width: 760px), (pointer: coarse)');
    const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const columns = () => [...track.children];
    const position = column => column.offsetLeft - (track.firstElementChild?.offsetLeft ?? 0);
    const nearest = () => columns().reduce((best, column, index, list) =>
        Math.abs(position(column) - viewport.scrollLeft) < Math.abs(position(list[best]) - viewport.scrollLeft) ? index : best, 0);

    function refresh() {
        const bounds = viewport.getBoundingClientRect();
        const first = track.firstElementChild?.getBoundingClientRect();
        const last = track.lastElementChild?.getBoundingClientRect();
        const { left, right } = first && last ? fallbackScrollEdges({ firstLeft: first.left, lastRight: last.right,
            left: bounds.left, right: bounds.right }) : { left: false, right: false };
        shell.classList.toggle('can-scroll-left', left);
        shell.classList.toggle('can-scroll-right', right);
        previous.disabled = !left;
        next.disabled = !right;
    }

    function navigate(index, { animate = true } = {}) {
        const column = columns()[index];
        if (!column) return;
        horizontalUntil = performance.now() + (animate && !reduced() ? 280 : 0);
        viewport.scrollTo({ left: position(column), behavior: animate && !reduced() ? 'smooth' : 'instant' });
        requestAnimationFrame(refresh);
    }

    function reveal(column) {
        if (!column) return;
        const box = column.getBoundingClientRect(), frame = viewport.getBoundingClientRect();
        if (box.left < frame.left - 1 || box.right > frame.right + 1) navigate(columns().indexOf(column));
    }

    function reset() {
        viewport.scrollTo({ top: 0, left: 0, behavior: 'instant' });
        track.querySelectorAll('.bp-fallback-picker-steps').forEach(list => { list.scrollTop = 0; });
        horizontalUntil = 0;
        refresh();
    }

    function wheel(event) {
        if (mobile.matches || event.ctrlKey || !event.deltaY
            || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
        const listColumns = columns();
        const column = event.target.closest('.bp-fallback-picker-column') ?? listColumns[nearest()];
        const list = column?.querySelector('.bp-fallback-picker-steps');
        if (!list) return;
        if (performance.now() < horizontalUntil) { event.preventDefault(); return; }
        const delta = event.deltaY * (event.deltaMode === 1 ? 20 : event.deltaMode === 2 ? list.clientHeight : 1);
        const action = sequentialScrollStep({ delta, top: list.scrollTop, height: list.scrollHeight,
            visible: list.clientHeight, index: listColumns.indexOf(column), count: listColumns.length });
        if (action.kind === 'boundary') return;
        event.preventDefault();
        if (action.kind === 'vertical') list.scrollTop = action.top;
        else navigate(action.index);
    }
    const back = () => navigate(nearest() - 1);
    const forward = () => navigate(nearest() + 1);
    const focus = event => reveal(event.target.closest('.bp-fallback-picker-column'));
    viewport.addEventListener('wheel', wheel, { passive: false });
    viewport.addEventListener('scroll', refresh, { passive: true });
    viewport.addEventListener('scrollend', refresh);
    track.addEventListener('focusin', focus);
    previous.addEventListener('click', back);
    next.addEventListener('click', forward);
    mobile.addEventListener('change', refresh);
    const observer = new window.ResizeObserver(refresh);
    observer.observe(viewport); observer.observe(track);
    reset();
    return { refresh, reveal, reset,
        destroy() {
            observer.disconnect();
            viewport.removeEventListener('wheel', wheel); viewport.removeEventListener('scroll', refresh);
            viewport.removeEventListener('scrollend', refresh);
            track.removeEventListener('focusin', focus); previous.removeEventListener('click', back);
            next.removeEventListener('click', forward); mobile.removeEventListener('change', refresh);
        } };
}
