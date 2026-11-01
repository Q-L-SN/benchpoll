import { basicComparisonOptions, readComparisonSettings } from './workspace/comparison-settings.js';
import { canonicalAccountID } from './shared/account-identity.js';
import { readWorkspacePreferences } from './workspace/preferences.js';
import { rankingReadBody } from './shared/available-score.js?v=coverage-factor-20261019';
import { readHomeModelFocusIntent } from './workspace/model-focus-target.js';

const ordered = value => Array.isArray(value) ? value.map(ordered)
    : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map(key => [key, ordered(value[key])])) : value;
const identity = (url, body) => url + ':' + JSON.stringify(ordered(body));

export function startHomeReads(target, { fetch = target.fetch.bind(target), ttlMs = 15000,
    settings = userID => readComparisonSettings(userID), preferences = () => readWorkspacePreferences() } = {}) {
    if (target.__benchpollInitialReads || /^\/personal\//.test(target.location.pathname)) return null;
    const focusIntent = target.location.href ? readHomeModelFocusIntent(target.location.href) : null;
    const entries = new Map();
    const deadline = Date.now() + ttlMs;
    let stopped = false;
    const start = (url, body) => {
        body = rankingReadBody(url, body);
        const key = identity(url, body), controller = new globalThis.AbortController();
        const timer = setTimeout(() => { entries.delete(key); controller.abort(); }, ttlMs);
        const value = Promise.resolve().then(() => fetch(url, { method: 'POST',
            headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal }));
        value.catch(() => {});
        const entry = { value, controller, timer }; entries.set(key, entry);
        return value;
    };
    const stop = () => {
        stopped = true;
        for (const entry of entries.values()) { clearTimeout(entry.timer); entry.controller.abort(); }
        entries.clear();
    };
    const reads = {
        take(url, body, options = {}) {
            body = rankingReadBody(url, body);
            if (options.signal?.aborted || Object.keys(options.headers ?? {}).length) return null;
            const key = identity(url, body), entry = entries.get(key);
            if (!entry) return null;
            entries.delete(key); clearTimeout(entry.timer);
            options.signal?.addEventListener('abort', () => entry.controller.abort(options.signal.reason), { once: true });
            return entry.value.catch(error => {
                if (options.signal?.aborted || entry.controller.signal.aborted) throw error;
                return fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body), ...(options.signal ? { signal: options.signal } : {}) });
            });
        }, stop
    };
    target.__benchpollInitialReads = reads;
    target.addEventListener('pagehide', stop, { once: true });
    target.addEventListener('storage', stop);
    const bootstrap = target.document?.querySelector('meta[name="benchpoll-startup-category"]');
    const categoryID = Number(bootstrap?.content);
    let workspaceStarted = false;
    const startWorkspace = (ID, userID) => {
        if (workspaceStarted || stopped || Date.now() >= deadline) return;
        const comparison = focusIntent?.valid
            ? { mode: 'best', keys: focusIntent.keys, filters: [] } : basicComparisonOptions(settings(userID));
        const preference = preferences();
        workspaceStarted = true;
        start('/api/get_weighted_workspace', { categoryID: ID, contextValues: {},
            comparison, scoreMode: focusIntent?.valid ? focusIntent.scoreMode : preference.scoreMode,
            initialMode: focusIntent?.valid ? focusIntent.mode : preference.mode,
            ...(focusIntent?.valid ? { homeComparison: { ...focusIntent.comparison } } : {}),
            benchmarkQuery: '', pinPersonal: false });
    };
    if (Number.isSafeInteger(categoryID) && categoryID > 0 && bootstrap.dataset.guest === 'true') startWorkspace(categoryID, null);
    const tree = start('/api/get_page' + target.location.pathname, { treeOnly: true });
    const profile = start('/api/get_user_profile');
    // Speculative work is read-only and usable once, only by the exact normal startup request.
    Promise.all([tree.then(response => response.ok ? response.clone().json() : null),
        profile.then(response => !response.ok ? undefined : response.status === 204 ? null : response.clone().json())]).then(([page, profile]) => {
        if (stopped || Date.now() >= deadline || !Number.isSafeInteger(page?.currentCategoryID)
            || profile === undefined) return;
        const userID = profile === null ? null : canonicalAccountID(profile.userID);
        if (profile !== null && !userID) return;
        startWorkspace(page.currentCategoryID, userID);
    }).catch(() => {});
    return reads;
}

if (typeof window !== 'undefined') startHomeReads(window);
