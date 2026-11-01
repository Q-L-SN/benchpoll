import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8) ?? root;
if (stage !== root && !/^\/tmp\/benchpoll-write-review-[0-9]+$/.test(stage)) throw Error('Invalid review stage');
const moduleURL = path => pathToFileURL(path).href;
const dotenv = await import(moduleURL(`${root}/node_modules/dotenv/lib/main.js`));
dotenv.config({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await import(moduleURL(`${root}/node_modules/mysql2/index.js`));
const { ensureWriteRequestSchema } = await import(moduleURL(`${stage}/scripts/migrate-write-requests.mjs`));
const { readWriteIdentity, claimWriteIntent, completeWriteIntent } = await import(moduleURL(`${stage}/write-idempotency.js`));
const { requireAccountWriteOwner } = await import(moduleURL(`${stage}/public/js/shared/account-identity.js`));
const { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } = await import(moduleURL(`${root}/moderation-admin.js`));
const { createModerationEmailService } = await import(moduleURL(`${root}/moderation-email.js`));
const server = await readFile(`${stage}/server.js`, 'utf8');
const config = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 10, waitForConnections: true };
const schema = `benchpoll_review_write_${Date.now()}_${randomUUID().replace(/-/g, '').slice(0, 8)}`;
assert.match(schema, /^benchpoll_review_write_[0-9]+_[0-9a-f]{8}$/);
const setup = mysql.createConnection(config).promise();
let created = false, pool;
const results = [];
const record = (name, details = {}) => results.push({ name, passed: true, ...details });
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
try {
    await setup.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    created = true;
    await setup.query(`USE \`${schema}\``);
    await setup.query('CREATE TABLE users (ID BIGINT UNSIGNED PRIMARY KEY, email VARCHAR(255)) ENGINE=InnoDB');
    await setup.execute('INSERT INTO users (ID, email) VALUES (?, ?), (?, ?), (?, ?)',
        ['1', 'one@example.test', '2', 'two@example.test', '18446744073709551615', 'large@example.test']);
    await ensureWriteRequestSchema(setup);
    await ensureWriteRequestSchema(setup);
    record('schema creation and repeated verification');
    await setup.query(`CREATE TABLE review_business (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        actor VARCHAR(32), request_key CHAR(36)) ENGINE=InnoDB`);
    pool = mysql.createPool({ ...config, database: schema }).promise();
    const counts = async key => {
        const [[business]] = await setup.execute('SELECT COUNT(*) AS total FROM review_business WHERE request_key = ?', [key]);
        const [[requests]] = await setup.execute('SELECT COUNT(*) AS total FROM write_requests WHERE request_key = ?', [key]);
        return { business: Number(business.total), requests: Number(requests.total) };
    };
    const perform = async ({ key, payload = { value: 1 }, actor = '1', action = 'submit_contribution', fail = false, hold = null }) => {
        const connection = await pool.getConnection();
        try {
            await connection.beginTransaction();
            const intent = await claimWriteIntent(connection, { userID: actor, key, action, payload });
            if (intent.response) { await connection.commit(); return { replayed: true, ...intent.response }; }
            if (hold) await hold;
            const [insert] = await connection.execute('INSERT INTO review_business (actor, request_key) VALUES (?, ?)', [actor, key]);
            if (fail) throw Error('Synthetic business rollback');
            const body = { ID: Number(insert.insertId) };
            await completeWriteIntent(connection, intent, { status: 200, body });
            await connection.commit();
            return { replayed: false, status: 200, body };
        } catch (error) {
            try { await connection.rollback(); } catch { connection.destroy(); }
            throw error;
        } finally { connection.release(); }
    };
    for (let repetition = 1; repetition <= 2; repetition++) {
        const key = randomUUID();
        let release;
        const held = new Promise(resolve => { release = resolve; });
        const owner = perform({ key, hold: held });
        await delay(80);
        const deliveries = Array.from({ length: 9 }, () => perform({ key }));
        await delay(80); release();
        const outcomes = await Promise.all([owner, ...deliveries]);
        assert.equal(new Set(outcomes.map(outcome => outcome.body.ID)).size, 1);
        assert.equal(outcomes.filter(outcome => !outcome.replayed).length, 1);
        assert.deepEqual(await counts(key), { business: 1, requests: 1 });
        record('ten concurrent identical deliveries', { repetition, deliveries: 10, ...await counts(key) });

        const failedKey = randomUUID();
        await assert.rejects(perform({ key: failedKey, fail: true }), /Synthetic business rollback/);
        assert.deepEqual(await counts(failedKey), { business: 0, requests: 0 });
        await perform({ key: failedKey });
        assert.deepEqual(await counts(failedKey), { business: 1, requests: 1 });
        record('business and replay record rollback together then retry', { repetition });

        const actorKey = randomUUID();
        await Promise.all([perform({ key: actorKey }), perform({ key: actorKey, actor: '2' })]);
        assert.deepEqual(await counts(actorKey), { business: 2, requests: 2 });
        record('same key is isolated by actor', { repetition });

        await assert.rejects(perform({ key, payload: { value: 2 } }), error => error.body?.error === 'write_identity_reused');
        await assert.rejects(perform({ key, action: 'send_admin_message' }), error => error.body?.error === 'write_identity_reused');
        assert.deepEqual(await counts(key), { business: 1, requests: 1 });
        record('changed payload or action cannot reuse a committed identity', { repetition });

        const distinct = [randomUUID(), randomUUID()];
        await Promise.all(distinct.map(key => perform({ key })));
        for (const key of distinct) assert.deepEqual(await counts(key), { business: 1, requests: 1 });
        record('different intents may contain identical content', { repetition });

        await pool.end();
        pool = mysql.createPool({ ...config, database: schema }).promise();
        const replay = await perform({ key });
        assert.equal(replay.replayed, true);
        assert.equal(replay.body.ID, outcomes[0].body.ID);
        record('durable replay survives complete pool recreation', { repetition });
    }
    const largeKey = randomUUID();
    await perform({ key: largeKey, actor: '18446744073709551615' });
    const [[large]] = await setup.execute('SELECT CAST(actor_user_ID AS CHAR) AS actor FROM write_requests WHERE request_key = ?', [largeKey]);
    assert.equal(large.actor, '18446744073709551615');
    record('unsigned bigint actor identity stays exact');

    await setup.query(`CREATE TABLE moderation_logs (ID INT UNSIGNED PRIMARY KEY, status VARCHAR(32), content JSON,
        report_count INT, user_id BIGINT UNSIGNED, created_at DATETIME(3), updated_at DATETIME(3)) ENGINE=InnoDB`);
    await setup.query(`CREATE TABLE moderation_audit_logs (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        moderation_log_ID INT UNSIGNED NULL, reviewer_user_ID BIGINT UNSIGNED, action_type VARCHAR(48),
        request_type VARCHAR(64), request_summary VARCHAR(255), status_before VARCHAR(32), status_after VARCHAR(32),
        request_before JSON, request_after JSON, executed_sql LONGTEXT, database_response JSON,
        outcome VARCHAR(16), duration_ms INT UNSIGNED) ENGINE=InnoDB`);
    await setup.query(`CREATE TABLE moderation_email_outbox (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
        moderation_log_ID INT UNSIGNED, user_ID BIGINT UNSIGNED, recipient_email VARCHAR(255), decision VARCHAR(32),
        contribution_type VARCHAR(64), delivery_status VARCHAR(32), next_attempt_at DATETIME(3), last_error TEXT) ENGINE=InnoDB`);
    const handlers = new Map();
    const context = vm.createContext({ db: pool, URL, structuredClone,
        console: { error() {} }, createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot,
        readWriteIdentity, claimWriteIntent, completeWriteIntent,
        moderationEmailService: createModerationEmailService({ pool, publicOrigin: 'https://example.test', transport: null, environment: {} }),
        requireReviewerAuthForAPI: (_req, _res, next) => next(), requireAccountWriteOwner,
        API: { post(path, ...callbacks) { handlers.set(path, callbacks); } } });
    const contractStart = server.indexOf('function normalizeString(');
    const contractEnd = server.indexOf('async function buildExecutedModerationSQLPreview(', contractStart);
    vm.runInContext(server.slice(contractStart, contractEnd), context);
    const helpersStart = server.indexOf('function directMutationAuditError(');
    vm.runInContext(server.slice(helpersStart, server.indexOf("API.post('/send_admin_message'", helpersStart)), context);
    const start = server.indexOf("API.post('/review_moderation_log'");
    vm.runInContext(server.slice(start, server.indexOf('\n});', start) + '\n});'.length), context);
    const callbacks = handlers.get('/review_moderation_log');
    assert.equal(callbacks.length, 3);
    for (let repetition = 1; repetition <= 2; repetition++) {
        const ID = 900 + repetition;
        await setup.execute("INSERT INTO moderation_logs VALUES (?, 'pending', ?, 1, 1, NOW(3), NOW(3))",
            [ID, JSON.stringify({ schemaVersion: 1, type: 'feedback', pageURL: '', details: 'Isolated moderation feedback.' })]);
        const actions = ['1', '2'].map(async actor => {
            const req = { body: { ID, status: 'approved', expectedUserID: actor }, session: { userID: actor }, user: { ID: actor },
                headers: { 'idempotency-key': randomUUID() } };
            let response;
            const res = { json(body) { response = body; } };
            try {
                for (const callback of callbacks.slice(0, -1)) { let error; callback(req, res, value => { error = value; }); if (error) throw error; }
                await callbacks.at(-1)(req, res);
                return { success: true, response };
            } catch (error) { return { success: false, status: error.status, code: error.body?.error, message: error.message }; }
        });
        const outcomes = await Promise.all(actions);
        assert.equal(outcomes.filter(outcome => outcome.success).length, 1, JSON.stringify(outcomes));
        assert.equal(outcomes.find(outcome => !outcome.success).code, 'already_reviewed');
        const [[audit]] = await setup.execute("SELECT COUNT(*) AS total FROM moderation_audit_logs WHERE moderation_log_ID = ? AND outcome = 'success'", [ID]);
        const [[mail]] = await setup.execute('SELECT COUNT(*) AS total FROM moderation_email_outbox WHERE moderation_log_ID = ?', [ID]);
        assert.equal(Number(audit.total), 1); assert.equal(Number(mail.total), 1);
        record('two real moderation callbacks serialize approval under InnoDB row locks', { repetition, successfulActions: 1,
            successAudits: Number(audit.total), outboxEntries: Number(mail.total), authentication: 'synthetic reviewer fixture' });
    }
} finally {
    await pool?.end();
    if (created) await setup.query(`DROP DATABASE \`${schema}\``);
    await setup.end();
}
console.log(JSON.stringify({ passed: results.length, total: results.length, results,
    codeSource: stage, actualDriverAndTransactions: true, disposableSchemaCreatedAndRemoved: schema,
    productionApplicationTablesRead: false, productionApplicationTablesWritten: false,
    realOAuth: false, realEmailDelivery: false }));
