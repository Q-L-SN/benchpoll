import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import * as transactionCleanup from '../db-transaction.js';
import crypto from 'node:crypto';
import { createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot } from '../moderation-admin.js';
import { requireAccountWriteOwner } from '../public/js/shared/account-identity.js';
import { readWriteIdentity, claimWriteIntent, completeWriteIntent } from '../write-idempotency.js';
import { normalizeFieldContribution, normalizeScoreFieldRequests } from '../score-field-service.js';

export async function createWriteRouteHarness({ route, source, releaseFailure = false } = {}) {
    source ??= await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const records = [], responses = [], callbacks = new Map(), notificationCalls = [];
    const writeRows = new Map();
    let serial = 0, commits = 0;
    const connection = {
        journal: [],
        async beginTransaction() { this.journal = []; },
        async execute(sql, parameters = []) {
            if (sql.includes('INSERT INTO write_requests')) {
                const [actor, key, action, payload_hash, owner_token] = parameters;
                const rowKey = `${actor}:${key}`;
                if (!writeRows.has(rowKey)) this.journal.push({ table: 'write_requests', rowKey,
                    data: { action, payload_hash, owner_token, response_status: null, response_body: null } });
                return [{ affectedRows: 1 }, []];
            }
            if (sql.includes('FROM write_requests')) {
                const rowKey = parameters.join(':');
                const row = this.journal.find(item => item.rowKey === rowKey)?.data ?? writeRows.get(rowKey);
                return [[row], []];
            }
            if (sql.includes('UPDATE write_requests SET response_status')) {
                const [status, body, actor, key] = parameters;
                const row = this.journal.find(item => item.rowKey === `${actor}:${key}`)?.data;
                assert.ok(row);
                row.response_status = status; row.response_body = body;
                return [{ affectedRows: 1 }, []];
            }
            if (sql.includes('SELECT email FROM users')) return [[{ email: 'fixture@example.test',
                email_verified_at: new Date('2026-10-08T00:00:00Z'), deleted_at: null, banned_at: null, banned_until: null }], []];
            if (/INSERT INTO (?:moderation_logs|admin_messages|moderation_audit_logs)/.test(sql)) {
                const table = sql.match(/INSERT INTO (\w+)/)[1];
                const ID = ++serial;
                this.journal.push({ table, ID, parameters });
                return [{ insertId: ID, affectedRows: 1 }, []];
            }
            throw new Error(`Unhandled isolated replay statement: ${sql}`);
        },
        async commit() {
            records.push(...this.journal);
            for (const row of this.journal) if (row.table === 'write_requests') writeRows.set(row.rowKey, row.data);
            this.journal = []; commits += 1;
        },
        async rollback() { this.journal = []; },
        release() { if (releaseFailure) throw new Error('Isolated release failure'); }, destroy() { this.journal = []; }
    };
    const passAuth = (_req, _res, next) => next();
    // These probes exercise business replay; real terms enforcement has its own tests.
    const passCurrentTerms = (_req, _res, next) => next();
    const context = vm.createContext({ ...transactionCleanup, crypto, URL, structuredClone,
        db: { getConnection: async () => connection },
        requireAuthForAPI: passAuth, requireReviewerAuthForAPI: passAuth, requireAccountWriteOwner,
        requireCurrentTermsForAPI: passCurrentTerms,
        createModerationAuditRecorder, insertModerationAuditLog, moderationAuditSnapshot,
        readWriteIdentity, claimWriteIntent, completeWriteIntent,
        normalizeFieldContribution, normalizeScoreFieldRequests,
        moderationEmailService: {
            async enqueue() { notificationCalls.push('enqueue'); throw new Error('Ordinary pending submission must not enqueue email'); },
            kick() { notificationCalls.push('kick'); throw new Error('Ordinary pending submission must not kick email'); }
        },
        requireAdminMessagesSchema: async () => {},
        prepareEntityChangeForSubmission: async (_connection, content) => content,
        validateContributionReferences: async () => {}, validateContributionStructureForSubmission: async () => {},
        validateContributionEntitiesForSubmission: async () => {}, validateModelResultForSubmission: async () => {},
        API: { post(path, ...handlers) { callbacks.set(path, handlers); } },
        console: { error() {} }
    });
    const contractsStart = source.indexOf('function normalizeString(');
    const contractsEnd = source.indexOf('function parseModerationContent(', contractsStart);
    assert.ok(contractsStart > 0 && contractsEnd > contractsStart);
    vm.runInContext(source.slice(contractsStart, contractsEnd), context);
    const emailHelpersStart = source.indexOf('async function enqueueModerationDecisionEmail(');
    const emailHelpersEnd = source.indexOf('function getModerationStatus(', emailHelpersStart);
    assert.ok(emailHelpersStart > 0 && emailHelpersEnd > emailHelpersStart);
    vm.runInContext(source.slice(emailHelpersStart, emailHelpersEnd), context);
    const helpersStart = source.indexOf('function directMutationAuditError(');
    const helpersEnd = source.indexOf("API.post('/send_admin_message'", helpersStart);
    vm.runInContext(source.slice(helpersStart, helpersEnd), context);
    const start = source.indexOf(`API.post('/${route}'`);
    const end = source.indexOf('\n});', start) + '\n});'.length;
    assert.ok(start >= 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
    const handlers = callbacks.get(`/${route}`);
    assert.equal(handlers.length, 4, 'Auth, owner and terms guards stay registered');
    assert.equal(handlers[1], requireAccountWriteOwner);
    assert.equal(handlers[2], passCurrentTerms);
    return {
        records, responses,
        async invoke(body, key) {
            const req = { body: { ...body }, session: { userID: '1' },
                user: { ID: '1', isSenior: false }, headers: { 'idempotency-key': key },
                get(name) { return this.headers[name.toLowerCase()]; } };
            const response = { status: 200, body: null };
            const res = { status(value) { response.status = value; return this; },
                json(value) { response.body = value; }, end() {} };
            for (const handler of handlers.slice(0, -1)) {
                let error; handler(req, res, value => { error = value; }); if (error) throw error;
            }
            await handlers.at(-1)(req, res);
            return response;
        },
        summary() {
            const table = route === 'submit_contribution' ? 'moderation_logs' : 'admin_messages';
            return { route, recordCount: records.filter(record => record.table === table).length, commits,
                emailEnqueues: notificationCalls.filter(call => call === 'enqueue').length,
                emailKicks: notificationCalls.filter(call => call === 'kick').length };
        }
    };
}

export async function runWriteReplayProbe({ route, source } = {}) {
    const harness = await createWriteRouteHarness({ route, source });
    const body = route === 'submit_contribution'
        ? { type: 'feedback', details: 'One user feedback intent.', pageURL: '' }
        : { body: 'One reviewer message intent.' };
    const key = '2535c09f-f7ac-4f02-8f79-45ffda82fefe';
    for (let attempt = 1; attempt <= 2; attempt++) {
        const response = await harness.invoke({ ...body, expectedUserID: '1' }, key);
        // The first server result is committed but never delivered to the synthetic browser.
        harness.responses.push({ attempt, delivered: attempt === 2, ...response });
    }
    const summary = harness.summary();
    return { ...summary, expectedRecords: 1, responses: harness.responses,
        passed: summary.recordCount === 1 && summary.emailEnqueues === 0 && summary.emailKicks === 0,
        scope: 'Actual route callbacks, contribution parser, owner guard and audit recorder; simulated SQL and discarded first response. No real authentication or production writes.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const observe = process.argv.includes('--observe');
    const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
        ?? 'artifacts/review-20261008/write-replay-before';
    const results = [];
    for (const route of ['submit_contribution', 'send_admin_message']) for (let repetition = 1; repetition <= 2; repetition++) {
        const result = { ...await runWriteReplayProbe({ route }), repetition };
        results.push(result);
        console.log(JSON.stringify(result));
    }
    await mkdir(output, { recursive: true });
    await writeFile(`${output}/results.json`, JSON.stringify({ passed: results.filter(value => value.passed).length,
        total: results.length, results }, null, 2));
    if (!observe && results.some(value => !value.passed)) process.exitCode = 1;
}
