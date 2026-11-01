export const UPDATE_HOLD_MS = 1200;
export const UPDATE_FADE_MS = 700;

export function createUpdateIndicator({ document = globalThis.document, timers = globalThis.window } = {}) {
    const element = document.createElement('span');
    element.className = 'bp-update-indicator';
    element.dataset.phase = 'idle';
    element.setAttribute('role', 'status');
    element.setAttribute('aria-live', 'polite');
    const icon = document.createElement('i');
    icon.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'bp-update-label';
    element.append(icon, label);
    let revision, initialized = false, pendingBefore = false, holdTimer, fadeTimer;
    function clearTimers() {
        timers.clearTimeout(holdTimer);
        timers.clearTimeout(fadeTimer);
    }
    function show(phase) {
        element.dataset.phase = phase;
        icon.className = phase === 'pending' ? 'bp-spinner' : 'fa-solid fa-check';
        label.textContent = phase === 'pending' ? 'Updating' : phase === 'complete' ? 'Updated' : '';
    }
    return {
        element,
        update({ pending = false, error = false, version } = {}) {
            const changed = initialized && version !== revision;
            revision = version;
            initialized = true;
            if (error) {
                clearTimers(); pendingBefore = false; show('idle'); return;
            }
            if (pending) {
                clearTimers(); pendingBefore = true; show('pending'); return;
            }
            if (pendingBefore || changed) {
                clearTimers(); pendingBefore = false; show('complete');
                holdTimer = timers.setTimeout(() => {
                    show('fading');
                    fadeTimer = timers.setTimeout(() => show('idle'), UPDATE_FADE_MS);
                }, UPDATE_HOLD_MS);
            }
        },
        destroy() { clearTimers(); }
    };
}
