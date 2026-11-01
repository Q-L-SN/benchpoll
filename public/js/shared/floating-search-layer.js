const activeLayers = new WeakMap();
const focusableSelector = 'a[href], button, input, select, textarea, summary, [tabindex], [contenteditable="true"]';

export function floatingSearchPosition({ anchor, viewport, width = 320, height, margin = 16, gap = 4, align = 'end' }) {
    const insetX = Math.min(margin, viewport.width / 2), insetY = Math.min(margin, viewport.height / 2);
    const left = viewport.left + insetX, right = viewport.left + viewport.width - insetX;
    const top = viewport.top + insetY, bottom = viewport.top + viewport.height - insetY;
    const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
    width = Math.min(width, right - left);
    const below = clamp(bottom - anchor.bottom - gap, 0, bottom - top);
    const above = clamp(anchor.top - top - gap, 0, bottom - top);
    const upward = below < height && above > below;
    const maxHeight = upward ? above : below;
    const renderedHeight = Math.min(height, maxHeight);
    return { width, maxHeight, left: clamp(align === 'start' ? anchor.left : anchor.right - width, left, right - width),
        top: clamp(upward ? anchor.top - gap - renderedHeight : anchor.bottom + gap, top, bottom - renderedHeight),
        placement: upward ? 'above' : 'below' };
}

