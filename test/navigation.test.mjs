import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { configuredRows, contextKey, compareLocations, entryFromContext, locationURL, validateNavigationPayload } from '../public/js/navigation/model.js';
import { readSidebarPreferences, writeSidebarPreferences } from '../public/js/navigation/preferences.js';
import { buildPersonalNavigation, getPersonalNavigation } from '../navigation-service.js';

const entry = (path, values = {}) => ({
    categoryID: path.at(-1), categoryName: `Category ${path.at(-1)}`,
    lineage: path.map(ID => ({ ID, name: `Category ${ID}` })), contextValues: values,
    contextLabel: Object.values(values).join(' · '), contextOrder: [], available: true
});
const keys = rows => rows.map(row => row.key);
const roots = rows => [...new Set(rows.filter(row => row.configured).map(row => row.groupID))];

test('navigation identity is the exact category and canonical complete context, not mode or labels', () => {
    assert.equal(contextKey(5, { tools: 'yes', budget: 'low' }), contextKey(5, { budget: 'low', tools: 'yes' }));
    assert.notEqual(contextKey(5, { tools: 'yes' }), contextKey(5, { tools: 'no' }));
    assert.notEqual(contextKey(5, {}), contextKey(6, {}));
});

test('configured locations follow full depth-first tree order rather than depth, name or save time', () => {
    const rows = [entry([1, 3]), entry([1, 2, 10]), entry([1]), entry([1, 2]), entry([1, 3, 4])];
    assert.deepEqual(rows.sort(compareLocations).map(row => row.categoryID), [1, 2, 10, 3, 4]);
});

test('only the top level of the configured forest gets gaps; missing intermediate categories do not split it', () => {
    const items = [entry([1, 2]), entry([1, 2, 4, 6]), entry([1, 2, 5], { tools: 'yes' }), entry([1, 3, 7])];
    const rows = configuredRows(items, null);
    assert.deepEqual(rows.map(row => row.categoryID), [2, 6, 5, 7]);
    assert.deepEqual(rows.map(row => row.groupStart), [false, false, false, true]);
    assert.deepEqual(rows.map(row => row.depth), [0, 1, 1, 0]);
    assert.deepEqual(roots(rows), [2, 7]);
});

test('all contexts in one category are adjacent with no internal gap and stable template order', () => {
    const first = { ...entry([1, 2], { tools: 'yes' }), contextOrder: [0] };
    const second = { ...entry([1, 2], { tools: 'no' }), contextOrder: [1] };
    const rows = configuredRows([second, entry([1, 3]), first], null);
    assert.deepEqual(keys(rows).slice(0, 2), [contextKey(2, first.contextValues), contextKey(2, second.contextValues)]);
    assert.deepEqual(rows.map(row => row.groupStart), [false, false, true]);
});

test('current saved location is deduplicated and an unconfigured current location is the only temporary row', () => {
    const saved = entry([1, 2], { tools: 'yes' });
    assert.equal(configuredRows([saved], saved).length, 1);
    const next = entry([1, 2], { tools: 'no' });
    const rows = configuredRows([saved], next);
    assert.equal(rows.filter(row => !row.configured).length, 1);
    assert.equal(rows.find(row => row.current).configured, false);
    assert.deepEqual(roots(rows), [2]);
    assert.equal(configuredRows([saved], entry([1, 4])).some(row => row.key === contextKey(2, next.contextValues)), false);
});

test('a temporary common ancestor cannot merge existing configured top-level groups', () => {
    const items = [entry([1, 2, 3]), entry([1, 2, 4]), entry([1, 5])];
    const rows = configuredRows(items, entry([1, 2]));
    assert.deepEqual(roots(rows), [3, 4, 5]);
    assert.deepEqual(rows.filter(row => row.groupStart).map(row => row.categoryID), [4, 5]);
    assert.equal(rows[0].configured, false);
});

test('saving a common ancestor merges its branches and clearing it restores gaps without reordering siblings', () => {
    const items = [entry([1, 2, 3]), entry([1, 2, 4]), entry([1, 5])];
    const parent = entry([1, 2]);
    const before = configuredRows(items, parent);
    const after = configuredRows([...items, parent], parent);
    assert.deepEqual(roots(after), [2, 5]);
    assert.deepEqual(keys(after), keys(before));
    assert.deepEqual(configuredRows(items, parent), before);
});

test('search matches paths and template terms, retains DFS order and never adds fake ancestor entries', () => {
    const items = [entry([1, 2, 5], { tools: 'allowed' }), entry([1, 2, 3]), entry([1, 4])];
    assert.deepEqual(configuredRows(items, null, 'category 2').map(row => row.categoryID), [3, 5]);
    assert.deepEqual(configuredRows(items, null, '2 allowed').map(row => row.categoryID), [5]);
    assert.deepEqual(configuredRows(items, null, 'missing'), []);
});

