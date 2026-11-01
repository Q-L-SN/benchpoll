import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import crypto from 'node:crypto';
import vm from 'node:vm';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8) ?? root;
assert.ok(stage === root || /^\/tmp\/benchpoll-account-review-[0-9]+$/.test(stage));
const loadRoot = path => import(pathToFileURL(`${root}/${path}`).href);
const loadApp = path => import(pathToFileURL(`${stage}/${path}`).href);
const { config: dotenv } = await loadRoot('node_modules/dotenv/lib/main.js');
dotenv({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await loadRoot('node_modules/mysql2/index.js');
const { canonicalAccountID, requireAccountWriteOwner } = await loadRoot('public/js/shared/account-identity.js');
const { readWriteIdentity, claimWriteIntent, completeWriteIntent } = await loadRoot('write-idempotency.js');
const { canonicalWritePayload } = await loadRoot('public/js/shared/write-intent.js');
const { ensureWriteRequestSchema } = await loadRoot('scripts/migrate-write-requests.mjs');
const dbSource = await readFile(`${stage}/db.js`, 'utf8');
let config;
const deadlineHelpers = dbSource.includes('databaseDeadlineOptions') ? await loadApp('db-deadlines.js') : {};
const driverContext = vm.createContext({ process, ...deadlineHelpers, mysql: { createPool(options) {
    config = options; return { promise() { return {}; } };
} } });
vm.runInContext(dbSource.slice(dbSource.indexOf('var pool;'), dbSource.indexOf('export { pool }'))
    .replace('export function initPool', 'function initPool'), driverContext);
driverContext.password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
vm.runInContext('initPool(password)', driverContext);
config = { ...config, charset: 'utf8mb4' };

if (process.argv.includes('--preflight')) {
    assert.equal(config.database, 'benchmarks');
    const connection = mysql.createConnection(config).promise();
    try {
        const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name,COLUMN_TYPE AS type FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='users' AND COLUMN_NAME='ID'`);
        assert.deepEqual(columns, [{ name: 'ID', type: 'bigint unsigned' }]);
        const [[counts]] = await connection.execute('SELECT COUNT(*) AS total FROM users WHERE ID > 9007199254740991');
        const helper = 'public/js/shared/account-identity.js';
        assert.equal(crypto.createHash('sha256').update(await readFile(`${stage}/${helper}`)).digest('hex'),
            crypto.createHash('sha256').update(await readFile(`${root}/${helper}`)).digest('hex'));
        console.log(JSON.stringify({ accountIDType: columns[0].type, accountsOutsideSafeRange: Number(counts.total),
            aggregateIdentityBoundaryReadOnly: true, userNamesOrEmailsRead: false, databaseWritten: false,
            unchangedIdentityDependencyVerified: true }));
    } finally { await connection.end(); }
} else {
    assert.equal(config.supportBigNumbers, true); assert.equal(config.bigNumberStrings, false);
    const { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } = await loadApp('moderation-admin.js');
    const { createModerationEmailService } = await loadApp('moderation-email.js');
    const schema = `benchpoll_review_identity_${Date.now()}_${crypto.randomUUID().replaceAll('-', '').slice(0, 8)}`;
    assert.match(schema, /^benchpoll_review_identity_[0-9]+_[0-9a-f]{8}$/);
    const setup = mysql.createConnection({ ...config, database: undefined }).promise();
    let created = false, pool, serial = 5000;
    const results = [], pairs = [['9007199254740993', '9007199254740992'], ['18446744073709551615', '18446744073709551614']];
    const passed = (kind, actor, repetition) => results.push({ kind, actor, repetition, passed: true });
    try {
        await setup.query(`CREATE DATABASE \`${schema}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        created = true; await setup.query(`USE \`${schema}\``);
        await setup.query(`CREATE TABLE users (ID BIGINT UNSIGNED PRIMARY KEY,email VARCHAR(255),role VARCHAR(32),
            deleted_at DATETIME NULL,banned_at DATETIME NULL,banned_until DATETIME NULL) ENGINE=InnoDB`);
        for (const ID of ['1', ...pairs.flat()]) await setup.execute("INSERT INTO users VALUES (?,?,'reviewer',NULL,NULL,NULL)", [ID, `identity-${ID}@example.test`]);
        await ensureWriteRequestSchema(setup);
        await setup.query(`CREATE TABLE moderation_logs (ID INT UNSIGNED PRIMARY KEY,status VARCHAR(32),content JSON,
            report_count INT,user_id BIGINT UNSIGNED,created_at DATETIME(3),updated_at DATETIME(3)) ENGINE=InnoDB`);
        await setup.query(`CREATE TABLE moderation_audit_logs (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            moderation_log_ID INT UNSIGNED NULL,reviewer_user_ID BIGINT UNSIGNED,action_type VARCHAR(48),request_type VARCHAR(64),
            request_summary VARCHAR(255),status_before VARCHAR(32),status_after VARCHAR(32),request_before JSON,request_after JSON,
            executed_sql LONGTEXT,database_response JSON,outcome VARCHAR(16),duration_ms INT UNSIGNED,
            FOREIGN KEY (reviewer_user_ID) REFERENCES users(ID)) ENGINE=InnoDB`);
        await setup.query(`CREATE TABLE moderation_email_outbox (ID BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
            moderation_log_ID INT UNSIGNED,user_ID BIGINT UNSIGNED,recipient_email VARCHAR(255),decision VARCHAR(32),
            contribution_type VARCHAR(64),delivery_status VARCHAR(32),next_attempt_at DATETIME(3),last_error TEXT,
            FOREIGN KEY (user_ID) REFERENCES users(ID)) ENGINE=InnoDB`);
        await setup.query('CREATE TABLE categories (ID INT PRIMARY KEY,is_active TINYINT,owner_user_ID BIGINT UNSIGNED) ENGINE=InnoDB');
        await setup.query('INSERT INTO categories VALUES (1,1,NULL)');
        await setup.query(`CREATE TABLE discussion_posts (ID INT PRIMARY KEY,author_ID BIGINT UNSIGNED,body TEXT,
            category_ID INT,context_ID INT,parent_ID INT NULL,deleted_at DATETIME(3),hidden_at DATETIME(3)) ENGINE=InnoDB`);
        await setup.query('CREATE TABLE discussion_votes (post_ID INT,user_ID BIGINT UNSIGNED,value INT,PRIMARY KEY(post_ID,user_ID)) ENGINE=InnoDB');
        await setup.query('CREATE TABLE discussion_mentions (ID INT,post_ID INT,benchmark_ID INT,condition_ID INT,label VARCHAR(255)) ENGINE=InnoDB');
        await setup.query('CREATE TABLE benchmarks (ID INT,name VARCHAR(255)) ENGINE=InnoDB');
        await setup.query('CREATE TABLE benchmark_conditions (ID INT,name VARCHAR(255)) ENGINE=InnoDB');
        pool = mysql.createPool({ ...config, database: schema }).promise();
        const source = await readFile(`${stage}/server.js`, 'utf8'), handlers = new Map();
        const transactionCleanup = source.includes("from './db-transaction.js'") ? await loadRoot('db-transaction.js') : {};
        const email = createModerationEmailService({ pool, publicOrigin: 'https://example.test', environment: {}, transport: null });
        const context = vm.createContext({ ...transactionCleanup, crypto, Buffer, URL, Date, structuredClone, canonicalAccountID,
            db: pool, sessionSecret: 'isolated-identity-preview-secret', console: { error() {} },
            readWriteIdentity, claimWriteIntent, completeWriteIntent, requireAccountWriteOwner,
            createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot,
            moderationEmailService: email, API: { post(path, ...callbacks) { handlers.set(path, callbacks); } } });
        vm.runInContext(source.slice(source.indexOf('const REVIEWER_ROLES ='), source.indexOf("page.get('/',")), context);
        const contractStart = source.indexOf('function normalizeString(');
        vm.runInContext(source.slice(contractStart, source.indexOf('async function buildExecutedModerationSQLPreview(', contractStart)), context);
        const previewStart = source.indexOf('function moderationTimestamp(');
        vm.runInContext(source.slice(previewStart, source.indexOf("API.post('/submit_contribution'", previewStart)), context);
        const helpersStart = source.indexOf('function directMutationAuditError(');
        vm.runInContext(source.slice(helpersStart, source.indexOf("API.post('/send_admin_message'", helpersStart)), context);
        for (const route of ['review_moderation_log', 'apply_moderation_log']) {
            const start = source.indexOf(`API.post('/${route}'`);
            vm.runInContext(source.slice(start, source.indexOf('\n});', start) + '\n});'.length), context);
        }
        const discussionSource = await readFile(`${stage}/discussion-service.js`, 'utf8');
        if (discussionSource.includes("from './db-transaction.js'")) {
            Object.assign(context, await loadRoot('db-transaction.js'));
        }
        vm.runInContext(discussionSource.slice(discussionSource.indexOf('const fail =')).replaceAll('export ', ''), context);
        const call = async (name, ...args) => { context.args = args; return vm.runInContext(`${name}(...args)`, context); };
        const post = async author => {
            const ID = ++serial;
            await setup.execute("INSERT INTO discussion_posts VALUES (?,?,'Isolated message',1,1,NULL,NULL,NULL)", [ID, author]);
            return ID;
        };
        for (const [actor, neighbor] of pairs) for (let repetition = 1; repetition <= 2; repetition++) {
            for (const protocol of ['query', 'execute']) {
                const [[row]] = await setup[protocol]('SELECT ID,CAST(7 AS UNSIGNED) AS safeCount,0.25E0 AS fraction FROM users WHERE ID=?', [actor]);
                assert.equal(row.ID, actor); assert.equal(row.safeCount, 7); assert.equal(row.fraction, 0.25);
                passed(`exact driver decoding and unchanged scalars: ${protocol}`, actor, repetition);
            }
            const active = await call('activeUserRecord', actor);
            assert.equal(active.ID, actor); assert.equal(active.isReviewer, true); passed('actual active-user lookup', actor, repetition);
            const postID = await post(neighbor);
            await assert.rejects(call('deleteDiscussionPost', pool, actor, { postID }), error => error.body?.error === 'discussion_delete_forbidden');
            const [[unchanged]] = await setup.execute('SELECT author_ID,body,deleted_at FROM discussion_posts WHERE ID=?', [postID]);
            assert.equal(unchanged.author_ID, neighbor); assert.equal(unchanged.body, 'Isolated message'); assert.equal(unchanged.deleted_at, null);
            await call('deleteDiscussionPost', pool, neighbor, { postID });
            passed('foreign deletion denied and own deletion succeeds', actor, repetition);
            const voteID = await post(neighbor);
            await call('voteDiscussion', pool, actor, { postID: voteID, value: 1 });
            await assert.rejects(call('voteDiscussion', pool, neighbor, { postID: voteID, value: 1 }), error => error.body?.error === 'discussion_self_vote');
            const [[vote]] = await setup.execute('SELECT user_ID,value FROM discussion_votes WHERE post_ID=?', [voteID]);
            assert.equal(vote.user_ID, actor); assert.equal(vote.value, 1); passed('neighbor vote succeeds and actual self-vote denied', actor, repetition);
            const [[raw]] = await setup.execute('SELECT * FROM discussion_posts WHERE ID=?', [voteID]);
            raw.context_values = {};
            assert.equal((await call('decorate', setup, [raw], actor))[0].isOwn, false);
            assert.equal((await call('decorate', setup, [raw], neighbor))[0].isOwn, true); passed('exact ownership display from real rows', actor, repetition);
            assert.equal(moderationAuditSnapshot({ ID: voteID, user_id: actor }, {}).submittedBy, actor);
            passed('exact audit contributor snapshot', actor, repetition);
            await setup.beginTransaction();
            const recorder = createModerationAuditRecorder(setup);
            await recorder.connection.execute('SELECT ID FROM users WHERE ID=? FOR UPDATE', [actor]);
            const auditID = await insertModerationAuditLog(setup, recorder, { reviewerUserID: actor, actionType: 'approve',
                moderationLogID: voteID, statusBefore: 'pending', statusAfter: 'approved',
                requestBefore: moderationAuditSnapshot({ ID: voteID, user_id: neighbor, status: 'pending' }, { type: 'feedback' }) });
            await setup.commit();
            const [[audit]] = await setup.execute('SELECT reviewer_user_ID,request_before FROM moderation_audit_logs WHERE ID=?', [auditID]);
            assert.equal(audit.reviewer_user_ID, actor); assert.equal(audit.request_before.submittedBy, neighbor);
            passed('exact audit identities with real foreign keys', actor, repetition);
            for (const decision of ['approve', 'reject', 'apply']) {
                const ID = ++serial, content = { schemaVersion: 1, type: 'feedback', details: 'Isolated account precision review.', pageURL: '' };
                await setup.execute("INSERT INTO moderation_logs VALUES (?,'pending',?,1,?,NOW(3),NOW(3))", [ID, JSON.stringify(content), neighbor]);
                const [[log]] = await setup.execute('SELECT * FROM moderation_logs WHERE ID=?', [ID]);
                const input = decision === 'apply' ? { ID, content: { ...content, details: 'Edited isolated account precision review.' } }
                    : { ID, status: decision === 'approve' ? 'approved' : 'rejected' };
                if (decision === 'apply') {
                    context.previewLog = log; context.edited = input.content; context.actor = actor;
                    input.previewToken = vm.runInContext(`(() => {
                        const actionAt = new Date().toISOString();
                        const content = prepareEditedModerationContent(parseModerationContent(previewLog.content), edited, actor, actionAt);
                        return createModerationPreviewToken({ moderationLogID: previewLog.ID, reviewerUserID: actor,
                            updatedAt: moderationTimestamp(previewLog.updated_at), actionAt, content });
                    })()`, context);
                }
                const key = crypto.randomUUID();
                const invoke = async () => {
                    const req = { body: { ...input, expectedUserID: actor }, session: { userID: actor }, headers: { 'idempotency-key': key } };
                    const response = { status: 200, body: null }, res = { status(value) { response.status = value; return this; }, json(value) { response.body = value; } };
                    const callbacks = handlers.get(decision === 'apply' ? '/apply_moderation_log' : '/review_moderation_log');
                    for (const middleware of callbacks.slice(0, -1)) {
                        let error, proceeded = false;
                        await middleware(req, res, value => { error = value; proceeded = true; });
                        if (error) throw error; assert.equal(proceeded, true);
                    }
                    assert.equal(req.user.ID, actor);
                    await callbacks.at(-1)(req, res);
                    return response;
                };
                const first = await invoke(), replay = await invoke();
                assert.equal(first.status, 200);
                assert.equal(canonicalWritePayload(first), canonicalWritePayload(replay));
                const [notifications] = await setup.execute('SELECT user_ID,recipient_email FROM moderation_email_outbox WHERE moderation_log_ID=?', [ID]);
                assert.equal(notifications.length, 1); assert.equal(notifications[0].user_ID, neighbor);
                assert.equal(notifications[0].recipient_email, `identity-${neighbor}@example.test`);
                const [decisions] = await setup.execute('SELECT reviewer_user_ID,request_before FROM moderation_audit_logs WHERE moderation_log_ID=?', [ID]);
                assert.equal(decisions.length, 1); assert.equal(decisions[0].reviewer_user_ID, actor);
                assert.equal(decisions[0].request_before.submittedBy, neighbor);
                passed(`actual ${decision} callback, exact recipient and actor, durable replay`, actor, repetition);
            }
            const [[ownership]] = await setup.execute('SELECT (? = ?) AS sameAccount', [actor, neighbor]);
            assert.equal(ownership.sameAccount, 0); passed('distinct account SQL string parameters', actor, repetition);
        }
        for (const invalid of [Number('9007199254740993'), '01', '1e0', '18446744073709551616']) {
            assert.equal(await call('activeUserRecord', invalid), null);
            let queries = 0;
            await assert.rejects(email.enqueue({ execute: async () => { queries++; throw new Error('Invalid identity reached SQL'); } },
                { moderationLogID: 7, userID: invalid, decision: 'approved', contributionType: 'feedback' }), /valid user ID/);
            assert.equal(queries, 0); passed('invalid or already-rounded identities rejected', String(invalid), 1);
        }
        assert.equal(results.length, 52);
    } finally {
        await pool?.end();
        if (created) await setup.query(`DROP DATABASE \`${schema}\``);
        await setup.end();
    }
    console.log(JSON.stringify({ passed: results.length, total: results.length, results, codeSource: stage,
        actualDriverAndTransactions: true, realSQLAuthRolesAndDecisionCallbacks: true,
        disposableSchemaCreatedAndRemoved: schema, productionApplicationTablesRead: false, productionApplicationTablesWritten: false,
        authentication: 'actual server role/owner middleware against disposable fixture accounts, not OAuth', realOAuth: false, realEmailDelivery: false }));
}
