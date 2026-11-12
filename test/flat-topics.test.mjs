import { legacyTopicRouteKey } from '../scripts/historical-topic-route-key.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { FEATURED_TOPIC_ID, topicURL } from '../public/js/shared/topics.js';
import { normalizeTopicRequest, serializeTopic, getTopic, listTopics } from '../topic-service.js';
import { buildCategoryNavigation, buildPersonalNavigation } from '../navigation-service.js';
import { flatTopicsPlan } from '../scripts/migrate-flat-topics-20261022.mjs';

test('topic identity is numeric and independent of the old taxonomy name', () => {
    assert.equal(FEATURED_TOPIC_ID, 1);
    assert.equal(topicURL(54, 'Renamed General Intelligence'), '/54');
    assert.equal(topicURL('PrivateToken3', 'My mix', true), '/private/PrivateToken3');
    assert.throws(() => topicURL(-1, 'Invalid'));
});

test('topic requests accept explicit visibility and bounded plain text only', () => {
    assert.deepEqual(normalizeTopicRequest({ name: '  Medical coding  ', description: 'Clinical software', isPrivate: false }),
        { name: 'Medical coding', description: 'Clinical software', isPrivate: false });
    for (const body of [{ name: 'A' }, { name: 'A', isPrivate: 'false' }, { name: 'A\nB', isPrivate: false },
        { name: 'A'.repeat(129), isPrivate: false }, { name: 'A', isPrivate: false, parentID: 54 },
        { name: 'A', isPrivate: false, references: [] }, { name: 'A', isPrivate: false, importFrom: 54 }]) {
        assert.throws(() => normalizeTopicRequest(body));
    }
});

test('creator credits expose the public profile, never account IDs or an owner-only default', () => {
    const topic = serializeTopic({ ID: 55, public_ID: 55, name: 'Software', created_by_user_ID: '123', creator_public_id: 'writer',
        creator_name: 'A contributor', creator_avatar: 'data:image/png;base64,test', owner_user_ID: null });
    assert.equal(topic.creator.handle, 'writer');
    assert.equal(topic.creator.url, '/@writer');
    assert.equal(topic.isPrivate, false);
    assert.equal(JSON.stringify(topic).includes('123'), false);
    assert.equal(serializeTopic({ ID: 54, public_ID: 1, is_official: 1, name: 'Intelligence' }).creator, null);
});

test('topic reads filter private access in SQL and do not rely on creator ownership', async () => {
    const queries = [];
    const db = { execute: async (sql, args) => { queries.push({ sql, args }); return [[]]; } };
    await assert.rejects(getTopic(db, null, 56), error => error.status === 404);
    assert.match(queries[0].sql, /c\.owner_user_ID IS NULL OR c\.owner_user_ID = \?/);
    assert.deepEqual(queries[0].args, [null, null, 56, null]);
    assert.doesNotMatch(queries[0].sql, /created_by_user_ID = \?/);
    assert.deepEqual(await listTopics(db, '42'), { topics: [], featuredTopicID: null });
    assert.match(queries[1].sql, /topic_favorites/);
});

test('navigation is flat, including topics that previously had inactive or missing ancestors', () => {
    const items = buildCategoryNavigation([
        { ID: 2, public_ID: 2, name: 'Software', is_active: 1, position: 0, parent_ID: 999 },
        { ID: 54, public_ID: 54, name: 'Renamed flagship', is_active: 1, position: 99, parent_ID: null },
        { ID: 3, name: 'Private', is_active: 1, owner_user_ID: '123' }
    ]);
    assert.deepEqual(items.map(item => item.categoryID), [2, 54]);
    assert.ok(items.every(item => item.lineage.length === 1));
    const personal = buildPersonalNavigation([{ contextID: 1, categoryID: 2, contextValues: {},
        weightCount: 1, totalBasisPoints: 10000, unavailableConditions: 0 }],
    [{ ID: 2, public_ID: 2, name: 'Software', is_active: 1, parent_ID: 999 }], [], []);
    assert.equal(personal[0].available, true);
    assert.equal(personal[0].lineage.length, 1);
});