test('duplicate category labels reveal their parent path without conflating identities', () => {
    const items = [{ ...entry([1, 2]), categoryName: 'Shared' }, { ...entry([1, 3]), categoryName: 'Shared' }];
    assert.ok(configuredRows(items, null).every(row => row.pathLabel === 'Category 1'));
});

test('navigation links carry full context and encode category names rather than injecting URLs', () => {
    const value = { ...entry([1, 2], { tools: 'allowed&other=1' }), lineage: [{ ID: 1, name: 'Root' }, { ID: 2, name: '<script>/Two words' }] };
    const url = new URL(locationURL(value), 'https://example.com');
    assert.equal(url.origin, 'https://example.com');
    assert.ok(url.pathname.includes('%2F'));
    assert.equal(url.searchParams.get('context_tools'), 'allowed&other=1');
    assert.equal(url.searchParams.size, 1);
});

test('index payload validation rejects malformed data and duplicate canonical locations', () => {
    const valid = { userID: '12345678901234567890', items: [entry([1, 2])] };
    assert.equal(validateNavigationPayload(valid), valid);
    for (const mutate of [
        data => { data.userID = null; }, data => { data.items = null; },
        data => { data.items.push({ ...data.items[0] }); },
        data => { data.items[0].contextValues = []; },
        data => { data.items[0].lineage.push({ ID: 2, name: 'Loop' }); },
        data => { data.items[0].available = 'yes'; },
        data => { data.items[0].contextOrder = [NaN]; }
    ]) {
        const data = structuredClone(valid); mutate(data);
        assert.throws(() => validateNavigationPayload(data));
    }
});

const categories = [
    { ID: 1, parent_ID: null, name: 'Root', is_active: 1 },
    { ID: 2, parent_ID: 1, name: 'Code', is_active: 1 },
    { ID: 3, parent_ID: 2, name: 'Generation', is_active: 1 },
    { ID: 4, parent_ID: 1, name: 'Inactive', is_active: 0 }
];
const dimensions = [
    { ID: 1, scope_category_ID: 0, dimension_key: 'tools', name: 'Global tools', position: 0 },
    { ID: 2, scope_category_ID: 2, dimension_key: 'tools', name: 'Tools', position: 0 }
];
const options = dimensions.flatMap(dimension => [
    { dimension_ID: dimension.ID, option_key: 'any', name: 'Any', is_default: 1, is_neutral: 1 },
    { dimension_ID: dimension.ID, option_key: 'yes', name: 'Allowed', is_default: 0, is_neutral: 0 }
]);
const stored = (categoryID, contextValues = '{}') => ({ categoryID, contextID: categoryID + 100,
    contextValues, weightCount: 2, totalBasisPoints: 10000, unavailableConditions: 0 });

test('server index is metadata-only, resolves nearest scoped dimensions and keeps non-leaf contexts dimensionless', () => {
    const items = buildPersonalNavigation([stored(2), stored(3, '{"tools":"yes"}')], categories, dimensions, options);
    assert.equal(items[0].contextLabel, '');
    assert.equal(items[1].contextLabel, 'Tools: Allowed');
    assert.ok(items.every(item => item.available));
    assert.deepEqual(items[1].lineage.map(item => item.ID), [1, 2, 3]);
    assert.ok(items.every(item => !('weights' in item) && !('entries' in item) && !('modelLeaderboards' in item)));
});

test('invalid or retired locations stay visible but unavailable, never mapped to a default context', () => {
    for (const row of [stored(3, '{"tools":"removed"}'), stored(3, '{}'), stored(4, '{"tools":"any"}'), stored(88)]) {
        const [item] = buildPersonalNavigation([row], categories, dimensions, options);
        assert.equal(item.available, false);
        assert.equal(item.categoryID, row.categoryID);
    }
    const [retired] = buildPersonalNavigation([stored(3, '{"tools":"removed"}')], categories, dimensions, options);
    assert.equal(retired.contextValues.tools, 'removed');
});

test('empty pies are excluded while nonempty configurations without fallback remain in the index', () => {
    const rows = [stored(2), { ...stored(1), weightCount: 0 }];
    assert.deepEqual(buildPersonalNavigation(rows, categories, dimensions, options).map(item => item.categoryID), [2]);
    assert.equal(buildPersonalNavigation([{ ...stored(2), totalBasisPoints: 9000 }], categories, dimensions, options)[0].available, false);
});