// Manual popovers keep DOM ancestry, event handlers and accessibility relationships intact.
export function createFloatingSearchLayer({ anchor, panel, getAnchorRect = () => anchor.getBoundingClientRect(),
    scope = anchor, align = 'end', width = 320, maxHeight = Infinity, gap = 4, margin = 16, closeOnFocusOut = true, onClose = () => {} }) {
    const document = panel.ownerDocument, view = document.defaultView;
    let open = false, disposed = false, closing = false, native = false, portal = null, placeholder = null;
    let frame = null, focusTimer = null, outsideTimer = null, resize = null, mutations = null;
    let originalPopover = null, savedStyles = new Map();

    function style(name, value) {
        if (!savedStyles.has(name)) savedStyles.set(name, [panel.style.getPropertyValue(name), panel.style.getPropertyPriority(name)]);
        if (panel.style.getPropertyValue(name) !== value) panel.style.setProperty(name, value);
    }
    function contains(target) { return scope.contains(target) || panel.contains(target); }
    function available() {
        return anchor.isConnected && panel.isConnected && !anchor.closest('[hidden], [inert]')
            && anchor.getClientRects().length && view.getComputedStyle(anchor).visibility === 'visible';
    }
    function portalHost() {
        const styles = view.getComputedStyle(document.body);
        const clipped = ['transform', 'perspective', 'filter', 'backdrop-filter', 'clip-path', 'mask-image']
            .some(name => { const value = styles.getPropertyValue(name); return value && value !== 'none'; });
        return clipped || /paint|layout|strict|content/.test(styles.contain)
            || /transform|filter|perspective/.test(styles.willChange) ? document.documentElement : document.body;
    }
    function reposition() {
        if (!open) return;
        if (panel.hidden || !available()) { close({ reason: 'anchor-hidden' }); return; }
        if (portal && portal.parentElement !== portalHost()) {
            const focused = document.activeElement;
            portalHost().append(portal);
            if (panel.contains(focused)) focused.focus({ preventScroll: true });
        }
        const viewport = view.visualViewport;
        const bounds = { left: viewport?.offsetLeft ?? 0, top: viewport?.offsetTop ?? 0,
            width: viewport?.width ?? document.documentElement.clientWidth, height: viewport?.height ?? view.innerHeight };
        const preferredWidth = typeof width === 'function' ? width() : width;
        style('width', `${Math.min(preferredWidth, Math.max(0, bounds.width - margin * 2))}px`);
        // Measure unconstrained content so a growing result list can flip above its anchor.
        style('max-height', 'none');
        const position = floatingSearchPosition({ anchor: getAnchorRect(), viewport: bounds, width: preferredWidth,
            height: Math.min(maxHeight, panel.getBoundingClientRect().height), margin, gap, align });
        style('width', `${position.width}px`);
        style('max-height', `${Math.min(maxHeight, position.maxHeight)}px`);
        style('left', `${position.left}px`);
        style('top', `${position.top}px`);
        panel.dataset.placement = position.placement;
    }
    function schedule(event) {
        if (!open || frame !== null || event?.target?.nodeType && panel.contains(event.target)) return;
        frame = view.requestAnimationFrame(() => { frame = null; reposition(); });
    }
    function close({ reason = 'close', restoreFocus = false } = {}) {
        if (!open) return;
        open = false;
        closing = true;
        if (activeLayers.get(document) === layer) activeLayers.delete(document);
        view.cancelAnimationFrame(frame); frame = null;
        view.clearTimeout(focusTimer); view.clearTimeout(outsideTimer);
        resize?.disconnect(); mutations?.disconnect();
        document.removeEventListener('scroll', schedule, true);
        document.removeEventListener('click', outside, true);
        document.removeEventListener('keydown', keydown, true);
        document.removeEventListener('focusin', focusChanged);
        view.removeEventListener('resize', schedule);
        view.removeEventListener('pagehide', pagehide);
        view.visualViewport?.removeEventListener('resize', schedule);
        view.visualViewport?.removeEventListener('scroll', schedule);
        if (native && panel.matches(':popover-open')) panel.hidePopover();
        panel.hidden = true;
        if (placeholder) { placeholder.replaceWith(panel); placeholder = null; }
        portal?.remove(); portal = null;
        for (const [name, [value, priority]] of savedStyles) {
            if (value) panel.style.setProperty(name, value, priority);
            else panel.style.removeProperty(name);
        }
        savedStyles = new Map();
        if (originalPopover === null) panel.removeAttribute('popover');
        else panel.setAttribute('popover', originalPopover);
        delete panel.dataset.floatingSearchLayer; delete panel.dataset.placement;
        try {
            onClose(reason);
            if (restoreFocus && anchor.isConnected && anchor.getClientRects().length) anchor.focus({ preventScroll: true });
        } finally { closing = false; }
    }
    function outside(event) {
        if (event.composedPath().some(node => node === scope || node === panel)) return;
        // Let the clicked control finish before dismissal changes layout or filtered results.
        view.clearTimeout(outsideTimer);
        outsideTimer = view.setTimeout(() => close({ reason: 'outside' }), 0);
    }
    function focusChanged() {
        if (!closeOnFocusOut) return;
        view.clearTimeout(focusTimer);
        focusTimer = view.setTimeout(() => { if (!contains(document.activeElement)) close({ reason: 'focusout' }); }, 0);
    }
    function focusables(root) {
        return [...root.querySelectorAll(focusableSelector)].filter(node => node.tabIndex >= 0 && !node.matches(':disabled')
            && !node.closest('[hidden], [inert]') && node.getClientRects().length && view.getComputedStyle(node).visibility === 'visible');
    }
    function keydown(event) {
        if (event.key === 'Escape' && !event.isComposing) {
            event.preventDefault(); event.stopImmediatePropagation();
            close({ reason: 'escape', restoreFocus: true });
        } else if (event.key === 'Tab' && placeholder && event.target === anchor && !event.shiftKey) {
            const first = focusables(panel)[0];
            if (first) { event.preventDefault(); first.focus({ preventScroll: true }); }
        } else if (event.key === 'Tab' && placeholder && panel.contains(event.target)) {
            const fields = focusables(panel), edge = event.shiftKey ? fields[0] : fields.at(-1);
            if (event.target !== edge) return;
            // The fallback portal must retain the panel's original sequential focus position.
            const candidates = focusables(document).filter(node => !panel.contains(node));
            const next = event.shiftKey
                ? candidates.filter(node => placeholder.compareDocumentPosition(node) & view.Node.DOCUMENT_POSITION_PRECEDING).at(-1)
                : candidates.find(node => placeholder.compareDocumentPosition(node) & view.Node.DOCUMENT_POSITION_FOLLOWING);
            if (next) { event.preventDefault(); next.focus({ preventScroll: true }); }
        }
    }
    function pagehide() { close({ reason: 'pagehide' }); }
    function toggled() { if (open && native && !panel.matches(':popover-open')) close({ reason: 'dismissed' }); }
    const stopClick = event => event.stopPropagation();
    panel.addEventListener('click', stopClick);
    panel.addEventListener('toggle', toggled);

    function show() {
        if (disposed || closing || !available()) return false;
        if (open) { reposition(); return open; }
        activeLayers.get(document)?.close({ reason: 'replaced' });
        originalPopover = panel.getAttribute('popover');
        open = true;
        activeLayers.set(document, layer);
        panel.hidden = false;
        for (const [name, value] of Object.entries({ position: 'fixed', top: 'auto', right: 'auto', bottom: 'auto', left: 'auto',
            'margin-top': '0px', 'margin-right': '0px', 'margin-bottom': '0px', 'margin-left': '0px', 'box-sizing': 'border-box',
            'min-width': '0', 'min-height': '0', 'max-width': 'none', 'pointer-events': 'auto', overflow: 'auto',
            'overscroll-behavior': 'contain' })) style(name, value);
        native = typeof panel.showPopover === 'function' && typeof panel.hidePopover === 'function';
        if (native) {
            panel.setAttribute('popover', 'manual');
            try { panel.showPopover(); } catch { native = false; panel.removeAttribute('popover'); }
        }
        if (!native) {
            const inherited = view.getComputedStyle(panel);
            for (const name of [...inherited].filter(name => name.startsWith('--'))
                .concat(['font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'color', 'direction', 'text-align'])) {
                style(name, inherited.getPropertyValue(name));
            }
            panel.removeAttribute('popover');
            placeholder = document.createComment('floating search');
            panel.before(placeholder);
            portal = document.createElement('div');
            portal.dataset.floatingSearchPortal = '';
            // Keep body-scoped styles unless the body itself clips or contains fixed descendants.
            portal.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:20000;';
            portalHost().append(portal);
            portal.append(panel);
        }
        panel.dataset.floatingSearchLayer = native ? 'popover' : 'portal';
        reposition();
        document.addEventListener('scroll', schedule, true);
        document.addEventListener('click', outside, true);
        document.addEventListener('keydown', keydown, true);
        document.addEventListener('focusin', focusChanged);
        view.addEventListener('resize', schedule);
        view.addEventListener('pagehide', pagehide);
        view.visualViewport?.addEventListener('resize', schedule);
        view.visualViewport?.addEventListener('scroll', schedule);
        if (view.ResizeObserver) {
            resize = new view.ResizeObserver(() => schedule());
            resize.observe(anchor); resize.observe(panel);
        }
        mutations = new view.MutationObserver(records => {
            if (panel.hidden || records.some(record => !panel.contains(record.target))) schedule();
        });
        mutations.observe(document.documentElement, { childList: true, subtree: true, attributes: true,
            attributeFilter: ['hidden', 'inert', 'class', 'style'] });
        return true;
    }
    const layer = { open: show, close, reposition, contains, get isOpen() { return open; },
        destroy() { close({ reason: 'destroy' }); disposed = true; panel.removeEventListener('click', stopClick); panel.removeEventListener('toggle', toggled); } };
    return layer;
}
