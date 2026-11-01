import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8) ?? root;
const baseline = process.argv.find(value => value.startsWith('--baseline='))?.slice(11) ?? root;
assert.ok(stage === root || /^\/tmp\/(?:launch-20261008-|benchpoll-transaction-review-)[0-9]+$/.test(stage));
assert.ok(baseline === root || /^\/home\/ubuntu\/benchpoll-code-backups\/launch-20261008-[0-9]+$/.test(baseline));
const loadRoot = path => import(pathToFileURL(`${root}/${path}`).href);
const { config: dotenv } = await loadRoot('node_modules/dotenv/lib/main.js');
dotenv({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await loadRoot('node_modules/mysql2/index.js');
const { canonicalAccountID } = await loadRoot('public/js/shared/account-identity.js');
const helpers = await import(pathToFileURL(`${stage}/db-transaction.js`).href);
const { publishArenaBatch, cleanupArenaImportConnection } = await import(pathToFileURL(`${stage}/arena-sync.js`).href);
const { initializeScoreSyncSchema, registerScoreSync } = await import(pathToFileURL(`${stage}/score-sync-service.js`).href);
const config = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    supportBigNumbers: true, bigNumberStrings: false, charset: 'utf8mb4' };
const schema = `benchpoll_review_cleanup_${Date.now()}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
assert.match(schema, /^benchpoll_review_cleanup_[0-9]+_[0-9a-f]{8}$/);
const setup = mysql.createConnection(config).promise();
let created = false, pool;
const results = [], cleanupLogs = [];
const passed = (scenario, phase, repetition, details = {}) => results.push({ scenario, phase, repetition, ...details, passed: true });

function callbacks(discussionSource, serverSource, db) {
    const routes = new Map();
    const context = vm.createContext({ ...helpers, canonicalAccountID, db,
        console: { error: (...items) => cleanupLogs.push(items.map(String)) },
        API: { post(path, ...handlers) { routes.set(path, handlers.at(-1)); } },
        requireAuthForAPI() {}, requireAccountWriteOwner() {}, destroyRequestSession: async () => {} });
    vm.runInContext(discussionSource.slice(discussionSource.indexOf('const fail =')).replaceAll('export ', ''), context);
    const start = serverSource.indexOf('async function deleteAllStoredUserSessions(');
    vm.runInContext(serverSource.slice(start, serverSource.indexOf('const REVIEWER_ROLES', start)), context);
    for (const route of ['logout', 'delete_account']) {
        const from = serverSource.indexOf(`API.post('/${route}'`);
        vm.runInContext(serverSource.slice(from, serverSource.indexOf('\n});', from) + '\n});'.length), context);
    }
    return async scenario => {
        if (scenario === 'discussion delete') {
            context.args = [db, '1', { postID: 1 }];
            return vm.runInContext('deleteDiscussionPost(...args)', context);
        }
        const req = { session: { userID: '1' }, sessionID: 'isolated', query: scenario === 'logout all' ? { all: '' } : {}, body: {} };
        const route = routes.get(scenario === 'delete account' ? '/delete_account' : '/logout');
        return route(req, { clearCookie() {} }, error => { assert.equal(error.status, 204); });
    };
}

async function reset() {
    for (const table of ['discussion_posts', 'discussion_mentions', 'discussion_votes', 'users', 'user_comparison_profiles', 'sessions', 'user_sessions']) {
        await setup.query(`DELETE FROM \`${table}\``);
    }
    await setup.query("INSERT INTO discussion_posts VALUES (1,1,'Original',NULL)");
    await setup.query('INSERT INTO discussion_mentions VALUES (1)');
    await setup.query('INSERT INTO discussion_votes VALUES (1)');
    await setup.query('INSERT INTO users VALUES (1,NULL)');
    await setup.query('INSERT INTO user_comparison_profiles VALUES (1)');
    await setup.query("INSERT INTO sessions VALUES ('isolated'),('other')");
    await setup.query("INSERT INTO user_sessions VALUES ('isolated',1),('other',1)");
}

async function state(scenario) {
    if (scenario === 'discussion delete') {
        const [[row]] = await setup.query('SELECT body,deleted_at FROM discussion_posts WHERE ID=1');
        const [[mentions]] = await setup.query('SELECT COUNT(*) AS n FROM discussion_mentions');
        return { changed: row.body === '' && row.deleted_at !== null, secondaryCount: mentions.n };
    }
    if (scenario === 'delete account') {
        const [[row]] = await setup.query('SELECT deleted_at FROM users WHERE ID=1');
        const [[profiles]] = await setup.query('SELECT COUNT(*) AS n FROM user_comparison_profiles');
        return { changed: row.deleted_at !== null, secondaryCount: profiles.n };
    }
    const [[sessions]] = await setup.query('SELECT COUNT(*) AS n FROM sessions');
    const [[links]] = await setup.query('SELECT COUNT(*) AS n FROM user_sessions');
    return { changed: sessions.n < 2, secondaryCount: links.n };
}

