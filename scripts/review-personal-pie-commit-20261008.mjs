import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { postJSON } from '../public/js/shared/http.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { cloneEntries, cloneFallbackRules } from '../public/js/workspace/weights.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { accountWriteError, isAccountWriteError } from '../public/js/shared/account-identity.js';
import { familyKey, portableFamilyEntry } from '../public/js/shared/benchmark-families.js';

const root = resolve('.');
const output = resolve('artifacts/review-20261008/personal-pie-commit-20261008');
const frozen = join(output, 'before');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);

async function capture() {
    const files = (await readdir(root)).filter(file => file.endsWith('.js'));
    async function collect(dir) {
        for (const entry of await readdir(join(root, dir), { withFileTypes: true })) {
            const file = dir + '/' + entry.name;
            if (entry.isDirectory()) await collect(file);
            else if (entry.name.endsWith('.js')) files.push(file);
        }
    }
    await collect('public/js');
    files.push('package.json');
    const hashes = {};
    for (const file of files.sort()) {
        const bytes = await readFile(join(root, file));
        hashes[file] = sha(bytes);
        await mkdir(dirname(join(frozen, file)), { recursive: true });
        await writeFile(join(frozen, file), bytes, { flag: 'wx' });
    }
    await writeFile(join(output, 'baseline.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
        hashes, productionAccess: false, databaseChanged: false }, null, 2), { flag: 'wx' });
    return hashes;
}

function fakeDatabase({ conflict = false } = {}) {
    const events = [], bodies = [];
    let deleted = false, committed = false, borrows = 0;
    const failure = { status: 503, body: { error: 'fixture_ranking_read_failed' } };
    const connection = {
        async beginTransaction() { events.push('begin'); },
        async commit() { events.push('commit'); committed = true; },
        async rollback() { events.push('rollback'); deleted = false; },
        release() { events.push('release'); },
        destroy() { events.push('destroy'); },
        async execute(sql, params) {
            if (/SELECT ID\s+FROM users/.test(sql)) return [[{ ID: '7' }], []];
            if (/FROM categories WHERE ID = \?/.test(sql)
                || sql.includes('FROM categories c LEFT JOIN users creator') && sql.endsWith('WHERE c.ID = ? AND c.is_active = 1')) return [[{
                ID: 1, parent_ID: null, name: 'Intelligence', slug: 'intelligence', description: 'Compare general intelligence benchmarks.',
                position: 0, owner_user_ID: null, created_by_user_ID: null, creator_name: null, creator_avatar: null }], []];
            if (/COUNT\(\*\) AS count FROM categories/.test(sql)) return [[{ count: 1 }], []];
            if (/FROM ranking_contexts/.test(sql)) return [[{ ID: 10 }], []];
            if (/SELECT ID, revision\s+FROM personal_pies/.test(sql)) return [[{ ID: 70, revision: conflict ? 2 : 1 }], []];
            if (/SELECT family_ID FROM personal_pie_score_rules/.test(sql)) return [[], []];
            if (/DELETE FROM personal_pies/.test(sql)) {
                assert.deepEqual(params, [70]); events.push('delete'); deleted = true;
                return [{ affectedRows: 1 }, []];
            }
            throw new Error('Unexpected fixture SQL: ' + sql);
        }
    };
    const db = { async getConnection() {
        borrows += 1;
        if (borrows === 1) return connection;
        events.push('ranking-read'); throw failure;
    } };
    return { db, events, bodies, failure, get deleted() { return deleted; },
        get committed() { return committed; }, get borrows() { return borrows; } };
}

