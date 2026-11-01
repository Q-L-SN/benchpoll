import { mountDisclosureChevron } from './disclosure-chevron.js';

const STORAGE_KEY = 'benchpoll:config-sidebar-collapsed';
const SIDEBAR_MS = 300;
const FADE_MS = 110;
const swipeExcluded = 'a, button, input, select, textarea, label, form, summary, dialog, global-dialog, '
    + '[contenteditable]:not([contenteditable="false"]), [role="button"], [role="link"], [role="slider"], '
    + '[role="textbox"], [role="dialog"], [role="menu"], [role="listbox"], [data-sidebar-swipe="ignore"], '
    + '.discussion-rail, .bp-scene-strip, .bp-scene-tabs, .bp-model-name, .bp-model-parameters, '
    + '.bp-pie-stage, .bp-overlay-scrollbar, canvas, svg';

export function configSidebarSwipeIntent(dx, dy, elapsed) {
    if (elapsed > 650 || dx < -10 || Math.abs(dy) > 32
        || Math.abs(dy) > 10 && Math.abs(dy) * 1.5 > Math.abs(dx)) return 'cancel';
    return dx >= 72 && dx > Math.abs(dy) * 2.5 ? 'open' : 'pending';
}

function bindConfigSidebarSwipe(workspace, mobile, open) {
    if (!workspace) return;
    let swipe = null;
    const cancel = () => { swipe = null; };
    const available = () => mobile.matches && !document.body.matches('.taxonomy-open, .discussion-open')
        && !(window.visualViewport?.scale > 1.01)
        && !document.activeElement?.matches('input, select, textarea, [contenteditable]:not([contenteditable="false"]), [role="textbox"]')
        && ![...document.querySelectorAll('dialog[open], global-dialog:not([hidden]), [role="dialog"], [aria-modal="true"]')]
            .some(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden');

    workspace.addEventListener('touchstart', event => {
        cancel();
        if (event.touches.length !== 1 || !available()) return;
        const point = event.touches[0];
        const viewport = window.visualViewport;
        const left = viewport?.offsetLeft ?? 0, width = viewport?.width ?? window.innerWidth;
        // Leave both browser-navigation edges and every horizontal scroller native.
        if (point.clientX <= left + 24 || point.clientX >= left + width - 24) return;
        for (const node of event.composedPath()) {
            if (!(node instanceof Element)) continue;
            if (node.matches(swipeExcluded)) return;
            const style = getComputedStyle(node);
            if (/(auto|scroll)/.test(style.overflowX) && node.scrollWidth > node.clientWidth + 1) return;
            if (node === workspace) break;
        }
        swipe = { id: point.identifier, x: point.clientX, y: point.clientY, time: event.timeStamp };
    }, { passive: true });
    document.addEventListener('touchstart', event => { if (event.touches.length !== 1) cancel(); }, { passive: true });
    document.addEventListener('touchmove', event => {
        if (!swipe) return;
        const point = [...event.touches].find(point => point.identifier === swipe.id);
        if (event.touches.length !== 1 || !point
            || configSidebarSwipeIntent(point.clientX - swipe.x, point.clientY - swipe.y, event.timeStamp - swipe.time) === 'cancel') cancel();
    }, { passive: true });
    document.addEventListener('touchend', event => {
        const start = swipe;
        cancel();
        if (!start || event.touches.length || !available()) return;
        const point = [...event.changedTouches].find(point => point.identifier === start.id);
        if (point && configSidebarSwipeIntent(point.clientX - start.x, point.clientY - start.y, event.timeStamp - start.time) === 'open') open();
    }, { passive: true });
    document.addEventListener('touchcancel', cancel, { passive: true });
    document.addEventListener('scroll', cancel, { passive: true, capture: true });
    window.addEventListener('blur', cancel);
    window.addEventListener('resize', cancel);
    mobile.addEventListener('change', cancel);
}

export function readConfigSidebarCollapsed() {
    try { return globalThis.localStorage.getItem(STORAGE_KEY) !== 'false'; }
    catch { return true; }
}

export function createConfigSidebar() {
    const body = document.body;
    const sidebar = document.getElementById('config-sidebar');
    const toggle = document.getElementById('config-sidebar-toggle');
    const headerSlot = document.getElementById('workspace-brand-slot');
    const discussionSlot = document.getElementById('discussion-brand-slot');
    const brand = document.querySelector('.bp-shell .bp-brand');
    if (!sidebar || !toggle || !headerSlot || !brand) return null;
    mountDisclosureChevron(toggle, { icon: toggle.querySelector('.bp-sidebar-toggle-direction') });
    const mobile = window.matchMedia('(max-width: 760px)');
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    const identity = document.querySelector('.bp-context-identity');
    const creator = document.getElementById('workspace-topic-creator');
    const creatorParent = creator?.parentElement, creatorNext = creator?.nextSibling;
    let collapsed = readConfigSidebarCollapsed();
    let sequence = 0;
    let animation = null;
    let transitioning = false;
    let context = '';

    const discussionOpen = () => body.classList.contains('discussion-open');
    const inHeader = () => !mobile.matches && collapsed && !discussionOpen();
    const contextKey = () => `${mobile.matches}:${discussionOpen()}:${body.classList.contains('taxonomy-open')}`;
    const wait = ms => new Promise(resolve => window.setTimeout(resolve, ms));

    function placeBrand(target) {
        if (!target || brand.parentElement === target) return;
        if (target === sidebar) sidebar.prepend(brand);
        else target.append(brand);
    }

    function updateAccess() {
        const hidden = discussionOpen() || !mobile.matches && collapsed;
        sidebar.inert = hidden;
        sidebar.setAttribute('aria-hidden', String(hidden));
        toggle.setAttribute('aria-expanded', String(!collapsed && !discussionOpen()));
        const label = collapsed ? 'Show topics sidebar' : 'Hide topics sidebar';
        toggle.setAttribute('aria-label', label);
        toggle.dataset.tooltip = label;
        toggle.disabled = transitioning || discussionOpen();
    }

    function settle() {
        ++sequence;
        animation?.cancel();
        animation = null;
        transitioning = false;
        body.classList.toggle('config-sidebar-collapsed', collapsed);
        body.classList.toggle('config-brand-in-header', inHeader());
        placeBrand(discussionOpen() ? discussionSlot : inHeader() ? headerSlot : sidebar);
        if (creator && identity && creatorParent) {
            if (mobile.matches && creator.parentElement !== identity) identity.append(creator);
            else if (!mobile.matches && creator.parentElement !== creatorParent) creatorParent.insertBefore(creator, creatorNext);
        }
        brand.style.opacity = '';
        body.dataset.configSidebarPhase = 'idle';
        context = contextKey();
        updateAccess();
    }

    async function fade(visible) {
        brand.style.opacity = visible ? '1' : '0';
        animation = brand.animate([{ opacity: visible ? 0 : 1 }, { opacity: visible ? 1 : 0 }],
            { duration: FADE_MS, easing: 'ease', fill: 'none' });
        await animation.finished.catch(() => {});
    }

    async function setCollapsed(next, { remember = true } = {}) {
        if (transitioning || collapsed === next || discussionOpen()) return;
        collapsed = Boolean(next);
        if (remember) {
            try { globalThis.localStorage.setItem(STORAGE_KEY, String(collapsed)); }
            catch { /* The current document still keeps the preference. */ }
        }
        if (mobile.matches || reduced.matches) { settle(); return; }
        const token = ++sequence;
        transitioning = true;
        updateAccess();
        body.dataset.configSidebarPhase = 'brand-out';
        // Start both layout transitions together; hand off the single logo while invisible.
        body.classList.toggle('config-sidebar-collapsed', collapsed);
        body.classList.toggle('config-brand-in-header', collapsed);
        const sidebarFinished = wait(SIDEBAR_MS);
        await fade(false);
        if (token !== sequence) return;
        placeBrand(collapsed ? headerSlot : sidebar);
        body.dataset.configSidebarPhase = 'brand-in';
        await fade(true);
        if (token !== sequence) return;
        body.dataset.configSidebarPhase = 'sidebar';
        await sidebarFinished;
        if (token === sequence) settle();
    }

    function reconcile() {
        if (contextKey() !== context || !transitioning) settle();
    }

    const observer = new MutationObserver(reconcile);
    observer.observe(body, { attributes: true, attributeFilter: ['class'] });
    // discussion.js moves this same brand on both open and close.
    [sidebar, headerSlot, discussionSlot].filter(Boolean).forEach(slot => observer.observe(slot, { childList: true }));
    toggle.addEventListener('click', () => { void setCollapsed(!collapsed); });
    mobile.addEventListener('change', settle);
    reduced.addEventListener('change', settle);
    window.addEventListener('storage', event => {
        if (event.key !== STORAGE_KEY && event.key !== null) return;
        collapsed = readConfigSidebarCollapsed();
        settle();
    });
    bindConfigSidebarSwipe(body.classList.contains('bp-home') ? body.querySelector('.bp-workspace') : null,
        mobile, () => document.getElementById('taxonomy-toggle')?.click());
    settle();
    return { setCollapsed, get collapsed() { return collapsed; } };
}
