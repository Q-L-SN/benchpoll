import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8) ?? root;
assert.ok(stage === root || /^\/tmp\/benchpoll-db-deadline-review-[0-9]+$/.test(stage));
const loadRoot = path => import(pathToFileURL(`${root}/${path}`).href);
const { config: dotenv } = await loadRoot('node_modules/dotenv/lib/main.js');
dotenv({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await loadRoot('node_modules/mysql2/index.js');
const { default: session } = await loadRoot('node_modules/express-session/index.js');
const { default: storeFactory } = await loadRoot('node_modules/express-mysql-session/index.js');
const { createDeadlinePool } = await import(pathToFileURL(`${stage}/db-deadlines.js`).href);
const helpers = await import(pathToFileURL(`${stage}/db-transaction.js`).href);
const config = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    connectTimeout: 5000, supportBigNumbers: true, bigNumberStrings: false };
const schema = `benchpoll_review_deadline_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
assert.match(schema, /^benchpoll_review_deadline_[0-9]+_[0-9a-f]{8}$/);
const setup = mysql.createConnection(config).promise();
const results = [];
let created = false, native, pool, applicationPool, held, locker, store;
const pass = (scenario, repetition, details = {}) => results.push({ scenario, repetition, ...details, passed: true });
const timeout = error => error.code === 'DATABASE_OPERATION_TIMEOUT' && error.status === 503 && error.body.outcomeUnknown;
const fresh = () => createDeadlinePool(native, { acquireTimeoutMs: 80, queryTimeoutMs: 120, pendingLimit: 2 });

try {
    await setup.query(`CREATE DATABASE \`${schema}\``); created = true;
    await setup.query(`USE \`${schema}\``);
    await setup.query('CREATE TABLE items (ID BIGINT UNSIGNED PRIMARY KEY,value INT NOT NULL) ENGINE=InnoDB');
    await setup.query('INSERT INTO items VALUES (9007199254740993,0)');
    native = mysql.createPool({ ...config, database: schema, connectionLimit: 1, waitForConnections: true, queueLimit: 2 }).promise();
    pool = fresh();
    for (let repetition = 1; repetition <= 2; repetition++) {
        const [rows, fields] = await pool.execute('SELECT ID,value FROM items');
        assert.equal(rows[0].ID, '9007199254740993'); assert.equal(fields[0].name, 'ID'); pass('BIGINT and result shape', repetition);
        held = await pool.getConnection();
        const oldID = held.threadId; held.release();
        const next = await pool.getConnection(); held.destroy(); held.release();
        await assert.rejects(held.execute('SELECT 1'), error => error.code === 'DATABASE_CONNECTION_DISCARDED');
        assert.equal(next.threadId, oldID); await next.query('SELECT 1'); next.release(); held = null;
        pass('released wrapper cannot damage next borrower', repetition);

        held = await pool.getConnection();
        const waiting = [pool.getConnection(), pool.getConnection()].map(promise => promise.catch(error => error));
        await assert.rejects(pool.getConnection(), error => error.body.error === 'database_busy');
        assert.equal(native.pool._connectionQueue.length, 2); pass('bounded native queue', repetition);
        assert.ok((await Promise.all(waiting)).every(error => error.code === 'DATABASE_ACQUIRE_TIMEOUT'));
        await assert.rejects(pool.execute('UPDATE items SET value=999'), error => error.body.error === 'database_busy');
        held.release(); held = null; await delay(30);
        assert.equal(native.pool._connectionQueue.length, 0);
        assert.equal((await pool.query('SELECT value FROM items'))[0][0].value, 0);
        pass('late acquisitions release without late business SQL', repetition);

        for (const method of ['query', 'execute']) {
            const leased = await pool.getConnection(), doomedID = leased.threadId;
            await assert.rejects(leased[method]('SELECT SLEEP(0.3)'), timeout);
            leased.release();
            const healthy = await pool.getConnection(); assert.notEqual(healthy.threadId, doomedID);
            await healthy.query('SELECT 1'); healthy.release(); pass(`${method} deadline discards real native lease`, repetition);
        }
        await assert.rejects(pool.query({ sql: 'SELECT SLEEP(0.3)', timeout: 30 }), error => error.code === 'PROTOCOL_SEQUENCE_TIMEOUT');
        await pool.query('SELECT 1'); pass('native timeout retains code and restores capacity', repetition);

        locker = mysql.createConnection({ ...config, database: schema }).promise();
        await locker.beginTransaction(); await locker.query('SELECT ID FROM items FOR UPDATE');
        held = await pool.getConnection(); await helpers.startTransactionConnection(held, 'ISOLATED LOCK TEST');
        await assert.rejects(held.execute('UPDATE items SET value=77'), timeout);
        assert.equal(await helpers.rollbackTransactionConnection(held, 'ISOLATED LOCK TEST'), false);
        held.release(); held = null; await locker.rollback(); await locker.end(); locker = null;
        const after = await pool.query('SELECT value FROM items'); assert.equal(after[0][0].value, 0);
        pass('timed-out locked write cannot leak into next transaction', repetition);

        held = await pool.getConnection();
        const begin = held.connection.beginTransaction.bind(held.connection);
        held.connection.beginTransaction = callback => begin(error => { if (error) callback(error); });
        await assert.rejects(helpers.startTransactionConnection(held, 'ISOLATED LOST BEGIN ACK'), timeout);
        held.release(); held = null; await pool.query('SELECT 1'); pass('lost BEGIN acknowledgement is bounded', repetition);

        held = await pool.getConnection(); await helpers.startTransactionConnection(held, 'ISOLATED LOST COMMIT ACK');
        await held.execute('UPDATE items SET value=4');
        const commit = held.connection.commit.bind(held.connection);
        held.connection.commit = callback => commit(error => { if (error) callback(error); });
        await assert.rejects(helpers.commitTransactionConnection(held, 'ISOLATED LOST COMMIT ACK'), timeout);
        held.release(); held = null;
        assert.equal((await pool.query('SELECT value FROM items'))[0][0].value, 4);
        pass('unknown commit is not reported as success or repeated', repetition);
        await setup.query('UPDATE items SET value=0');

        held = await pool.getConnection(); await helpers.startTransactionConnection(held, 'ISOLATED NORMAL TRANSACTION', { readOnlySnapshot: true });
        assert.equal((await held.query('SELECT ID FROM items'))[0][0].ID, '9007199254740993');
        await helpers.commitTransactionConnection(held, 'ISOLATED NORMAL TRANSACTION'); held.release(); held = null;
        pass('normal read-only snapshot preserves transaction behavior', repetition);
    }

    process.env.BENCHPOLL_DB_NAME = schema;
    process.env.DB_PASSWORD = config.password ?? '';
    process.env.BENCHPOLL_DB_ACQUIRE_TIMEOUT_MS = '5000'; process.env.BENCHPOLL_DB_QUERY_TIMEOUT_MS = '30000';
    const module = await import(pathToFileURL(`${stage}/db.js`).href);
    module.initPool(config.password ?? ''); applicationPool = module.pool;
    const MySQLStore = storeFactory(session);
    store = new MySQLStore({ createDatabaseTable: true, clearExpired: false }, applicationPool);
    await store.onReady();
    for (let repetition = 1; repetition <= 2; repetition++) {
        const value = { userID: '9007199254740993', cookie: { expires: new Date(Date.now() + 60000) } };
        await store.set('synthetic-review-session', value);
        assert.equal((await store.get('synthetic-review-session')).userID, value.userID);
        await store.touch('synthetic-review-session', value); await store.destroy('synthetic-review-session');
        assert.equal(await store.get('synthetic-review-session'), null);
        pass('actual application pool and session-store lifecycle', repetition);
    }
} finally {
    if (store) await store.close();
    if (held) held.destroy();
    if (locker) { await locker.rollback().catch(() => {}); await locker.end(); }
    if (applicationPool) await applicationPool.end();
    if (native) await native.end();
    if (created) await setup.query(`DROP DATABASE \`${schema}\``);
    await setup.end();
}
console.log(JSON.stringify({ passed: results.length, total: results.length, results, applicationSource: stage,
    actualDriverAndSQL: true, disposableSchemaCreatedAndRemoved: schema,
    productionBusinessTablesAccessed: false, realOAuth: false, realEmailDelivery: false }));
