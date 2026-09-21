import 'dotenv/config';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { deleteDiscussionPost } from '../discussion-service.js';

const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST,
    port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER,
    password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: process.env.BENCHPOLL_DB_NAME || 'benchmarks' });
try {
    // Connection-local copies shadow production tables; no production messages are written.
    await connection.query(`CREATE TEMPORARY TABLE discussion_posts (ID BIGINT PRIMARY KEY,
        category_ID BIGINT, context_ID BIGINT, author_ID BIGINT, parent_ID BIGINT,
        body TEXT NOT NULL, deleted_at DATETIME(3) NULL) ENGINE=InnoDB`);
    await connection.query('CREATE TEMPORARY TABLE discussion_mentions (post_ID BIGINT, label VARCHAR(600)) ENGINE=InnoDB');
    await connection.query('CREATE TEMPORARY TABLE discussion_votes (post_ID BIGINT, user_ID BIGINT, value TINYINT) ENGINE=InnoDB');
    await connection.execute("INSERT INTO discussion_posts (ID, category_ID, context_ID, author_ID, body) VALUES (1, 1, 1, 10, 'Own message')");
    await connection.execute("INSERT INTO discussion_posts (ID, category_ID, context_ID, author_ID, parent_ID, body) VALUES (2, 1, 1, 20, 1, 'Other author reply')");
    await connection.execute("INSERT INTO discussion_mentions (post_ID, label) VALUES (1, 'Mention')");
    await connection.execute('INSERT INTO discussion_votes (post_ID, user_ID, value) VALUES (1, 20, 1)');
    const db = { getConnection: async () => ({
        execute: (...args) => connection.execute(...args),
        beginTransaction: () => connection.beginTransaction(), commit: () => connection.commit(),
        rollback: () => connection.rollback(), release: () => {}
    }) };
    await assert.rejects(deleteDiscussionPost(db, 20, { postID: 1 }), error => error.status === 403);
    await deleteDiscussionPost(db, 10, { postID: 1 });
    await deleteDiscussionPost(db, 10, { postID: 1 });
    const [rows] = await connection.execute('SELECT ID, body, deleted_at FROM discussion_posts ORDER BY ID');
    assert.equal(rows.length, 2);
    assert.equal(rows[0].body, ''); assert.ok(rows[0].deleted_at);
    assert.equal(rows[1].body, 'Other author reply'); assert.equal(rows[1].deleted_at, null);
    for (const name of ['discussion_mentions', 'discussion_votes']) {
        const [remaining] = await connection.query(`SELECT COUNT(*) AS n FROM ${name}`);
        assert.equal(Number(remaining[0].n), 0);
    }
    console.log('Real MySQL: ownership, idempotency, reply retention, mention/vote removal passed on temporary tables.');
} finally { await connection.end(); }
