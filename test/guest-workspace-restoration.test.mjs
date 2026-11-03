import { estimationRequest, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test, { before, after } from 'node:test';
import vm from 'node:vm';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';

// Point this at a frozen source tree to keep pre-fix failures reproducible.
const root = fileURLToPath(new URL('../', import.meta.url));
const sourceRoot = resolve(process.env.GUEST_WORKSPACE_RESTORATION_SOURCE_DIR ?? root);
const source = await readFile(join(sourceRoot, 'public/js/home-workspace.js'), 'utf8');
const actualModule = relative => import(pathToFileURL(join(sourceRoot, relative)).href);
const { chartWeightMode } = source.includes('chartWeightMode') ? await actualModule('public/js/workspace/chart-workspace.js') : {};
const { createWorkspaceState } = await actualModule('public/js/workspace/state.js');
const { createGuestDraftStore } = await actualModule('public/js/workspace/guest-drafts.js');
const { createPersonalPieRecovery } = await actualModule('public/js/workspace/pie-recovery.js');
const { validateWorkspacePayload } = await actualModule('public/js/workspace/contracts.js');
const { cloneEntries, cloneFallbackRules } = await actualModule('public/js/workspace/weights.js');
const { readRankingContext } = await actualModule('public/js/shared/ranking-url.js');
const { comparisonProfileKey } = await actualModule('public/js/shared/comparison-profile-key.js');
const { accountWriteError } = await actualModule('public/js/shared/account-identity.js');
const { postJSON } = await actualModule('public/js/shared/http.js');
const constants = await actualModule('public/js/workspace/constants.js');

function block(start, end) {
    const left = source.indexOf(start);
    const right = source.indexOf(end, left + start.length);
    assert.ok(left >= 0 && right > left, `Missing actual source block: ${start}`);
    return source.slice(left, right);
}

const code = [
    ...(source.includes('function loadOverviewFirstPage(') ? [block('function loadOverviewFirstPage(', 'function renderPie(')] : []),
    block('function currentPieEntries()', 'function resetPieVisualState()'),
    block('function sameContextValues(', 'function syncContextValuesToURL()'),
    block('const defaultComparison =', 'initializeMobilePanels('),
    block('function invalidateRankingPages()', 'let rankingRecovery ='),
    block('function applyServerWorkspace(', 'function workspaceLoadErrorMessage('),
    block('async function loadWeightedWorkspace(', 'async function previewGuestPersonalPie('),
    '({ load: loadWeightedWorkspace, fingerprint: workspaceContextFingerprint })'
].join('\n');

const originalFetch = globalThis.fetch;
before(() => {
    globalThis.fetch = () => { throw new Error('Live network access is forbidden in guest restoration tests.'); };
});
after(() => { globalThis.fetch = originalFetch; });

const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
const contextKey = budget => `1:${JSON.stringify([['budget', budget]])}`;
const draftA = { entries: [{ conditionID: 1, weightBasisPoints: 10000 }], fallbackRules: [] };
const draftB = { entries: [{ conditionID: 1, weightBasisPoints: 5000 },
    { conditionID: 2, weightBasisPoints: 5000 }], fallbackRules: [] };
const failure = (status, error) => Object.assign(new Error(error), { status, payload: { error } });
const isTimeout = error => error?.name === 'TimeoutError' && error.code === 'request_timeout';
const httpResponse = (value, status = 200) => ({ status, ok: status >= 200 && status < 300,
    headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => value });
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}

