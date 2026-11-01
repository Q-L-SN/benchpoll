import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile, access } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createDiscussionPost, deleteDiscussionPost, voteDiscussion, listDiscussion } from '../discussion-service.js';
import { createPrivateCategory, preserveRemovedPersonalPies } from '../private-category-service.js';
import { saveComparisonProfile, renameComparisonProfile } from '../comparison-profiles.js';
import { getPersonalNavigation } from '../navigation-service.js';
import { getRankingWorkspace, savePersonalPie } from '../ranking-service.js';
import { getBenchmarkScores } from '../benchmark-scores.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';

export const cleanupCases = ['discussion create', 'discussion vote', 'discussion delete', 'discussion read',
    'private category create', 'private pie preserve', 'comparison save', 'comparison rename',
    'personal navigation', 'ranking workspace', 'personal pie save', 'model evidence',
    'logout current', 'logout all', 'delete account', 'benchmark scores'];
export const cleanupFailures = ['begin rollback failure', 'work rollback failure', 'work release failure'];

async function routeCallback(name, db, serverSource) {
    const source = serverSource ?? await readFile(new URL('../server.js', import.meta.url), 'utf8');
    let helpers = {};
    const helperURL = new URL('../db-transaction.js', import.meta.url);
    try { await access(helperURL); helpers = await import(helperURL); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    const start = source.indexOf(`API.post('/${name}'`);
    assert.ok(start >= 0);
    const end = source.indexOf('\n});', start);
    assert.ok(end > start);
    let callback;
    const context = vm.createContext({ ...helpers, db,
        API: { post(_path, ...handlers) { callback = handlers.at(-1); } },
        requireAuthForAPI() {}, requireAccountWriteOwner() {},
        requireCurrentTermsForAPI(_req, _res, next) { next(); },
        normalizeRequiredPositiveInteger: value => Number(value), normalizeExpectedEvidence: () => null,
        loadScoreFieldCatalog, console, Date, Number, Object, JSON });
    const helperStart = source.indexOf('async function deleteAllStoredUserSessions(');
    vm.runInContext(source.slice(helperStart, source.indexOf('const REVIEWER_ROLES', helperStart)), context);
    vm.runInContext(source.slice(start, end + 5), context);
    return callback;
}

export async function runCleanupProbe({ scenario, failure, serverSource }) {
    const original = Object.assign(new Error('synthetic_operation_failure'), {
        code: 'ISOLATED_OPERATION_FAILURE', status: 409, body: { error: 'synthetic_operation_failure' }
    });
    const events = [], messages = [];
    let active = false;
    const beginFailure = failure.startsWith('begin');
    const releaseFailure = failure.includes('release');
    const cleanupError = Object.assign(new Error('synthetic_cleanup_failure'), { code: 'ISOLATED_CLEANUP_FAILURE' });
    const connection = {
        async beginTransaction() { events.push('begin'); active = true; if (beginFailure) throw original; },
        async query(sql) {
            events.push('query');
            if (sql.startsWith('SET TRANSACTION')) { if (beginFailure) throw original; return [[]]; }
            if (sql.startsWith('START TRANSACTION')) return this.beginTransaction();
            throw original;
        },
        async execute() { events.push('execute'); throw original; },
        async commit() { events.push('commit'); active = false; },
        async rollback() {
            events.push('rollback');
            if (!releaseFailure) throw cleanupError;
            active = false;
        },
        release() {
            events.push(active ? 'release unsafe' : 'release');
            if (releaseFailure) throw cleanupError;
        },
        destroy() { events.push('destroy'); active = false; }
    };
    const db = { async getConnection() { events.push('borrow'); return connection; }, async execute(sql) {
        if (sql.includes('FROM score_fields') || sql.includes('FROM score_field_options')) return [[]];
        if (sql.includes('FROM models')) return [[{ ID: 1, name: 'Isolated model' }]];
        throw new Error(`Unexpected nontransactional fixture query: ${sql}`);
    } };
    const operations = {
        'discussion create': () => createDiscussionPost(db, '1', { text: 'Isolated message', mentions: [], categoryID: 1, contextValues: {} }),
        'discussion vote': () => voteDiscussion(db, '1', { postID: 1, value: 1 }),
        'discussion delete': () => deleteDiscussionPost(db, '1', { postID: 1 }),
        'discussion read': () => listDiscussion(db, '1', { categoryID: 1, contextValues: {} }),
        'private category create': () => createPrivateCategory(db, '1', {
            name: 'Isolated category', description: 'An isolated personal benchmark comparison.' }),
        'private pie preserve': () => preserveRemovedPersonalPies(db, '1'),
        'comparison save': () => saveComparisonProfile(db, '1', { name: 'Isolated profile', comparison: { mode: 'best', keys: ['model'], filters: [] } }),
        'comparison rename': () => renameComparisonProfile(db, '1', 'Old', 'New'),
        'personal navigation': () => getPersonalNavigation(db, '1'),
        'ranking workspace': () => getRankingWorkspace(db, { categoryID: 1, userID: '1' }),
        'benchmark scores': () => getBenchmarkScores(db, { benchmarkID: 1, conditionID: 1 }),
        'personal pie save': () => savePersonalPie(db, { categoryID: 1, userID: '1', expectedRevision: 0, entries: [], fallbackRules: [], contextValues: {} })
    };
    const priorLogger = console.error;
    console.error = (...items) => messages.push(items.map(String));
    let caught;
    try {
        if (operations[scenario]) await operations[scenario]();
        else {
            const route = scenario === 'model evidence' ? 'get_approved_benchmark_results' : scenario === 'delete account' ? 'delete_account' : 'logout';
            const callback = await routeCallback(route, db, serverSource);
            await callback({ session: { userID: '1' }, sessionID: 'isolated',
                query: scenario === 'logout all' ? { all: '' } : {}, body: { modelID: 1 } }, {}, () => {});
        }
    } catch (error) { caught = error; }
    finally { console.error = priorLogger; }
    return { scenario, failure, originalErrorPreserved: caught === original,
        unsafeRelease: events.includes('release unsafe'), destroyed: events.filter(event => event === 'destroy').length,
        events, cleanupMessages: messages, actualError: caught?.body?.error ?? caught?.message,
        passed: caught === original && !events.includes('release unsafe') && events.includes('destroy') };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const phase = process.argv.includes('--before') ? 'before' : 'after';
    const results = [];
    for (const scenario of cleanupCases) for (const failure of cleanupFailures) for (let repetition = 1; repetition <= 2; repetition++) {
        results.push({ ...await runCleanupProbe({ scenario, failure }), repetition });
    }
    const output = `artifacts/review-20261008/transaction-cleanup-${phase}`;
    await mkdir(output, { recursive: true });
    const report = { passed: results.filter(check => check.passed).length, total: results.length, results,
        scope: 'Actual service exports and actual server route callbacks with isolated SQL/session prerequisites and injected cleanup errors; no production mutation.' };
    await writeFile(`${output}/results.json`, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ passed: report.passed, total: report.total, report: `${output}/results.json` }));
    if (phase === 'after' && report.passed !== report.total) process.exitCode = 1;
}
