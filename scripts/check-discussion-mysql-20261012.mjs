import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

const root = process.argv[2] ?? '/home/ubuntu/benchpoll';
const require = createRequire('/home/ubuntu/benchpoll/package.json');
const mysql = require('mysql2/promise');
const admin = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
const schema = `benchpoll_discussion_check_20261012_${process.pid}`;
let created = false, pool;
const contextHash = createHash('sha256').update('{}').digest('hex');
try {
    await admin.query(`CREATE DATABASE ${schema}`); created = true;
    for (const table of ['ranking_contexts', 'discussion_posts', 'discussion_mentions']) {
        await admin.query(`CREATE TABLE ${schema}.${table} LIKE benchmarks.${table}`);
    }
    await admin.query(`CREATE TABLE ${schema}.users (ID BIGINT PRIMARY KEY, deleted_at DATETIME NULL, banned_at DATETIME NULL, banned_until DATETIME NULL)`);
    await admin.query(`INSERT INTO ${schema}.users (ID) VALUES (1),(2),(3),(4),(5)`);
    await admin.query(`CREATE TABLE ${schema}.categories (ID INT PRIMARY KEY, parent_ID INT NULL, name VARCHAR(100), position INT, owner_user_ID BIGINT NULL, is_active TINYINT)`);
    await admin.query(`INSERT INTO ${schema}.categories VALUES (1,NULL,'Existing',0,NULL,1),(2,1,'Child',0,NULL,1),
        (3,NULL,'New',1,NULL,1),(4,3,'Child',0,NULL,1),(5,NULL,'Concurrent',2,NULL,1),(6,5,'Child',0,NULL,1)`);
    await admin.query(`CREATE TABLE ${schema}.benchmarks (ID INT PRIMARY KEY, name VARCHAR(100), is_active TINYINT)`);
    await admin.query(`INSERT INTO ${schema}.benchmarks VALUES (1,'A benchmark',1)`);
    await admin.query(`CREATE TABLE ${schema}.benchmark_conditions (ID INT PRIMARY KEY, benchmark_ID INT, name VARCHAR(100), deleted_at DATETIME NULL)`);
    await admin.query(`INSERT INTO ${schema}.benchmark_conditions VALUES (1,1,'Overall',NULL)`);
    await admin.query(`CREATE TABLE ${schema}.revisions (ID INT PRIMARY KEY, revision INT)`);
    await admin.query(`INSERT INTO ${schema}.revisions VALUES (2,0)`);
    await admin.query(`CREATE TRIGGER ${schema}.contexts_update AFTER UPDATE ON ${schema}.ranking_contexts FOR EACH ROW
        UPDATE ${schema}.revisions SET revision = revision + 1 WHERE ID = 2`);
    await admin.execute(`INSERT INTO ${schema}.ranking_contexts (category_ID,context_values,context_hash) VALUES (1,'{}',?)`, [contextHash]);
    pool = mysql.createPool({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: schema, connectionLimit: 4 });
    const { createDiscussionPost } = await import(pathToFileURL(`${root}/discussion-service.js`));
    const message = (categoryID, extra = {}) => ({ categoryID, contextValues: {}, text: 'Isolated integration check',
        mentions: [{ benchmarkID: 1, conditionID: 1 }], ...extra });
    const existing = await createDiscussionPost(pool, 1, message(1));
    const fresh = await createDiscussionPost(pool, 2, message(3));
    const reused = await createDiscussionPost(pool, 3, message(3));
    const reply = await createDiscussionPost(pool, 4, message(1, { parentID: existing.ID }));
    assert.equal(reply.threadID, existing.ID);
    let injectedRace = false;
    const racingPool = { async getConnection() {
        const connection = await pool.getConnection();
        return new Proxy(connection, { get(target, property) {
            if (property === 'execute') return async (sql, args) => {
                const result = await target.execute(sql, args);
                if (!injectedRace && /SELECT ID\s+FROM ranking_contexts/.test(sql) && !result[0].length) {
                    injectedRace = true;
                    await pool.execute("INSERT INTO ranking_contexts (category_ID,context_values,context_hash) VALUES (5,'{}',?)", [contextHash]);
                }
                return result;
            };
            const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
        } });
    } };
    const concurrent = await createDiscussionPost(racingPool, 5, message(5));
    assert.equal(injectedRace, true);
    const [[counts]] = await pool.query('SELECT COUNT(*) AS posts, COUNT(DISTINCT context_ID) AS contexts FROM discussion_posts');
    assert.equal(counts.posts, 5); assert.equal(counts.contexts, 3);
    const [[mentions]] = await pool.query('SELECT COUNT(*) AS count FROM discussion_mentions'); assert.equal(mentions.count, 5);
    console.log(JSON.stringify({ passed: true, cases: ['existing context', 'new context', 'reused context', 'reply', 'concurrent context with trigger'],
        posts: counts.posts, mentions: mentions.count, IDs: [existing.ID, fresh.ID, reused.ID, reply.ID, concurrent.ID], productionBusinessWrites: 0 }));
} finally {
    if (pool) await pool.end();
    if (created) await admin.query(`DROP DATABASE ${schema}`);
    await admin.end();
}
