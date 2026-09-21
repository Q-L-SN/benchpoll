import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspacePreferences, writeWorkspacePreferences } from '../public/js/workspace/preferences.js';

const storageKey = 'benchpoll-workspace-preferences-v1';
const defaults = { mode: 'public', publicFallbackVisible: false };

function memoryStorage(initialValue = null) {
    const values = new Map(initialValue === null ? [] : [[storageKey, initialValue]]);
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

test('workspace preferences preserve the public visibility while switching modes through a round trip', () => {
    const storage = memoryStorage();
    const preferences = { mode: 'personal', publicFallbackVisible: true };
    assert.equal(writeWorkspacePreferences(preferences, storage), true);
    assert.deepEqual(readWorkspacePreferences(storage), preferences);

    preferences.mode = 'public';
    assert.equal(writeWorkspacePreferences(preferences, storage), true);
    assert.deepEqual(readWorkspacePreferences(storage), {
        mode: 'public', publicFallbackVisible: true
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
        [{ mode: 'personal' }, { mode: 'personal', publicFallbackVisible: false }],
        [{ publicFallbackVisible: true }, { mode: 'public', publicFallbackVisible: true }]
    ]) {
        assert.deepEqual(readWorkspacePreferences(memoryStorage(JSON.stringify(value))), expected);
    }
});

test('legacy preferences retain public visibility and discard personal visibility', () => {
    for (const [value, expected] of [
        [{ mode: 'personal', fallbackVisible: { personal: false } }, { mode: 'personal', publicFallbackVisible: false }],
        [{ fallbackVisible: { personal: false, public: true } }, { mode: 'public', publicFallbackVisible: true }],
        [{ fallbackVisible: { personal: true, public: false } }, defaults]
    ]) {
        const storage = memoryStorage(JSON.stringify(value));
        const preferences = readWorkspacePreferences(storage);
        assert.deepEqual(preferences, expected);
        assert.equal(writeWorkspacePreferences(preferences, storage), true);
        assert.deepEqual(JSON.parse(storage.getItem(storageKey)), expected);
    }
});

test('explicit public visibility takes precedence over legacy visibility, including false', () => {
    for (const publicFallbackVisible of [false, true]) {
        const storage = memoryStorage(JSON.stringify({
            mode: 'personal', publicFallbackVisible,
            fallbackVisible: { personal: !publicFallbackVisible, public: !publicFallbackVisible }
        }));
        assert.deepEqual(readWorkspacePreferences(storage), { mode: 'personal', publicFallbackVisible });
    }
    const storage = memoryStorage(JSON.stringify({
        publicFallbackVisible: 'false', fallbackVisible: { public: true }
    }));
    assert.deepEqual(readWorkspacePreferences(storage), { mode: 'public', publicFallbackVisible: true });
});

test('invalid modes and non-boolean visibility values never become active preferences', () => {
    for (const invalidMode of ['', 'PUBLIC', 'Personal', 'overview', true, 1, {}, null]) {
        const storage = memoryStorage(JSON.stringify({ mode: invalidMode }));
        assert.deepEqual(readWorkspacePreferences(storage), defaults);
    }
    for (const invalidValue of ['true', 'false', 0, 1, null, [], {}]) {
        const storage = memoryStorage(JSON.stringify({
            mode: 'personal', publicFallbackVisible: invalidValue, fallbackVisible: { public: invalidValue }
        }));
        assert.deepEqual(readWorkspacePreferences(storage), {
            mode: 'personal', publicFallbackVisible: false
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
    const preferences = { mode: 'personal', publicFallbackVisible: true };
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
            mode: 'personal', publicFallbackVisible: false
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
        first.mode = 'personal';
        first.publicFallbackVisible = true;
        assert.deepEqual(second, defaults);
        assert.deepEqual(readWorkspacePreferences(storage), defaults);
    }
});

test('writes persist only the mode and public visibility, excluding personal rules and draft data', () => {
    const storage = memoryStorage();
    const workspace = {
        mode: 'personal',
        publicFallbackVisible: false,
        fallbackVisible: { personal: false, public: true, categoryID: 7 },
        categoryID: 7,
        selectedContextValues: { budget: 'extended' },
        personalEntries: [{ conditionID: 1, weightBasisPoints: 10000 }],
        personalFallbackRules: [{ primaryConditionID: 1 }],
        personalFallbackEnabled: true,
        fallbackDraft: { primaryConditionID: 2, fallbackConditionIDs: [3] },
        authenticated: true,
        toJSON() { throw new Error('The entire workspace must not be serialized'); }
    };
    assert.equal(writeWorkspacePreferences(workspace, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), {
        mode: 'personal', publicFallbackVisible: false
    });
    assert.equal(workspace.fallbackVisible.categoryID, 7);
    assert.equal(workspace.personalEntries[0].weightBasisPoints, 10000);
});

test('writes normalize invalid or missing fields before storing them', () => {
    const storage = memoryStorage();
    assert.equal(writeWorkspacePreferences({ mode: 'other', publicFallbackVisible: true }, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), {
        mode: 'public', publicFallbackVisible: true
    });
    assert.equal(writeWorkspacePreferences(undefined, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), defaults);
});