function createHarness(t, { reconcile = false, realHTTP = false } = {}) {
    const state = createWorkspaceState();
    Object.assign(state, { categoryID: 1, categoryPath: 'Language-models', mode: 'personal',
        selectedContextValues: reconcile ? {} : { budget: 'standard' },
        comparisonRequest: { mode: 'best', keys: ['model'], filters: [] } });
    const stored = new Map();
    const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value) };
    const guestDrafts = createGuestDraftStore(() => storage);
    const pieRecovery = createPersonalPieRecovery({ state, guestDrafts, getStorage: () => storage,
        snapshot: () => ({ entries: state.personalEntries, fallbackRules: state.personalFallbackRules }) });
    for (const budget of ['standard', 'extended']) guestDrafts.set(contextKey(budget), draftA);
    const fixture = createFixtureState({ authenticated: false });
    const requests = [], applied = [], errors = [], recoveries = [], recoveryBarriers = [], tasks = [], transports = [];
    const location = { search: reconcile ? '?context_budget=extended' : '',
        href: 'https://offline.invalid/Language-models', pathname: '/Language-models', origin: 'https://offline.invalid' };
    const payload = body => validateWorkspacePayload(workspace(fixture, body), { initialMode: body.initialMode });
    const globals = { estimationRequest, normalizeEstimationAlgorithm,
        ...constants, state, structuredClone, URL, URLSearchParams, Map, Set, Date, Number, guestDrafts, pieRecovery,
        workspaceLoadFailed: false, comparisonProfileFailure: null, comparisonProfileLoadError: '',
        comparisonProfilesReady: Promise.resolve(true), pendingFallbackSave: false,
        lowCoverageExpanded: false, otherConditionsExpanded: false, hiddenPersonalBenchmarkIDs: new Set(),
        benchmarkSearch: { value: '' }, benchmarkRows: { scrollTop: 0 }, modelRows: { scrollTop: 0 },
        benchmarkFallbackCatalogue: { invalidate() {}, setSnapshot() {} },
        comparisonControls: { render() {}, resetToDefault() {} },
        navigationChannel: { publish(detail) {
            applied.push({ detail: structuredClone(detail), snapshotID: state.rankingPagination.snapshotID,
                entries: structuredClone(state.personalEntries), comparison: structuredClone(state.comparison) });
        } },
        window: { location, queueMicrotask() {}, setTimeout: (...args) => globalThis.setTimeout(...args),
            clearTimeout: timer => globalThis.clearTimeout(timer) },
        console: { error() {}, warn() {} },
        validateWorkspacePayload, readRankingContext, cloneEntries, cloneFallbackRules, comparisonProfileKey, accountWriteError, chartWeightMode,
        finishPendingWeightAdjustments: async () => true, flushPendingPersonalPieSave: async () => true,
        registerPieEntries() {}, resetPieVisualState() {}, syncContextValuesToURL() {}, updateDiscussionEntry() {},
        renderAll() {}, renderScoringControls() {}, revealBenchmarkRow() {}, reloadBenchmarkPage() {},
        rankingRecoveryScope: () => 'unused-no-page-recovery',
        setStatus(message) { state.statusMessage = message; },
        renderLoadError(error) { errors.push(error); state.loading = false; globals.workspaceLoadFailed = true; },
        postJSON(route, body, options) {
            assert.equal(route, '/api/get_weighted_workspace', 'Only synthetic read requests are permitted.');
            const request = { ...deferred(), route, body: structuredClone(body), options: options && { ...options },
                payload: payload(body) };
            requests.push(request);
            return realHTTP ? postJSON(route, body, options) : request.promise;
        }
    };
    const context = vm.createContext(globals);
    const api = vm.runInContext(code, context, { timeout: 1000 });
    const actualRecovery = context.recoverComparison;
    context.recoverComparison = async (...args) => {
        recoveries.push(args[0]);
        const barrier = deferred(); recoveryBarriers.push(barrier);
        await actualRecovery(...args);
        // Keep the async completion boundary controllable without writing a retired profile.
        await barrier.promise;
    };
    const h = { state, requests, applied, errors, recoveries, transports, guestDrafts, location, payload,
        readDraft: budget => createGuestDraftStore(() => storage).get(contextKey(budget)),
        load(options) {
            const task = { settled: false };
            task.promise = api.load(options);
            task.promise.then(() => { task.settled = true; }, error => { task.settled = true; task.error = error; });
            tasks.push(task);
            return task;
        },
        async respond(index) { requests[index].resolve(requests[index].payload); await flush(); },
        async reject(index, error) { requests[index].reject(error); await flush(); },
        async finishRecovery(index = 0) {
            recoveryBarriers[index].resolve();
            await flush();
        }
    };
    // Failure cleanup must not let a dangling baseline request escape into a later test or live fetch.
    t.after(async () => {
        state.selectedContextValues = {};
        location.search = '';
        for (const budget of ['standard', 'extended']) guestDrafts.delete(contextKey(budget));
        for (let turn = 0; turn < 6 && tasks.some(task => !task.settled); turn++) {
            state.loadSequence++;
            for (const request of requests) request.resolve(request.payload);
            for (const transport of transports) transport.resolveLate();
            for (const barrier of recoveryBarriers) barrier.resolve();
            await flush();
        }
        assert.ok(tasks.every(task => task.settled), 'Every controlled load must be retired and drained.');
    });
    return h;
}

