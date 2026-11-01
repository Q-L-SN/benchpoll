import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTopicsByPopularity, TOPIC_ACTIVITY_JOIN } from '../topic-popularity.js';

const now = Date.parse('2026-10-22T10:00:00Z');
const old = Array.from({ length: 15 }, (_, index) => ({ ID: index + 100, popularity: 100 - index,
    created_at: '2025-01-01T00:00:00Z' }));
const fresh = (ID, creator = '42', extra = {}) => ({ ID, popularity: 1,
    created_by_user_ID: creator, created_at: new Date(now - 3600000).toISOString(), ...extra });

test('featured ID stays first regardless of name, heat or new-topic slots', () => {
    const rows = orderTopicsByPopularity([...old, { ID: 54, name: 'Renamed', popularity: 0 }, fresh(200)], { now });
    assert.equal(rows[0].ID, 54);
    assert.equal(rows[6].ID, 200);
    assert.deepEqual(rows.slice(1, 6).map(row => row.ID), old.slice(0, 5).map(row => row.ID));
});

test('exploration is at most one in six ordinary positions, not fabricated popularity', () => {
    const inputs = [...old, fresh(200), fresh(201, '43'), fresh(202, '44')];
    const rows = orderTopicsByPopularity(inputs, { now });
    assert.equal(rows[5].ID, 200);
    assert.equal(rows[11].ID, 201);
    assert.equal(inputs.find(row => row.ID === 200).popularity, 1);
    assert.equal(new Set(rows.map(row => row.ID)).size, inputs.length);
    assert.deepEqual(new Set(rows.map(row => row.ID)), new Set(inputs.map(row => row.ID)));
});

test('a new public topic with no saved pies can take an exploration slot', () => {
    const empty = fresh(200, '42', { popularity: 0 });
    const rows = orderTopicsByPopularity([...old, empty], { now });
    assert.equal(rows[5].ID, 200);
    assert.equal(empty.popularity, 0);
});

test('private, future-dated, old or ineligible-creator topics cannot take exploration slots', () => {
    for (const extra of [{ owner_user_ID: '42' }, { created_at: new Date(now + 1).toISOString() },
        { created_at: new Date(now - 8 * 86400000).toISOString() }, { creator_eligible: 0 }]) {
        const rows = orderTopicsByPopularity([...old, fresh(200, '42', extra)], { now });
        assert.equal(rows[5].ID, 105);
    }
});

test('one creator cannot occupy multiple exploration slots and small directories retain all topics', () => {
    const rows = orderTopicsByPopularity([...old, fresh(200), fresh(201)], { now });
    assert.equal(rows[5].ID, 200);
    assert.equal(rows[11].ID, 110);
    assert.equal(orderTopicsByPopularity([fresh(200), old[0]], { now }).length, 2);
});

test('heat counts distinct eligible contributors with nonempty direct-topic pies, not visits or repeats', () => {
    assert.match(TOPIC_ACTIVITY_JOIN, /COUNT\(DISTINCT pp\.user_ID\)/);
    assert.match(TOPIC_ACTIVITY_JOIN, /INTERVAL 14 DAY/);
    assert.match(TOPIC_ACTIVITY_JOIN, /contributor\.deleted_at IS NULL/);
    assert.match(TOPIC_ACTIVITY_JOIN, /EXISTS\(SELECT 1 FROM personal_pie_weights/);
    assert.doesNotMatch(TOPIC_ACTIVITY_JOIN, /parent_ID|RECURSIVE|discussion_posts|visits/);
});
