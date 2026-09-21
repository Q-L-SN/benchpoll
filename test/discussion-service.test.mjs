import test from 'node:test';
import assert from 'node:assert/strict';
import { discussionID, normalizeDiscussionPost, normalizeDiscussionReport, discussionHotScore,
    createDiscussionPost, deleteDiscussionPost, voteDiscussion, applyDiscussionReport, discussionSummary } from '../discussion-service.js';

const isError = code => error => error.body?.error === code;

test('discussion summary only counts visible category threads without loading a preview', async () => {
    const calls = [];
    const db = { execute: async (sql, args) => { calls.push({ sql, args }); return [[{ count: '3' }]]; } };
    assert.deepEqual(await discussionSummary(db, { categoryID: 7 }), { count: 3 });
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, [7]);
    assert.match(calls[0].sql, /p.category_ID = \? AND p.parent_ID IS NULL/);
    assert.match(calls[0].sql, /hidden_at IS NULL/);
    assert.doesNotMatch(calls[0].sql, /ORDER BY|p.body/);
});
test('discussion IDs reject coercion and unsafe IDs', () => {
    for (const value of [null, true, false, [], [1], {}, -1, 0, 1.2, '1e1', Number.MAX_SAFE_INTEGER + 1]) {
        assert.throws(() => discussionID(value), isError('invalid_discussion_id'));
    }
    assert.equal(discussionID('12'), 12);
});
test('discussion posts use explicit ID references and enforce bounded content', () => {
    assert.deepEqual(normalizeDiscussionPost({ text: '  Evidence matters  ', mentions: [{ benchmarkID: 5, conditionID: 6 }] }), {
        text: 'Evidence matters', parentID: null, mentions: [{ benchmarkID: 5, conditionID: 6 }]
    });
    assert.throws(() => normalizeDiscussionPost({ text: 'x', mentions: [] }), isError('discussion_text_length'));
    assert.throws(() => normalizeDiscussionPost({ text: 'x'.repeat(4001), mentions: [] }), isError('discussion_text_length'));
    assert.throws(() => normalizeDiscussionPost({ text: 'hello', mentions: [{ benchmarkID: 1 }, { benchmarkID: 1 }] }), isError('duplicate_discussion_mention'));
    assert.throws(() => normalizeDiscussionPost({ text: 'hello', mentions: Array(11).fill({ benchmarkID: 1 }) }), isError('invalid_discussion_mentions'));
});
test('hot ranking decays with age and does not reward downvote controversy', () => {
    assert.ok(discussionHotScore(10, 1, 2) > discussionHotScore(10, 1, 20));
    assert.equal(discussionHotScore(100, 100, 0), discussionHotScore(0, 0, 0));
    assert.equal(discussionHotScore(0, 10, 0), discussionHotScore(0, 0, 0));
    assert.ok(discussionHotScore(0, 0, 0) > discussionHotScore(100, 0, 24 * 30));
    assert.ok(discussionHotScore(5, 0, 2) > discussionHotScore(10, 8, 2));
});
test('report contract requires an existing-target ID, reason and substantial private notes', () => {
    const report = { type: 'discussion_report', postID: 5, reason: 'spam', details: 'This is repeated advertising.' };
    assert.equal(normalizeDiscussionReport(report).pageURL, '/?discussion=1&threadID=5');
    assert.throws(() => normalizeDiscussionReport({ ...report, reason: 'hide everything' }), isError('report_reason_required'));
    assert.throws(() => normalizeDiscussionReport({ ...report, details: '' }), isError('report_details_required'));
    assert.throws(() => normalizeDiscussionReport({ ...report, autoApprove: true }), isError('unknown_report_field'));
});
function fakeDB(execute) {
    const calls = [];
    const connection = { execute, beginTransaction: async () => calls.push('begin'), commit: async () => calls.push('commit'),
        rollback: async () => calls.push('rollback'), release: () => calls.push('release') };
    return { db: { getConnection: async () => connection }, calls };
}

