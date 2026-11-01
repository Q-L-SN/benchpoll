import assert from 'node:assert/strict';
import test from 'node:test';
import { readWorkspacePreferences, writeWorkspacePreferences } from '../public/js/workspace/preferences.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';

const storageKey = 'benchpoll-workspace-preferences-v1';
const defaults = { mode: 'public', personalFallbackExpanded: false, scoreMode: 'available' };

function memoryStorage(initialValue = null) {
    const values = new Map(initialValue === null ? [] : [[storageKey, initialValue]]);
    return {
        getItem(key) { return values.get(key) ?? null; },
        setItem(key, value) { values.set(key, String(value)); }
    };
}

test('new workspace state and absent preferences both default to Estimated score', () => {
    const state = createWorkspaceState();
    assert.equal(state.scoreMode, 'available');
    assert.equal(state.scoreMode, readWorkspacePreferences(memoryStorage()).scoreMode);
});

test('both explicitly saved scoring modes survive preference reads and writes', () => {
    for (const scoreMode of ['range', 'available']) {
        const preferences = { ...defaults, mode: 'personal', personalFallbackExpanded: true, scoreMode };
        const storage = memoryStorage(JSON.stringify(preferences));
        assert.deepEqual(readWorkspacePreferences(storage), preferences);
        assert.equal(writeWorkspacePreferences(readWorkspacePreferences(storage), storage), true);
        assert.deepEqual(JSON.parse(storage.getItem(storageKey)), preferences);
        assert.deepEqual(readWorkspacePreferences(storage), preferences);
    }
});

test('invalid scoring preferences default to Estimated score without discarding other valid fields', () => {
    for (const scoreMode of [undefined, null, '', 'RANGE', 'AVAILABLE', 'other', true, false, 0, 1, [], {}]) {
        const preferences = { mode: 'personal', personalFallbackExpanded: true, scoreMode };
        const expected = { ...defaults, mode: 'personal', personalFallbackExpanded: true };
        const storage = memoryStorage(JSON.stringify(preferences));
        assert.deepEqual(readWorkspacePreferences(storage), expected);
        assert.equal(writeWorkspacePreferences(preferences, storage), true);
        assert.deepEqual(JSON.parse(storage.getItem(storageKey)), expected);
    }
});

test('workspace preferences preserve personal fallback expansion while switching modes through a round trip', () => {
    const storage = memoryStorage();
    const preferences = { ...defaults, mode: 'personal', personalFallbackExpanded: true, scoreMode: 'available' };
    assert.equal(writeWorkspacePreferences(preferences, storage), true);
    assert.deepEqual(readWorkspacePreferences(storage), preferences);

    preferences.mode = 'public';
    assert.equal(writeWorkspacePreferences(preferences, storage), true);
    assert.deepEqual(readWorkspacePreferences(storage), {
        ...preferences, mode: 'public'
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
        [{ mode: 'personal' }, { ...defaults, mode: 'personal' }],
        [{ publicFallbackVisible: true }, defaults],
        [{ personalFallbackExpanded: true }, { ...defaults, personalFallbackExpanded: true }]
    ]) {
        assert.deepEqual(readWorkspacePreferences(memoryStorage(JSON.stringify(value))), expected);
    }
});

test('legacy inline fallback visibility is discarded on read and write', () => {
    for (const [value, expected] of [
        [{ mode: 'personal', fallbackVisible: { personal: false } }, { ...defaults, mode: 'personal' }],
        [{ fallbackVisible: { personal: false, public: true } }, defaults],
        [{ fallbackVisible: { personal: true, public: false } }, defaults]
    ]) {
        const storage = memoryStorage(JSON.stringify(value));
        const preferences = readWorkspacePreferences(storage);
        assert.deepEqual(preferences, expected);
        assert.equal(writeWorkspacePreferences(preferences, storage), true);
        assert.deepEqual(JSON.parse(storage.getItem(storageKey)), expected);
    }
});

