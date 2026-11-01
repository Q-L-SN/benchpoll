export function createShowcaseScrollGate(isActive, onInput = () => {}) {
    let blocked = false, transitioning = false, touchDown = false, lastInput = -Infinity, source = '', timer = 0;
    const positions = new Map();
    const quiet = 240;
    const reset = () => {
        blocked = false; transitioning = false; positions.clear(); window.clearTimeout(timer);
        document.body.classList.remove('is-showcase-handoff');
    };
    const releaseWhenQuiet = () => {
        window.clearTimeout(timer);
        if (blocked && !transitioning && !touchDown) timer = window.setTimeout(reset, quiet);
    };
    const stop = event => { event.preventDefault(); event.stopImmediatePropagation(); };
    const wheel = event => {
        const now = performance.now();
        if (isActive() && Math.abs(event.deltaY) >= Math.abs(event.deltaX)) onInput();
        if (blocked && !transitioning && !touchDown && now - lastInput >= quiet) reset();
        lastInput = now; source = 'wheel';
        if (blocked) { stop(event); releaseWhenQuiet(); }
    };
    const touchStart = event => {
        if (isActive()) onInput();
        if (blocked && !transitioning && !touchDown) reset();
        touchDown = event.touches.length > 0; source = 'touch'; lastInput = performance.now();
    };
    const touchMove = event => {
        if (isActive()) onInput();
        lastInput = performance.now(); source = 'touch';
        if (blocked) stop(event);
    };
    const touchEnd = event => { touchDown = event.touches.length > 0; lastInput = performance.now(); releaseWhenQuiet(); };
    const scroll = event => {
        if (!blocked || isActive()) return;
        if (event.target === document || event.target === window) {
            if (window.scrollY !== 0) { window.scrollTo({ top: 0, behavior: 'instant' }); lastInput = performance.now(); releaseWhenQuiet(); }
        } else if (positions.has(event.target)) {
            const top = positions.get(event.target);
            if (event.target.scrollTop !== top) { event.target.scrollTop = top; lastInput = performance.now(); releaseWhenQuiet(); }
        }
    };
    const options = { capture: true, passive: false };
    window.addEventListener('wheel', wheel, options);
    window.addEventListener('touchstart', touchStart, { capture: true, passive: true });
    window.addEventListener('touchmove', touchMove, options);
    window.addEventListener('touchend', touchEnd, { capture: true, passive: true });
    window.addEventListener('touchcancel', touchEnd, { capture: true, passive: true });
    window.addEventListener('scroll', scroll, { capture: true, passive: true });
    return {
        recentlyScrolling: () => touchDown || performance.now() - lastInput < (source === 'touch' ? 900 : 600),
        begin() { blocked = true; transitioning = true; document.body.classList.add('is-showcase-handoff'); },
        capture() {
            if (!blocked) return;
            for (const node of document.querySelectorAll('.bp-workspace, .bp-shell, .bp-pie-scroll-shell, .bp-model-rows, .bp-benchmark-rows')) positions.set(node, node.scrollTop);
        },
        finish() { transitioning = false; releaseWhenQuiet(); },
        reset,
        destroy() {
            reset();
            window.removeEventListener('wheel', wheel, true); window.removeEventListener('touchstart', touchStart, true);
            window.removeEventListener('touchmove', touchMove, true); window.removeEventListener('touchend', touchEnd, true);
            window.removeEventListener('touchcancel', touchEnd, true); window.removeEventListener('scroll', scroll, true);
        }
    };
}
