export function createTaxonomyDrawer(toggle, sidebar) {
    const body = document.body;
    body.classList.add('taxonomy-tracked');
    let closeTimer = null;
    let frame = null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const setProgress = value => body.style.setProperty('--bp-drawer-progress', String(Math.max(0, Math.min(1, value))));
    const clear = () => { clearTimeout(closeTimer); cancelAnimationFrame(frame); closeTimer = null; frame = null; };

    function finishClosing() {
        clearTimeout(closeTimer);
        closeTimer = null;
        if (!body.classList.contains('taxonomy-closing')) return;
        body.classList.remove('taxonomy-open', 'taxonomy-closing', 'taxonomy-dragging');
        body.style.removeProperty('--bp-drawer-progress');
    }

    sidebar.addEventListener('transitionend', event => {
        if (event.target === sidebar && event.propertyName === 'transform') finishClosing();
    });

    function setTaxonomyOpen(open) {
        clear();
        body.classList.remove('taxonomy-dragging');
        toggle.setAttribute('aria-expanded', String(open));
        body.querySelectorAll('[data-taxonomy-trigger]').forEach(trigger => {
            trigger.setAttribute('aria-expanded', String(open));
        });
        if (open) {
            const wasOpen = body.classList.contains('taxonomy-open');
            body.classList.remove('taxonomy-closing');
            body.classList.add('taxonomy-open');
            if (!wasOpen && !reduced.matches) {
                setProgress(0);
                sidebar.getBoundingClientRect();
                frame = requestAnimationFrame(() => setProgress(1));
            } else setProgress(1);
            return;
        }
        if (!body.classList.contains('taxonomy-open')) return;
        if (!window.matchMedia('(max-width: 760px) and (prefers-reduced-motion: no-preference)').matches) {
            body.classList.remove('taxonomy-open');
            body.style.removeProperty('--bp-drawer-progress');
            return;
        }
        body.classList.add('taxonomy-closing');
        setProgress(0);
        closeTimer = setTimeout(finishClosing, 350);
    }
    sidebar.addEventListener('taxonomy:drag', event => {
        const { phase, progress, open } = event.detail;
        if (phase === 'start') {
            clear(); body.classList.add('taxonomy-dragging', 'taxonomy-open'); body.classList.remove('taxonomy-closing');
            setProgress(progress);
        } else if (phase === 'move') setProgress(progress);
        else if (phase === 'end') setTaxonomyOpen(open);
    });
    return setTaxonomyOpen;
}
