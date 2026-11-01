// Keep native scrolling while drawing its thumb outside the content flow.
export function createOverlayScrollbar(viewport) {
    const shell = document.createElement('div');
    shell.className = 'bp-pie-scroll-shell';
    viewport.replaceWith(shell);
    const track = document.createElement('div');
    track.className = 'bp-overlay-scrollbar'; track.hidden = true;
    track.tabIndex = 0; track.setAttribute('role', 'scrollbar');
    track.setAttribute('aria-label', 'Scroll weights');
    track.setAttribute('aria-controls', viewport.id);
    track.setAttribute('aria-orientation', 'vertical');
    track.setAttribute('aria-valuemin', '0');
    const thumb = document.createElement('span'); track.append(thumb);
    shell.append(viewport, track);
    const desktop = window.matchMedia('(min-width: 761px)');
    let thumbSize = 0, travel = 0, max = 0, frame = null;
    function update() {
        frame = null;
        max = Math.max(0, viewport.scrollHeight - viewport.clientHeight);
        track.hidden = !desktop.matches || max < 1;
        if (track.hidden) return;
        thumbSize = Math.min(track.clientHeight, Math.max(32, track.clientHeight * viewport.clientHeight / viewport.scrollHeight));
        travel = track.clientHeight - thumbSize;
        thumb.style.height = `${thumbSize}px`;
        thumb.style.transform = `translateY(${travel * viewport.scrollTop / max}px)`;
        track.setAttribute('aria-valuemax', String(Math.round(max)));
        track.setAttribute('aria-valuenow', String(Math.round(viewport.scrollTop)));
    }
    const schedule = () => { if (frame === null) frame = requestAnimationFrame(update); };
    const resize = new window.ResizeObserver(schedule);
    resize.observe(viewport); resize.observe(viewport.firstElementChild);
    viewport.addEventListener('scroll', schedule, { passive: true });
    desktop.addEventListener('change', schedule);
    let drag = null;
    track.addEventListener('pointerdown', event => {
        if (event.button !== 0 || !travel) return;
        event.preventDefault(); event.stopPropagation();
        track.focus({ preventScroll: true }); track.setPointerCapture(event.pointerId);
        if (event.target !== thumb) viewport.scrollTop = (event.clientY - track.getBoundingClientRect().top - thumbSize / 2) / travel * max;
        drag = { y: event.clientY, top: viewport.scrollTop };
        track.classList.add('is-dragging');
    });
    track.addEventListener('pointermove', event => {
        if (drag && travel) viewport.scrollTop = drag.top + (event.clientY - drag.y) / travel * max;
    });
    const end = () => { drag = null; track.classList.remove('is-dragging'); };
    track.addEventListener('lostpointercapture', end);
    track.addEventListener('pointerup', end);
    track.addEventListener('pointercancel', end);
    track.addEventListener('keydown', event => {
        const values = { ArrowDown: viewport.scrollTop + 40, ArrowUp: viewport.scrollTop - 40,
            PageDown: viewport.scrollTop + viewport.clientHeight, PageUp: viewport.scrollTop - viewport.clientHeight,
            Home: 0, End: max };
        if (Object.hasOwn(values, event.key)) { event.preventDefault(); event.stopPropagation(); viewport.scrollTop = values[event.key]; }
    });
    schedule();
}
