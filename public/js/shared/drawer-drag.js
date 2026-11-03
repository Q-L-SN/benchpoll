const excluded = 'input, select, textarea, [contenteditable]:not([contenteditable="false"]), '
    + '[role="slider"], dialog, global-dialog, .discussion-rail, .bp-scene-strip, .bp-mobile-panels, '
    + '.bp-model-controls, .bp-pie-stage, .bp-overlay-scrollbar, [data-sidebar-swipe="ignore"], canvas, svg';
const closedControls = 'a, button, label, form, summary, [role="button"], [role="link"], [role="dialog"], '
    + '.bp-scene-tabs, .bp-model-name, .bp-model-parameters';

export function drawerReleaseOpen(progress, velocity = 0) {
    return Math.abs(velocity) > .45 ? velocity > 0 : progress >= .5;
}

export function bindDrawerDrag(workspace, mobile) {
    const sidebar = document.getElementById('config-sidebar');
    if (!workspace || !sidebar) return;
    let gesture = null;
    const send = detail => sidebar.dispatchEvent(new CustomEvent('taxonomy:drag', { detail }));
    const cancel = () => {
        if (gesture?.dragging) send({ phase: 'end', open: gesture.wasOpen });
        gesture = null;
    };
    document.addEventListener('touchstart', event => {
        cancel();
        if (!mobile.matches || workspace.dataset.display === 'charts' || event.touches.length !== 1 || document.body.classList.contains('discussion-open')
            || window.visualViewport?.scale > 1.01
            || document.activeElement?.matches('input, select, textarea, [contenteditable]:not([contenteditable="false"])')
            || [...document.querySelectorAll('dialog[open], global-dialog:not([hidden]), [aria-modal="true"]')]
                .some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')) return;
        const point = event.touches[0], wasOpen = document.body.classList.contains('taxonomy-open');
        const pager = workspace.querySelector('#workspace-scene-panel');
        if (!wasOpen && (!workspace.contains(event.target) || pager?.scrollLeft > 1)) return;
        if (point.clientX <= 24 || point.clientX >= window.innerWidth - 24) return;
        for (const node of event.composedPath()) {
            if (!(node instanceof Element)) continue;
            if (node.matches(excluded) || !wasOpen && node.matches(closedControls)) return;
            const style = getComputedStyle(node);
            if (node !== pager && /(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return;
            if (node === workspace || node === sidebar) break;
        }
        const width = wasOpen ? sidebar.getBoundingClientRect().width : Math.min(310, window.innerWidth * .88);
        const transform = wasOpen ? new window.DOMMatrix(getComputedStyle(sidebar).transform).m41 : -width;
        const initial = Math.max(0, Math.min(1, 1 + transform / width));
        gesture = { id: point.identifier, x: point.clientX, y: point.clientY, wasOpen, width, initial,
            progress: initial, lastX: point.clientX, lastTime: event.timeStamp, velocity: 0, dragging: false };
    }, { passive: true });
    document.addEventListener('touchmove', event => {
        if (!gesture) return;
        const point = [...event.touches].find(point => point.identifier === gesture.id);
        if (!point || event.touches.length !== 1) { cancel(); return; }
        const dx = point.clientX - gesture.x, dy = point.clientY - gesture.y;
        if (!gesture.dragging) {
            if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { cancel(); return; }
            if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.4) return;
            if (!gesture.wasOpen && dx < 0) { cancel(); return; }
            gesture.dragging = true;
            send({ phase: 'start', progress: gesture.initial });
        }
        if (event.cancelable) event.preventDefault();
        const elapsed = event.timeStamp - gesture.lastTime;
        if (elapsed > 0) gesture.velocity = (point.clientX - gesture.lastX) / elapsed;
        gesture.lastTime = event.timeStamp; gesture.lastX = point.clientX;
        gesture.progress = Math.max(0, Math.min(1, gesture.initial + dx / gesture.width));
        send({ phase: 'move', progress: gesture.progress });
    }, { passive: false });
    document.addEventListener('touchend', event => {
        if (!gesture) return;
        if (event.touches.length) { cancel(); return; }
        const finished = gesture; gesture = null;
        if (!finished.dragging) return;
        if (event.cancelable) event.preventDefault();
        const velocity = event.timeStamp - finished.lastTime < 120 ? finished.velocity : 0;
        send({ phase: 'end', open: drawerReleaseOpen(finished.progress, velocity) });
    }, { passive: false });
    document.addEventListener('touchcancel', cancel, { passive: true });
    document.addEventListener('scroll', () => { if (gesture && !gesture.dragging) cancel(); }, { passive: true, capture: true });
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    mobile.addEventListener('change', cancel);
}
