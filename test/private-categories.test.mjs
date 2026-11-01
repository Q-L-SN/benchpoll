import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPrivateCategory, getPrivateCategory, ownsCategory, privateCategoryName } from '../private-category-service.js';
import { resolveRankingContext, loadPublicPie, canonicalizeContextValues } from '../ranking-service.js';
import { buildPersonalNavigation, buildCategoryNavigation } from '../navigation-service.js';
import { locationURL } from '../public/js/navigation/model.js';
import { isContextDimensionUnlocked, selectContextOption } from '../public/js/shared/context-selection.js';
import { planCategories, desiredDimensions } from '../scripts/migrate-expanded-taxonomy.mjs';

test('private categories use the session owner, never request-supplied ownership', async () => {
    const db = { getConnection() { throw new Error('should not access DB'); } };
    await assert.rejects(createPrivateCategory(db, null, { name: 'Mine' }), e => e.status === 401);
    await assert.rejects(createPrivateCategory(db, '1', { name: 'Mine', owner_user_ID: '2' }), e => e.status === 400);
    assert.equal(ownsCategory({ owner_user_ID: '1' }, 1), true);
    assert.equal(ownsCategory({ owner_user_ID: '1' }, null), false);
    assert.equal(ownsCategory({ owner_user_ID: '1' }, 2), false);
    for (const name of ['', ' ', '\u0000', 'a'.repeat(129)]) assert.throws(() => privateCategoryName(name));
});

