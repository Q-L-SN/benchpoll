import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeTopicSummary, TOPIC_SUMMARY_MAX_LENGTH } from '../public/js/shared/topics.js';
import { normalizeTopicRequest, serializeTopic } from '../topic-service.js';
import { normalizePrivateCategoryRequest } from '../private-category-service.js';
import { buildCategoryNavigation, buildPersonalNavigation } from '../navigation-service.js';
import { entryFromContext, configuredRows } from '../public/js/navigation/model.js';
import { topicSummaryPlan, OFFICIAL_TOPIC_SUMMARIES } from '../scripts/migrate-topic-summaries-20261026.mjs';

test('a one-sentence summary is required and bounded in public and private topic requests', () => {
    assert.equal(TOPIC_SUMMARY_MAX_LENGTH, 180);
    assert.equal(normalizeTopicSummary('  Clinical tasks. '), 'Clinical tasks.');
    assert.equal(normalizeTopicSummary('\u{1f4a1}'.repeat(180)), '\u{1f4a1}'.repeat(180));
    for (const description of [undefined, null, '', '  ', 8, 'a'.repeat(181), 'First\nSecond', 'x\u200by', 'x\u2028y']) {
        assert.throws(() => normalizeTopicRequest({ name: 'Clinical coding', description, isPrivate: false }), e => e.body.error === 'invalid_topic_description');
        assert.throws(() => normalizePrivateCategoryRequest({ name: 'Clinical coding', description }), e => e.body.error === 'invalid_topic_description');
    }
    assert.deepEqual(normalizePrivateCategoryRequest({ name: 'Private coding', description: 'My coding tasks.' }), { name: 'Private coding', description: 'My coding tasks.' });
});

test('backfill covers all official topics while keeping private and authored summaries intact', () => {
    assert.equal(Object.keys(OFFICIAL_TOPIC_SUMMARIES).length, 30);
    assert.ok(Object.values(OFFICIAL_TOPIC_SUMMARIES).every(value => normalizeTopicSummary(value) === value));
    const rows = [
        { ID: 54, name: 'Intelligence', description: null, is_active: 1 },
        { ID: 55, name: 'Old topic', description: '', is_active: 0 },
        { ID: 2000, name: 'Personal', description: 'My own concise scope.', owner_user_ID: '42', is_active: 1 },
        { ID: 2001, name: 'Custom', description: ' A custom sentence. ', created_by_user_ID: '42', is_active: 1 }
    ];
    const plan = topicSummaryPlan(rows);
    assert.equal(plan[0].description, OFFICIAL_TOPIC_SUMMARIES[54]);
    assert.equal(plan[1].description, 'Archived benchmarks for Old topic.');
    assert.equal(plan[2].description, rows[2].description); assert.equal(plan[3].description, rows[3].description);
    assert.deepEqual(topicSummaryPlan(plan.map((row, i) => ({ ...rows[i], description: row.description }))).map(row => row.description), plan.map(row => row.description));
    assert.throws(() => topicSummaryPlan([{ ...rows[0], description: 'x'.repeat(181) }]), /Review the existing/);
    assert.throws(() => topicSummaryPlan([{ ...rows[0], description: 42 }]), /Invalid summary/);
});

test('directory, configured locations and current-context identities share summaries without ordinary public creator credits', () => {
    const row = { ID: 54, name: 'Intelligence', description: 'Useful reasoning.', is_active: 1, owner_user_ID: null,
        creator_name: 'BenchPoll', creator_avatar: '/assets/benchpoll-mark.svg' };
    const topic = serializeTopic(row), publicEntry = buildCategoryNavigation([row])[0];
    const personalEntry = buildPersonalNavigation([{ contextID: 1, categoryID: 54, contextValues: {}, weightCount: 1,
        totalBasisPoints: 10000, unavailableConditions: 0 }], [row], [], [])[0];
    assert.equal(topic.creator, null);
    for (const entry of [topic, publicEntry, personalEntry, entryFromContext(topic)]) {
        assert.equal(entry.description, row.description); assert.deepEqual(entry.creator, topic.creator);
        assert.equal('created_by_user_ID' in entry, false);
    }
    assert.equal(configuredRows([personalEntry], null, 'useful reasoning')[0].categoryID, 54);
});
