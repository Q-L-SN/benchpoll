import { estimationRequest, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import vm from 'node:vm';
import { createRankingPager } from '../ranking-pagination.js';
import { createBenchmarkFallbackCatalogue } from '../public/js/workspace/benchmark-fallback-catalogue.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { chartWeightMode } from '../public/js/workspace/chart-workspace.js';
import { createGuestDraftStore } from '../public/js/workspace/guest-drafts.js';
import { createPersonalPieRecovery } from '../public/js/workspace/pie-recovery.js';
import { validatePersonalPieSave } from '../public/js/workspace/pie-save.js';
import { cloneEntries, cloneFallbackRules, clonePersonalPieSnapshot } from '../public/js/workspace/weights.js';
import { accountWriteError, isAccountWriteError } from '../public/js/shared/account-identity.js';
import { validateWorkspacePayload, validateRankingPagePayload } from '../public/js/workspace/contracts.js';
import { captureRankingResume } from '../public/js/shared/ranking-resume.js';
import { comparisonProfileKey } from '../public/js/shared/comparison-profile-key.js';
import { BENCHMARK_GROUPS } from '../public/js/shared/benchmark-condition-groups.js';
import { readRankingContext } from '../public/js/shared/ranking-url.js';
import { FALLBACK_CONFIGURATION_VERSION } from '../public/js/shared/benchmark-families.js';
import { createFixtureState, workspace, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const before = process.env.RANKING_RECOVERY_REVIEW_SOURCE_DIR;
const currentSource = await readFile(path.join(root, 'public/js/home-workspace.js'), 'utf8');
const beforeSource = before ? await readFile(path.join(before, 'public/js/home-workspace.js'), 'utf8') : currentSource;
function block(source, start, end) {
    const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
    assert.ok(left >= 0 && right > left, start);
    return source.slice(left, right);
}
async function beforeModule(file) {
    const text = await readFile(path.join(before, file), 'utf8');
    const linked = text.replace(/(from\s+['"])(\.[^'"]+)(['"])/g, (_, prefix, relative, quote) =>
        prefix + new URL(relative, pathToFileURL(path.join(root, file))).href + quote);
    return import('data:text/javascript;base64,' + Buffer.from(linked).toString('base64'));
}
const oldPagerFactory = before ? (await beforeModule('ranking-pagination.js')).createRankingPager : createRankingPager;
const oldCatalogueFactory = before ? (await beforeModule('public/js/workspace/benchmark-fallback-catalogue.js')).createBenchmarkFallbackCatalogue : createBenchmarkFallbackCatalogue;
class Element {
    constructor(tag) { this.tag = tag; this.children = []; this.dataset = {}; this.listeners = new Map(); this.parts = new Map(); this.attributes = {}; }
    append(...children) { this.children.push(...children); }
    setAttribute(key, value) { this.attributes[key] = value; }
    querySelector(key) { if (!this.parts.has(key)) this.parts.set(key, new Element(key)); return this.parts.get(key); }
    addEventListener(type, callback) { this.listeners.set(type, callback); }
    focus() {}
}
const previousGlobals = new Map(['document', 'window'].map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
after(() => {
    for (const [key, descriptor] of previousGlobals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
    }
});
globalThis.document = { createElement: tag => new Element(tag), getElementById: () => null };
globalThis.window = { matchMedia: () => ({ matches: true }), queueMicrotask };
const settle = () => new Promise(resolve => setImmediate(resolve));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
async function waitFor(condition) {
    for (let turn = 0; turn < 30; turn++) { if (condition()) return; await settle(); }
    assert.fail('Controlled request was not reached');
}
async function createHarness(version = before ? 'before' : 'current') {
    const source = version === 'current' ? currentSource : beforeSource;
    const pagerFactory = version === 'current' ? createRankingPager : oldPagerFactory;
    const catalogueFactory = version === 'current' ? createBenchmarkFallbackCatalogue : oldCatalogueFactory;
    let clock = 0, heldFallback = null, holdFallback = false;
    const pager = pagerFactory({ now: () => clock });
    const fixture = createFixtureState({ userID: '7', rankingStress: true,
        families: Array.from({ length: 7 }, (_, index) => index + 2).flatMap(a =>
            Array.from({ length: 7 }, (_, index) => index + 2).filter(b => b !== a).map(b => [a, b])).slice(0, 17)
            .map((pair, index) => ({ primaryConditionID: 1, familyID: 10000 + index, mode: 'ordered',
                entries: pair.map(conditionID => ({ conditionID })) })) });
    const state = createWorkspaceState();
    const requests = [], applied = [], pending = [], fallbackRequests = [], expiredCallbacks = [], loadErrors = [];
    let api, catalogue;
    function response(body) {
        const data = workspace(fixture, body, { paginate: false });
        return pager.create(data, { userID: fixture.userID, initialMode: body.initialMode ?? 'public',
            query: body.benchmarkQuery ?? '', pinPersonal: body.pinPersonal ?? false,
            groupVersions: body.groupVersions ?? false, resume: body.rankingResume });
    }
    function getPage(body) {
        try { return pager.getPage({ ...body, userID: fixture.userID }); }
        catch (error) { throw { status: error.status, payload: error.body }; }
    }
    catalogue = catalogueFactory({
        request(body) {
            fallbackRequests.push(structuredClone(body));
            if (holdFallback) {
                heldFallback = { ...deferred(), body: structuredClone(body) };
                return heldFallback.promise;
            }
            return Promise.resolve(getPage(body));
        }, onChange() {},
        onExpired(page) {
            expiredCallbacks.push(page);
            const task = version === 'current' ? api.recover(page) : api.refresh({ preserveUndo: true });
            pending.push(task);
        }
    });
    const globals = { estimationRequest, normalizeEstimationAlgorithm,
        state, structuredClone, console, Map, Set, Date, Number, chartWeightMode,
        workspaceLoadFailed: false, comparisonProfileFailure: null, comparisonProfileLoadError: '',
        comparisonProfilesReady: Promise.resolve(true), pendingFallbackSave: false,
        fallbackSaveFailed: false, lowCoverageExpanded: false, otherConditionsExpanded: false,
        wheelWeightCommitTimer: null, guestDrafts: createGuestDraftStore(() => storage), hiddenPersonalBenchmarkIDs: new Set(),
        benchmarkSearch: { value: '' }, benchmarkRows: { scrollTop: 0 }, modelRows: { scrollTop: 0 },
        benchmarkFallbackCatalogue: catalogue,
        comparisonControls: { render() {} }, navigationChannel: { publish(value) { applied.push(structuredClone(value)); } },
        window: { queueMicrotask() {}, setTimeout() { return 0; }, clearTimeout() {}, location: { search: '' } },
        benchmarkPageKey: group => ({ primary: 'benchmarks', other: 'benchmarkOther', lowCoverage: 'benchmarkLow' })[group],
        validateWorkspacePayload, validateRankingPagePayload, captureRankingResume, comparisonProfileKey, BENCHMARK_GROUPS,
        readRankingContext, cloneEntries, cloneFallbackRules, clonePersonalPieSnapshot, accountWriteError, isAccountWriteError,
        finishPendingWeightAdjustments: async () => true, flushPendingPersonalPieSave: async () => true,
        registerPieEntries() {}, resetPieVisualState() {}, syncContextValuesToURL() {}, updateDiscussionEntry() {},
        renderAll() {}, renderScoringControls() {}, renderBenchmarks() {}, renderModels() {}, renderBenchmarkSummary() {},
        renderModeState() {}, updateUndoState() {}, updateLastUpdated() {}, renderInlineFallback() {}, revealBenchmarkRow() {}, loadVisibleBenchmarkPage() {},
        waitForGestureToSettle: async () => {}, portableFamilyEntry: entry => ({ conditionID: entry.conditionID }),
        FALLBACK_CONFIGURATION_VERSION, FALLBACK_RULE_MODE: 'ordered', WORKSPACE_LOAD_RETRY_DELAYS_MS: [], invalidSavedComparison: () => false,
        undoButton: { disabled: false }, redoButton: { disabled: false, hidden: true }, resetButton: new Element('button'),
        personalPieStart: { isOpen: false },
        topicViewButton: new Element('button'), isTopicReference: entry => entry.conditionID < 0,
        setStatus(message) { state.statusMessage = message; }, renderLoadError(error) { loadErrors.push(error); state.loading = false; },
        postJSON(route, body) {
            if (route === '/api/get_ranking_page') return Promise.resolve(getPage(body));
            assert.ok(['/api/get_weighted_workspace', '/api/save_personal_pie'].includes(route));
            if (route === '/api/save_personal_pie') {
                assert.equal(body.expectedUserID, fixture.userID);
                fixture.personalEntries = weightedEntries(body.entries);
                fixture.fallbackRules = body.fallbackRules;
                fixture.revision += 1;
            }
            if (route === '/api/get_weighted_workspace' && state.saving && state.personalRankingRefreshNeeded) {
                return Promise.resolve(response(body));
            }
            const request = { ...deferred(), route, body: structuredClone(body), payload: response(body) };
            requests.push(request);
            return request.promise;
        }
    };
    const stored = new Map();
    const storage = { getItem: key => stored.get(key) ?? null, setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
    globals.pieRecovery = createPersonalPieRecovery({ state, guestDrafts: globals.guestDrafts, getStorage: () => storage,
        snapshot: () => ({ entries: state.personalEntries.map(({ conditionID, weightBasisPoints }) => ({ conditionID, weightBasisPoints })),
            fallbackRules: state.personalFallbackRules }) });
    globals.postWriteJSON = async (route, body, options) => {
        const key = options.requestKey ?? 'abd00572-ec87-47f1-8acb-258bda9d69fe';
        await options.onIdentity?.(key);
        const payload = await globals.postJSON(route, body);
        const receipt = { saved: true, requestKey: key, userID: fixture.userID,
            categoryID: body.categoryID, contextValues: body.contextValues,
            personalPie: { revision: payload.personalPie.revision, entries: body.entries, fallbackRules: body.fallbackRules } };
        assert.equal(options.timeoutMs, 60000);
        assert.equal(options.validateResponse, validatePersonalPieSave);
        options.validateResponse(receipt, body, key);
        return receipt;
    };
    globals.validatePersonalPieSave = validatePersonalPieSave;
    const code = [
        ...(source.includes('function loadOverviewFirstPage(') ? [block(source, 'function loadOverviewFirstPage(', 'function renderPie(')] : []),
        block(source, 'function snapshotPersonalPie()', 'function restorePersonalPieSnapshot('),
        block(source, 'function restorePersonalPieSnapshot(', 'function selectedObjectIndex('),
        block(source, 'function currentPieEntries()', 'function resetPieVisualState()'),
        block(source, 'function sameContextValues(', 'function syncContextValuesToURL()'),
        block(source, 'function invalidateRankingPages()', 'function renderBenchmarkSummary('),
        block(source, 'function applyServerWorkspace(', 'function workspaceLoadErrorMessage('),
        block(source, 'async function loadWeightedWorkspace(', 'async function previewGuestPersonalPie('),
        block(source, 'async function persistPersonalPie(', 'async function applyWorkspaceState('),
        block(source, 'async function applyWorkspaceState(', "personalModeButton.addEventListener("),
        block(source, 'function restoreHistory(', 'function bindHistoryControl('),
        block(source, 'function updateUndoState()', 'function requestLogin()'),
        '({ refresh: loadWeightedWorkspace, switchContext: applyWorkspaceState, loadPage: loadNextRankingPage, apply: applyServerWorkspace, undo: () => restoreHistory("undo"), undoAvailable: () => { updateUndoState(); return !undoButton.disabled; }, ' +
            (version === 'current' ? 'recover: recoverRankingPages, coordinator: () => rankingRecovery' : 'recover: null, coordinator: () => null') + ' })'
    ].join('\n');
    api = vm.runInNewContext(code, globals);
    api.apply(response({ categoryID: 1, contextValues: { budget: 'standard' }, scoreMode: 'range' }));
    return { api, state, requests, applied, pending, fallbackRequests, expiredCallbacks, loadErrors, catalogue, fixture, search: globals.benchmarkSearch, page: getPage,
        expire() { clock = 900001; }, hold() { holdFallback = true; }, live() { holdFallback = false; },
        getHeld: () => heldFallback, failHeld() { try { getPage(heldFallback.body); assert.fail('Expected expired old snapshot'); }
            catch (error) { assert.equal(error.status, 410); heldFallback.reject(error); } },
        fallbackSection() { return catalogue.create(state.benchmarks.find(row => row.ID === 1), item => { const row = new Element('row'); row.item = item; return row; }); }
    };
}

const weights = h => Array.from(h.state.personalEntries, row => row.weightBasisPoints);
function panel(h) {
    if (h.catalogue.view) return h.catalogue.view(h.state.benchmarks.find(row => row.ID === 1));
    return h.fallbackSection().children.find(element => element.id === 'benchmark-fallback-configs-1');
}
function more(h) {
    if (h.catalogue.load) { void h.catalogue.load(1); return; }
    const button = panel(h).children.find(element => element.className === 'bp-fallback-catalogue-more');
    assert.ok(button, 'Actual fallback continuation control exists');
    button.listeners.get('click')();
}
async function openFallback(h) {
    if (h.catalogue.load) {
        await h.catalogue.load(1);
        assert.equal(panel(h).items.length, 5);
        return;
    }
    h.fallbackSection().children.find(element => element.className === 'bp-benchmark-fallback-toggle')
        .listeners.get('click')();
    await settle();
    assert.equal(panel(h).children.filter(element => element.tag === 'row').length, 5);
}

for (const lateResult of ['success', 'failure']) {
    test('newer saved Undo wins over late recovery ' + lateResult + ', twice', async () => {
        for (let repeat = 0; repeat < 2; repeat++) {
            const h = await createHarness();
            h.state.editHistory.record({ entries: h.state.personalEntries.map(row => ({
                ...row, weightBasisPoints: 2500, weight: 25
            })), fallbackRules: [] });
            h.expire(); await h.api.loadPage('public');
            await waitFor(() => h.requests.length === 1);
            const recovery = h.api.coordinator()?.promise;
            assert.equal(h.state.loading, true);
            assert.equal(h.api.undoAvailable(), true);
            h.api.undo();
            await waitFor(() => h.requests.length === 2);
            assert.equal(h.requests[1].route, '/api/save_personal_pie');
            h.requests[1].resolve(h.requests[1].payload);
            await waitFor(() => h.applied.length === 2);
            const savedSnapshot = h.state.rankingPagination.snapshotID;
            assert.deepEqual(weights(h), [2500, 2500, 2500, 2500]);
            assert.equal(h.state.personalRevision, 2);
            if (lateResult === 'success') h.requests[0].resolve(h.requests[0].payload);
            else h.requests[0].reject({ status: 503, payload: { error: 'offline_late_workspace_failure' } });
            if (recovery) await recovery;
            await settle();
            assert.deepEqual(weights(h), [2500, 2500, 2500, 2500], 'Late recovery cannot roll back saved Undo');
            assert.equal(h.state.personalRevision, h.fixture.revision);
            assert.equal(h.state.rankingPagination.snapshotID, savedSnapshot);
            assert.equal(h.applied.length, 2, 'Only initial workspace and newer save apply');
            assert.equal(h.loadErrors.length, 0, 'Obsolete failure cannot replace the saved ranking');
            assert.equal(h.state.loading, false);
            assert.equal(h.state.personalRankingDirty, false);
            assert.equal(h.state.userID, '7');
        }
    });
}

test('abandoned fallback 410 cannot create any recovery or resume after context transition, twice', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
        const h = await createHarness();
        await h.api.loadPage('benchmarks'); await h.api.loadPage('public');
        await openFallback(h);
        h.expire(); h.hold(); more(h);
        assert.equal(h.getHeld().body.offset, 5);
        const transition = h.api.switchContext({ currentCategoryID: 2, categoryPath: 'Language models/Reasoning',
            contextValues: { budget: 'extended' } });
        await waitFor(() => h.requests.length === 1);
        h.failHeld(); await settle();
        assert.equal(h.expiredCallbacks.length, 0, 'Abandoned actual catalogue request is retired');
        assert.equal(h.requests.length, 1, 'Old 410 cannot supersede the new-context request');
        assert.equal(h.api.coordinator(), null);
        assert.equal(h.state.loadSequence, 1);
        assert.ok(h.requests.every(request => request.body.rankingResume === undefined));
        h.requests[0].resolve(h.requests[0].payload); await transition;
        assert.equal(h.state.categoryID, 2);
        assert.equal(h.state.selectedContextValues.budget, 'extended');
        assert.equal(h.state.benchmarks.length, 40);
        assert.equal(h.state.modelLeaderboards.public.length, 25);
        assert.equal(h.state.rankingPagination.fallbacks, undefined);
        assert.equal(h.loadErrors.length, 0);
    }
});

test('same-scope 410 restores pending model and fallback frontiers once, twice', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
        const h = await createHarness();
        await openFallback(h);
        h.expire(); h.hold(); more(h);
        await h.api.loadPage('public');
        await waitFor(() => h.requests.length === 1);
        const recovery = h.api.coordinator()?.promise;
        const resume = h.requests[0].body.rankingResume;
        assert.equal(resume.public, 50);
        assert.deepEqual(Array.from(resume.fallbacks, row => ({ ...row })), [{ conditionID: 1, depth: 10 }]);
        h.failHeld(); await settle();
        assert.equal(h.requests.length, 1);
        h.requests[0].resolve(h.requests[0].payload); await recovery; await settle();
        assert.equal(h.state.modelLeaderboards.public.length, 50);
        assert.equal(h.catalogue.progress()[0].depth, 10);
        h.live(); more(h); await settle();
        assert.equal(h.fallbackRequests.at(-1).offset, 10);
        const keys = panel(h).items ? panel(h).items.map(item => item.familyKey)
            : panel(h).children.filter(element => element.tag === 'row').map(element => element.item.familyKey);
        assert.equal(keys.length, 15);
        assert.equal(new Set(keys).size, 15);
        assert.equal(h.catalogue.progress()[0].depth, 15);
    }
});

