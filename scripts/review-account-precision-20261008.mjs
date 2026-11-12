import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { canonicalAccountID } from '../public/js/shared/account-identity.js';
import { deleteDiscussionPost, voteDiscussion } from '../discussion-service.js';
import { moderationAuditSnapshot, insertModerationAuditLog } from '../moderation-admin.js';
import { createModerationEmailService } from '../moderation-email.js';
import { createModerationMutationHarness } from './review-moderation-replay-20261008.mjs';
import { createDeadlinePool, databaseDeadlineOptions } from '../db-deadlines.js';

export const accountPairs = [
    ['9007199254740993', '9007199254740992'],
    ['18446744073709551615', '18446744073709551614']
];
export const precisionCases = ['active account', 'audit snapshot', 'reviewer audit', 'foreign discussion deletion',
    'neighbor discussion vote', 'discussion ownership', 'approve recipient', 'reject recipient', 'apply recipient'];

export async function probeActiveAccount(source, actor, returnedID = actor) {
    const calls = [];
    const context = vm.createContext({ canonicalAccountID,
        db: { execute: async (sql, args) => { calls.push({ sql, args }); return [[{ ID: returnedID, role: 'reviewer' }]]; } } });
    const start = source.indexOf('const REVIEWER_ROLES =');
    const end = source.indexOf('async function activeUserExists', start);
    assert.ok(start > 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
    context.actor = actor;
    return { user: await vm.runInContext('activeUserRecord(actor)', context), calls };
}

export async function probeDriverConfiguration(source) {
    let options;
    const context = vm.createContext({ process: { env: {} }, createDeadlinePool, databaseDeadlineOptions, mysql: { createPool(value) {
        options = value; return { promise() { return {}; } };
    } } });
    const start = source.indexOf('var pool;'), end = source.indexOf('export { pool }');
    assert.ok(start > 0 && end > start);
    vm.runInContext(source.slice(start, end).replace('export function initPool', 'function initPool'), context);
    vm.runInContext("initPool('isolated-password-not-used')", context);
    return options;
}

export async function probeDiscussionOwnership(source, actor, author, { showGitHubProfile = false, active = true } = {}) {
    const context = vm.createContext({ canonicalAccountID });
    const start = source.indexOf('async function decorate('), end = source.indexOf('export async function listDiscussion', start);
    assert.ok(start > 0 && end > start);
    vm.runInContext(source.slice(start, end), context);
    context.actor = actor;
    context.rows = [{ ID: 7, author_ID: author, context_values: {}, body: 'Isolated text', category_ID: 1, context_ID: 1,
        author_name: 'Custom public name', author_avatar_url: null, author_public_id: 'verified-user', author_github_username: 'Verified-Login',
        author_show_github_profile: showGitHubProfile ? 1 : 0, author_profile_active: active ? 1 : 0 }];
    const calls = [];
    context.connection = { execute: async (sql, args) => { calls.push({ sql, args }); return [[]]; } };
    const post = (await vm.runInContext('decorate(connection, rows, actor)', context))[0];
    assert.equal(post.authorName, 'Custom public name');
    assert.equal(Object.hasOwn(post, 'githubURL'), false);
    assert.equal(post.authorPublicID, active ? 'verified-user' : null);
    for (const key of ['author_ID', 'author_github_username', 'author_show_github_profile', 'author_profile_active']) {
        assert.equal(Object.hasOwn(post, key), false);
    }
    if (canonicalAccountID(actor)) {
        const voteRead = calls.find(call => call.sql.startsWith('SELECT post_ID, value FROM discussion_votes'));
        assert.equal(voteRead.args[0], canonicalAccountID(actor));
    }
    return post.isOwn;
}

export async function runAccountPrecisionProbe({ actor, neighbor, scenario }) {
    assert.equal(canonicalAccountID(actor), actor); assert.equal(canonicalAccountID(neighbor), neighbor);
    assert.notEqual(actor, neighbor);
    const record = { actor, neighbor, scenario, passed: false };
    try {
        if (scenario === 'active account') {
            const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
            const { user, calls } = await probeActiveAccount(source, actor);
            record.actual = user?.ID;
            assert.equal(user?.ID, actor); assert.equal(calls[0].args[0], actor);
        } else if (scenario === 'audit snapshot') {
            record.actual = moderationAuditSnapshot({ ID: 7, user_id: actor, status: 'pending' }, { type: 'feedback' }).submittedBy;
            assert.equal(record.actual, actor);
        } else if (scenario === 'reviewer audit') {
            const calls = [], recorder = { statements: [{ sql: 'SELECT 1', success: true }], elapsedMs: () => 0 };
            await insertModerationAuditLog({ execute: async (sql, args) => { calls.push({ sql, args }); return [{ insertId: 7 }]; } },
                recorder, { reviewerUserID: actor, actionType: 'approve', moderationLogID: 7, requestBefore: { content: { type: 'feedback' } } });
            record.actual = calls[0].args[1]; assert.equal(record.actual, actor);
        } else if (scenario === 'foreign discussion deletion' || scenario === 'neighbor discussion vote') {
            const writes = [];
            const connection = { beginTransaction: async () => {}, commit: async () => {}, rollback: async () => {}, release() {},
                execute: async (sql, args) => {
                    if (sql.startsWith('SELECT ID FROM users')) return [[{ ID: actor }]];
                    if (sql.startsWith('SELECT')) return [[{ ID: 7, author_ID: neighbor, deleted_at: null }]];
                    writes.push({ sql, args }); return [{ affectedRows: 1 }];
                } };
            const db = { getConnection: async () => connection };
            if (scenario === 'foreign discussion deletion') {
                let failure;
                try { await deleteDiscussionPost(db, actor, { postID: 7 }); } catch (error) { failure = error.body?.error; }
                record.actual = { failure: failure ?? null, writes: writes.length };
                assert.equal(failure, 'discussion_delete_forbidden'); assert.equal(writes.length, 0);
            } else {
                await voteDiscussion(db, actor, { postID: 7, value: 1 });
                record.actual = writes[0]?.args[1]; assert.equal(record.actual, actor); assert.equal(writes.length, 1);
            }
        } else if (scenario === 'discussion ownership') {
            const source = await readFile(new URL('../discussion-service.js', import.meta.url), 'utf8');
            record.actual = await probeDiscussionOwnership(source, actor, neighbor); assert.equal(record.actual, false);
        } else {
            const decision = scenario.split(' ')[0];
            assert.ok(['approve', 'reject', 'apply'].includes(decision));
            const harness = await createModerationMutationHarness({ scenario: decision });
            harness.log.user_id = actor;
            await harness.invoke();
            record.actual = harness.records.find(row => row.table === 'moderation_email_outbox')?.parameters[0].userID;
            assert.equal(record.actual, actor);
        }
        record.passed = true;
    } catch (error) { record.error = error.body?.error ?? error.message; }
    return record;
}

export async function probeInvalidRecipient(value) {
    const calls = [];
    const service = createModerationEmailService({ pool: {}, publicOrigin: 'https://example.test', environment: {}, transport: null });
    let rejected = false;
    try {
        await service.enqueue({ execute: async (sql, args) => {
            calls.push({ sql, args }); return sql.startsWith('SELECT') ? [[{ email: 'isolated@example.test' }]] : [{ insertId: 1 }];
        } }, { moderationLogID: 7, userID: value, decision: 'approved', contributionType: 'feedback' });
    } catch { rejected = true; }
    return { rejected, queries: calls.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const phase = process.argv.includes('--before') ? 'before' : 'after';
    const output = `artifacts/review-20261008/account-precision-${phase}`;
    const results = [];
    for (const [actor, neighbor] of accountPairs) for (const scenario of precisionCases) for (let repetition = 1; repetition <= 2; repetition++) {
        results.push({ ...await runAccountPrecisionProbe({ actor, neighbor, scenario }), repetition });
    }
    const source = await readFile(new URL('../db.js', import.meta.url), 'utf8');
    const options = await probeDriverConfiguration(source);
    await mkdir(output, { recursive: true });
    const report = { passed: results.filter(item => item.passed).length, total: results.length, results,
        driverConfiguration: { supportBigNumbers: Boolean(options.supportBigNumbers), bigNumberStrings: Boolean(options.bigNumberStrings) },
        scope: 'Actual service/auth/source/callback code with isolated SQL/session fixtures. No production rows, sessions or mail transport.' };
    await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ phase, passed: report.passed, total: report.total, driverConfiguration: report.driverConfiguration,
        failures: [...new Set(results.filter(item => !item.passed).map(item => item.scenario))] }));
    if (phase !== 'before' && (report.passed !== report.total || !options.supportBigNumbers)) process.exitCode = 1;
}
