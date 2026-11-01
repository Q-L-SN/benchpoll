import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonProfileName, listComparisonProfiles, renameComparisonProfile, saveComparisonProfile, validateComparisonProfile } from '../comparison-profiles.js';
import { createComparisonProfileStore } from '../public/js/workspace/comparison-profiles.js';
import { comparisonProfileKey } from '../public/js/shared/comparison-profile-key.js';
import { assertAccountWriteOwner, isAccountWriteError } from '../public/js/shared/account-identity.js';

const configuration = { mode: 'best', keys: ['model'], filters: [] };
const memoryStorage = () => {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
};

test('saved comparison names normalize consistently and reject invalid names', () => {
    assert.deepEqual(comparisonProfileName('  Model   only '), { name: 'Model only', key: 'named:model only' });
    assert.throws(() => comparisonProfileName('  '), error => error.body.error === 'invalid_comparison_profile_name');
    assert.throws(() => comparisonProfileName('x'.repeat(81)), error => error.body.error === 'invalid_comparison_profile_name');
});

test('server validates saved configurations against current models and field catalog', async () => {
    const connection = { async execute(sql) {
        if (sql.includes('FROM score_fields')) return [[], []];
        if (sql.includes('FROM score_field_options')) return [[], []];
        if (sql.includes('FROM models')) return [[{ ID: 42, name: 'Test model' }], []];
        throw Error(sql);
    } };
    assert.deepEqual(await validateComparisonProfile(connection, {
        mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 42 }]
    }), { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 42 }] });
    await assert.rejects(validateComparisonProfile(connection, {
        mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 99 }]
    }), error => error.body.error === 'comparison_model_unavailable');
    await assert.rejects(validateComparisonProfile(connection, { mode: 'matched', keys: [], filters: [] }),
        error => error.body.error === 'comparison_key_required');
});

test('account listing separates recent configuration from named profiles', async () => {
    const connection = { async execute(_sql, values) {
        assert.deepEqual(values, [7]);
        return [[{ profile_key: 'last', name: '', comparison: JSON.stringify(configuration) },
            { profile_key: 'named:main', name: 'Main', comparison: configuration }], []];
    } };
    assert.deepEqual(await listComparisonProfiles(connection, 7), { authenticated: true, userID: '7',
        last: configuration, profiles: [{ name: 'Main', comparison: configuration }] });
});

test('guest last-used and named comparisons survive a new store instance', async () => {
    const storage = memoryStorage();
    const request = async () => ({ authenticated: false, last: null, profiles: [] });
    const first = createComparisonProfileStore({ request, storage: () => storage });
    await first.load();
    await first.saveLast(configuration);
    await first.saveNamed('Only models', configuration);
    const second = createComparisonProfileStore({ request, storage: () => storage });
    assert.deepEqual(await second.load(), { authenticated: false, last: configuration,
        profiles: [{ name: 'Only models', comparison: configuration }] });
    await second.deleteNamed('Only models');
    assert.deepEqual((await second.load()).profiles, []);
});

test('account profiles use the server but cache last-used separately from guest settings', async () => {
    const storage = memoryStorage();
    const requests = [];
    const request = async (path, body) => {
        requests.push({ path, body });
        if (path === '/api/get_comparison_profiles') return { authenticated: true, userID: '7', last: null, profiles: [] };
        if (path === '/api/save_comparison_profile') return { name: body.name ?? '', comparison: body.comparison };
        if (path === '/api/delete_comparison_profile') return { deleted: true };
        throw Error(path);
    };
    const store = createComparisonProfileStore({ request, storage: () => storage });
    await store.load();
    await store.saveLast(configuration);
    await store.saveNamed('Main', configuration);
    assert.equal(requests.filter(item => item.path === '/api/save_comparison_profile').length, 2);
    assert.ok(requests.filter(item => item.path !== '/api/get_comparison_profiles').every(item => item.body.expectedUserID === '7'));
    assert.deepEqual(store.snapshot().profiles, [{ name: 'Main', comparison: configuration }]);
    await store.deleteNamed('Main');
    assert.deepEqual(store.snapshot().profiles, []);
    assert.deepEqual(JSON.parse(storage.getItem('benchpoll-comparison-profiles-v2:7')).last, configuration);
    assert.equal(storage.getItem('benchpoll-comparison-profiles-v2:guest'), null);
});

function deferred() {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
}