function contextDB(owner) {
    const calls = [];
    return { calls, async execute(sql, parameters) {
        calls.push({ sql, parameters });
        if (sql.includes('FROM categories c') && sql.includes('WHERE c.ID = ? AND c.is_active = 1')) {
            assert.deepEqual(parameters, [500]);
            return [[{ ID: 500, name: 'My mix', position: 0, owner_user_ID: owner }]];
        }
        if (sql.includes('LEFT JOIN topic_scenes')) {
            assert.equal(parameters[0], 500);
            return [[{ contextID: 10, category_ID: 500, scene_context_ID: null, context_hash: parameters.at(-1) }]];
        }
        if (sql.includes('FROM ranking_contexts')) return [[{ ID: 10, context_values: {}, context_hash: 'hash' }]];
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
}
test('private ranking contexts reject guests and other users before reading any scores', async () => {
    for (const userID of [null, '2']) {
        const db = contextDB('1');
        await assert.rejects(resolveRankingContext(db, { categoryID: 500, userID }),
            e => e.status === 404 && e.body.error === 'category_not_found');
        assert.equal(db.calls.length, 1, 'Foreign accounts cannot read contexts, templates or scores');
    }
    const context = await resolveRankingContext(contextDB('1'), { categoryID: 500, userID: '1' });
    assert.equal(context.isPrivate, true); assert.deepEqual(context.dimensions, []);
    assert.deepEqual(context.contextValues, {});
    assert.equal(context.categoryPath, 'personal/500');
    assert.deepEqual(context.lineage, [{ ID: 500, name: 'My mix', position: 0 }]);
    await assert.rejects(resolveRankingContext(contextDB('1'), { categoryID: 500, userID: '1', contextValues: { web: 'allowed' } }),
        e => e.status === 404 && e.body.error === 'topic_scene_not_found');
});
test('private categories have no public aggregation or public navigation, even with pies', async () => {
    const pie = await loadPublicPie({ execute() { throw new Error('Public database access in private category'); } }, { isPrivate: true }, new Map());
    assert.equal(pie.participantCount, 0); assert.deepEqual(pie.entries, []); assert.deepEqual(pie.familyComposition, []);
    assert.deepEqual(pie.scoringEntries, []); assert.deepEqual(pie.contextIDs, []);
    assert.deepEqual(buildCategoryNavigation([{ ID: 500, parent_ID: null, name: 'My mix', position: 0, is_active: 1, owner_user_ID: 1 }]), []);
});

test('private category reads return the personal ranking first; writes return only a save receipt', () => {
    const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
    const read = server.slice(server.indexOf("API.post('/get_weighted_workspace'")).split('\n});')[0];
    assert.match(read, /initialMode: workspace\.context\.isPrivate \? 'personal' : req\.body\.initialMode \?\? 'public'/);
    const save = server.slice(server.indexOf("API.post('/save_personal_pie'")).split('\n});')[0];
    assert.match(save, /requireAuthForAPI, requireAccountWriteOwner/);
    assert.match(save, /writeIdentity: readWriteIdentity\(req\)/);
    assert.match(save, /res\.json\(receipt\)/);
    assert.doesNotMatch(save, /rankingPager|getRankingWorkspace|initialMode/);
});
test('empty private topics leave Configured but remain owner-addressable after removing the final slice', async () => {
    const categories = [{ ID: 500, parent_ID: null, name: 'My mix', position: 0, is_active: 1, owner_user_ID: 1 }];
    const items = buildPersonalNavigation([{ categoryID: 500, contextID: 10, contextValues: {}, weightCount: 0,
        totalBasisPoints: null, unavailableConditions: 0 }], categories, [], []);
    assert.deepEqual(items, []);
    const configured = buildPersonalNavigation([{ categoryID: 500, contextID: 10, contextValues: {}, weightCount: 1,
        totalBasisPoints: 10000, unavailableConditions: 0 }], categories, [], []);
    assert.equal(configured.length, 1); assert.equal(configured[0].available, true); assert.equal(configured[0].isPrivate, true);
    assert.equal(locationURL(configured[0]), '/personal/500');
    const empty = await getPrivateCategory({ execute: async (_sql, parameters) => {
        assert.deepEqual(parameters, [500, '1']);
        return [[{ ID: 500, name: 'My mix', position: 0 }]];
    } }, '1', 500);
    assert.equal(locationURL(empty), '/personal/500');
});
test('private category lookups bind both ID and owner and mask missing/foreign categories', async () => {
    await assert.rejects(getPrivateCategory({}, null, 1), e => e.status === 401);
    await assert.rejects(getPrivateCategory({ execute: async () => [[]] }, 1, 500), e => e.status === 404);
    const entry = await getPrivateCategory({ async execute(sql, parameters) {
        assert.match(sql, /owner_user_ID = \?/); assert.deepEqual(parameters, [500, 1]);
        return [[{ ID: 500, name: 'My mix', position: 0 }]];
    } }, 1, 500);
    assert.equal(entry.isPrivate, true);
});

const dimension = key => ({ key, name: key, options: [
    { key: 'any', name: 'Any', isDefault: true, isNeutral: true },
    { key: 'no', name: 'No', isDefault: false, isNeutral: false },
    { key: 'yes', name: 'Yes', isDefault: false, isNeutral: false }
] });
test('context dimensions remain independent when another dimension is neutral', () => {
    const dimensions = [dimension('a'), dimension('b'), dimension('c')];
    assert.equal(isContextDimensionUnlocked(dimensions, 0, {}), true);
    assert.equal(isContextDimensionUnlocked(dimensions, 1, { a: 'any' }), true);
    assert.equal(isContextDimensionUnlocked(dimensions, 1, { a: 'no' }), true);
    assert.equal(isContextDimensionUnlocked(dimensions, 2, { a: 'no', b: 'any' }), true);
    assert.deepEqual(canonicalizeContextValues({ a: 'any', b: 'yes' }, dimensions).contextValues,
        { a: 'any', b: 'yes', c: 'any' });
    assert.deepEqual(selectContextOption(dimensions, { a: 'any', b: 'any' }, 1, 'yes'), { a: 'any', b: 'yes' });
    assert.deepEqual(selectContextOption(dimensions, { a: 'yes', b: 'yes', c: 'yes' }, 0, 'any'), { a: 'any', b: 'yes', c: 'yes' });
    assert.throws(() => selectContextOption(dimensions, {}, 2, 'invalid'), /invalid_context_option/);
    assert.throws(() => selectContextOption(dimensions, {}, 3, 'yes'), /context_dimension_locked/);
    assert.deepEqual(canonicalizeContextValues({ a: 'no', b: 'yes', c: 'no' }, dimensions).contextValues, { a: 'no', b: 'yes', c: 'no' });
});
test('new taxonomy keeps identities while reparenting, and ordered templates match the requested tree', () => {
    const spec = JSON.parse(readFileSync(new URL('../ops/task-taxonomy-20261002.json', import.meta.url), 'utf8'));
    const byKey = new Map(spec.categories.map(node => [node.key, node]));
    const rows = spec.categories.filter(node => node.existingID).map(node => ({ ID: node.existingID,
        name: node.previousName ?? node.name, parent_ID: node.parent === null ? null : byKey.get(node.parent).existingID ?? 54,
        is_active: 1, position: node.position }));
    rows.push(...spec.retiredCategories.map(node => ({ ...node, parent_ID: 54, is_active: 1, position: 0 })));
    const plan = planCategories(rows, spec);
    assert.equal(plan.find(node => node.key === 'service').parent, 'work');
    assert.equal(plan.find(node => node.key === 'business').ID, 202);
    assert.equal(plan.find(node => node.key === 'driving').parent, 'execution');
    assert.equal(plan.find(node => node.key === 'support').parent, 'communication');
    assert.equal(plan.some(node => /counsel/i.test(node.name)), false);
    assert.deepEqual(desiredDimensions('image_understanding', spec).map(d => d.key), ['count', 'task']);
    assert.deepEqual(desiredDimensions('video_understanding', spec).at(1).options.map(o => o.key), ['any', 'accessibility']);
});
