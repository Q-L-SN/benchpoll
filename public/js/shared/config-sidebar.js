import { bindDrawerDrag } from './drawer-drag.js';

const STORAGE_KEY = 'benchpoll:config-sidebar-collapsed';
const SIDEBAR_MS = 300;
const FADE_MS = 110;
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
    const direction = toggle.querySelector('.bp-sidebar-toggle-direction');
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
        const expanded = !collapsed && !discussionOpen();
        toggle.setAttribute('aria-expanded', String(expanded));
        direction?.classList.toggle('fa-chevron-left', expanded);
        direction?.classList.toggle('fa-chevron-right', !expanded);
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
        if (!next) sidebar.dispatchEvent(new CustomEvent('sidebar:beforeopen'));
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
    bindDrawerDrag(body.classList.contains('bp-home') ? body.querySelector('.bp-workspace') : null, mobile);
    settle();
    return { setCollapsed, get collapsed() { return collapsed; } };
}
