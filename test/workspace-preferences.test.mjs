import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspacePreferences, writeWorkspacePreferences } from '../public/js/workspace/preferences.js';

const storageKey = 'benchpoll-workspace-preferences-v1';
const defaults = { mode: 'public', fallbackVisible: { personal: true, public: false } };

function memoryStorage(initialValue = null) {
    const values = new Map(initialValue === null ? [] : [[storageKey, initialValue]]);
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

test('workspace preferences preserve separate personal and public visibility through a round trip', () => {
    const storage = memoryStorage();
    const preferences = { mode: 'personal', fallbackVisible: { personal: false, public: true } };
    assert.equal(writeWorkspacePreferences(preferences, storage), true);
    assert.deepEqual(readWorkspacePreferences(storage), preferences);

    preferences.mode = 'public';
    assert.equal(writeWorkspacePreferences(preferences, storage), true);
    assert.deepEqual(readWorkspacePreferences(storage), {
        mode: 'public', fallbackVisible: { personal: false, public: true }
    });
});

test('absent, malformed, and non-object stored values use the default preferences', () => {
    for (const value of [null, '', '{', 'undefined', 'null', 'true', '42', '"personal"', '[]']) {
        assert.deepEqual(readWorkspacePreferences(memoryStorage(value)), defaults, String(value));
    }
});

test('partial preferences retain valid fields and supply independent defaults for missing fields', () => {
    for (const [value, expected] of [
        [{}, defaults],
        [{ mode: 'personal' }, { mode: 'personal', fallbackVisible: { personal: true, public: false } }],
        [{ fallbackVisible: { personal: false } }, { mode: 'public', fallbackVisible: { personal: false, public: false } }],
        [{ fallbackVisible: { public: true } }, { mode: 'public', fallbackVisible: { personal: true, public: true } }]
    ]) {
        assert.deepEqual(readWorkspacePreferences(memoryStorage(JSON.stringify(value))), expected);
    }
});

test('invalid modes and non-boolean visibility values never become active preferences', () => {
    for (const invalidMode of ['', 'PUBLIC', 'Personal', 'overview', true, 1, {}, null]) {
        const storage = memoryStorage(JSON.stringify({ mode: invalidMode }));
        assert.deepEqual(readWorkspacePreferences(storage), defaults);
    }
    for (const invalidValue of ['true', 'false', 0, 1, null, [], {}]) {
        const storage = memoryStorage(JSON.stringify({
            mode: 'personal', fallbackVisible: { personal: invalidValue, public: invalidValue }
        }));
        assert.deepEqual(readWorkspacePreferences(storage), {
            mode: 'personal', fallbackVisible: { personal: true, public: false }
        });
    }
    for (const invalidMap of [null, false, 0, 'true', []]) {
        assert.deepEqual(readWorkspacePreferences(memoryStorage(JSON.stringify({ fallbackVisible: invalidMap }))), defaults);
    }
});

test('storage read and write failures leave callers with usable in-memory preferences', () => {
    const storage = {
        getItem() { throw new Error('Storage access denied'); },
        setItem() { throw new Error('Storage quota exceeded'); }
    };
    const preferences = { mode: 'personal', fallbackVisible: { personal: false, public: true } };
    const before = structuredClone(preferences);
    assert.deepEqual(readWorkspacePreferences(storage), defaults);
    assert.equal(writeWorkspacePreferences(preferences, storage), false);
    assert.deepEqual(preferences, before);
    assert.deepEqual(readWorkspacePreferences(null), defaults);
    assert.equal(writeWorkspacePreferences(preferences, null), false);
});

test('default session storage access is protected even when the global getter throws', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    try {
        const storage = memoryStorage();
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: storage });
        assert.equal(writeWorkspacePreferences({ mode: 'personal' }), true);
        assert.deepEqual(readWorkspacePreferences(), {
            mode: 'personal', fallbackVisible: { personal: true, public: false }
        });

        Object.defineProperty(globalThis, 'sessionStorage', {
            configurable: true,
            get() { throw new Error('Session storage is disabled'); }
        });
        assert.deepEqual(readWorkspacePreferences(), defaults);
        assert.equal(writeWorkspacePreferences(defaults), false);

        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: undefined });
        assert.deepEqual(readWorkspacePreferences(), defaults);
        assert.equal(writeWorkspacePreferences(defaults), false);
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
        else delete globalThis.sessionStorage;
    }
});

test('separate reads do not share mutable objects or change the stored preferences', () => {
    for (const storage of [memoryStorage(), memoryStorage(JSON.stringify(defaults))]) {
        const first = readWorkspacePreferences(storage);
        const second = readWorkspacePreferences(storage);
        assert.notEqual(first, second);
        assert.notEqual(first.fallbackVisible, second.fallbackVisible);
        first.mode = 'personal';
        first.fallbackVisible.public = true;
        assert.deepEqual(second, defaults);
        assert.deepEqual(readWorkspacePreferences(storage), defaults);
    }
});

test('writes persist only display preferences and never serialize workspace data', () => {
    const storage = memoryStorage();
    const workspace = {
        mode: 'personal',
        fallbackVisible: { personal: false, public: true, categoryID: 7 },
        categoryID: 7,
        selectedContextValues: { budget: 'extended' },
        personalEntries: [{ conditionID: 1, weightBasisPoints: 10000 }],
        personalFallbackRules: [{ primaryConditionID: 1 }],
        authenticated: true,
        toJSON() { throw new Error('The entire workspace must not be serialized'); }
    };
    assert.equal(writeWorkspacePreferences(workspace, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), {
        mode: 'personal', fallbackVisible: { personal: false, public: true }
    });
    assert.equal(workspace.fallbackVisible.categoryID, 7);
    assert.equal(workspace.personalEntries[0].weightBasisPoints, 10000);
});

test('writes normalize invalid or missing fields before storing them', () => {
    const storage = memoryStorage();
    assert.equal(writeWorkspacePreferences({ mode: 'other', fallbackVisible: { personal: 0, public: true } }, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), {
        mode: 'public', fallbackVisible: { personal: true, public: true }
    });
    assert.equal(writeWorkspacePreferences(undefined, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), defaults);
});
