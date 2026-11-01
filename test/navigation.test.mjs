import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { configuredRows, contextKey, compareLocations, entryFromContext, locationURL, validateNavigationPayload } from '../public/js/navigation/model.js';
import { readSidebarPreferences, writeSidebarPreferences } from '../public/js/navigation/preferences.js';
import { buildPersonalNavigation, getPersonalNavigation } from '../navigation-service.js';

const entry = (ID, values = {}, position = 0) => ({
    categoryID: ID, categoryName: `Topic ${ID}`, slug: `topic-${ID}-stored`, url: `/topic-${ID}-stored`, weightCount: 1,
    lineage: [{ ID, name: `Topic ${ID}`, position }], contextValues: values,
    contextLabel: Object.values(values).join(' · '), contextOrder: [], available: true
});
const keys = rows => rows.map(row => row.key);
const roots = rows => [...new Set(rows.filter(row => row.configured).map(row => row.groupID))];

test('navigation identity is the exact category and canonical complete context, not mode or labels', () => {
    assert.equal(contextKey(5, { tools: 'yes', budget: 'low' }), contextKey(5, { budget: 'low', tools: 'yes' }));
    assert.notEqual(contextKey(5, { tools: 'yes' }), contextKey(5, { tools: 'no' }));
    assert.notEqual(contextKey(5, {}), contextKey(6, {}));
});

test('configured topics follow stable position and ID order rather than label or save time', () => {
    const rows = [entry(3, {}, 20), entry(10, {}, 10), entry(1), entry(2, {}, 10), entry(4, {}, 20)];
    assert.deepEqual(rows.sort(compareLocations).map(row => row.categoryID), [1, 2, 10, 3, 4]);
    assert.ok(rows.every(row => row.lineage.length === 1));
});

test('configured locations retain independent topic positions from server and workspace metadata', () => {
    const rows = [
        entryFromContext({ categoryID: 1, lineage: [{ ID: 1, name: 'Root', position: 10 }], contextValues: {} }),
        entryFromContext({ categoryID: 2, lineage: [{ ID: 2, name: 'Second', position: 20 }], contextValues: {} }),
        entryFromContext({ categoryID: 9, lineage: [{ ID: 9, name: 'First', position: 10 }], contextValues: {} })
    ].map(item => ({ ...item, weightCount: 1 }));
    assert.deepEqual(configuredRows(rows, null).map(row => row.categoryID), [1, 9, 2]);
});

test('configured topics stay flat with no synthetic ancestors, depth or tree-group gaps', () => {
    const items = [entry(2), entry(6), entry(5, { tools: 'yes' }), entry(7)];
    const rows = configuredRows(items, null);
    assert.deepEqual(rows.map(row => row.categoryID), [2, 5, 6, 7]);
    assert.deepEqual(rows.map(row => row.groupStart), [false, false, false, false]);
    assert.deepEqual(rows.map(row => row.depth), [0, 0, 0, 0]);
    assert.deepEqual(roots(rows), [2, 5, 6, 7]);
});

test('all contexts in one category are adjacent with no internal gap and stable template order', () => {
    const first = { ...entry(2, { tools: 'yes' }), contextOrder: [0] };
    const second = { ...entry(2, { tools: 'no' }), contextOrder: [1] };
    const rows = configuredRows([second, entry(3), first], null);
    assert.deepEqual(keys(rows).slice(0, 2), [contextKey(2, first.contextValues), contextKey(2, second.contextValues)]);
    assert.deepEqual(rows.map(row => row.groupStart), [false, false, false]);
});

test('Configured marks a saved current location but never inserts an unconfigured browsing location', () => {
    const saved = entry(2, { tools: 'yes' });
    assert.equal(configuredRows([saved], saved).length, 1);
    const next = entry(2, { tools: 'no' });
    const rows = configuredRows([saved], next);
    assert.equal(rows.length, 1);
    assert.equal(rows.some(row => row.current), false);
    assert.ok(rows.every(row => row.configured));
    assert.deepEqual(roots(rows), [2]);
    assert.equal(configuredRows([saved], entry(4)).some(row => row.key === contextKey(2, next.contextValues)), false);
});

test('browsing an unconfigured topic leaves the configured list unchanged', () => {
    const items = [entry(3), entry(4), entry(5)];
    const rows = configuredRows(items, entry(2));
    assert.deepEqual(roots(rows), [3, 4, 5]);
    assert.deepEqual(rows.filter(row => row.groupStart), []);
    assert.deepEqual(rows, configuredRows(items, null));
});

