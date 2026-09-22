const KEY = 'benchpoll-sidebar-preferences-v1';
export function readSidebarPreferences() {
    try {
        const value = JSON.parse(globalThis.sessionStorage.getItem(KEY));
        return {
            view: value?.view === 'configured' ? 'configured' : 'all',
            scroll: Object.fromEntries(['all', 'configured'].map(view => [view,
                Number.isFinite(value?.scroll?.[view]) && value.scroll[view] >= 0 ? value.scroll[view] : 0])),
            expansion: Object.fromEntries(Object.entries(value?.expansion ?? {}).filter(([key, expanded]) => /^\d+$/.test(key) && typeof expanded === 'boolean').slice(-1024))
        };
    } catch { return { view: 'all', scroll: { all: 0, configured: 0 }, expansion: {} }; }
}
export function writeSidebarPreferences(value) {
    try { globalThis.sessionStorage.setItem(KEY, JSON.stringify({ view: value.view, scroll: value.scroll, expansion: value.expansion })); }
    catch { /* Navigation still works when storage is unavailable. */ }
}
