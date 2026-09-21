import 'dotenv/config';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { createDiscussionPost, listDiscussion, voteDiscussion, applyDiscussionReport, discussionSummary } from '../discussion-service.js';

const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
// All fixtures remain uncommitted on one connection and are rolled back, including on failure.
const facade = { execute: (...args) => connection.execute(...args), beginTransaction: async () => {},
    commit: async () => {}, rollback: async () => {}, release: () => {} };
const db = { ...facade, getConnection: async () => facade };
try {
    await connection.beginTransaction();
    const [[user]] = await connection.execute('SELECT ID FROM users WHERE deleted_at IS NULL AND banned_at IS NULL ORDER BY ID LIMIT 1');
    const [[category]] = await connection.execute('SELECT ID FROM categories WHERE parent_ID IS NULL AND is_active = 1');
    const [[benchmark]] = await connection.execute('SELECT c.ID, c.benchmark_ID FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID WHERE c.is_active = 1 AND b.is_active = 1 LIMIT 1');
    assert.ok(user && category && benchmark, 'Existing active fixtures required');
    const categoryID = Number(category.ID), userID = Number(user.ID);
    const before = await listDiscussion(db, null, { categoryID });
    const created = await createDiscussionPost(db, userID, { categoryID, contextValues: {}, text: 'Rollback-only discussion integration check', mentions: [] });
    await assert.rejects(createDiscussionPost(db, userID, { categoryID, contextValues: {}, text: 'Cooldown check', mentions: [] }), error => error.body?.error === 'discussion_post_cooldown');
    await connection.execute('UPDATE discussion_posts SET created_at = DATE_SUB(NOW(), INTERVAL 1 MINUTE) WHERE ID = ?', [created.ID]);
    const reply = await createDiscussionPost(db, userID, { categoryID, parentID: created.ID,
        text: 'Rollback-only reply', mentions: [{ benchmarkID: Number(benchmark.benchmark_ID), conditionID: Number(benchmark.ID) }] });
    const threads = await listDiscussion(db, userID, { categoryID, benchmarkID: Number(benchmark.benchmark_ID), sort: 'new' });
    assert.ok(threads.posts.some(post => post.ID === created.ID && post.replyCount === 1));
    const replies = await listDiscussion(db, userID, { threadID: reply.ID });
    assert.equal(replies.root.ID, created.ID);
    assert.equal(replies.posts[0].mentions[0].benchmarkID, Number(benchmark.benchmark_ID));
    await assert.rejects(voteDiscussion(db, userID, { postID: created.ID, value: 1 }), error => error.body?.error === 'discussion_self_vote');
    await applyDiscussionReport(facade, { postID: created.ID });
    await assert.rejects(listDiscussion(db, null, { threadID: reply.ID }), error => error.body?.error === 'discussion_post_unavailable');
    assert.equal((await listDiscussion(db, null, { categoryID })).total, before.total);
    assert.equal((await discussionSummary(db, { categoryID })).count, before.total);
    console.log('PASS: live MySQL post, cooldown, reply, reference, filter, self-vote and moderation visibility (rolled back)');
} finally { await connection.rollback(); await connection.end(); }