async function restoreLatest(h, requestIndex) {
    const latest = h.load({ preserveUndo: true });
    await flush();
    assert.equal(h.requests.length, requestIndex + 1);
    await h.respond(requestIndex);
    assert.equal(h.requests.length, requestIndex + 2);
    assert.deepEqual(plain(h.requests[requestIndex + 1].body.previewPersonalPie), draftB);
    await h.respond(requestIndex + 1);
    assert.equal(latest.settled, true);
    await latest.promise;
    assert.equal(h.applied.length, 1);
    assert.deepEqual(h.readDraft('standard'), draftB);
    return latest;
}

function assertRestored(h, snapshotID) {
    assert.equal(h.applied.length, 1, 'Only the latest restored workspace may apply.');
    assert.equal(h.errors.length, 0, 'Obsolete errors cannot replace the latest workspace.');
    assert.equal(h.state.rankingPagination.snapshotID, snapshotID);
    assert.deepEqual(h.readDraft('standard'), draftB);
    assert.deepEqual(plain(h.state.personalEntries.map(entry => ({ conditionID: entry.conditionID,
        weightBasisPoints: entry.weightBasisPoints }))), draftB.entries);
    assert.equal(h.state.usingGuestDraft, true);
    assert.equal(h.state.loading, false);
}

const staleErrors = [
    [400, 'invalid_ranking_pin'], [404, 'category_not_found'], [400, 'comparison_keys_unavailable'],
    [400, 'pie_benchmark_condition_not_found'], [404, 'pie_benchmark_condition_not_found']
];
const comparisonErrors = ['comparison_keys_unavailable', 'invalid_comparison_filter_key', 'comparison_model_unavailable',
    'invalid_comparison_keys', 'invalid_comparison_filters', 'score_field_option_unavailable'];