test('queued last-used writes retain the account that queued them after a session changes', async () => {
    const gate = deferred(), started = deferred();
    let owner = '7';
    const writes = [];
    const store = createComparisonProfileStore({ storage: memoryStorage, request: async (path, body) => {
        if (path === '/api/get_comparison_profiles') return { authenticated: true, userID: owner, last: null, profiles: [] };
        assertAccountWriteOwner(owner, body.expectedUserID);
        writes.push({ owner, body });
        started.resolve();
        await gate.promise;
        return { name: '', comparison: body.comparison };
    } });
    await store.load();
    const first = store.saveLast(configuration);
    await started.promise;
    const second = store.saveLast({ ...configuration, keys: ['model', 'field:1'] });
    const rejected = assert.rejects(second, isAccountWriteError);
    owner = '8';
    gate.resolve();
    await first;
    await rejected;
    assert.equal(writes.length, 1);
    assert.equal(writes[0].owner, '7');
    await assert.rejects(store.saveLast(configuration), isAccountWriteError);
    assert.equal(writes.length, 1, 'A rejected account boundary stops subsequent queued writes');
});

test('an account reload invalidates queued writes and old responses without replacing the new settings', async () => {
    const gate = deferred(), started = deferred();
    let owner = '7';
    const writes = [];
    const accountB = { mode: 'matched', keys: ['model'], filters: [] };
    const storage = memoryStorage();
    const store = createComparisonProfileStore({ storage: () => storage, request: async (path, body) => {
        if (path === '/api/get_comparison_profiles') return { authenticated: true, userID: owner,
            last: owner === '8' ? accountB : null, profiles: [] };
        assertAccountWriteOwner(owner, body.expectedUserID);
        writes.push({ owner, body });
        if (writes.length === 1) { started.resolve(); await gate.promise; }
        return { name: '', comparison: body.comparison };
    } });
    await store.load();
    const first = store.saveLast(configuration);
    const rejectedFirst = assert.rejects(first, isAccountWriteError);
    await started.promise;
    const second = store.saveLast({ ...configuration, keys: ['field:1'] });
    const rejectedSecond = assert.rejects(second, isAccountWriteError);
    owner = '8';
    await store.load();
    gate.resolve();
    await rejectedFirst;
    await rejectedSecond;
    assert.equal(writes.length, 1);
    assert.equal(store.accountID(), '8');
    assert.deepEqual(store.snapshot().last, accountB);
    assert.equal(storage.getItem('benchpoll-comparison-profiles-v2:8'), null);
    await store.saveLast(accountB);
    assert.equal(writes.at(-1).body.expectedUserID, '8');
});

for (const operation of ['save', 'rename', 'delete']) {
    test(`an obsolete named-profile ${operation} cannot mutate the next account's profile list`, async () => {
        const gate = deferred(), started = deferred();
        let owner = '7';
        const profilesB = [{ name: 'Personal B', comparison: configuration }];
        const store = createComparisonProfileStore({ storage: memoryStorage, request: async (path, body) => {
            if (path === '/api/get_comparison_profiles') return { authenticated: true, userID: owner, last: null,
                profiles: owner === '7' ? [{ name: 'Main', comparison: configuration }] : profilesB };
            assert.equal(body.expectedUserID, '7');
            started.resolve();
            await gate.promise;
            return { name: body.name, comparison: body.comparison };
        } });
        await store.load();
        const pending = operation === 'save' ? store.saveNamed('New A', { ...configuration, keys: ['field:1'] })
            : operation === 'rename' ? store.renameNamed('Main', 'Renamed A') : store.deleteNamed('Main');
        const rejected = assert.rejects(pending, isAccountWriteError);
        await started.promise;
        owner = '8';
        await store.load();
        gate.resolve();
        await rejected;
        assert.deepEqual(store.snapshot().profiles, profilesB);
    });
}

test('newer profile loads win and invalid responses cannot half-switch the store account', async () => {
    const gate = deferred();
    let loads = 0;
    const store = createComparisonProfileStore({ storage: memoryStorage, request: async () => {
        loads += 1;
        if (loads === 1) return gate.promise;
        if (loads === 2) return { authenticated: true, userID: '8', last: configuration, profiles: [] };
        return { authenticated: true, userID: '9', last: null, profiles: null };
    } });
    const older = store.load();
    await store.load();
    gate.resolve({ authenticated: true, userID: '7', last: null, profiles: [] });
    await older;
    assert.equal(store.accountID(), '8');
    assert.deepEqual(store.snapshot().last, configuration);
    await assert.rejects(store.load(), /profiles are invalid/);
    assert.equal(store.accountID(), '8');
    assert.deepEqual(store.snapshot().last, configuration);
});

