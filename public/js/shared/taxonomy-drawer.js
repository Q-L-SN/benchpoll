export function createTaxonomyDrawer(toggle, sidebar) {
    const body = document.body;
    body.classList.add('taxonomy-tracked');
    let closeTimer = null;
    let frame = null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const scrim = document.getElementById('taxonomy-scrim');
    const setProgress = value => {
        const progress = Math.max(0, Math.min(1, value));
        body.style.setProperty('--bp-drawer-progress', String(progress));
        // Safari can jump straight to an inherited custom property's transform.
        // Set the animated properties on their elements so CSS transitions and
        // finger-driven progress share the same interpolated geometry.
        sidebar.style.transform = `translateX(${(progress - 1) * 100}%)`;
        if (scrim) scrim.style.opacity = String(progress);
    };
    const resetProgress = () => {
        body.style.removeProperty('--bp-drawer-progress');
        sidebar.style.removeProperty('transform');
        scrim?.style.removeProperty('opacity');
    };
    const clear = () => { clearTimeout(closeTimer); cancelAnimationFrame(frame); closeTimer = null; frame = null; };

    function finishClosing() {
        clearTimeout(closeTimer);
        closeTimer = null;
        if (!body.classList.contains('taxonomy-closing')) return;
        body.classList.remove('taxonomy-open', 'taxonomy-closing', 'taxonomy-dragging');
        resetProgress();
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
            if (!wasOpen && !reduced.matches) body.classList.add('taxonomy-preparing');
            body.classList.remove('taxonomy-closing');
            body.classList.add('taxonomy-open');
            // Mobile directory content is display:none while closed. Lay it out and
            // restore its position synchronously, before the first opening frame.
            if (!wasOpen) sidebar.dispatchEvent(new CustomEvent('sidebar:beforeopen'));
            if (!wasOpen && !reduced.matches) {
                setProgress(0);
                sidebar.getBoundingClientRect();
                frame = requestAnimationFrame(() => {
                    frame = requestAnimationFrame(() => {
                        body.classList.remove('taxonomy-preparing');
                        // WebKit needs the transition-enabled start position
                        // committed before the destination changes.
                        getComputedStyle(sidebar).transform;
                        frame = requestAnimationFrame(() => setProgress(1));
                    });
                });
            } else setProgress(1);
            return;
        }
        if (!body.classList.contains('taxonomy-open')) return;
        body.classList.remove('taxonomy-preparing');
        if (!window.matchMedia('(max-width: 760px) and (prefers-reduced-motion: no-preference)').matches) {
            body.classList.remove('taxonomy-open');
            resetProgress();
            return;
        }
        body.classList.add('taxonomy-closing');
        setProgress(0);
        closeTimer = setTimeout(finishClosing, 350);
    }
    sidebar.addEventListener('taxonomy:drag', event => {
        const { phase, progress, open } = event.detail;
        if (phase === 'start') {
            const wasOpen = body.classList.contains('taxonomy-open');
            clear(); body.classList.add('taxonomy-dragging', 'taxonomy-open'); body.classList.remove('taxonomy-closing');
            if (!wasOpen) sidebar.dispatchEvent(new CustomEvent('sidebar:beforeopen'));
            setProgress(progress);
        } else if (phase === 'move') setProgress(progress);
        else if (phase === 'end') setTaxonomyOpen(open);
    });
    return setTaxonomyOpen;
}
