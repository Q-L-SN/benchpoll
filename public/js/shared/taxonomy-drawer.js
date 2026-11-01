export function createTaxonomyDrawer(toggle, sidebar) {
    const body = document.body;
    let closeTimer = null;

    function finishClosing() {
        clearTimeout(closeTimer);
        closeTimer = null;
        if (!body.classList.contains('taxonomy-closing')) return;
        body.classList.remove('taxonomy-open', 'taxonomy-closing');
    }

    sidebar.addEventListener('animationend', event => {
        if (event.target === sidebar && event.animationName === 'bp-drawer-exit') finishClosing();
    });

    return function setTaxonomyOpen(open) {
        toggle.setAttribute('aria-expanded', String(open));
        body.querySelectorAll('[data-taxonomy-trigger]').forEach(trigger => {
            trigger.setAttribute('aria-expanded', String(open));
        });
        if (open) {
            clearTimeout(closeTimer);
            closeTimer = null;
            body.classList.remove('taxonomy-closing');
            body.classList.add('taxonomy-open');
            return;
        }
        if (!body.classList.contains('taxonomy-open') || body.classList.contains('taxonomy-closing')) return;
        if (!window.matchMedia('(max-width: 760px) and (prefers-reduced-motion: no-preference)').matches) {
            body.classList.remove('taxonomy-open');
            return;
        }
        body.classList.add('taxonomy-closing');
        closeTimer = setTimeout(finishClosing, 350);
    };
}