test('Popular uses favorites without featured pinning, while empty private pies stay unconfigured', () => {
    const items = buildCategoryNavigation([
        { ID: 2, public_ID: 2, name: 'Software', is_active: 1, favorite_count: 100 },
        { ID: 54, public_ID: 54, name: 'Renamed flagship', is_active: 1, favorite_count: 0 },
        { ID: 3, public_ID: 3, name: 'Writing', is_active: 1, favorite_count: 30 }
    ]);
    assert.deepEqual(items.map(item => item.categoryID), [2, 3, 54]);
    assert.equal(items[0].favoriteCount, 100);
    assert.deepEqual(buildPersonalNavigation([{ categoryID: 4, contextValues: {}, weightCount: 0 }],
        [{ ID: 4, name: 'Empty private', is_active: 1, owner_user_ID: '123' }], [], []), []);
});

test('migration materializes previous leaf context inheritance without copying weights', () => {
    const categories = [{ ID: 54, parent_ID: null, name: 'Intelligence', is_active: 1 },
        { ID: 167, parent_ID: 54, name: 'Research', is_active: 1 },
        { ID: 168, parent_ID: 167, name: 'Math', is_active: 1 },
        { ID: 172, parent_ID: 54, name: 'Image', is_active: 1 },
        { ID: 211, parent_ID: 54, name: 'Image', is_active: 0 }];
    const dimensions = [{ ID: 1, scope_category_ID: 0, dimension_key: 'language', name: 'Language', is_active: 1 },
        { ID: 2, scope_category_ID: 168, dimension_key: 'language', name: 'Local language', is_active: 1 }];
    const plan = flatTopicsPlan(categories, dimensions, [{ dimension_ID: 2, option_key: 'any' }]);
    assert.equal(plan.find(topic => topic.ID === 168).dimensions[0].ID, 2);
    assert.equal(plan.find(topic => topic.ID === 172).dimensions[0].ID, 1);
    assert.deepEqual(plan.find(topic => topic.ID === 54).dimensions, []);
    assert.equal(plan.find(topic => topic.ID === 172).name, 'Image Generation');
    assert.equal(plan.find(topic => topic.ID === 168).alias, 'intelligence/research/math');
    assert.equal(plan.some(topic => 'weights' in topic || 'references' in topic), false);
    assert.equal(legacyTopicRouteKey('/Intelligence/Office-%26-Data'), 'intelligence/office & data');
});

test('runtime ranking queries never walk ancestors or descendants, and Public composition is retired', async () => {
    const source = await readFile(new URL('../ranking-service.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /WITH RECURSIVE|parent_ID|name = 'Intelligence'|composition: publicPie\.composition/);
    assert.match(source, /WHERE rc\.category_ID = \?/);
    assert.match(source, /const scopedIDs = \[Number\(category\.ID \?\? category\.lineage\.at\(-1\)\.ID\)\]/);
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    assert.match(server, /page\.get\('\/', async \(_req, res\) => \{\s*const topics = await searchPresentation\.topics\(\);\s*await renderIndex\(res,/);
    assert.match(server, /topic_hierarchy_removed/);
});

test('migration preserves effective dimension order even when a retained local ID sorts before a new inherited copy', () => {
    const categories = [{ ID: 54, parent_ID: null, name: 'Intelligence', is_active: 1 },
        { ID: 80, parent_ID: 54, name: 'Software', is_active: 1 }];
    const dimensions = [
        { ID: 1, scope_category_ID: 54, dimension_key: 'language', position: 0, is_active: 1 },
        { ID: 2, scope_category_ID: 80, dimension_key: 'framework', position: 0, is_active: 1 }
    ];
    const planned = flatTopicsPlan(categories, dimensions, []).find(topic => topic.ID === 80).dimensions;
    assert.deepEqual(planned.map(dimension => [dimension.dimension_key, dimension.position]), [['language', 0], ['framework', 10]]);
});
