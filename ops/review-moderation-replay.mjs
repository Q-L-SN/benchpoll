import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8) ?? root;
assert.ok(stage === root || /^\/tmp\/benchpoll-moderation-review-[0-9]+$/.test(stage));
const load = path => import(pathToFileURL(`${root}/${path}`).href);
const { config: dotenv } = await load('node_modules/dotenv/lib/main.js');
dotenv({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await load('node_modules/mysql2/index.js');
const { readWriteIdentity, claimWriteIntent, completeWriteIntent } = await load('write-idempotency.js');
const { canonicalWritePayload } = await load('public/js/shared/write-intent.js');
const { requireAccountWriteOwner } = await load('public/js/shared/account-identity.js');
const { ensureWriteRequestSchema, verifyWriteRequestSchema } = await load('scripts/migrate-write-requests.mjs');
const { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } = await load('moderation-admin.js');
const { createModerationEmailService } = await load('moderation-email.js');
const { initializeArenaConflictSchema, resolveArenaSyncConflict } = await load('arena-sync-conflicts.js');
const { arenaRowHash } = await load('arena-import-plan.js');
const source = await readFile(`${stage}/server.js`, 'utf8');
const transactionCleanup = source.includes("from './db-transaction.js'")
    ? await import(pathToFileURL(`${stage}/db-transaction.js`).href) : {};
const config = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    supportBigNumbers: true, bigNumberStrings: true, connectionLimit: 10, waitForConnections: true };

if (process.argv.includes('--preflight')) {
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    assert.equal(database, 'benchmarks');
    const connection = mysql.createConnection({ ...config, database }).promise();
    try {
        await verifyWriteRequestSchema(connection);
        console.log(JSON.stringify({ database, replaySchemaVerified: true,
            applicationBusinessRowsRead: false, databaseWritten: false }));
    } finally { await connection.end(); }
} else {
    const schema = `benchpoll_review_decisions_${Date.now()}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    assert.match(schema, /^benchpoll_review_decisions_[0-9]+_[0-9a-f]{8}$/);
    const setup = mysql.createConnection(config).promise();
    let created = false, pool, serial = 4000, clockOffset = 0;
    class Clock extends Date { static now() { return Date.now() + clockOffset; } }
    const results = [];
    try {
        await setup.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        created = true;
        await setup.query(`USE \`${schema}\``);
        await setup.query('CREATE TABLE users (ID BIGINT UNSIGNED PRIMARY KEY, email VARCHAR(255)) ENGINE=InnoDB');
        await setup.execute('INSERT INTO users VALUES (1, ?), (2, ?)', ['one@example.test', 'two@example.test']);
        await ensureWriteRequestSchema(setup);
        await setup.query('CREATE TABLE review_fail_keys (request_key CHAR(36) PRIMARY KEY) ENGINE=InnoDB');
        await setup.query(`CREATE TRIGGER review_fail_completion BEFORE UPDATE ON write_requests FOR EACH ROW
            BEGIN
                IF NEW.response_status IS NOT NULL AND EXISTS
                    (SELECT 1 FROM review_fail_keys WHERE request_key=NEW.request_key) THEN
                    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Isolated review completion failure';
                END IF;
            END`);
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
        await setup.query('CREATE TABLE benchmark_results (ID BIGINT UNSIGNED PRIMARY KEY, status VARCHAR(32)) ENGINE=InnoDB');
        await setup.query(`CREATE TABLE arena_import_rows (row_key CHAR(64) PRIMARY KEY, result_ID BIGINT UNSIGNED,
            source_hash CHAR(64), manual_override VARCHAR(32), source_revision CHAR(40), source_date DATE) ENGINE=InnoDB`);
        await initializeArenaConflictSchema(setup);
        pool = mysql.createPool({ ...config, database: schema }).promise();
        const handlers = new Map();
        const context = vm.createContext({ ...transactionCleanup, mysql, crypto, Buffer, URL, Date: Clock, structuredClone,
            sessionSecret: 'isolated-review-preview-signing-key', console: { error() {} },
            db: { getConnection: async () => {
                const connection = await pool.getConnection(), query = connection.query.bind(connection);
                // Exercise named-lock order without sharing a lock with production sync jobs.
                connection.query = (sql, parameters) => query(sql, /GET_LOCK|RELEASE_LOCK/.test(sql) ? [`${schema}:arena`] : parameters);
                return connection;
            } },
            createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot,
            readWriteIdentity, claimWriteIntent, completeWriteIntent, resolveArenaSyncConflict,
            moderationEmailService: createModerationEmailService({ pool, publicOrigin: 'https://example.test', transport: null, environment: {} }),
            requireReviewerAuthForAPI: (_req, _res, next) => next(), requireAccountWriteOwner,
            API: { post(path, ...callbacks) { handlers.set(path, callbacks); } } });
        const contractStart = source.indexOf('function normalizeString(');
        vm.runInContext(source.slice(contractStart, source.indexOf('async function buildExecutedModerationSQLPreview(', contractStart)), context);
        const previewStart = source.indexOf('function moderationTimestamp(');
        vm.runInContext(source.slice(previewStart, source.indexOf("API.post('/submit_contribution'", previewStart)), context);
        const helpersStart = source.indexOf('function directMutationAuditError(');
        vm.runInContext(source.slice(helpersStart, source.indexOf("API.post('/send_admin_message'", helpersStart)), context);
        for (const route of ['review_moderation_log', 'apply_moderation_log', 'escalate_moderation_log', 'resolve_score_sync_conflict']) {
            const start = source.indexOf(`API.post('/${route}'`);
            vm.runInContext(source.slice(start, source.indexOf('\n});', start) + '\n});'.length), context);
            assert.equal(handlers.get(`/${route}`).length, 3);
        }
        const preview = (log, content, actor) => {
            context.__log = log; context.__edited = content; context.__actor = actor;
            return vm.runInContext(`(() => {
                const actionAt = new Date().toISOString();
                const edited = prepareEditedModerationContent(parseModerationContent(__log.content), __edited, __actor, actionAt);
                return createModerationPreviewToken({ moderationLogID: __log.ID, reviewerUserID: __actor,
                    updatedAt: moderationTimestamp(__log.updated_at), actionAt, content: edited });
            })()`, context);
        };
        const fixture = async scenario => {
            const ID = ++serial;
            if (['source', 'correction'].includes(scenario)) {
                const rowKey = ID.toString(16).padStart(64, '0');
                const incoming = { leaderboard_publish_date: '2026-10-08', score: ID }, incomingHash = arenaRowHash(incoming);
                await setup.execute("INSERT INTO benchmark_results VALUES (?, 'accepted')", [ID]);
                await setup.execute("INSERT INTO arena_import_rows VALUES (?, ?, ?, 'edit', ?, '2026-10-01')",
                    [rowKey, ID, 'c'.repeat(64), 'd'.repeat(40)]);
                await setup.execute(`INSERT INTO arena_sync_conflicts
                    (row_key,result_ID,incoming_hash,incoming_row,source_revision,config,category)
                    VALUES (?,?,?,?,?,'text','overall')`, [rowKey, ID, incomingHash, JSON.stringify(incoming), 'b'.repeat(40)]);
                return { ID, scenario, route: 'resolve_score_sync_conflict', input: { rowKey, resultID: ID, incomingHash, choice: scenario } };
            }
            await setup.execute("INSERT INTO moderation_logs VALUES (?, 'pending', ?, 1, 1, NOW(3), NOW(3))",
                [ID, JSON.stringify({ schemaVersion: 1, type: 'feedback', details: `Isolated decision ${ID}`, pageURL: '' })]);
            const [[log]] = await setup.execute('SELECT * FROM moderation_logs WHERE ID=?', [ID]);
            const input = scenario === 'escalate' ? { ID, note: `Isolated escalation ${ID}` }
                : scenario === 'apply' ? { ID, content: { schemaVersion: 1, type: 'feedback', details: `Edited decision ${ID}`, pageURL: '' } }
                    : { ID, status: scenario === 'approve' ? 'approved' : 'rejected' };
            if (scenario === 'apply') input.previewToken = preview(log, input.content, '1');
            return { ID, scenario, log, route: scenario === 'apply' ? 'apply_moderation_log'
                : scenario === 'escalate' ? 'escalate_moderation_log' : 'review_moderation_log', input };
        };
        const invoke = async (item, key, actor = '1', override = null) => {
            const req = { body: { ...structuredClone(override ?? item.input), expectedUserID: actor },
                session: { userID: actor }, user: { ID: actor }, headers: { 'idempotency-key': key } };
            const response = { status: 200, body: null }, res = {
                status(value) { response.status = value; return this; }, json(value) { response.body = value; } };
            try {
                const callbacks = handlers.get(`/${item.route}`);
                for (const callback of callbacks.slice(0, -1)) {
                    let error; callback(req, res, value => { error = value; }); if (error) throw error;
                }
                await callbacks.at(-1)(req, res);
                return { success: true, ...response };
            } catch (error) { return { success: false, status: error.status ?? 500, code: error.body?.error ?? error.message }; }
        };
        const counts = async item => {
            const [audits] = await setup.execute(item.route === 'resolve_score_sync_conflict'
                ? "SELECT outcome,COUNT(*) AS total FROM moderation_audit_logs WHERE JSON_UNQUOTE(JSON_EXTRACT(request_before,'$.content.rowKey'))=? GROUP BY outcome"
                : 'SELECT outcome,COUNT(*) AS total FROM moderation_audit_logs WHERE moderation_log_ID=? GROUP BY outcome',
            [item.route === 'resolve_score_sync_conflict' ? item.input.rowKey : item.ID]);
            const [[mail]] = await setup.execute('SELECT COUNT(*) AS total FROM moderation_email_outbox WHERE moderation_log_ID=?', [item.ID]);
            return { successAudits: Number(audits.find(row => row.outcome === 'success')?.total ?? 0),
                failureAudits: Number(audits.find(row => row.outcome === 'failure')?.total ?? 0), outbox: Number(mail.total) };
        };
        const assertOnce = async (item, expectedFailures = 0) => {
            assert.deepEqual(await counts(item), { successAudits: 1, failureAudits: expectedFailures,
                outbox: ['approve', 'reject', 'apply'].includes(item.scenario) ? 1 : 0 });
            if (item.route === 'resolve_score_sync_conflict') {
                const [rows] = await setup.execute('SELECT status FROM arena_sync_conflicts WHERE row_key=?', [item.input.rowKey]);
                if (item.scenario === 'source') assert.equal(rows[0].status, 'accept_source');
                else {
                    assert.equal(rows.length, 0);
                    const [[tracked]] = await setup.execute('SELECT source_hash FROM arena_import_rows WHERE row_key=?', [item.input.rowKey]);
                    assert.equal(tracked.source_hash, item.input.incomingHash);
                }
            } else {
                const [[log]] = await setup.execute('SELECT status,content FROM moderation_logs WHERE ID=?', [item.ID]);
                if (item.scenario === 'escalate') {
                    assert.equal(log.status, 'pending'); assert.equal(log.content.moderation.state, 'escalated');
                } else assert.equal(log.status, item.scenario === 'reject' ? 'rejected' : 'approved');
            }
        };
        for (const scenario of ['approve', 'reject', 'apply', 'escalate', 'source', 'correction']) for (let repetition = 1; repetition <= 2; repetition++) {
            const item = await fixture(scenario), key = crypto.randomUUID();
            const first = await invoke(item, key), replay = await invoke(item, key);
            assert.equal(first.success, true, JSON.stringify(first)); assert.equal(replay.success, true, JSON.stringify(replay));
            assert.equal(canonicalWritePayload(first.body), canonicalWritePayload(replay.body));
            await assertOnce(item);
            results.push({ scenario, repetition, kind: 'committed response replay', passed: true, ...await counts(item) });

            const concurrent = await fixture(scenario), concurrentKey = crypto.randomUUID();
            const deliveries = await Promise.all(Array.from({ length: 10 }, () => invoke(concurrent, concurrentKey)));
            assert.ok(deliveries.every(result => result.success), JSON.stringify(deliveries));
            assert.equal(new Set(deliveries.map(result => canonicalWritePayload(result.body))).size, 1);
            await assertOnce(concurrent);
            results.push({ scenario, repetition, kind: 'ten concurrent deliveries of one intent', passed: true, deliveries: 10, ...await counts(concurrent) });

            const competing = await fixture(scenario);
            const secondInput = structuredClone(competing.input);
            if (scenario === 'apply') secondInput.previewToken = preview(competing.log, secondInput.content, '2');
            const outcomes = await Promise.all([invoke(competing, crypto.randomUUID()), invoke(competing, crypto.randomUUID(), '2', secondInput)]);
            assert.equal(outcomes.filter(result => result.success).length, 1, JSON.stringify(outcomes));
            assert.equal(outcomes.find(result => !result.success).code,
                ['source', 'correction'].includes(scenario) ? 'sync_conflict_changed' : scenario === 'escalate' ? 'already_escalated' : 'already_reviewed');
            await assertOnce(competing, 1);
            results.push({ scenario, repetition, kind: 'different actors and intents retain genuine conflict', passed: true, ...await counts(competing) });

            const rollback = await fixture(scenario), rollbackKey = crypto.randomUUID();
            await setup.execute('INSERT INTO review_fail_keys VALUES (?)', [rollbackKey]);
            const failed = await invoke(rollback, rollbackKey);
            assert.equal(failed.success, false, JSON.stringify(failed));
            assert.deepEqual(await counts(rollback), { successAudits: 0, failureAudits: 1, outbox: 0 });
            const [[unclaimed]] = await setup.execute('SELECT COUNT(*) AS total FROM write_requests WHERE request_key=?', [rollbackKey]);
            assert.equal(Number(unclaimed.total), 0, 'Failed transaction must not retain a replay claim');
            if (rollback.route === 'resolve_score_sync_conflict') {
                const [[candidate]] = await setup.execute('SELECT status FROM arena_sync_conflicts WHERE row_key=?', [rollback.input.rowKey]);
                assert.equal(candidate.status, 'pending');
                const [[tracked]] = await setup.execute('SELECT source_hash FROM arena_import_rows WHERE row_key=?', [rollback.input.rowKey]);
                assert.equal(tracked.source_hash, 'c'.repeat(64));
            } else {
                const [[log]] = await setup.execute('SELECT status,content FROM moderation_logs WHERE ID=?', [rollback.ID]);
                assert.equal(log.status, 'pending');
                assert.equal(canonicalWritePayload(log.content), canonicalWritePayload(rollback.log.content));
            }
            await setup.execute('DELETE FROM review_fail_keys WHERE request_key=?', [rollbackKey]);
            const retry = await invoke(rollback, rollbackKey), retryReplay = await invoke(rollback, rollbackKey);
            assert.equal(retry.success, true, JSON.stringify(retry)); assert.equal(retryReplay.success, true, JSON.stringify(retryReplay));
            assert.equal(canonicalWritePayload(retry.body), canonicalWritePayload(retryReplay.body));
            await assertOnce(rollback, 1);
            results.push({ scenario, repetition, kind: 'real SQL completion failure rolls back business, audit, outbox and identity before retry',
                passed: true, ...await counts(rollback) });
        }
    } finally {
        await pool?.end();
        if (created) await setup.query(`DROP DATABASE \`${schema}\``);
        await setup.end();
    }
    console.log(JSON.stringify({ passed: results.length, total: results.length, results, codeSource: stage,
        actualDriverAndTransactions: true, actualDecisionAndSourceCallbacks: true,
        disposableSchemaCreatedAndRemoved: schema, productionApplicationTablesRead: false,
        productionApplicationTablesWritten: false, namedLocks: 'namespaced to the disposable schema',
        reviewerAuthentication: 'synthetic fixture', realOAuth: false, realEmailDelivery: false }));
}