test('Mine merges owned private topics without Pies, deduplicates saved Pies and excludes other authors', () => {
    const privateTopic = ID => entryFromContext({ categoryID: ID, name: `Private ${ID}`, isPrivate: true, isMine: true });
    const empty = privateTopic(8), saved = { ...privateTopic(9), weightCount: 2 };
    const catalog = [empty, saved, { ...privateTopic(10), isMine: false }, { ...entry(11), isMine: true }];
    const rows = configuredRows([entry(2), saved], empty, '', catalog);
    assert.deepEqual(rows.map(row => [row.categoryID, row.configured, row.current]), [[2, true, false], [8, false, true], [9, true, false]]);
    assert.equal(locationURL(rows[1]), '/personal/8');
    assert.deepEqual(configuredRows([], null, 'Private 8', catalog).map(row => row.categoryID), [8]);
    assert.deepEqual(configuredRows([], null), []);
});

test('saving and clearing another topic only adds or removes that topic without regrouping existing entries', () => {
    const items = [entry(3), entry(4), entry(5)];
    const added = entry(2);
    const before = configuredRows(items, added);
    const after = configuredRows([...items, added], added);
    assert.deepEqual(roots(after), [2, 3, 4, 5]);
    assert.deepEqual(keys(after.filter(row => row.categoryID !== added.categoryID)), keys(before));
    assert.equal(after.find(row => row.categoryID === 2).current, true);
    assert.ok(after.every(row => row.depth === 0 && !row.groupStart));
    assert.deepEqual(configuredRows(items, added), before);
});

test('search matches topic and template terms, retains flat order and never adds synthetic entries', () => {
    const named = (ID, name, values) => ({ ...entry(ID, values), categoryName: name, lineage: [{ ID, name, position: 0 }] });
    const items = [named(5, 'Code practice', { tools: 'allowed' }), named(3, 'Code'), named(4, 'Planning')];
    assert.deepEqual(configuredRows(items, null, 'code').map(row => row.categoryID), [3, 5]);
    assert.deepEqual(configuredRows(items, null, 'code allowed').map(row => row.categoryID), [5]);
    assert.deepEqual(configuredRows(items, null, 'missing'), []);
});

test('duplicate topic labels reveal stable topic IDs without inventing parent paths or conflating identities', () => {
    const items = [2, 3].map(ID => ({ ...entry(ID), categoryName: 'Shared', lineage: [{ ID, name: 'Shared', position: 0 }] }));
    const rows = configuredRows(items, null);
    assert.deepEqual(rows.map(row => row.pathLabel), ['Topic 2', 'Topic 3']);
    assert.notEqual(rows[0].key, rows[1].key);
});

test('navigation links carry full context and stored slugs without injecting URLs or exposing private names', () => {
    const value = { ...entry(2, { tools: 'allowed&other=1' }), categoryName: '<script> Two words', slug: 'script-two-words',
        url: '/script-two-words', lineage: [{ ID: 2, name: '<script> Two words' }] };
    const url = new URL(locationURL(value), 'https://example.com');
    assert.equal(url.origin, 'https://example.com');
    assert.equal(url.pathname, '/script-two-words');
    assert.equal(url.searchParams.get('context_tools'), 'allowed&other=1');
    assert.equal(url.searchParams.size, 1);
    value.categoryName = 'Part/Other';
    value.slug = 'part-other'; value.url = '/part-other';
    assert.equal(new URL(locationURL(value), url).pathname, '/part-other');
    delete value.url;
    assert.equal(new URL(locationURL(value), url).pathname, '/part-other');
    delete value.slug;
    assert.equal(new URL(locationURL(value), url).pathname, '/part-other');
    value.isPrivate = true;
    assert.equal(new URL(locationURL(value), url).pathname, '/personal/2');
    assert.throws(() => locationURL({ ...value, categoryID: '../2' }), /Invalid topic ID/);
});

test('index payload validation rejects malformed data and duplicate canonical locations', () => {
    const valid = { userID: '12345678901234567890', items: [entry(2)] };
    assert.equal(validateNavigationPayload(valid), valid);
    for (const mutate of [
        data => { data.userID = null; }, data => { data.items = null; },
        data => { data.items.push({ ...data.items[0] }); },
        data => { data.items[0].contextValues = []; },
        data => { data.items[0].lineage.push({ ID: 2, name: 'Loop' }); },
        data => { data.items[0].available = 'yes'; },
        data => { data.items[0].contextOrder = [NaN]; },
        data => { data.items[0].url = '//example.com/not-a-topic'; }
    ]) {
        const data = structuredClone(valid); mutate(data);
        assert.throws(() => validateNavigationPayload(data));
    }
});

