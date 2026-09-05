const WELCOME_STORAGE_KEY = 'benchpoll-welcome-seen-v1';
const WELCOME_TRANSITION_MS = 220;

const overlay = document.getElementById('welcome-overlay');
const dialog = document.getElementById('welcome-dialog');
const closeButton = document.getElementById('welcome-close');
const primaryButton = document.getElementById('welcome-primary');
const methodologyLink = document.getElementById('welcome-methodology');
const missionWelcomeTrigger = document.getElementById('mission-welcome-trigger');
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

let previouslyFocusedElement = null;
let closeTimer = null;

function hasSeenWelcome() {
    try {
        return window.localStorage.getItem(WELCOME_STORAGE_KEY) === '1';
    } catch {
        return false;
    }
}

function rememberWelcome() {
    try {
        window.localStorage.setItem(WELCOME_STORAGE_KEY, '1');
    } catch {
        // The welcome remains dismissible when storage is unavailable.
    }
}

function focusableElements() {
    if (!dialog) return [];
    return [...dialog.querySelectorAll(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    )].filter(element => !element.hidden && element.getClientRects().length > 0);
}

function showWelcome({ force = false } = {}) {
    if (!overlay || !dialog || (!force && hasSeenWelcome())) return;

    window.clearTimeout(closeTimer);
    closeTimer = null;
    previouslyFocusedElement = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    overlay.hidden = false;
    document.body.classList.add('bp-welcome-open');

    window.requestAnimationFrame(() => {
        overlay.classList.add('is-open');
        dialog.focus({ preventScroll: true });
    });
}

function finishClosing() {
    if (!overlay) return;
    overlay.hidden = true;
    previouslyFocusedElement?.focus?.({ preventScroll: true });
    previouslyFocusedElement = null;
    closeTimer = null;
}

function dismissWelcome() {
    if (!overlay || overlay.hidden) return;

    rememberWelcome();
    overlay.classList.remove('is-open');
    document.body.classList.remove('bp-welcome-open');
    window.clearTimeout(closeTimer);

    if (reducedMotion.matches) {
        finishClosing();
        return;
    }
    closeTimer = window.setTimeout(finishClosing, WELCOME_TRANSITION_MS);
}

function trapDialogFocus(event) {
    if (!overlay || overlay.hidden || event.key !== 'Tab') return;

    const focusable = focusableElements();
    if (focusable.length === 0) {
        event.preventDefault();
        dialog?.focus({ preventScroll: true });
        return;
    }

    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const activeElement = document.activeElement;
    if (activeElement === dialog || !dialog.contains(activeElement)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
    } else if (event.shiftKey && activeElement === first) {
        event.preventDefault();
        last.focus();
    } else if (!event.shiftKey && activeElement === last) {
        event.preventDefault();
        first.focus();
    }
}

closeButton?.addEventListener('click', dismissWelcome);
primaryButton?.addEventListener('click', dismissWelcome);
methodologyLink?.addEventListener('click', rememberWelcome);
missionWelcomeTrigger?.addEventListener('click', () => showWelcome({ force: true }));
overlay?.addEventListener('click', event => {
    if (event.target === overlay) dismissWelcome();
});
document.addEventListener('keydown', event => {
    if (!overlay || overlay.hidden) return;
    if (event.key === 'Escape') {
        event.preventDefault();
        dismissWelcome();
        return;
    }
    trapDialogFocus(event);
});

showWelcome();