test('retired public fallback expansion never reopens a modal', () => {
    for (const publicFallbackVisible of [false, true]) {
        const storage = memoryStorage(JSON.stringify({
            mode: 'personal', publicFallbackVisible,
            fallbackVisible: { personal: !publicFallbackVisible, public: !publicFallbackVisible }
        }));
        assert.deepEqual(readWorkspacePreferences(storage), { ...defaults, mode: 'personal' });
    }
    const storage = memoryStorage(JSON.stringify({
        publicFallbackVisible: 'false', fallbackVisible: { public: true }
    }));
    assert.deepEqual(readWorkspacePreferences(storage), defaults);
});

test('invalid modes and non-boolean visibility values never become active preferences', () => {
    for (const invalidMode of ['', 'PUBLIC', 'Personal', 'overview', true, 1, {}, null]) {
        const storage = memoryStorage(JSON.stringify({ mode: invalidMode }));
        assert.deepEqual(readWorkspacePreferences(storage), defaults);
    }
    for (const invalidValue of ['true', 'false', 0, 1, null, [], {}]) {
        const storage = memoryStorage(JSON.stringify({
            mode: 'personal', publicFallbackVisible: invalidValue, personalFallbackExpanded: invalidValue, fallbackVisible: { public: invalidValue }
        }));
        assert.deepEqual(readWorkspacePreferences(storage), {
            ...defaults, mode: 'personal'
        });
    }
    for (const invalidMap of [null, false, 0, 'true', []]) {
        assert.deepEqual(readWorkspacePreferences(memoryStorage(JSON.stringify({ fallbackVisible: invalidMap }))), defaults);
    }
});

test('scoring mode owns chart scaling and obsolete fillTopBar preferences are discarded', () => {
    const storage = memoryStorage(JSON.stringify({ scoreMode: 'available', fillTopBar: true }));
    assert.deepEqual(readWorkspacePreferences(storage), { ...defaults, scoreMode: 'available' });
    assert.deepEqual(readWorkspacePreferences(memoryStorage(JSON.stringify({ scoreMode: 'other', fillTopBar: 'true' }))), defaults);
    assert.equal(writeWorkspacePreferences({ scoreMode: 'available', fillTopBar: true }, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), { ...defaults, scoreMode: 'available' });
});

test('obsolete version-grouping preferences are discarded on read and write', () => {
    const storage = memoryStorage(JSON.stringify({ groupBenchmarkVersions: true }));
    assert.deepEqual(readWorkspacePreferences(storage), defaults);
    assert.equal(writeWorkspacePreferences({ groupBenchmarkVersions: true }, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), defaults);
});

test('storage read and write failures leave callers with usable in-memory preferences', () => {
    const storage = {
        getItem() { throw new Error('Storage access denied'); },
        setItem() { throw new Error('Storage quota exceeded'); }
    };
    const preferences = { ...defaults, mode: 'personal', personalFallbackExpanded: true };
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
            ...defaults, mode: 'personal'
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
        first.personalFallbackExpanded = true;
        assert.deepEqual(second, defaults);
        assert.deepEqual(readWorkspacePreferences(storage), defaults);
    }
});

test('writes persist only viewing preferences, excluding personal rules and draft data', () => {
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
        ...defaults, mode: 'personal'
    });
    assert.equal(workspace.fallbackVisible.categoryID, 7);
    assert.equal(workspace.personalEntries[0].weightBasisPoints, 10000);
});

test('writes normalize invalid or missing fields before storing them', () => {
    const storage = memoryStorage();
    assert.equal(writeWorkspacePreferences({ mode: 'other', publicFallbackVisible: true }, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), {
        ...defaults
    });
    assert.equal(writeWorkspacePreferences(undefined, storage), true);
    assert.deepEqual(JSON.parse(storage.getItem(storageKey)), defaults);
});