const categories = [
    { ID: 1, name: 'General', position: 0, is_active: 1 },
    { ID: 2, name: 'Code', position: 1, is_active: 1 },
    { ID: 3, name: 'Generation', position: 2, is_active: 1 },
    { ID: 4, name: 'Inactive', position: 3, is_active: 0 }
];
const dimensions = [
    { ID: 1, scope_category_ID: 0, dimension_key: 'tools', name: 'Global tools', position: 0 },
    { ID: 2, scope_category_ID: 2, dimension_key: 'tools', name: 'Tools', position: 0 },
    { ID: 3, scope_category_ID: 3, dimension_key: 'budget', name: 'Budget', position: 0 }
];
const options = dimensions.flatMap(dimension => [
    { dimension_ID: dimension.ID, option_key: 'any', name: 'Any', is_default: 1, is_neutral: 1 },
    { dimension_ID: dimension.ID, option_key: 'yes', name: 'Allowed', is_default: 0, is_neutral: 0 }
]);
const stored = (categoryID, contextValues = '{}') => ({ categoryID, contextID: categoryID + 100,
    contextValues, weightCount: 2, totalBasisPoints: 10000, unavailableConditions: 0 });

test('server index is metadata-only and uses only each flat topic template, not global or parent scopes', () => {
    const items = buildPersonalNavigation([stored(2, '{"tools":"yes"}'), stored(3, '{"budget":"yes"}')], categories, dimensions, options);
    assert.equal(items[0].contextLabel, 'Tools: Allowed');
    assert.equal(items[1].contextLabel, 'Budget: Allowed');
    assert.ok(items.every(item => item.available));
    assert.deepEqual(items[1].lineage.map(item => item.ID), [3]);
    assert.deepEqual(buildPersonalNavigation([stored(1)], categories, dimensions, options)[0].contextValues, {});
    assert.equal(buildPersonalNavigation([stored(3, '{"tools":"yes"}')], categories, dimensions, options)[0].available, false);
    assert.ok(items.every(item => !('weights' in item) && !('entries' in item) && !('modelLeaderboards' in item)));
});

test('invalid or retired locations stay visible but unavailable, never mapped to a default context', () => {
    for (const row of [stored(3, '{"budget":"removed"}'), stored(3, '{}'), stored(4, '{"tools":"any"}'), stored(88)]) {
        const [item] = buildPersonalNavigation([row], categories, dimensions, options);
        assert.equal(item.available, false);
        assert.equal(item.categoryID, row.categoryID);
    }
    const [retired] = buildPersonalNavigation([stored(3, '{"budget":"removed"}')], categories, dimensions, options);
    assert.equal(retired.contextValues.budget, 'removed');
});

test('empty pies are excluded while nonempty configurations without fallback remain in the index', () => {
    const rows = [stored(2, '{"tools":"any"}'), { ...stored(1), weightCount: 0 }];
    assert.deepEqual(buildPersonalNavigation(rows, categories, dimensions, options).map(item => item.categoryID), [2]);
    assert.equal(buildPersonalNavigation([{ ...stored(2, '{"tools":"any"}'), totalBasisPoints: 9000 }], categories, dimensions, options)[0].available, false);
});

test('legacy ancestry cannot hide an independent topic, while a missing topic remains unavailable', () => {
    const cyclic = [...categories, { ID: 7, parent_ID: 8, name: 'A', is_active: 1 }, { ID: 8, parent_ID: 7, name: 'B', is_active: 1 }];
    const [item] = buildPersonalNavigation([stored(7)], cyclic, [], []);
    assert.equal(item.available, true);
    assert.deepEqual(item.lineage, [{ ID: 7, name: 'A', position: 0 }]);
    assert.equal(buildPersonalNavigation([stored(2, '{"tools":"any"}')], categories.filter(item => item.ID !== 1), dimensions, options)[0].available, true);
    const [missing] = buildPersonalNavigation([stored(88)], categories, dimensions, options);
    assert.equal(missing.available, false); assert.equal(missing.categoryID, 88);
    assert.deepEqual(missing.lineage, [{ ID: 88, name: 'Topic #88', position: 0 }]);
});

