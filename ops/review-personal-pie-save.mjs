import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8);
assert.match(stage ?? '', /^\/tmp\/benchpoll-pie-review-[0-9]+$/);
const moduleURL = path => pathToFileURL(path).href;
const dotenv = await import(moduleURL(`${root}/node_modules/dotenv/lib/main.js`));
dotenv.config({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await import(moduleURL(`${root}/node_modules/mysql2/index.js`));
const { savePersonalPie } = await import(moduleURL(`${stage}/ranking-service.js`));
const { pieConditionRows } = await import(moduleURL(`${stage}/scripts/personal-pie-save-fixture.mjs`));
const { ensureWriteRequestSchema, verifyWriteRequestSchema } = await import(moduleURL(`${stage}/scripts/migrate-write-requests.mjs`));
const config = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 12, waitForConnections: true };
const schema = `benchpoll_review_pie_${Date.now()}_${randomUUID().replaceAll('-', '').slice(0, 8)}`;
assert.match(schema, /^benchpoll_review_pie_[0-9]+_[0-9a-f]{8}$/);
const setup = mysql.createConnection(config).promise();
let pool, created = false;
const results = [];
const record = (name, details = {}) => results.push({ name, passed: true, ...details });
const run = (extra = {}) => ({ userID: '7', writeIdentity: randomUUID(), categoryID: 1,
    contextValues: {}, expectedRevision: 0, entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [], ...extra });
const errorCode = code => error => error.body?.error === code;
try {
    // The only production access is schema verification, never application data.
    await setup.query('USE ??', [process.env.BENCHPOLL_DB_NAME || 'benchmarks']);
    await verifyWriteRequestSchema(setup);
    record('installed replay schema is usable without a migration');
    await setup.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    await setup.query(`USE \`${schema}\``);
    const tables = [
        `users (ID BIGINT UNSIGNED PRIMARY KEY, deleted_at DATETIME NULL, banned_at DATETIME NULL, banned_until DATETIME NULL)`,
        `categories (ID INT UNSIGNED PRIMARY KEY, parent_ID INT UNSIGNED NULL, name VARCHAR(128), position INT,
            owner_user_ID BIGINT UNSIGNED NULL, is_active BOOL DEFAULT 1)`,
        `ranking_contexts (ID INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, category_ID INT UNSIGNED,
            context_values JSON, context_hash CHAR(64), UNIQUE(category_ID, context_hash))`,
        `benchmark_conditions (ID INT UNSIGNED PRIMARY KEY, deleted_at DATETIME NULL)`,
        `personal_pies (ID INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, user_ID BIGINT UNSIGNED, context_ID INT UNSIGNED,
            revision INT UNSIGNED NOT NULL, updated_at DATETIME(3) DEFAULT CURRENT_TIMESTAMP(3), UNIQUE(user_ID, context_ID),
            FOREIGN KEY(user_ID) REFERENCES users(ID), FOREIGN KEY(context_ID) REFERENCES ranking_contexts(ID))`,
        `personal_pie_weights (pie_ID INT UNSIGNED, benchmark_condition_ID INT UNSIGNED, weight_basis_points INT UNSIGNED,
            PRIMARY KEY(pie_ID, benchmark_condition_ID), FOREIGN KEY(pie_ID) REFERENCES personal_pies(ID) ON DELETE CASCADE,
            FOREIGN KEY(benchmark_condition_ID) REFERENCES benchmark_conditions(ID))`,
        `benchmark_families (ID INT UNSIGNED AUTO_INCREMENT PRIMARY KEY, primary_benchmark_condition_ID INT UNSIGNED,
            chain_hash CHAR(64) UNIQUE, FOREIGN KEY(primary_benchmark_condition_ID) REFERENCES benchmark_conditions(ID))`,
        `benchmark_family_members (family_ID INT UNSIGNED, position INT UNSIGNED, benchmark_condition_ID INT UNSIGNED NULL,
            PRIMARY KEY(family_ID, position), FOREIGN KEY(family_ID) REFERENCES benchmark_families(ID) ON DELETE CASCADE,
            FOREIGN KEY(benchmark_condition_ID) REFERENCES benchmark_conditions(ID))`,
        `personal_pie_score_rules (pie_ID INT UNSIGNED, primary_benchmark_condition_ID INT UNSIGNED, family_ID INT UNSIGNED,
            PRIMARY KEY(pie_ID, primary_benchmark_condition_ID),
            FOREIGN KEY(pie_ID, primary_benchmark_condition_ID) REFERENCES personal_pie_weights(pie_ID, benchmark_condition_ID) ON DELETE CASCADE,
            FOREIGN KEY(family_ID) REFERENCES benchmark_families(ID))`
    ];
    for (const table of tables) await setup.query(`CREATE TABLE ${table} ENGINE=InnoDB`);
    await setup.query("INSERT INTO users(ID) VALUES (7), (8), (18446744073709551615)");
    await setup.query("INSERT INTO categories(ID,parent_ID,name,position) VALUES (1,NULL,'Intelligence',0), (2,1,'Child',0)");
    await setup.query('INSERT INTO benchmark_conditions(ID) VALUES (1), (2), (3)');
    await ensureWriteRequestSchema(setup);
    const openPool = () => mysql.createPool({ ...config, database: schema }).promise();
    pool = openPool();
    const database = ({ failCompletion = false, loseCommit = false } = {}) => ({ async getConnection() {
        const connection = await pool.getConnection();
        return {
            beginTransaction: () => connection.beginTransaction(), rollback: () => connection.rollback(),
            release: () => connection.release(), destroy: () => connection.destroy(),
            async commit() { await connection.commit(); if (loseCommit) throw Error('Synthetic lost commit acknowledgement'); },
            execute(sql, parameters) {
                // Only the unrelated benchmark catalogue is synthetic; all writes, locks and receipts use InnoDB.
                if (sql.includes('SELECT benchmark_conditions.ID AS condition_ID')) return Promise.resolve([pieConditionRows, []]);
                if (failCompletion && sql.includes('UPDATE write_requests SET response_status')) throw Error('Synthetic completion failure');
                return connection.execute(sql, parameters);
            }
        };
    } });
    const saved = async actor => {
        const [rows] = await setup.execute('SELECT ID, revision FROM personal_pies WHERE user_ID = ?', [actor]);
        if (!rows.length) return { revision: 0, weights: [], rules: [] };
        const [weights] = await setup.execute('SELECT benchmark_condition_ID AS conditionID, weight_basis_points AS weightBasisPoints FROM personal_pie_weights WHERE pie_ID = ? ORDER BY benchmark_condition_ID', [rows[0].ID]);
        const [rules] = await setup.execute('SELECT family_ID FROM personal_pie_score_rules WHERE pie_ID = ?', [rows[0].ID]);
        return { revision: rows[0].revision, weights, rules };
    };
    const receipts = async key => {
        const [[row]] = await setup.execute('SELECT COUNT(*) AS total FROM write_requests WHERE request_key = ?', [key]);
        return Number(row.total);
    };
    for (let repetition = 1; repetition <= 2; repetition++) {
        const body = run({ expectedRevision: (await saved('7')).revision,
            fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: [{ conditionID: 2 }, { kind: 'other_versions' }] }] });
        const outcomes = await Promise.all(Array.from({ length: 10 }, () => savePersonalPie(database(), body)));
        for (const value of outcomes) assert.deepEqual(value, outcomes[0]);
        assert.equal(await receipts(body.writeIdentity), 1);
        assert.equal((await saved('7')).revision, body.expectedRevision + 1);
        assert.equal((await saved('7')).rules.length, 1);
        record('ten concurrent deliveries update the pie and ordered fallback exactly once', { repetition });
        await assert.rejects(savePersonalPie(database(), { ...body, entries: [{ conditionID: 3, weightBasisPoints: 10000 }], fallbackRules: [] }), errorCode('write_identity_reused'));
        record('committed identity rejects different weights', { repetition });
        const deletion = run({ expectedRevision: (await saved('7')).revision, entries: [] });
        const removed = await savePersonalPie(database(), deletion);
        assert.deepEqual(await saved('7'), { revision: 0, weights: [], rules: [] });
        const recreate = run({ entries: [{ conditionID: 3, weightBasisPoints: 10000 }] });
        await savePersonalPie(database(), recreate);
        assert.deepEqual(await savePersonalPie(database(), deletion), removed);
        assert.deepEqual((await saved('7')).weights, recreate.entries);
        assert.equal((await saved('7')).revision, 1);
        record('replayed deletion cannot delete a new pie with the same revision', { repetition });
        const [[unused]] = await setup.query('SELECT COUNT(*) AS total FROM benchmark_families');
        assert.equal(Number(unused.total), 0);
        record('unreferenced fallback families are pruned in the same transaction', { repetition });
        const failed = run({ expectedRevision: 1, entries: [{ conditionID: 2, weightBasisPoints: 10000 }] });
        const before = await saved('7');
        await assert.rejects(savePersonalPie(database({ failCompletion: true }), failed), /Synthetic completion failure/);
        assert.deepEqual(await saved('7'), before); assert.equal(await receipts(failed.writeIdentity), 0);
        await savePersonalPie(database(), failed); assert.equal((await saved('7')).revision, 2);
        record('receipt failure rolls back weights and identity, allowing a later retry', { repetition });
        const lost = run({ expectedRevision: 2, entries: [{ conditionID: 1, weightBasisPoints: 10000 }] });
        await assert.rejects(savePersonalPie(database({ loseCommit: true }), lost), /Synthetic lost commit acknowledgement/);
        assert.equal((await saved('7')).revision, 3); assert.equal(await receipts(lost.writeIdentity), 1);
        await pool.end(); pool = openPool();
        const replay = await savePersonalPie(database(), lost);
        assert.equal(replay.personalPie.revision, 3); assert.equal((await saved('7')).revision, 3);
        record('lost acknowledgement remains replayable after pool recreation', { repetition });
    }
    const key = randomUUID();
    const [first, second] = await Promise.all(['8', '18446744073709551615'].map(userID => savePersonalPie(database(), run({ userID, writeIdentity: key }))));
    assert.equal(first.userID, '8'); assert.equal(second.userID, '18446744073709551615'); assert.equal(await receipts(key), 2);
    record('same identity is actor-scoped and unsigned bigint ownership remains exact');
} finally {
    await pool?.end();
    if (created) await setup.query(`DROP DATABASE \`${schema}\``);
    await setup.end();
}
const hashes = {};
for (const path of ['ranking-service.js', 'write-idempotency.js', 'db-transaction.js', 'db-deadlines.js']) {
    hashes[path] = createHash('sha256').update(await readFile(`${stage}/${path}`)).digest('hex');
}
console.log(JSON.stringify({ passed: results.length, total: results.length, results, hashes, stage,
    disposableSchemaCreatedAndRemoved: schema, actualDriverAndTransactions: true,
    syntheticBenchmarkCatalogue: true, productionBusinessDataRead: false, productionBusinessDataWritten: false,
    productionSchemaVerifiedReadOnly: true, realOAuth: false }));
