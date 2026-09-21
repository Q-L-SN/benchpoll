const STORAGE_KEY = 'benchpoll-workspace-preferences-v1';

function normalizeWorkspacePreferences(value) {
    const preferences = value && typeof value === 'object' ? value : {};
    const publicFallbackVisible = typeof preferences.publicFallbackVisible === 'boolean'
        ? preferences.publicFallbackVisible
        : preferences.fallbackVisible?.public;
    return {
        mode: preferences.mode === 'personal' ? 'personal' : 'public',
        publicFallbackVisible: typeof publicFallbackVisible === 'boolean' ? publicFallbackVisible : false
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