function database({ fail = false, active = true } = {}) {
    const calls = [];
    const connection = {
        async query(sql) { calls.push(['query', sql]); },
        async execute(sql, args) {
            calls.push(['execute', sql, args]);
            if (sql.includes('SELECT ID FROM users')) return [active ? [{ ID: args[0] }] : []];
            if (fail) throw new Error('Database failed');
            if (sql.includes('AS scene_context_ID')) return [[{
                contextID: 102, category_ID: 2, scene_context_ID: 102,
                name: 'General', slug: 'general', description: 'General coding tasks.',
                position: 0, is_default: 1, is_active: 1, legacy_context_values: '{"tools":"any"}',
                category_name: 'Code', category_slug: 'code', owner_user_ID: null
            }]];
            if (sql.includes('FROM ranking_contexts rc')) return [[stored(2, '{"tools":"any"}')]];
            if (sql.includes('FROM categories')) return [categories];
            throw new Error(`Unexpected navigation SQL: ${sql}`);
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
    const pies = db.calls.find(call => call[1]?.includes('FROM ranking_contexts rc'));
    assert.deepEqual(pies[2], [owner, owner, owner]);
    assert.match(pies[1], /pp\.user_ID = \?/);
    assert.match(pies[1], /cat\.owner_user_ID = \?/);
    const topics = db.calls.find(call => call[0] === 'execute' && call[1].includes('FROM categories'));
    assert.deepEqual(topics[2], [owner]);
    assert.match(topics[1], /WHERE c\.owner_user_ID IS NULL OR c\.owner_user_ID = \?/);
    assert.doesNotMatch(topics[1], /parent_ID/);
    assert.ok(payload.items.every(item => item.lineage.length === 1));
    assert.equal(payload.items[0].contextID, 102);
    assert.equal(payload.items[0].sceneID, 102);
    assert.equal(payload.items[0].contextLabel, 'General');
    assert.deepEqual(payload.items[0].contextValues, { scene: '102' });
    assert.equal(payload.items[0].url, '/code?scene=102');
    assert.equal(payload.items[0].available, true);
    assert.ok(db.calls.some(call => call[1]?.includes('READ ONLY')));
    assert.deepEqual(db.calls.slice(-2).map(call => call[0]), ['commit', 'release']);
    assert.equal(db.calls.filter(call => call[0] === 'execute').length, 4);
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
    const route = source.slice(source.indexOf("API.post('/get_personal_navigation'"), source.indexOf("API.post('/create_private_category'"));
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
        assert.equal(readSidebarPreferences().view, 'popular');
        const scroll = { popular: 50, recent: 30, configured: 120, search: 60 };
        for (const view of ['popular', 'recent', 'configured', 'search']) {
            writeSidebarPreferences({ view, scroll, expansion: { 1: true }, items: [entry(1)], userID: 'private' });
            assert.deepEqual(readSidebarPreferences(), { view, scroll, expansion: { 1: true } });
        }
        assert.ok(!saved.includes('items') && !saved.includes('userID'));
        saved = JSON.stringify({ view: 'all', scroll: { all: 70 }, expansion: {} });
        assert.deepEqual(readSidebarPreferences(), { view: 'popular', scroll: { popular: 70, recent: 0, configured: 0, search: 0 }, expansion: {} });
        saved = JSON.stringify({ view: 'mine', scroll: { mine: 40, configured: 120 } });
        assert.deepEqual(readSidebarPreferences(), { view: 'configured', scroll: { popular: 0, recent: 0, configured: 40, search: 0 }, expansion: {} });
        saved = JSON.stringify({ view: 'configured', scroll: { mine: 40, configured: 120 } });
        assert.equal(readSidebarPreferences().scroll.configured, 120);
        Object.defineProperty(globalThis, 'sessionStorage', { configurable: true, get() { throw new Error('Denied'); } });
        assert.equal(readSidebarPreferences().view, 'popular');
        assert.doesNotThrow(() => writeSidebarPreferences({ view: 'configured' }));
    } finally {
        if (descriptor) Object.defineProperty(globalThis, 'sessionStorage', descriptor);
        else delete globalThis.sessionStorage;
    }
});

test('workspace-to-index metadata contains exact context identity but no UI-mode or weight payload', () => {
    const value = entryFromContext({ ID: 101, categoryID: 2, lineage: [{ ID: 2, name: 'Code' }], contextValues: { tools: 'yes' },
        dimensions: [{ key: 'tools', name: 'Tools', options: [{ key: 'yes', name: 'Allowed' }] }] });
    assert.equal(value.contextLabel, 'Tools: Allowed');
    assert.deepEqual(value.contextOrder, [0]);
    assert.equal('mode' in value, false);
});