test('missing and cyclic taxonomy ancestry cannot hang the index or silently create navigable locations', () => {
    const cyclic = [...categories, { ID: 7, parent_ID: 8, name: 'A', is_active: 1 }, { ID: 8, parent_ID: 7, name: 'B', is_active: 1 }];
    const [item] = buildPersonalNavigation([stored(7)], cyclic, [], []);
    assert.equal(item.available, false);
    assert.ok(item.lineage.length <= 64);
    assert.equal(buildPersonalNavigation([stored(2)], categories.filter(item => item.ID !== 1), [], [])[0].available, false);
});

function database({ fail = false, active = true } = {}) {
    const calls = [];
    const connection = {
        async query(sql) { calls.push(['query', sql]); },
        async execute(sql, args) {
            calls.push(['execute', sql, args]);
            if (sql.includes('SELECT ID FROM users')) return [active ? [{ ID: '123' }] : []];
            if (fail) throw new Error('Database failed');
            if (sql.includes('FROM personal_pies')) return [[stored(2)]];
            if (sql.includes('FROM categories')) return [categories];
            if (sql.includes('FROM ranking_dimensions')) return [dimensions];
            return [options];
        },
        async commit() { calls.push(['commit']); }, async rollback() { calls.push(['rollback']); },
        release() { calls.push(['release']); }
    };
    return { calls, async getConnection() { return connection; } };
}

test('account index uses a parameter-bound owner in a read-only consistent snapshot and always releases', async () => {
    const db = database();
    const owner = '12345678901234567890';
    const payload = await getPersonalNavigation(db, owner);
    assert.equal(payload.userID, owner);
    const pies = db.calls.find(call => call[1]?.includes('FROM personal_pies'));
    assert.deepEqual(pies[2], [owner]);
    assert.match(pies[1], /WHERE pp\.user_ID = \?/);
    assert.ok(db.calls.some(call => call[1]?.includes('READ ONLY')));
    assert.deepEqual(db.calls.slice(-2).map(call => call[0]), ['commit', 'release']);
    assert.equal(db.calls.filter(call => call[0] === 'execute').length, 5);
});

test('index rejects guests or inactive accounts and rolls back when data access fails', async () => {
    const db = database();
    for (const user of [null, '', '1 OR 1=1', {}, 0]) {
        await assert.rejects(() => getPersonalNavigation(db, user), error => error.status === 401);
    }
    assert.equal(db.calls.length, 0);
    for (const options of [{ active: false }, { fail: true }]) {
        const broken = database(options);
        await assert.rejects(() => getPersonalNavigation(broken, '123'));
        assert.deepEqual(broken.calls.slice(-2).map(call => call[0]), ['rollback', 'release']);
    }
});

test('HTTP index endpoint requires an active session, ignores caller-supplied user IDs and is not cached', () => {
    const source = fs.readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const route = source.slice(source.indexOf("API.post('/get_personal_navigation'"), source.indexOf("API.post('/get_weighted_workspace'"));
    assert.match(route, /requireAuthForAPI/);
    assert.match(route, /getPersonalNavigation\(db, req\.session\.userID\)/);
    assert.doesNotMatch(route, /req\.body/);
    assert.match(route, /private, no-store/);
});

test('sidebar preferences store presentation only and tolerate unavailable or malformed storage', () => {
    const descriptor = Object.getOwnPropertyDescriptor(globalThis, 'sessionStorage');
    let saved;
    try {
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, value: {
            getItem: () => saved ?? '{', setItem: (_, value) => { saved = value; }
        } });
        assert.equal(readSidebarPreferences().view, 'all');
        writeSidebarPreferences({ view: 'configured', scroll: { all: 50, configured: 120 }, expansion: { 1: true }, items: [entry([1])], userID: 'private' });
        assert.deepEqual(readSidebarPreferences(), { view: 'configured', scroll: { all: 50, configured: 120 }, expansion: { 1: true } });
        assert.ok(!saved.includes('items') && !saved.includes('userID'));
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Denied'); } });
        assert.equal(readSidebarPreferences().view, 'all');
        assert.doesNotThrow(() => writeSidebarPreferences({ view: 'configured' }));
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
        else delete globalThis.sessionStorage;
    }
});

test('workspace-to-index metadata contains exact context identity but no UI-mode or weight payload', () => {
    const value = entryFromContext({ ID: 101, categoryID: 2, lineage: [{ ID: 1, name: 'Root' }, { ID: 2, name: 'Child' }], contextValues: { tools: 'yes' },
        dimensions: [{ key: 'tools', name: 'Tools', options: [{ key: 'yes', name: 'Allowed' }] }] });
    assert.equal(value.contextLabel, 'Tools: Allowed');
    assert.deepEqual(value.contextOrder, [0]);
    assert.equal('mode' in value, false);
});
