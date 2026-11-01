import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCategoryNavigation, getCategoryNavigation } from '../navigation-service.js';
import { searchItems } from '../public/js/shared/search.js';
import { locationURL } from '../public/js/navigation/model.js';

test('public topic search is flat, keeps active topic identities and excludes private or retired topics', () => {
    const rows = [
        { ID: 1, parent_ID: null, name: 'AI Evaluation', is_active: 1 },
        { ID: 2, parent_ID: 1, name: 'Coding', slug: 'coding', is_active: 1 },
        { ID: 3, parent_ID: 2, name: 'Python', is_active: 1 },
        { ID: 4, parent_ID: 1, name: 'Retired', is_active: 0 },
        { ID: 5, parent_ID: 4, name: 'Independent topic', is_active: 1 },
        { ID: 6, parent_ID: null, name: 'Secret mix', owner_user_ID: '7', is_active: 1 },
        { ID: 7, parent_ID: null, name: 'Coding 7', slug: 'coding-7', is_active: 1 }
    ];
    const entries = buildCategoryNavigation(rows);
    assert.deepEqual(entries.map(entry => entry.categoryID), [1, 2, 3, 5, 7]);
    for (const entry of entries) {
        assert.deepEqual(entry.lineage.map(item => [item.ID, item.name]), [[entry.categoryID, entry.categoryName]]);
        assert.deepEqual(entry.contextValues, {});
        assert.equal(entry.isPrivate, false);
        assert.equal('children' in entry || 'hasChildren' in entry, false);
    }
    const fields = entry => [entry.categoryName];
    const matches = searchItems(entries, 'Coding', fields);
    assert.deepEqual(matches.map(entry => entry.categoryID), [2, 7]);
    assert.deepEqual(matches.map(locationURL), ['/coding', '/coding-7']);
    assert.deepEqual(searchItems(entries, 'Secret mix', fields), []);
    assert.deepEqual(searchItems(entries, 'AI Evaluation Python', fields), []);
});
test('legacy parent metadata cannot hide independent topics or recreate hierarchy routes', () => {
    const entries = buildCategoryNavigation([
        { ID: 10, parent_ID: 10, name: 'Former self-reference', is_active: 1 },
        { ID: 11, parent_ID: 999, name: 'Former missing parent', is_active: 1 },
        { ID: 12, parent_ID: 13, name: 'Former cycle A', is_active: 1 },
        { ID: 13, parent_ID: 12, name: 'Former cycle B', is_active: 1 }
    ]);
    assert.deepEqual(entries.map(entry => entry.categoryID), [10, 11, 12, 13]);
    assert.ok(entries.every(entry => entry.lineage.length === 1));
    assert.equal(locationURL(entries[1]), '/former-missing-parent');
});

test('Popular pins Intelligence before higher heat and preserves stable topic positions for ties', () => {
    const rows = [
        { ID: 54, parent_ID: null, name: 'Intelligence', popularity: 0, position: 10, is_active: 1 },
        { ID: 167, parent_ID: 54, name: 'Research', popularity: 1, position: 10, is_active: 1 },
        { ID: 170, parent_ID: 167, name: 'Biology and Medicine', popularity: 30, position: 40, is_active: 1 },
        { ID: 190, parent_ID: 167, name: 'Chemistry', popularity: 30, position: 30, is_active: 1 },
        { ID: 166, parent_ID: null, name: 'AGI', popularity: 50, position: 20, is_active: 1 }
    ];
    const entries = buildCategoryNavigation(rows);
    assert.deepEqual(entries.map(row => row.categoryID), [54, 166, 190, 170, 167]);
    assert.deepEqual(entries.map(row => row.popularity), [0, 50, 30, 30, 1]);
});
test('public topic index exposes flat compatibility aliases and aggregate activity, not private configuration data', async () => {
    const queries = [];
    const data = await getCategoryNavigation({ execute: async (sql, args) => {
        queries.push(sql);
        if (sql.includes('LEFT JOIN topic_scenes')) {
            assert.equal(args[0], 54);
            return [[{ contextID: 154, category_ID: 54, scene_context_ID: null, context_hash: args.at(-1) }]];
        }
        return [[{ ID: 54, name: 'Intelligence', is_active: 1, popularity: 3,
            userName: 'Not public metadata', personalEntries: [{ weightBasisPoints: 10000 }] }]];
    } });
    assert.equal(data.flat, true);
    assert.deepEqual(data.items, data.entries);
    assert.equal(data.items[0].categoryID, 54);
    assert.equal(data.items[0].popularity, 3);
    assert.doesNotMatch(JSON.stringify(data), /userName|personalEntries|weightBasisPoints|modelLeaderboards/);
    assert.equal(data.items[0].rootContextID, 154);
    assert.equal(data.items[0].defaultContextID, 154);
    assert.deepEqual(data.items[0].scenes, []);
    assert.equal(queries.length, 2);
    assert.match(queries[0], /FROM categories c/);
    assert.match(queries[0], /WHERE c\.owner_user_ID IS NULL/);
    assert.match(queries[0], /COUNT\(DISTINCT pp\.user_ID\) AS popularity/);
    assert.match(queries[0], /INTERVAL 14 DAY/);
    assert.match(queries[0], /contributor\.deleted_at IS NULL/);
    assert.match(queries[0], /w\.weight_basis_points > 0/);
    assert.doesNotMatch(queries[0], /benchmark_results|model_conditions|model_scores/);
    assert.doesNotMatch(queries[1], /benchmark_results|model_conditions|model_scores/);
    const empty = await getCategoryNavigation({ execute: async () => [[]] });
    assert.deepEqual(empty, { items: [], entries: [], flat: true });
});