for (const kind of ['context', 'score-mode', 'comparison']) {
    test('newer ' + kind + ' load retires pending recovery, twice', async () => {
        for (let repeat = 0; repeat < 2; repeat++) {
            const h = await createHarness();
            h.expire(); await h.api.loadPage('public');
            await waitFor(() => h.requests.length === 1);
            const recovery = h.api.coordinator()?.promise;
            let newer;
            if (kind === 'context') newer = h.api.switchContext({ currentCategoryID: 2,
                categoryPath: 'Language models/Reasoning', contextValues: { budget: 'standard' } });
            else {
                if (kind === 'score-mode') h.state.scoreMode = 'available';
                else h.state.comparisonRequest = { mode: 'best', keys: ['model'],
                    filters: [{ key: 'field:1', operator: 'enum_eq', value: 1 }] };
                newer = h.api.refresh({ preserveUndo: true, comparisonChange: kind === 'comparison' });
            }
            await waitFor(() => h.requests.length === 2);
            assert.equal(h.requests[1].body.rankingResume, undefined);
            h.requests[1].resolve(h.requests[1].payload); await newer;
            const acceptedSnapshot = h.state.rankingPagination.snapshotID;
            h.requests[0].resolve(h.requests[0].payload); await recovery; await settle();
            assert.equal(h.state.rankingPagination.snapshotID, acceptedSnapshot);
            assert.equal(h.applied.length, 2);
            if (kind === 'context') assert.equal(h.state.categoryID, 2);
            if (kind === 'score-mode') assert.equal(h.state.scoreMode, 'available');
            if (kind === 'comparison') assert.equal(h.state.comparison.filters[0].value, 1);
        }
    });
}

