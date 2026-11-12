import test from 'node:test';
import assert from 'node:assert/strict';
import { isReservedTopicSlug, topicURL, parseTopicPath } from '../public/js/shared/topics.js';
import { normalizeTopicRequest, listTopics, assertPublicTopicAvailable } from '../topic-service.js';
import { normalizePrivateCategoryRequest } from '../private-category-service.js';
import { shortTopicSlugPlan } from '../scripts/migrate-topic-slugs-20261023.mjs';
import { normalizeHomeComparison, topicPreviewComparison } from '../topic-home-service.js';

test('public addresses use durable numbers and private addresses use random tokens', () => {
    assert.equal(topicURL({ publicID: 1, name: 'Intelligence' }), '/1');
    assert.equal(topicURL({ publicID: 1, name: 'Renamed' }), '/1');
    assert.equal(topicURL({ privateID: 'AbCdEf123456', isPrivate: true }), '/private/AbCdEf123456');
    for (const path of ['/intelligence', '/topics/54', '/personal/4']) assert.equal(parseTopicPath(path), null);
    assert.throws(() => topicURL({ ID: 1, name: 'No external identity' }));
});

test('numeric URLs allow names that coincide with application routes', () => {
    for (const name of ['Settings', 'API', 'Account', 'How it works']) {
        assert.equal(isReservedTopicSlug(name), true, 'Historical slug migrations still know old route reservations');
        assert.equal(normalizeTopicRequest({ name, description: 'Evaluate this topic.', isPrivate: false }).name, name);
        assert.equal(normalizePrivateCategoryRequest({ name, description: 'Evaluate this topic.' }).name, name);
    }
});

test('metadata distinguishes authored topics and configured weights without exposing account IDs', async () => {
    let args;
    const db = { execute: async (sql, values) => {
        if (sql.includes('LEFT JOIN topic_scenes')) return [values.slice(0, -1).map(ID => ({
            contextID: ID + 100, category_ID: ID, scene_context_ID: null, context_hash: values.at(-1)
        }))];
        args = values;
        return [[{ ID: 54, public_ID: 1, is_official: 1, name: 'Intelligence', slug: 'intelligence', is_active: 1, configured_context_ids: '[154]' },
            { ID: 2, public_ID: 2, name: 'My work', slug: 'my-work', is_active: 1, created_by_user_ID: '42', configured: 0 }]];
    } };
    const { topics } = await listTopics(db, '42');
    assert.deepEqual(args, ['42', '42', '42']);
    assert.deepEqual(topics.map(row => [row.ID, row.isMine, row.configured]), [[54, false, true], [2, true, false]]);
    assert.deepEqual(topics.map(row => row.rootContextID), [154, 102]);
    assert.equal(JSON.stringify(topics).includes('"42"'), false);
});

test('migration preserves valid addresses, deconflicts normalized names and moves reserved names', () => {
    const rows = [
        { ID: 2, name: 'Duplicate', slug: 'duplicate', is_active: 1 },
        { ID: 1, name: 'Duplicate', slug: 'duplicate', is_active: 0 },
        { ID: 54, name: 'Renamed flagship', slug: 'duplicate', is_active: 1 },
        { ID: 5, name: 'Settings', slug: 'settings', is_active: 1 },
        { ID: 6, name: 'Settings Benchmarks', slug: 'settings-benchmarks', is_active: 1 },
        { ID: 7, name: 'Private', slug: 'duplicate', owner_user_ID: '42', is_active: 1 }
    ];
    const plan = shortTopicSlugPlan(rows);
    assert.equal(plan.find(row => row.ID === 54).slug, 'duplicate');
    assert.equal(plan.find(row => row.ID === 2).slug, 'duplicate-2');
    assert.equal(plan.find(row => row.ID === 1).slug, 'duplicate-3');
    assert.equal(plan.find(row => row.ID === 5).slug, 'settings-benchmarks-2');
    assert.equal(plan.find(row => row.ID === 6).slug, 'settings-benchmarks');
    assert.equal(plan.find(row => row.ID === 7).slug, 'duplicate');
    const rerun = shortTopicSlugPlan(rows.map(row => ({ ...row, slug: plan.find(item => item.ID === row.ID).slug })));
    assert.ok(rerun.every(row => row.slug === row.before));
});

test('public creation checks current names but never queries removed legacy route tables', async () => {
    const queries = [];
    const available = { execute: async sql => { queries.push(sql); return [[]]; } };
    assert.equal(await assertPublicTopicAvailable(available, { name: 'Historic work' }), 'historic-work');
    assert.ok(queries.every(sql => !sql.includes('topic_legacy_routes')));
    await assert.rejects(assertPublicTopicAvailable({ execute: async () => [[{ ID: 2 }]] }, { name: 'Duplicate' }),
        error => error.body.error === 'topic_name_exists');
});

test('home model jumps use the same bounded quick-comparison selection as the preview', () => {
    for (const value of [null, [], true, { reasoning: '1' }, { harness: 1 }, { filters: [] }, { reasoning: null }]) {
        assert.throws(() => normalizeHomeComparison(value), error => error.body.error === 'invalid_topic_comparison');
    }
    assert.deepEqual(normalizeHomeComparison({ harness: true }), { reasoning: false, harness: true });
    assert.deepEqual(topicPreviewComparison([], normalizeHomeComparison({ reasoning: true, harness: true })),
        { mode: 'best', keys: ['model'], filters: [] });
});