test('invalid stored profiles are reported rather than silently treated as defaults', async () => {
    const storage = memoryStorage();
    storage.setItem('benchpoll-comparison-profiles-v2:guest', '{broken');
    const store = createComparisonProfileStore({ storage: () => storage,
        request: async () => ({ authenticated: false, last: null, profiles: [] }) });
    await assert.rejects(store.load());
});

test('configuration identity ignores key and filter order but not operators or values', () => {
    const a = { mode: 'best', keys: ['model', 'field:1'], filters: [
        { key: 'model', operator: 'eq', value: 42 }, { key: 'field:1', operator: 'exists' }] };
    const b = { ...a, keys: [...a.keys].reverse(), filters: [...a.filters].reverse() };
    assert.equal(comparisonProfileKey(a), comparisonProfileKey(b));
    assert.notEqual(comparisonProfileKey(a), comparisonProfileKey({ ...b, mode: 'matched' }));
    assert.notEqual(comparisonProfileKey(a), comparisonProfileKey({ ...b, filters: [{ key: 'model', operator: 'eq', value: 43 }] }));
});

test('guest profiles reject duplicate configurations and names, and persist renames', async () => {
    const storage = memoryStorage();
    const store = createComparisonProfileStore({ request: async () => ({ authenticated: false, last: null, profiles: [] }), storage: () => storage });
    await store.load();
    await store.saveNamed('Models', configuration);
    await assert.rejects(() => store.saveNamed('Duplicate', configuration), /Already saved/);
    await assert.rejects(() => store.saveNamed('models', { ...configuration, keys: [] }), /name.*use/);
    await store.renameNamed('Models', ' Main ');
    const next = createComparisonProfileStore({ request: async () => ({ authenticated: false, last: null, profiles: [] }), storage: () => storage });
    assert.deepEqual((await next.load()).profiles, [{ name: 'Main', comparison: configuration }]);
});

function profileDatabase(existing = [], { active = true, failUpdate = false } = {}) {
    const calls = [];
    const connection = {
        async beginTransaction() { calls.push(['begin']); },
        async execute(sql, args) {
            calls.push([sql, args]);
            if (sql.includes('FROM users')) return [active ? [{ ID: 7 }] : []];
            if (sql.includes('FROM user_comparison_profiles')) return [existing];
            if (failUpdate) throw new Error('write failed');
            return [{ affectedRows: 1 }];
        },
        async commit() { calls.push(['commit']); }, async rollback() { calls.push(['rollback']); },
        release() { calls.push(['release']); }
    };
    return { calls, async getConnection() { return connection; }, async execute(sql) {
        if (sql.includes('FROM score_fields') || sql.includes('FROM score_field_options')) return [[]];
        if (sql.includes('FROM models')) return [[{ ID: 42, name: 'Model' }]];
        throw Error(sql);
    } };
}

test('server rejects duplicate saves under an owner lock without overwriting existing profiles', async () => {
    const db = profileDatabase([{ profile_key: 'named:main', name: 'Main', comparison: JSON.stringify(configuration) }]);
    await assert.rejects(() => saveComparisonProfile(db, 7, { name: 'Again', comparison: configuration }),
        error => error.status === 409 && error.body.name === 'Main');
    assert.ok(db.calls.some(([sql]) => sql.includes('FROM users') && sql.includes('FOR UPDATE')));
    assert.equal(db.calls.some(([sql]) => sql.startsWith('INSERT')), false);
    assert.deepEqual(db.calls.slice(-2).map(([sql]) => sql), ['rollback', 'release']);
});

test('rename is owner-scoped, permits case changes, and rolls back collisions or write failures', async () => {
    const db = profileDatabase([{ profile_key: 'named:main' }]);
    assert.deepEqual(await renameComparisonProfile(db, 7, 'Main', 'MAIN'), { name: 'MAIN' });
    const update = db.calls.find(([sql]) => sql.startsWith('UPDATE'));
    assert.deepEqual(update[1], ['named:main', 'MAIN', 7, 'named:main']);
    assert.deepEqual(db.calls.slice(-2).map(([sql]) => sql), ['commit', 'release']);
    for (const [database, reason] of [
        [profileDatabase([{ profile_key: 'named:main' }, { profile_key: 'named:other' }]), 'comparison_profile_name_exists'],
        [profileDatabase([]), 'comparison_profile_not_found'],
        [profileDatabase([], { active: false }), 'authentication_required'],
        [profileDatabase([{ profile_key: 'named:main' }], { failUpdate: true }), 'write failed']
    ]) {
        await assert.rejects(() => renameComparisonProfile(database, 7, 'Main', 'Other'), error => (error.body?.error ?? error.message) === reason);
        assert.deepEqual(database.calls.slice(-2).map(([sql]) => sql), ['rollback', 'release']);
    }
});
