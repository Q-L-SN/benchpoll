const STORAGE_KEY = 'benchpoll-workspace-preferences-v1';

function normalizeWorkspacePreferences(value) {
    const preferences = value && typeof value === 'object' ? value : {};
    const fallbackVisible = preferences.fallbackVisible;
    return {
        mode: preferences.mode === 'personal' ? 'personal' : 'public',
        fallbackVisible: {
            personal: typeof fallbackVisible?.personal === 'boolean' ? fallbackVisible.personal : true,
            public: typeof fallbackVisible?.public === 'boolean' ? fallbackVisible.public : false
        }
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