try {
    await setup.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true; await setup.query(`USE \`${schema}\``);
    for (const sql of [
        'CREATE TABLE discussion_posts (ID INT PRIMARY KEY,author_ID BIGINT UNSIGNED,body TEXT,deleted_at DATETIME(3)) ENGINE=InnoDB',
        'CREATE TABLE discussion_mentions (post_ID INT) ENGINE=InnoDB',
        'CREATE TABLE discussion_votes (post_ID INT) ENGINE=InnoDB',
        'CREATE TABLE users (ID BIGINT UNSIGNED PRIMARY KEY,deleted_at DATETIME) ENGINE=InnoDB',
        'CREATE TABLE user_comparison_profiles (user_ID BIGINT UNSIGNED) ENGINE=InnoDB',
        'CREATE TABLE sessions (session_id VARCHAR(64) PRIMARY KEY) ENGINE=InnoDB',
        'CREATE TABLE user_sessions (session_ID VARCHAR(64) PRIMARY KEY,user_ID BIGINT UNSIGNED) ENGINE=InnoDB'
    ]) await setup.query(sql);
    pool = mysql.createPool({ ...config, database: schema, connectionLimit: 1, waitForConnections: true }).promise();
    const source = await readFile(`${stage}/discussion-service.js`, 'utf8');
    const server = await readFile(`${stage}/server.js`, 'utf8');
    const oldSource = await readFile(`${baseline}/discussion-service.js`, 'utf8');
    assert.ok(oldSource.includes('await connection.rollback(); throw error;'), 'Baseline must contain the reproduced unsafe wrapper');
    await reset();
    const oldConnection = await pool.getConnection(), oldID = oldConnection.threadId;
    const oldRollback = oldConnection.rollback.bind(oldConnection), oldExecute = oldConnection.execute.bind(oldConnection);
    const original = Object.assign(new Error('isolated_operation'), { code: 'ISOLATED_OPERATION' });
    const rollbackError = Object.assign(new Error('isolated_rollback'), { code: 'ISOLATED_ROLLBACK' });
    oldConnection.rollback = async () => { throw rollbackError; };
    oldConnection.execute = async (...args) => {
        const result = await oldExecute(...args);
        if (args[0].startsWith('UPDATE')) throw original;
        return result;
    };
    await assert.rejects(callbacks(oldSource, server, { getConnection: async () => oldConnection })('discussion delete'), error => error === rollbackError);
    const nextOld = await pool.getConnection();
    assert.equal(nextOld.threadId, oldID);
    await nextOld.commit(); nextOld.release();
    assert.equal((await state('discussion delete')).changed, true, 'Before fix: next borrower commits the prior failed request');
    oldConnection.rollback = oldRollback; oldConnection.execute = oldExecute;
    passed('baseline accidental next-borrower commit', 'before', 1, { originalErrorLost: true, pendingChangesLeaked: true });

    for (const scenario of ['discussion delete', 'logout current', 'logout all', 'delete account']) {
        for (const phase of ['rollback failure', 'release failure', 'begin ack loss', 'commit before ack loss', 'commit after ack loss', 'success']) {
            for (let repetition = 1; repetition <= 2; repetition++) {
                await reset();
                const connection = await pool.getConnection(), ID = connection.threadId, events = [];
                const failure = Object.assign(new Error('isolated_operation'), { code: 'ISOLATED_OPERATION' });
                const methods = Object.fromEntries(['beginTransaction', 'execute', 'commit', 'rollback', 'release', 'destroy']
                    .map(name => [name, connection[name].bind(connection)]));
                let mutation = false;
                connection.beginTransaction = async () => { await methods.beginTransaction(); if (phase === 'begin ack loss') throw failure; };
                connection.execute = async (...args) => {
                    const result = await methods.execute(...args);
                    if (!mutation && /^\s*(?:UPDATE|DELETE)/.test(args[0])) {
                        mutation = true;
                        if (['rollback failure', 'release failure'].includes(phase)) throw failure;
                    }
                    return result;
                };
                connection.commit = async () => {
                    if (phase === 'commit before ack loss') throw failure;
                    await methods.commit();
                    if (phase === 'commit after ack loss') throw failure;
                };
                connection.rollback = async () => { events.push('rollback'); if (phase === 'rollback failure') throw rollbackError; return methods.rollback(); };
                connection.release = () => { events.push('release'); if (phase === 'release failure') throw rollbackError; return methods.release(); };
                connection.destroy = () => { events.push('destroy'); return methods.destroy(); };
                const operation = callbacks(source, server, { getConnection: async () => connection })(scenario);
                if (phase === 'success') await operation;
                else await assert.rejects(operation, error => error === failure);
                const next = await pool.getConnection();
                if (phase !== 'success') {
                    assert.notEqual(next.threadId, ID, 'Uncertain lease is not handed to a later borrower');
                    assert.deepEqual(events.filter(event => event !== 'rollback'), phase === 'release failure' ? ['release', 'destroy'] : ['destroy']);
                } else assert.deepEqual(events, ['release']);
                await next.commit(); next.release();
                const persisted = await state(scenario);
                const committed = ['success', 'commit after ack loss'].includes(phase);
                assert.equal(persisted.changed, committed);
                assert.equal(persisted.secondaryCount, committed ? (scenario === 'logout current' ? 1 : 0) : (scenario.startsWith('logout') ? 2 : 1));
                passed(scenario, phase, repetition, { committedOutcomeObserved: committed, unrelatedRequestCannotCommitFailedWork: true });
            }
        }
    }
    for (let repetition = 1; repetition <= 2; repetition++) {
        await reset();
        const connection = await pool.getConnection(), ID = connection.threadId;
        await helpers.startTransactionConnection(connection, 'REAL QUERY TIMEOUT');
        await connection.execute("UPDATE discussion_posts SET body='Pending timeout' WHERE ID=1");
        let error;
        try { await connection.query({ sql: 'SELECT SLEEP(1)', timeout: 10 }); } catch (cause) { error = cause; }
        assert.equal(error.code, 'PROTOCOL_SEQUENCE_TIMEOUT');
        assert.equal(await helpers.rollbackTransactionConnection(connection, 'REAL QUERY TIMEOUT', error), false);
        helpers.releaseTransactionConnection(connection, 'REAL QUERY TIMEOUT');
        const next = await pool.getConnection(); assert.notEqual(next.threadId, ID); await next.commit(); next.release();
        await delay(1200);
        const [[row]] = await setup.query('SELECT body FROM discussion_posts WHERE ID=1');
        assert.equal(row.body, 'Original');
        passed('actual mysql2 query timeout', 'after', repetition, { noQueuedRollback: true, pendingChangesLeaked: false });
    }
    for (let repetition = 1; repetition <= 2; repetition++) {
        const connection = await pool.getConnection(), ID = connection.threadId;
        const nativePool = pool.pool;
        let transferred;
        const listener = () => { transferred = pool.getConnection(); throw new Error('isolated release listener'); };
        nativePool.once('release', listener);
        helpers.releaseTransactionConnection(connection, 'REAL RELEASE LISTENER');
        assert.ok(transferred);
        const next = await transferred;
        assert.equal(next.threadId, ID, 'Transferred native lease remains alive');
        const [[row]] = await next.query('SELECT 1 AS alive'); assert.equal(row.alive, 1);
        next.release();
        passed('actual mysql2 release listener transfer', 'after', repetition, { nextBorrowerNotDestroyed: true });
    }
    for (const sql of [
        `CREATE TABLE arena_sync_batches (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,source_revision CHAR(40),
            source_modified_at DATETIME(3),snapshot_hash CHAR(64),status VARCHAR(16) DEFAULT 'running',summary JSON,
            error_message TEXT,completed_at DATETIME(3)) ENGINE=InnoDB`,
        'CREATE TABLE arena_sync_feed_state (config VARCHAR(64) PRIMARY KEY,current_batch_ID BIGINT,updated_at DATETIME(3)) ENGINE=InnoDB',
        'CREATE TABLE arena_sync_state (ID INT PRIMARY KEY,current_batch_ID BIGINT,updated_at DATETIME(3)) ENGINE=InnoDB'
    ]) await setup.query(sql);
    const batch = { snapshot: { revision: 'a'.repeat(40), expectedConfigs: ['text'] },
        sourceModifiedAt: '2026-10-01T00:00:00.000Z', contentHash: 'b'.repeat(64),
        plan: { entries: [{}] }, feedDates: new Map([['text/overall', '2026-10-01']]) };
    for (const phase of ['work failure', 'rollback failure', 'begin ack loss', 'commit before ack loss', 'commit after ack loss', 'success']) {
        for (let repetition = 1; repetition <= 2; repetition++) {
            await reset();
            for (const table of ['arena_sync_feed_state', 'arena_sync_state', 'arena_sync_batches']) await setup.query(`DELETE FROM \`${table}\``);
            const connection = mysql.createConnection({ ...config, database: schema }).promise();
            const error = new Error('isolated_arena_operation');
            const begin = connection.beginTransaction.bind(connection), commit = connection.commit.bind(connection), rollback = connection.rollback.bind(connection);
            connection.beginTransaction = async () => { await begin(); if (phase === 'begin ack loss') throw error; };
            connection.commit = async () => {
                if (phase === 'commit before ack loss') throw error;
                await commit(); if (phase === 'commit after ack loss') throw error;
            };
            connection.rollback = async () => { if (phase === 'rollback failure') throw rollbackError; return rollback(); };
            let recoveryBorrows = 0, caught;
            try {
                await publishArenaBatch(connection, batch, async () => {
                    await connection.execute("UPDATE discussion_posts SET body='Published' WHERE ID=1");
                    if (['work failure', 'rollback failure'].includes(phase)) throw error;
                    return { updated: 1 };
                }, { recoveryConnectionFactory: async () => {
                    recoveryBorrows++;
                    return mysql.createConnection({ ...config, database: schema }).promise();
                } });
            } catch (cause) { caught = cause; }
            finally { await cleanupArenaImportConnection(connection, { originalError: caught }); }
            if (phase === 'success') assert.equal(caught, undefined);
            else assert.ok(caught === error || caught?.cause === error);
            const [[row]] = await setup.query('SELECT status FROM arena_sync_batches');
            const [[score]] = await setup.query('SELECT body FROM discussion_posts WHERE ID=1');
            const committed = ['success', 'commit after ack loss'].includes(phase);
            assert.equal(row.status, committed ? 'succeeded' : 'failed');
            assert.equal(score.body, committed ? 'Published' : 'Original');
            assert.equal(recoveryBorrows, ['rollback failure', 'begin ack loss', 'commit before ack loss', 'commit after ack loss'].includes(phase) ? 1 : 0);
            passed('actual Arena batch recovery', phase, repetition, { durableStatus: row.status,
                scoreCommitObserved: committed, recoveryBorrows, noSuccessOverwrittenAfterAckLoss: true });
        }
    }
    await initializeScoreSyncSchema(setup);
    for (const phase of ['audit failure', 'rollback failure', 'begin ack loss', 'commit before ack loss', 'commit after ack loss', 'success']) {
        for (let repetition = 1; repetition <= 2; repetition++) {
            for (const table of ['score_sync_registry_events', 'score_sync_runs', 'score_sync_jobs']) await setup.query(`DELETE FROM \`${table}\``);
            const connection = mysql.createConnection({ ...config, database: schema }).promise();
            const error = Object.assign(new Error('isolated_registration_operation'), { status: 409, code: 'ISOLATED_REGISTRATION' });
            const begin = connection.beginTransaction.bind(connection), commit = connection.commit.bind(connection),
                rollback = connection.rollback.bind(connection), execute = connection.execute.bind(connection);
            connection.beginTransaction = async () => { await begin(); if (phase === 'begin ack loss') throw error; };
            connection.commit = async () => {
                if (phase === 'commit before ack loss') throw error;
                await commit(); if (phase === 'commit after ack loss') throw error;
            };
            connection.rollback = async () => { if (phase === 'rollback failure') throw rollbackError; return rollback(); };
            connection.execute = async (...args) => {
                const result = await execute(...args);
                if (args[0].includes('INSERT INTO score_sync_registry_events') && ['audit failure', 'rollback failure'].includes(phase)) throw error;
                return result;
            };
            let caught;
            try { await registerScoreSync(connection, { sourceKey: 'arena_official', intervalSeconds: 3600, operator: 'Isolated diagnostic' }); }
            catch (cause) { caught = cause; }
            finally { await cleanupArenaImportConnection(connection, { originalError: caught }); }
            if (phase === 'success') assert.equal(caught, undefined);
            else assert.equal(caught, error);
            const [[jobs]] = await setup.query('SELECT COUNT(*) AS n FROM score_sync_jobs');
            const [[events]] = await setup.query('SELECT COUNT(*) AS n FROM score_sync_registry_events');
            const count = ['success', 'commit after ack loss'].includes(phase) ? 1 : 0;
            assert.equal(jobs.n, count); assert.equal(events.n, count);
            passed('actual score-sync registration', phase, repetition, { originalStatusAndCodePreserved: true, committedRows: count });
        }
    }
    console.log(JSON.stringify({ passed: results.length, total: results.length,
        baselineReproduced: true, postFixPassed: results.length - 1, postFixTotal: results.length - 1, results, temporarySchema: schema,
        actualSQLInDisposableSchema: true, productionBusinessTablesAccessed: false, productionAuthenticationExecuted: false,
        scope: 'Actual discussion deletion and logout/account-deletion callbacks, Arena batch publication/recovery and score-sync registration, mysql2 pool capacity 1, injected faults, real query timeouts and release-listener ownership transfer.' }));
} finally {
    if (pool) await pool.end();
    if (created) await setup.query(`DROP DATABASE \`${schema}\``);
    await setup.end();
}