async function run() {
    const hashes = process.argv.includes('--capture') ? await capture()
        : JSON.parse(await readFile(join(output, 'baseline.json'), 'utf8')).hashes;
    for (const [file, expected] of Object.entries(hashes)) assert.equal(sha(await readFile(join(frozen, file))), expected);
    const { savePersonalPie } = await import(pathToFileURL(join(frozen, 'ranking-service.js')).href);
    const source = await readFile(join(frozen, 'public/js/home-workspace.js'), 'utf8');
    const left = source.indexOf('async function persistPersonalPie(');
    const right = source.indexOf('async function applyWorkspaceState(', left);
    assert.ok(left >= 0 && right > left);
    const code = source.slice(left, right) + '\npersistPersonalPie';
    const originalFetch = globalThis.fetch;
    const results = [];
    for (let repeat = 1; repeat <= 2; repeat++) {
        for (const scenario of ['committed-read-failure', 'revision-conflict-control', 'old-context-error']) {
            const fixture = fakeDatabase({ conflict: scenario === 'revision-conflict-control' });
            const state = createWorkspaceState();
            Object.assign(state, { authenticated: true, userID: '7', categoryID: 1,
                selectedContextValues: {}, mode: 'personal', personalEditVersion: 1, personalRevision: 1,
                personalEntries: [], serverPersonalEntries: [{ conditionID: 21, weightBasisPoints: 10000 }],
                comparisonRequest: null, personalRankingDirty: true });
            let clearHistory = 0, renderCount = 0;
            const globals = {
                state, Number, Map, Set, guestDrafts: new Map(), hiddenPersonalBenchmarkIDs: new Set([21]),
                pendingFallbackSave: false, fallbackSaveFailed: false, FALLBACK_RULE_MODE: 'ordered',
                window: { clearTimeout() {}, setTimeout() { return 0; } },
                workspaceContextFingerprint: (categoryID = state.categoryID) => String(categoryID),
                currentBenchmarkFilters: () => ({ benchmarkQuery: '', pinPersonal: false, groupVersions: false }),
                cloneEntries, cloneFallbackRules, portableFamilyEntry, validateWorkspacePayload,
                accountWriteError, isAccountWriteError,
                fallbackSignature: rules => rules.map(rule => familyKey(rule.primaryConditionID, rule.entries)).join('\n'),
                invalidSavedComparison: () => false, waitForGestureToSettle: async () => {},
                postJSON, setStatus(message) { state.statusMessage = message; },
                renderAll() { renderCount += 1; }, updateUndoState() {}, renderInlineFallback() {}, renderModels() {},
                requestLogin() { assert.fail('Authenticated fixture must not request login'); },
                applyServerWorkspace() { assert.fail('No successful workspace exists in this fixture'); }
            };
            state.editHistory.clear = () => { clearHistory += 1; };
            globalThis.fetch = async (path, options) => {
                assert.equal(path, '/api/save_personal_pie');
                const body = JSON.parse(options.body); fixture.bodies.push(body);
                assert.equal(body.expectedUserID, '7'); assert.equal(body.expectedRevision, 1);
                assert.deepEqual(body.entries, []);
                try {
                    await savePersonalPie(fixture.db, { ...body, userID: '7' });
                    assert.fail('Expected the injected ranking read or revision check to reject');
                } catch (error) {
                    if (scenario === 'old-context-error') {
                        state.categoryID = 2; state.statusMessage = 'Replacement context ready';
                        state.personalRankingError = '';
                    }
                    assert.ok([409, 503].includes(error.status), JSON.stringify(error));
                    return new Response(JSON.stringify(error.body), { status: error.status,
                        headers: { 'Content-Type': 'application/json' } });
                }
            };
            try {
                const persist = vm.runInNewContext(code, globals);
                const returned = await persist();
                const healthyControl = scenario === 'revision-conflict-control';
                if (healthyControl) {
                    assert.equal(fixture.committed, false); assert.equal(fixture.deleted, false);
                    assert.deepEqual(fixture.events, ['begin', 'rollback', 'release']);
                } else {
                    assert.equal(fixture.committed, true); assert.equal(fixture.deleted, true);
                    assert.deepEqual(fixture.events, ['begin', 'delete', 'commit', 'release', 'ranking-read']);
                    assert.equal(returned, false);
                    assert.match(state.statusMessage, /not saved/);
                    assert.equal(state.personalEntries.length, 1);
                    assert.equal(clearHistory, 1);
                    if (scenario === 'old-context-error') assert.ok(state.personalRankingError);
                }
                results.push({ scenario, repeat, healthyControl, violationObserved: !healthyControl,
                    returned, databaseCommitted: fixture.committed, pieDeletedInFixture: fixture.deleted,
                    borrowCount: fixture.borrows, events: fixture.events, wireBodies: fixture.bodies,
                    frontendStatus: state.statusMessage, frontendEntries: state.personalEntries,
                    historyCleared: clearHistory, renderCount, categoryID: state.categoryID,
                    rankingError: state.personalRankingError });
            } finally { globalThis.fetch = originalFetch; }
        }
    }
    const drift = [];
    for (const [file, expected] of Object.entries(hashes)) if (sha(await readFile(join(root, file))) !== expected) drift.push(file);
    const file = join(output, arg('report') ?? 'reproduction.json');
    await writeFile(file, JSON.stringify({ recordedAt: new Date().toISOString(), phase: 'before',
        repeated: 2, results, sourceDrift: drift, frozenSource: frozen,
        scope: 'Actual frozen service function, SQL lifecycle, frontend save function, HTTP helper and wire JSON with a synthetic database and transport. No production requests or persisted user data.' }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ report: file, violations: results.filter(result => result.violationObserved).length,
        controls: results.filter(result => result.healthyControl).length, sourceDrift: drift }));
}

await run();