test('only the author can delete a message; deletion is idempotent and keeps replies', async () => {
    for (const deleted of [false, true]) {
        const writes = [];
        const { db, calls } = fakeDB(async (sql, args) => {
            if (sql.startsWith('SELECT')) return [[{ ID: 7, author_ID: 2, deleted_at: deleted ? new Date() : null }]];
            writes.push({ sql, args }); return [{ affectedRows: 1 }];
        });
        await assert.rejects(deleteDiscussionPost(db, 3, { postID: 7 }), isError('discussion_delete_forbidden'));
        assert.equal(writes.length, 0);
        assert.deepEqual(await deleteDiscussionPost(db, 2, { postID: 7 }), { postID: 7, deleted: true });
        assert.equal(writes.length, deleted ? 0 : 3);
        assert.ok(writes.every(call => call.args.length === 1 && call.args[0] === 7));
        assert.ok(writes.every(call => !/DELETE FROM discussion_posts|parent_ID/.test(call.sql)));
        if (!deleted) assert.match(writes[0].sql, /body = '', deleted_at = NOW/);
        assert.equal(calls.at(-2), 'commit');
    }
});

test('deletion rejects missing posts and unexpected fields', async () => {
    const { db, calls } = fakeDB(async () => [[]]);
    await assert.rejects(deleteDiscussionPost(db, 2, { postID: 99 }), isError('discussion_post_unavailable'));
    await assert.rejects(deleteDiscussionPost(db, 2, { postID: 99, authorID: 2 }), isError('unknown_discussion_field'));
    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});
test('post cooldown locks the user first and rolls back without inserting', async () => {
    const { db, calls } = fakeDB(async sql => {
        if (sql.startsWith('SELECT ID FROM users') && sql.endsWith('FOR UPDATE')) return [[{ ID: 1 }]];
        if (sql.includes('INTERVAL 30 SECOND')) return [[{ ID: 2 }]];
        throw new Error(`Unexpected SQL: ${sql}`);
    });
    await assert.rejects(createDiscussionPost(db, 1, { text: 'My view', mentions: [], categoryID: 1 }), isError('discussion_post_cooldown'));
    assert.deepEqual(calls, ['begin', 'rollback', 'release']);
});
test('votes are set rather than incremented and neutral removes the single vote', async () => {
    for (const value of [-1, 0, 1]) {
        const writes = [];
        const { db, calls } = fakeDB(async (sql, args) => {
            if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: 1 }]];
            if (sql.includes('SELECT p.ID')) return [[{ ID: 2, author_ID: 3 }]];
            if (sql.startsWith('DELETE') || sql.includes('ON DUPLICATE KEY')) { writes.push({ sql, args }); return [{}]; }
            throw new Error(`Unexpected SQL: ${sql}`);
        });
        await voteDiscussion(db, 1, { postID: 2, value });
        assert.equal(writes.length, 1);
        assert.match(writes[0].sql, value === 0 ? /^DELETE/ : /value = VALUES\(value\)/);
        assert.deepEqual(calls, ['begin', 'commit', 'release']);
    }
});
test('invalid and self votes cannot mutate vote rows', async () => {
    const { db } = fakeDB(async sql => {
        if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: 1 }]];
        if (sql.includes('SELECT p.ID')) return [[{ ID: 2, author_ID: 1 }]];
        throw new Error('Unexpected write');
    });
    await assert.rejects(voteDiscussion(db, 1, { postID: 2, value: '1' }), isError('invalid_discussion_vote'));
    await assert.rejects(voteDiscussion(db, 1, { postID: 2, value: 1 }), isError('discussion_self_vote'));
});
test('report approval reads the complete target into the audit recorder before hiding it', async () => {
    const calls = [];
    await applyDiscussionReport({ execute: async (sql, args) => {
        calls.push({ sql, args });
        if (sql.startsWith('SELECT *')) return [[{ ID: 7, body: 'Reported content' }]];
        return [{ affectedRows: 1 }];
    } }, { postID: 7 });
    assert.match(calls[0].sql, /FOR UPDATE$/);
    assert.match(calls[1].sql, /hidden_at = COALESCE\(hidden_at, NOW\(\)\)/);
    assert.deepEqual(calls[1].args, [7]);
});
