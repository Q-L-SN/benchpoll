import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { RESERVED_TOPIC_SLUGS, isReservedTopicSlug, topicURL } from '../public/js/shared/topics.js';
import { normalizeTopicRequest, findTopicBySlug, serializeTopic, listTopics, assertPublicTopicAvailable } from '../topic-service.js';
import { normalizePrivateCategoryRequest } from '../private-category-service.js';
import { shortTopicSlugPlan } from '../scripts/migrate-topic-slugs-20261023.mjs';
import { normalizeHomeComparison, topicPreviewComparison } from '../topic-home-service.js';

test('public addresses must match the normalized name and private addresses remain ID-based', () => {
    assert.equal(topicURL(54, 'Intelligence'), '/intelligence');
    assert.throws(() => topicURL(20, 'Duplicate', false, 'duplicate-2'), /must match/);
    assert.throws(() => serializeTopic({ ID: 20, name: 'Duplicate', slug: 'duplicate-2' }), /must match/);
    assert.equal(topicURL(199, 'Security'), '/security');
    assert.equal(topicURL(189, 'Media'), '/media');
    assert.throws(() => topicURL(199, 'Security', false, 'security-benchmarks'), /must match/);
    for (const slug of ['../settings', 'topics/4', '', 'UPPER', '-x', 'a'.repeat(81)]) {
        assert.throws(() => topicURL(3, 'A', false, slug));
    }
    assert.equal(topicURL(4, 'Private'), '/private');
    assert.equal(topicURL(4, 'Private', true), '/personal/4');
});

test('reserved routes cover official pages, assets and future account/product routes', async () => {
    assert.ok(RESERVED_TOPIC_SLUGS.length > 180);
    for (const name of ['Settings', '  ACCOUNT ', 'GitHub_login', 'How it works', 'AdminLogin',
        'Privacy', 'API', 'Community guidelines', 'Support', 'Search', 'Workspace', 'Topic', 'Uploads',
        'HowItWorks', 'GitHubCallback', 'ResetPassword']) {
        assert.equal(isReservedTopicSlug(name), true, name);
        assert.throws(() => normalizeTopicRequest({ name, isPrivate: false }), error => error.body.error === 'reserved_topic_name');
        assert.throws(() => normalizePrivateCategoryRequest({ name }), error => error.body.error === 'reserved_topic_name');
    }
    for (const name of ['Security', 'Media', 'Intelligence', 'Medical diagnosis', 'My settings benchmark', 'Image Generation']) {
        assert.equal(isReservedTopicSlug(name), false);
    }
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    for (const match of server.matchAll(/page\.get\('\/([a-zA-Z_-]+)(?:\/|'|\[)/g)) {
        assert.equal(isReservedTopicSlug(match[1]), true, 'Official route: ' + match[1]);
    }
});

test('slug resolution exposes only an active public topic and rejects reserved routes without querying', async () => {
    const queries = [];
    const db = { execute: async (sql, args) => {
        queries.push({ sql, args });
        if (sql.includes('LEFT JOIN topic_scenes')) {
            assert.equal(args[0], 54);
            return [[{ contextID: 154, category_ID: 54, scene_context_ID: null, context_hash: args.at(-1) }]];
        }
        return [[{ ID: 54, name: 'Intelligence', slug: 'intelligence' }]];
    } };
    const topic = await findTopicBySlug(db, 'intelligence');
    assert.equal(topic.ID, 54);
    assert.equal(topic.rootContextID, 154);
    assert.deepEqual(topic.scenes, []);
    assert.match(queries[0].sql, /c\.slug = \? AND c\.owner_user_ID IS NULL AND c\.is_active = 1/);
    assert.deepEqual(queries[0].args, ['intelligence']);
    for (const slug of ['settings', '../intelligence', 'A', '', 'intelligence/other', 54]) assert.equal(await findTopicBySlug(db, slug), null);
    assert.equal(queries.length, 2);
});

test('metadata distinguishes authored topics and configured weights without exposing account IDs', async () => {
    let args;
    const db = { execute: async (sql, values) => {
        if (sql.includes('LEFT JOIN topic_scenes')) return [values.slice(0, -1).map(ID => ({
            contextID: ID + 100, category_ID: ID, scene_context_ID: null, context_hash: values.at(-1)
        }))];
        args = values;
        return [[{ ID: 54, name: 'Intelligence', slug: 'intelligence', is_active: 1, configured: 1 },
            { ID: 2, name: 'My work', slug: 'my-work', is_active: 1, created_by_user_ID: '42', configured: 0 }]];
    } };
    const { topics } = await listTopics(db, '42');
    assert.deepEqual(args, ['42', '42', 54]);
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

test('public creation cannot steal a retained legacy address and duplicate slugs return a clear conflict', async () => {
    for (const duplicate of ['legacy', 'index']) {
        const connection = {
            async execute(sql) {
                if (sql.includes('FROM categories')) return [duplicate === 'index' ? [{ ID: 2 }] : []];
                if (sql.includes('topic_legacy_routes')) return [duplicate === 'legacy' ? [{ category_ID: 2 }] : []];
                return [{}];
            },
            beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {}
        };
        await assert.rejects(assertPublicTopicAvailable(connection, { name: 'Historic work' }),
            error => error.status === 409 && error.body.error === 'topic_name_exists');
    }
});

test('home model jumps use the same bounded quick-comparison selection as the preview', () => {
    for (const value of [null, [], true, { reasoning: '1' }, { harness: 1 }, { filters: [] }, { reasoning: null }]) {
        assert.throws(() => normalizeHomeComparison(value), error => error.body.error === 'invalid_topic_comparison');
    }
    assert.deepEqual(normalizeHomeComparison({ harness: true }), { reasoning: false, harness: true });
    assert.deepEqual(topicPreviewComparison([], normalizeHomeComparison({ reasoning: true, harness: true })),
        { mode: 'best', keys: ['model'], filters: [] });
});
