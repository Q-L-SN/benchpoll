export function initializeMobilePanels(workspace) {
    const pager = workspace.querySelector('#workspace-scene-panel');
    const dock = workspace.querySelector('.bp-mobile-panels');
    const controls = [...dock.querySelectorAll('button[data-mobile-panel]')];
    const panels = [...pager.children];
    const mobile = window.matchMedia('(max-width: 760px)');
    const enabled = () => mobile.matches && workspace.dataset.display !== 'charts';
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const names = controls.map(control => control.dataset.mobilePanel);
    const thumb = document.createElement('span');
    thumb.className = 'bp-mobile-panel-thumb'; thumb.setAttribute('aria-hidden', 'true');
    // Both label rows stay in place. Only the darker row's visible area follows the lens.
    const emphasis = document.createElement('span');
    emphasis.className = 'bp-mobile-panel-emphasis'; emphasis.setAttribute('aria-hidden', 'true');
    emphasis.inert = true;
    for (const control of controls) {
        const label = document.createElement('span');
        label.dataset.mobilePanelLabel = control.dataset.mobilePanel;
        label.textContent = control.textContent;
        emphasis.append(label);
    }
    dock.append(thumb, emphasis);
    let current = names.includes(workspace.dataset.mobilePanel) ? workspace.dataset.mobilePanel : 'mix';
    let lastAnnounced = null, previewingDiscussion = false;
    let frame = null, settleTimer = null;
    const identity = workspace.querySelector('.bp-heading-stack');
    let viewportWidth = null;
    let dockPress = null, scrollStyles = null, ignoreClickUntil = 0;
    const progress = () => enabled() && pager.clientWidth ? Math.max(0, Math.min(names.length - 1, pager.scrollLeft / pager.clientWidth)) : names.indexOf(current);
    const dockStep = () => Math.max(0, (dock.clientWidth - 8) / names.length);
    function restoreDockScrolling() {
        if (!scrollStyles) return;
        pager.style.scrollSnapType = scrollStyles.snap;
        pager.style.scrollBehavior = scrollStyles.behavior;
        scrollStyles = null;
    }
    function activatePanels() {
        panels.forEach(panel => { panel.inert = false; panel.removeAttribute('aria-hidden'); });
    }

    function paint() {
        frame = null;
        const value = progress();
        dock.style.setProperty('--bp-page-count', String(names.length));
        dock.style.setProperty('--bp-page-indicator-width', `${dockStep()}px`);
        dock.style.setProperty('--bp-page-indicator-x', `${value * dockStep()}px`);
        if (enabled() && value > 1.02 && !previewingDiscussion) {
            previewingDiscussion = true;
            window.dispatchEvent(new CustomEvent('benchpoll:mobile-panel-preview', { detail: { panel: 'discussion' } }));
        }
    }
    function commit() {
        clearTimeout(settleTimer);
        if (!enabled() || dockPress) return;
        const value = progress();
        const index = Math.round(value);
        if (Math.abs(value - index) > .02) return;
        restoreDockScrolling();
        current = names[index];
        workspace.dataset.mobilePanel = current;
        controls.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mobilePanel === current)));
        panels.forEach((panel, index) => {
            panel.inert = index !== names.indexOf(current);
            panel.setAttribute('aria-hidden', String(panel.inert));
        });
        if (lastAnnounced !== current || previewingDiscussion && current !== 'discussion') {
            window.dispatchEvent(new CustomEvent('benchpoll:mobile-panel', { detail: { panel: current } }));
            lastAnnounced = current;
        }
        if (current !== 'discussion') previewingDiscussion = false;
        paint();
    }
    function select(mode, { instant = false } = {}) {
        current = names.includes(mode) ? mode : 'mix';
        workspace.dataset.mobilePanel = current;
        controls.forEach(button => button.setAttribute('aria-pressed', String(button.dataset.mobilePanel === current)));
        if (enabled()) {
            activatePanels();
            const left = names.indexOf(current) * pager.clientWidth;
            pager.scrollTo({ left,
                behavior: instant || reduced.matches ? 'instant' : 'smooth' });
            if (Math.abs(pager.scrollLeft - left) < .5) commit();
        }
        paint();
    }
    function resize() {
        if (identity) workspace.style.setProperty('--bp-mobile-topic-height', `${identity.getBoundingClientRect().height}px`);
        const widthChanged = viewportWidth !== pager.clientWidth;
        viewportWidth = pager.clientWidth;
        // A discussion/composer update may resize panel content while a finger
        // is between pages. Only a viewport-width change can realign the pager.
        if (widthChanged || !enabled()) {
            endDockPress(null, true);
            restoreDockScrolling();
        }
        if (enabled() && widthChanged) { select(current, { instant: true }); commit(); }
        else if (!enabled()) activatePanels();
        paint();
    }
    controls.forEach(control => control.addEventListener('click', event => {
        if (event.detail && performance.now() < ignoreClickUntil) { event.preventDefault(); return; }
        select(control.dataset.mobilePanel);
    }));
    dock.addEventListener('pointerdown', event => {
        if (!enabled() || dockPress || !event.isPrimary || event.button !== 0 || !dockStep()) return;
        const target = event.target.closest('button[data-mobile-panel]');
        dockPress = { id: event.pointerId, startX: event.clientX, start: progress(), original: current,
            target: target?.dataset.mobilePanel ?? current, moved: false };
        scrollStyles ??= { snap: pager.style.scrollSnapType, behavior: pager.style.scrollBehavior };
        pager.style.scrollSnapType = 'none'; pager.style.scrollBehavior = 'auto';
        pager.scrollTo({ left: pager.scrollLeft, behavior: 'instant' });
        activatePanels();
        dock.classList.add('is-pressed');
        dock.setPointerCapture(event.pointerId);
        event.preventDefault();
    });
    dock.addEventListener('pointermove', event => {
        if (!dockPress || event.pointerId !== dockPress.id) return;
        const distance = event.clientX - dockPress.startX;
        if (!dockPress.moved && Math.abs(distance) < 4) return;
        if (!dockPress.moved) {
            dockPress.moved = true;
            dock.classList.add('is-dragging');
        }
        const value = Math.max(0, Math.min(names.length - 1, dockPress.start + distance / dockStep()));
        pager.scrollTo({ left: value * pager.clientWidth, behavior: 'instant' });
        paint(); event.preventDefault();
    });
    function endDockPress(event, cancelled = false) {
        if (!dockPress || event && event.pointerId !== dockPress.id) return;
        const press = dockPress;
        dockPress = null;
        dock.classList.remove('is-pressed', 'is-dragging');
        if (dock.hasPointerCapture(press.id)) dock.releasePointerCapture(press.id);
        ignoreClickUntil = performance.now() + 500;
        if (!enabled()) return;
        const target = cancelled ? press.original : press.moved ? names[Math.round(progress())] : press.target;
        select(target);
    }
    dock.addEventListener('pointerup', event => endDockPress(event));
    dock.addEventListener('pointercancel', event => endDockPress(event, true));
    dock.addEventListener('lostpointercapture', event => endDockPress(event, true));
    dock.addEventListener('keydown', event => {
        if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
        event.preventDefault();
        const active = controls.indexOf(document.activeElement);
        const index = event.key === 'Home' ? 0 : event.key === 'End' ? controls.length - 1
            : Math.max(0, Math.min(controls.length - 1, (active < 0 ? names.indexOf(current) : active) + (event.key === 'ArrowRight' ? 1 : -1)));
        select(controls[index].dataset.mobilePanel); controls[index].focus({ preventScroll: true });
    });
    pager.addEventListener('scroll', () => {
        if (frame === null) frame = requestAnimationFrame(paint);
        clearTimeout(settleTimer); settleTimer = setTimeout(commit, 120);
    }, { passive: true });
    pager.addEventListener('scrollend', commit);
    // Native scrolling follows the finger and preserves vertical scrolling in each page.
    pager.addEventListener('touchstart', () => {
        activatePanels();
    }, { passive: true });
    pager.addEventListener('touchend', () => { clearTimeout(settleTimer); settleTimer = setTimeout(commit, 180); }, { passive: true });
    pager.addEventListener('touchcancel', commit, { passive: true });
    let display = workspace.dataset.display;
    const modeObserver = new MutationObserver(() => {
        if (display !== workspace.dataset.display) { display = workspace.dataset.display; viewportWidth = null; resize(); }
        else if (workspace.dataset.mobilePanel !== current) select(workspace.dataset.mobilePanel);
    });
    modeObserver.observe(workspace, { attributes: true, attributeFilter: ['data-mobile-panel', 'data-display'] });
    const sizing = new window.ResizeObserver(resize);
    sizing.observe(pager); sizing.observe(dock);
    if (identity) sizing.observe(identity);
    mobile.addEventListener('change', () => { viewportWidth = null; resize(); });

    const stickySizes = new window.ResizeObserver(entries => {
        for (const entry of entries) {
            const variable = entry.target.dataset.stickyHeight;
            workspace.style.setProperty(variable, `${entry.target.getBoundingClientRect().height}px`);
        }
    });
    for (const [selector, variable] of [['.bp-benchmark-toolbar', '--bp-evaluation-toolbar-height'],
        ['.bp-model-controls', '--bp-index-toolbar-height'], ['#estimation-test-control', '--bp-estimation-toolbar-height']]) {
        const element = workspace.querySelector(selector);
        if (element) { element.dataset.stickyHeight = variable; stickySizes.observe(element); }
    }

    const toolbar = workspace.querySelector('.bp-model-controls');
    const updateEdges = () => {
        toolbar.classList.toggle('has-overflow-start', toolbar.scrollLeft > 1);
        toolbar.classList.toggle('has-overflow-end', toolbar.scrollLeft + toolbar.clientWidth < toolbar.scrollWidth - 1);
    };
    toolbar.addEventListener('scroll', updateEdges, { passive: true });
    const toolbarResize = new window.ResizeObserver(updateEdges);
    toolbarResize.observe(toolbar);
    toolbar.querySelectorAll('button, a').forEach(node => toolbarResize.observe(node));
    new MutationObserver(updateEdges).observe(toolbar, { attributes: true, subtree: true, attributeFilter: ['hidden'] });
    document.fonts?.ready.then(() => { resize(); updateEdges(); });
    resize(); updateEdges();
    return { select };
}
