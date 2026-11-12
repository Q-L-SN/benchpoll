import test from 'node:test';
import assert from 'node:assert/strict';
import { orderTopicsByPopularity, topicPopularity, TOPIC_ACTIVITY_JOIN } from '../topic-popularity.js';

const row = (ID, total, recent = 0) => ({ ID, public_ID: ID, favorite_count: total, recent_favorite_count: recent });

test('Popular incorporates recent first-time favorites and durable total support', () => {
    const rows = [row(1, 1000), row(2, 30, 25), row(3, 5, 5), row(4, 0)];
    assert.deepEqual(orderTopicsByPopularity(rows).map(item => item.ID), [2, 1, 3, 4]);
    assert.ok(topicPopularity(row(1, 100)) > topicPopularity(row(2, 50)));
    assert.ok(topicPopularity(row(1, 100, 10)) > topicPopularity(row(2, 100, 2)));
});

test('ties use durable public identity independent of name, featured topic or input order', () => {
    const rows = [row(54, 0), row(3, 1), row(1, 0), row(2, 1)];
    assert.deepEqual(orderTopicsByPopularity(rows).map(item => item.ID), [2, 3, 1, 54]);
    assert.deepEqual(orderTopicsByPopularity([...rows].reverse()).map(item => item.ID), [2, 3, 1, 54]);
    assert.deepEqual(rows.map(item => item.ID), [54, 3, 1, 2]);
});

test('malformed counts are bounded and recent favorites cannot exceed total', () => {
    for (const value of [-2, NaN, Infinity, 'nope', null]) assert.equal(topicPopularity(row(1, value, value)), 0);
    assert.equal(topicPopularity(row(1, 5, 9999)), topicPopularity(row(1, 5, 5)));
    assert.equal(topicPopularity({ favoriteCount: 5, recentFavoriteCount: 2 }), topicPopularity(row(1, 5, 2)));
    assert.ok(Number.isFinite(topicPopularity(row(1, Number.MAX_VALUE, Number.MAX_VALUE))));
});

test('recent counts exclude future activity and ineligible accounts; toggles do not refresh age', () => {
    assert.match(TOPIC_ACTIVITY_JOIN, /topic_favorites f/);
    assert.match(TOPIC_ACTIVITY_JOIN, /first_favorited_at >= NOW\(\) - INTERVAL 14 DAY/);
    assert.match(TOPIC_ACTIVITY_JOIN, /first_favorited_at <= NOW\(\)/);
    assert.match(TOPIC_ACTIVITY_JOIN, /f\.is_active = 1/);
    assert.match(TOPIC_ACTIVITY_JOIN, /contributor\.deleted_at IS NULL/);
    assert.doesNotMatch(TOPIC_ACTIVITY_JOIN, /updated_at|personal_pies|visits/);
});