for (let repetition = 1; repetition <= 2; repetition++) {
    const run = (name, callback) => test(`${name} (${repetition})`, { timeout: 2000 }, callback);

    run('reconciliation and preview use immutable category/context/comparison/mode/score/URL snapshots', async t => {
        const h = createHarness(t, { reconcile: true });
        h.state.scoreMode = 'range';
        const loading = h.load();
        await flush();
        Object.assign(h.state, { categoryID: 2, selectedContextValues: { budget: 'standard' }, scoreMode: 'available', mode: 'public' });
        h.state.comparisonRequest.keys.push('field:1');
        h.location.search = '?context_budget=standard';
        await h.respond(0);
        assert.equal(h.requests.length, 2, 'The originally captured URL still requires reconciliation.');
        const expected = { categoryID: 1, contextValues: { budget: 'extended' },
            comparison: { mode: 'best', keys: ['model'], filters: [] }, scoreMode: 'range', initialMode: 'personal' };
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(plain(h.requests[1].body[key]), value, key);
        await h.respond(1);
        assert.equal(h.requests.length, 3);
        for (const [key, value] of Object.entries(expected)) assert.deepEqual(plain(h.requests[2].body[key]), value, key);
        await h.respond(2);
        assert.equal(loading.settled, true);
        await loading.promise;
        assert.equal(h.applied.length, 1);
        assert.equal(h.errors.length, 0);
    });

    for (const nextPhase of ['reconciliation', 'preview']) {
        run(`obsolete base cannot dispatch ${nextPhase}`, async t => {
            const h = createHarness(t);
            if (nextPhase === 'reconciliation') h.state.selectedContextValues = { budget: 'extended' };
            const old = h.load(); await flush();
            h.state.selectedContextValues = { budget: 'standard' };
            h.guestDrafts.set(contextKey('standard'), draftB);
            await restoreLatest(h, 1);
            const snapshot = h.state.rankingPagination.snapshotID;
            await h.respond(0);
            assert.equal(h.requests.length, 3, 'No follow-up request is allowed after the obsolete base await.');
            assert.equal(old.settled, true);
            await old.promise;
            assertRestored(h, snapshot);
        });
    }

    run('obsolete reconciled response cannot dispatch preview or apply', async t => {
        const h = createHarness(t, { reconcile: true });
        const old = h.load(); await flush(); await h.respond(0);
        assert.equal(h.requests.length, 2);
        assert.equal(h.requests[1].body.contextValues.budget, 'extended');
        h.state.selectedContextValues = { budget: 'standard' }; h.location.search = '';
        h.guestDrafts.set(contextKey('standard'), draftB);
        await restoreLatest(h, 2);
        const snapshot = h.state.rankingPagination.snapshotID;
        await h.respond(1);
        assert.equal(h.requests.length, 4, 'Reconciliation must check its generation before preview.');
        assert.equal(old.settled, true);
        await old.promise;
        assertRestored(h, snapshot);
    });

    for (const [status, error] of staleErrors) {
        run(`obsolete pending preview ${status} ${error} cannot erase B's restored draft`, async t => {
            const h = createHarness(t);
            const old = h.load(); await flush(); await h.respond(0);
            assert.equal(h.requests.length, 2);
            h.guestDrafts.set(contextKey('standard'), draftB);
            await restoreLatest(h, 2);
            const snapshot = h.state.rankingPagination.snapshotID;
            await h.reject(1, failure(status, error));
            assert.equal(old.settled, true);
            await old.promise;
            assert.equal(h.requests.length, 4);
            assert.equal(h.recoveries.length, 0, 'An obsolete comparison failure must not recover.');
            assertRestored(h, snapshot);
        });
    }

    run('obsolete successful preview cannot overwrite B', async t => {
        const h = createHarness(t);
        const old = h.load(); await flush(); await h.respond(0);
        h.guestDrafts.set(contextKey('standard'), draftB);
        await restoreLatest(h, 2);
        const snapshot = h.state.rankingPagination.snapshotID;
        await h.respond(1);
        assert.equal(old.settled, true);
        await old.promise;
        assertRestored(h, snapshot);
    });

    for (const error of comparisonErrors) {
        run(`current preview 400 ${error} recovers comparison without discarding draft`, async t => {
            const h = createHarness(t);
            const loading = h.load(); await flush(); await h.respond(0);
            await h.reject(1, failure(400, error));
            assert.equal(h.recoveries.length, 1, 'The actual recoverComparison helper must be reached.');
            assert.equal(h.recoveries[0].payload.error, error);
            assert.deepEqual(h.readDraft('standard'), draftA);
            assert.equal(h.applied.length, 0, 'Do not apply an empty base workspace during recovery.');
            assert.equal(h.requests.length, 2, 'Recovery completion must precede the retry.');
            await h.finishRecovery();
            assert.equal(h.requests.length, 3);
            await h.respond(2); assert.equal(h.requests.length, 4); await h.respond(3);
            assert.equal(loading.settled, true);
            await loading.promise;
            assert.deepEqual(h.readDraft('standard'), draftA);
            assert.equal(h.state.personalEntries.length, 1);
            assert.equal(h.state.usingGuestDraft, true);
            assert.equal(h.errors.length, 0);
            assert.equal(h.applied.length, 1);
        });
    }

    for (const [status, error] of [[400, 'invalid_ranking_pin'], [400, 'invalid_comparison_options'], [404, 'category_not_found']]) {
        run(`unrelated current preview ${status} ${error} preserves valid draft`, async t => {
            const h = createHarness(t);
            const loading = h.load(); await flush(); await h.respond(0); await h.reject(1, failure(status, error));
            assert.equal(loading.settled, true);
            await loading.promise;
            assert.deepEqual(h.readDraft('standard'), draftA);
            assert.equal(h.applied.length, 0);
            assert.equal(h.recoveries.length, 0);
            assert.equal(h.errors.length, 1);
            assert.equal(h.errors[0].payload.error, error);
            assert.equal(h.state.loading, false);
            assert.doesNotMatch(h.state.statusMessage, /discarded/);
        });
    }

    run('current explicit pie_benchmark_condition_not_found preserves the draft for intentional recovery or discard', async t => {
        const h = createHarness(t);
        const loading = h.load(); await flush(); await h.respond(0);
        await h.reject(1, failure(400, 'pie_benchmark_condition_not_found'));
        assert.equal(loading.settled, true);
        await loading.promise;
        assert.deepEqual(h.readDraft('standard'), draftA);
        assert.equal(h.state.personalEntries.length, 0);
        assert.equal(h.state.usingGuestDraft, false);
        assert.equal(h.state.loading, false);
        assert.equal(h.applied.length, 1);
        assert.equal(h.errors.length, 0);
        assert.equal(h.recoveries.length, 0);
        assert.equal(h.state.personalDraftUnavailable, true);
        assert.match(h.state.statusMessage, /kept until you discard/);
    });

    run('every base/reconciled/preview read explicitly receives a 60000ms deadline', async t => {
        const h = createHarness(t, { reconcile: true });
        const loading = h.load(); await flush();
        for (let index = 0; index < 3; index++) {
            assert.equal(h.requests.length, index + 1);
            assert.equal(h.requests[index].options?.timeoutMs, 60000, `Deadline for read ${index}`);
            await h.respond(index);
        }
        assert.equal(h.requests[1].body.contextValues.budget, 'extended');
        assert.ok(h.requests[2].body.previewPersonalPie);
        assert.equal(loading.settled, true);
        await loading.promise;
        assert.equal(h.errors.length, 0);
    });

    run('three successful reads each have their own deadline, not a total workspace deadline', async t => {
        t.mock.timers.enable({ apis: ['setTimeout'] });
        const h = createHarness(t, { reconcile: true, realHTTP: true });
        t.mock.method(globalThis, 'fetch', (url, options) => {
            assert.equal(url, '/api/get_weighted_workspace');
            const body = JSON.parse(options.body), work = deferred();
            h.transports.push({ signal: options.signal,
                resolveLate: () => work.resolve(httpResponse(h.payload(body))) });
            return work.promise;
        });
        const loading = h.load(); await flush();
        for (let index = 0; index < 3; index++) {
            assert.equal(h.transports.length, index + 1);
            assert.equal(h.requests[index].options?.timeoutMs, 60000);
            assert.ok(h.transports[index].signal);
            t.mock.timers.tick(59999); await flush();
            assert.equal(loading.settled, false);
            assert.equal(h.transports[index].signal.aborted, false);
            assert.equal(h.applied.length, 0);
            h.transports[index].resolveLate(); await flush();
        }
        assert.equal(loading.settled, true, '179997ms aggregate read time is permitted.');
        await loading.promise;
        assert.equal(h.errors.length, 0);
        assert.equal(h.applied.length, 1);
        assert.equal(h.state.usingGuestDraft, true);
        assert.ok(h.transports.every(transport => !transport.signal.aborted));
        assert.deepEqual(h.readDraft('extended'), draftA);
    });

    run('async comparison recovery completion cannot supersede a newer accepted load', async t => {
        const h = createHarness(t);
        const old = h.load(); await flush();
        await h.reject(0, failure(400, 'comparison_keys_unavailable'));
        assert.equal(h.recoveries.length, 1);
        h.guestDrafts.set(contextKey('standard'), draftB);
        await restoreLatest(h, 1);
        const snapshot = h.state.rankingPagination.snapshotID, sequence = h.state.loadSequence;
        await h.finishRecovery();
        assert.equal(h.state.loadSequence, sequence, 'Stale recovery must not start another generation.');
        assert.equal(h.requests.length, 3, 'No retry after a newer load has already won.');
        assert.equal(old.settled, true);
        await old.promise;
        assertRestored(h, snapshot);
    });

    for (const phase of ['fetch', 'body']) for (const late of ['resolve', 'reject']) {
        run(`real HTTP 60000ms ${phase} deadline aborts and ignores late ${late}`, async t => {
            t.mock.timers.enable({ apis: ['setTimeout'] });
            const work = deferred();
            let signal;
            t.mock.method(globalThis, 'fetch', (url, options) => {
                assert.equal(url, '/api/get_weighted_workspace'); signal = options.signal;
                return phase === 'fetch' ? work.promise : Promise.resolve({ ...httpResponse(null), json: () => work.promise });
            });
            const pending = postJSON('/api/get_weighted_workspace', {}, { timeoutMs: 60000 });
            const rejected = assert.rejects(pending, isTimeout);
            await flush();
            assert.equal(signal.aborted, false);
            t.mock.timers.tick(59999); await flush(); assert.equal(signal.aborted, false);
            t.mock.timers.tick(1); await rejected;
            assert.equal(signal.aborted, true); assert.ok(isTimeout(signal.reason));
            if (late === 'reject') work.reject(new Error('Late ignored transport failure'));
            else work.resolve(phase === 'fetch' ? httpResponse({ late: true }) : { late: true });
            await flush();
            await assert.rejects(pending, isTimeout);
        });
    }

    for (const readPhase of ['base', 'reconciled', 'preview']) {
        for (const transportPhase of ['fetch', 'body']) for (const late of ['resolve', 'reject']) {
            run(`${readPhase} ${transportPhase} timeout preserves draft and rejects late ${late} application`, async t => {
                t.mock.timers.enable({ apis: ['setTimeout'] });
                const h = createHarness(t, { reconcile: readPhase !== 'base', realHTTP: true });
                t.mock.method(globalThis, 'fetch', (url, options) => {
                    assert.equal(url, '/api/get_weighted_workspace');
                    const body = JSON.parse(options.body);
                    const currentPhase = body.previewPersonalPie ? 'preview'
                        : body.contextValues.budget === 'extended' ? 'reconciled' : 'base';
                    if (currentPhase !== readPhase) return Promise.resolve(httpResponse(h.payload(body)));
                    const work = deferred();
                    const transport = { work, signal: options.signal, body,
                        resolveLate: () => work.resolve(transportPhase === 'fetch' ? httpResponse(h.payload(body)) : h.payload(body)) };
                    h.transports.push(transport);
                    return transportPhase === 'fetch' ? work.promise : Promise.resolve({ ...httpResponse(null), json: () => work.promise });
                });
                const loading = h.load(); await flush();
                assert.equal(h.transports.length, 1);
                assert.ok(h.requests.every(request => request.options?.timeoutMs === 60000));
                assert.ok(h.transports[0].signal, 'The actual HTTP timeout must provide an abort signal.');
                t.mock.timers.tick(59999); await flush();
                assert.equal(loading.settled, false);
                assert.equal(h.transports[0].signal.aborted, false);
                t.mock.timers.tick(1); await flush();
                const delays = constants.WORKSPACE_LOAD_RETRY_DELAYS_MS;
                for (let index = 0; index <= delays.length; index++) {
                    assert.equal(h.transports[index].signal.aborted, true);
                    assert.ok(isTimeout(h.transports[index].signal.reason));
                    assert.deepEqual(h.readDraft('standard'), draftA);
                    assert.deepEqual(h.readDraft('extended'), draftA);
                    assert.equal(h.applied.length, 0);
                    if (index < delays.length) {
                        t.mock.timers.tick(delays[index]); await flush();
                        assert.equal(h.transports.length, index + 2);
                        assert.ok(h.requests.every(request => request.options?.timeoutMs === 60000));
                        assert.equal(h.transports[index + 1].signal.aborted, false);
                        t.mock.timers.tick(60000); await flush();
                    }
                }
                assert.equal(loading.settled, true, 'All retries must complete without wall-clock waits.');
                await loading.promise;
                assert.equal(h.errors.length, 1); assert.ok(isTimeout(h.errors[0]));
                assert.equal(h.state.loading, false);
                const requestCount = h.requests.length;
                for (const transport of h.transports) {
                    if (late === 'reject') transport.work.reject(new Error('Late workspace transport failure'));
                    else transport.resolveLate();
                }
                await flush();
                assert.equal(h.requests.length, requestCount);
                assert.equal(h.applied.length, 0);
                assert.equal(h.errors.length, 1);
                assert.deepEqual(h.readDraft('standard'), draftA);
                assert.deepEqual(h.readDraft('extended'), draftA);
            });
        }
    }
}
