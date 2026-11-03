import { normalizeEstimationAlgorithm, DEFAULT_ESTIMATION_ALGORITHM } from '../shared/estimation-algorithms.js';

const STORAGE_KEY = 'benchpoll-workspace-preferences-v1';
const ESTIMATION_STORAGE_KEY = 'benchpoll-estimation-test-v1';
const DISPLAY_STORAGE_KEY = 'benchpoll-workspace-display-v1';

export function readEstimationPreference(storage) {
    try {
        const value = (storage === undefined ? globalThis.sessionStorage : storage).getItem(ESTIMATION_STORAGE_KEY);
        return normalizeEstimationAlgorithm(value ?? undefined);
    } catch { return DEFAULT_ESTIMATION_ALGORITHM; }
}

export function writeEstimationPreference(value, storage) {
    try {
        (storage === undefined ? globalThis.sessionStorage : storage).setItem(ESTIMATION_STORAGE_KEY, normalizeEstimationAlgorithm(value));
        return true;
    } catch { return false; }
}

export function readWorkspaceDisplay(storage) {
    try {
        const target = storage === undefined ? globalThis.localStorage : storage;
        return target.getItem(DISPLAY_STORAGE_KEY) === 'standard' ? 'standard' : 'charts';
    } catch {
        return 'charts';
    }
}

export function writeWorkspaceDisplay(display, storage) {
    try {
        const target = storage === undefined ? globalThis.localStorage : storage;
        target.setItem(DISPLAY_STORAGE_KEY, display === 'charts' ? 'charts' : 'standard');
        return true;
    } catch {
        return false;
    }
}

function normalizeWorkspacePreferences(value) {
    const preferences = value && typeof value === 'object' ? value : {};
    return {
        mode: preferences.mode === 'personal' ? 'personal' : 'public',
        personalFallbackExpanded: preferences.personalFallbackExpanded === true,
        scoreMode: preferences.scoreMode === 'range' ? 'range' : 'available'
    };
}

export function readWorkspacePreferences(storage) {
    try {
        const target = storage === undefined ? globalThis.sessionStorage : storage;
        return normalizeWorkspacePreferences(JSON.parse(target.getItem(STORAGE_KEY)));
    } catch {
        return normalizeWorkspacePreferences();
    }
}

export function writeWorkspacePreferences(preferences, storage) {
    try {
        const target = storage === undefined ? globalThis.sessionStorage : storage;
        target.setItem(STORAGE_KEY, JSON.stringify(normalizeWorkspacePreferences(preferences)));
        return true;
    } catch {
        return false;
    }
}
