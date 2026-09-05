// Keep keyboard focus in the active custom overlay and return it on close.
export function initializeOverlays(overlays) {
    const open = [];
    const triggers = new Map();
    const controls = overlay => [...overlay.querySelectorAll('button:not([disabled]), a[href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex="0"]')]
        .filter(element => element.getClientRects().length > 0);
    const sync = overlay => {
        const index = open.indexOf(overlay);
        if (!overlay.hidden && index < 0) {
            triggers.set(overlay, document.activeElement);
            open.push(overlay);
            const target = controls(overlay)[0] ?? overlay;
            if (target === overlay) overlay.tabIndex = -1;
            target.focus({ preventScroll: true });
        } else if (overlay.hidden && index >= 0) {
            open.splice(index, 1);
            const target = triggers.get(overlay);
            triggers.delete(overlay);
            if (target?.isConnected) target.focus({ preventScroll: true });
        }
    };
    const observer = new MutationObserver(records => records.forEach(record => sync(record.target)));
    overlays.forEach(overlay => {
        observer.observe(overlay, { attributes: true, attributeFilter: ['hidden'] });
        sync(overlay);
    });
    document.addEventListener('keydown', event => {
        const overlay = open.at(-1);
        // Confirmation dialogs manage their own focus above an editor overlay.
        if (!overlay || document.querySelector('global-dialog:not([hidden])')) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            overlay.hidden = true;
        } else if (event.key === 'Tab') {
            const items = controls(overlay);
            const first = items[0] ?? overlay, last = items.at(-1) ?? overlay;
            const outside = !overlay.contains(document.activeElement);
            if (outside || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
                event.preventDefault();
                (event.shiftKey ? last : first).focus();
            }
        }
    });
}