test('benchmark filter changed during recovery reloads the actual filtered prefix, twice', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
        const h = await createHarness();
        h.expire(); await h.api.loadPage('public');
        await waitFor(() => h.requests.length === 1);
        const recovery = h.api.coordinator()?.promise;
        h.search.value = 'Advanced reasoning';
        h.requests[0].resolve(h.requests[0].payload); await recovery; await settle();
        const expected = h.page({ snapshotID: h.state.rankingPagination.snapshotID, list: 'benchmarks', group: 'primary',
            offset: 0, query: h.search.value, pinPersonal: false, groupVersions: false });
        assert.deepEqual(Array.from(h.state.benchmarks, row => row.ID), Array.from(expected.items, row => row.ID));
        assert.equal(h.state.benchmarks[0].ID, 2);
        assert.equal(h.state.rankingPagination.benchmarks.primary.nextOffset, expected.nextOffset);
    }
});

test('foreign-account recovery payload cannot change owner or snapshot, twice', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
        const h = await createHarness();
        const other = createRankingPager().create(workspace(createFixtureState({ userID: '8', rankingStress: true }),
            {}, { paginate: false }), { userID: '8' });
        const snapshot = h.state.rankingPagination.snapshotID;
        assert.throws(() => h.api.apply(other), isAccountWriteError);
        assert.equal(h.state.userID, '7');
        assert.equal(h.state.rankingPagination.snapshotID, snapshot);
        assert.equal(h.applied.length, 1);
    }
});

test('inactive real catalogue suppresses new requests until same-ID setSnapshot, twice', async () => {
    for (let repeat = 0; repeat < 2; repeat++) {
        const h = await createHarness();
        await openFallback(h);
        const snapshot = h.state.rankingPagination.snapshotID;
        h.catalogue.invalidate(); more(h); await settle();
        assert.equal(h.fallbackRequests.length, 1);
        assert.equal(h.catalogue.progress()[0].depth, 5);
        h.catalogue.setSnapshot(snapshot); more(h); await settle();
        assert.equal(h.fallbackRequests.length, 2);
        assert.equal(h.fallbackRequests.at(-1).offset, 5);
        assert.equal(h.catalogue.progress()[0].depth, 10);
    }
});
