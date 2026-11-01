import { canonicalAccountID } from '../shared/account-identity.js';
import { contextKey } from './model.js';

const KEY = 'benchpoll-sidebar-preferences-v1';
const VIEWS = ['popular', 'recent', 'configured', 'search'];
export const RECENT_TOPICS_PREFIX = 'benchpoll-sidebar-recent-v1:';
const MAX_RECENT = 80;

export function readSidebarPreferences() {
    try {
        const value = JSON.parse(globalThis.sessionStorage.getItem(KEY));
        return {
            view: value?.view === 'mine' ? 'configured' : VIEWS.includes(value?.view) ? value.view : 'popular',
            scroll: Object.fromEntries(VIEWS.map(view => {
                const top = view === 'configured' && value?.view === 'mine'
                    ? value?.scroll?.mine ?? value?.scroll?.configured
                    : value?.scroll?.[view] ?? (view === 'popular' ? value?.scroll?.all : view === 'configured' ? value?.scroll?.mine : 0);
                return [view, Number.isFinite(top) && top >= 0 ? top : 0];
            })),
            expansion: Object.fromEntries(Object.entries(value?.expansion ?? {}).filter(([key, expanded]) => /^\d+$/.test(key) && typeof expanded === 'boolean').slice(-1024))
        };
    } catch { return { view: 'popular', scroll: Object.fromEntries(VIEWS.map(view => [view, 0])), expansion: {} }; }
}

function recentKey(userID) {
    if (userID === null) return RECENT_TOPICS_PREFIX + 'guest';
    return canonicalAccountID(userID) === userID ? RECENT_TOPICS_PREFIX + `user:${userID}` : null;
}

function recentRecord(value) {
    if (!Number.isSafeInteger(value?.categoryID) || value.categoryID < 1
        || !Number.isFinite(value.visitedAt) || value.visitedAt < 1
        || !value.contextValues || typeof value.contextValues !== 'object' || Array.isArray(value.contextValues)
        || Object.keys(value.contextValues).length > 64
        || Object.entries(value.contextValues).some(([key, item]) => key.length > 128 || typeof item !== 'string' || item.length > 512)) return null;
    // Names, URLs and profile data are deliberately never persisted, even for public topics.
    return { categoryID: value.categoryID, contextValues: Object.fromEntries(Object.entries(value.contextValues).sort(([a], [b]) => a.localeCompare(b))),
        isPrivate: value.isPrivate === true, visitedAt: value.visitedAt };
}

function normalizeRecent(values, userID) {
    if (!Array.isArray(values)) return [];
    const seen = new Set();
    return values.slice(0, MAX_RECENT * 2).map(recentRecord).filter(value => value && (userID !== null || !value.isPrivate))
        .sort((left, right) => right.visitedAt - left.visitedAt)
        .filter(value => {
            const key = contextKey(value.categoryID, value.contextValues);
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
        }).slice(0, MAX_RECENT);
}

export function readRecentTopics(userID) {
    const key = recentKey(userID);
    if (!key) return [];
    try { return normalizeRecent(JSON.parse(globalThis.localStorage.getItem(key)), userID); }
    catch { return []; }
}

export function writeRecentTopics(userID, values) {
    const key = recentKey(userID);
    if (!key) return false;
    try { globalThis.localStorage.setItem(key, JSON.stringify(normalizeRecent(values, userID))); return true; }
    catch { return false; }
}

export function addRecentTopic(values, topic, userID, visitedAt = Date.now()) {
    if (!recentKey(userID)) return values;
    const record = recentRecord({ ...topic, visitedAt });
    if (!record || userID === null && record.isPrivate) return values;
    const key = contextKey(record.categoryID, record.contextValues);
    return normalizeRecent([record, ...values.filter(value => contextKey(value.categoryID, value.contextValues) !== key)], userID);
}
export function writeSidebarPreferences(value) {
    try { globalThis.sessionStorage.setItem(KEY, JSON.stringify({ view: value.view, scroll: value.scroll, expansion: value.expansion })); }
    catch { /* Navigation still works when storage is unavailable. */ }
}
