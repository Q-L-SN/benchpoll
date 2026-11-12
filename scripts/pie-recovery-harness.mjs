import { estimationRequest, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createFixtureState, workspace, weightedEntries } from './frontend/fixtures.mjs';
import { recoveryScene, withRecoveryScenes } from '../test/helpers/workspace-scene-fixture.mjs';

export function createRecoveryMemoryStorage() {
    const values = new Map();
    return { values, getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value), removeItem: key => values.delete(key) };
}

export async function createPieRecoveryHarness({ sourceRoot = '.', ownerID = '7', storage = createRecoveryMemoryStorage(),
    fixture = createFixtureState({ userID: ownerID, authenticated: ownerID !== null }), receipts = new Map() } = {}) {
    const root = resolve(sourceRoot), source = await readFile(join(root, 'public/js/home-workspace.js'), 'utf8');
    const module = relative => import(pathToFileURL(join(root, relative)).href);
    const { chartWeightMode } = source.includes('chartWeightMode') ? await module('public/js/workspace/chart-workspace.js') : {};
    const { createWorkspaceState } = await module('public/js/workspace/state.js');
    const { createGuestDraftStore } = await module('public/js/workspace/guest-drafts.js');
    const { createPersonalPieRecovery } = await module('public/js/workspace/pie-recovery.js');
    const { createRetryableWrite } = await module('public/js/shared/write-intent.js');
    const { validateWorkspacePayload } = await module('public/js/workspace/contracts.js');
    const { validatePersonalPieSave } = await module('public/js/workspace/pie-save.js');
    const weights = await module('public/js/workspace/weights.js');
    const { portableFamilyEntry, FALLBACK_CONFIGURATION_VERSION } = await module('public/js/shared/benchmark-families.js');
    const { comparisonProfileKey } = await module('public/js/shared/comparison-profile-key.js');
    const { readRankingContext } = await module('public/js/shared/ranking-url.js');
    const { topicReferenceError } = await module('public/js/workspace/topic-references.js');
    const { isTopicReference } = await module('public/js/shared/topic-label.js');
    const { mergeBenchmarkWeights } = await module('public/js/workspace/expanded-weights.js');
    const identity = await module('public/js/shared/account-identity.js');
    const block = (start, end) => {
        const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
        assert.ok(left >= 0 && right > left, start); return source.slice(left, right);
    };
    const state = Object.assign(createWorkspaceState(), { categoryID: 1, categoryPath: '1/1', mode: 'personal',
        selectedContextValues: { scene: recoveryScene.standard }, comparisonRequest: { mode: 'best', keys: ['model'], filters: [] } });
    const reads = [], writes = [], errors = [], applied = [], timers = new Map(), tasks = new Set();
    let api, nextTimer = 0, readHook = null;
    const setTimeout = callback => { const ID = ++nextTimer; timers.set(ID, callback); return ID; };
    const clearTimeout = ID => timers.delete(ID);
    const guestDrafts = createGuestDraftStore(() => storage);
    const recovery = createPersonalPieRecovery({ state, guestDrafts, getStorage: () => storage, snapshot: () => api.portable() });
    const saveButton = { listeners: {}, addEventListener: (type, callback) => { saveButton.listeners[type] = callback; } };
    const discardButton = { listeners: {}, addEventListener: (type, callback) => { discardButton.listeners[type] = callback; } };
    const globals = { estimationRequest, normalizeEstimationAlgorithm, state, ...weights, ...identity, portableFamilyEntry, comparisonProfileKey, readRankingContext, chartWeightMode, topicReferenceError,
        isTopicReference, mergeBenchmarkWeights, recordProfileVisit() {},
        guestDrafts, pieRecovery: recovery, Number, Date, Map, Set, structuredClone, console: { error() {}, warn() {} },
        validateWorkspacePayload, validatePersonalPieSave, FALLBACK_CONFIGURATION_VERSION, FALLBACK_RULE_MODE: 'ordered', SAVE_DEBOUNCE_MS: 100,
        WORKSPACE_LOAD_RETRY_DELAYS_MS: [], workspaceLoadFailed: false, pendingFallbackSave: false, fallbackSaveFailed: false,
        comparisonProfileFailure: null, comparisonProfileLoadError: '', comparisonProfilesReady: Promise.resolve(true),
        lowCoverageExpanded: false, otherConditionsExpanded: false, hiddenPersonalBenchmarkIDs: new Set(),
        benchmarkFallbackCatalogue: { invalidate() {}, setSnapshot() {} }, benchmarkSearch: { value: '' },
        benchmarkRows: { scrollTop: 0 }, modelRows: { scrollTop: 0 }, guestDraftSave: saveButton, guestDraftDiscard: discardButton,
        window: { setTimeout, clearTimeout, queueMicrotask() {}, location: { search: '', pathname: '/1/1' } },
        comparisonControls: { render() {} }, navigationChannel: { publish() { applied.push(structuredClone(state.personalEntries)); } },
        invalidSavedComparison: () => false, invalidateRankingPages() {}, rankingRecoveryScope: () => '',
        finishPendingWeightAdjustments: async () => true, waitForGestureToSettle: async () => {},
        renderAll() {}, renderModels() {}, renderModeState() {}, renderInlineFallback() {}, updateUndoState() {}, updateLastUpdated() {},
        registerPieEntries() {}, resetPieVisualState() {}, syncContextValuesToURL() {}, updateDiscussionEntry() {},
        renderScoringControls() {}, revealBenchmarkRow() {}, reloadBenchmarkPage() {}, refreshChangedBenchmarkFilters() {},
        requestLogin() {}, currentBenchmarkFilters: () => ({ benchmarkQuery: '', pinPersonal: false, groupVersions: false }),
        fallbackSignature: rules => JSON.stringify(rules), setStatus(message) { state.statusMessage = message; },
        renderLoadError(error) { errors.push(error); state.loading = false; },
        postJSON: async (route, body) => {
            assert.equal(route, '/api/get_weighted_workspace'); reads.push(structuredClone(body));
            if (readHook) await readHook(body);
            return withRecoveryScenes(workspace(fixture, body), body.contextValues);
        }
    };
    globals.postWriteJSON = createRetryableWrite((_route, body, options) => {
        const item = { body: structuredClone(body), key: options.headers['Idempotency-Key'] };
        item.promise = new Promise((resolve, reject) => { item.resolve = resolve; item.reject = reject; });
        writes.push(item); return item.promise;
    }, { storage, digest: async value => createHash('sha256').update(value).digest('hex') });
    const code = [
        ...(source.includes('function loadOverviewFirstPage(') ? [block('function loadOverviewFirstPage(', 'function renderPie(')] : []),
        block('function snapshotPersonalPie()', 'function resetPieVisualState()'),
        block('function sameContextValues(', 'function syncContextValuesToURL()'),
        block('function scheduleSave()', 'function adjustSelectedWeight('),
        block('function applyServerWorkspace(', 'function workspaceLoadErrorMessage('),
        block('async function loadWeightedWorkspace(', 'async function applyWorkspaceState('),
        block("guestDraftSave.addEventListener('click'", 'function isPersonalBenchmarkFocus('),
        '({ load: loadWeightedWorkspace, save: persistPersonalPie, preview: previewGuestPersonalPie, schedule: scheduleSave, ' +
            'checkpoint: recordPersonalDraft, portable: portablePersonalPie })'].join('\n');
    api = vm.runInNewContext(code, globals);
    const drain = async () => { for (let step = 0; step < 100; step++) await Promise.resolve(); };
    function track(promise) {
        tasks.add(promise); promise.then(() => tasks.delete(promise), () => tasks.delete(promise)); return promise;
    }
    const h = { state, fixture, storage, reads, writes, errors, applied, guestDrafts, recovery, receipts, drain,
        setReadHook(callback) { readHook = callback; },
        load: options => track(api.load(options)), save: options => track(api.save(options)),
        confirm: () => track(saveButton.listeners.click()), discard: () => track(discardButton.listeners.click()),
        checkpoint: api.checkpoint,
        edit(pie) {
            state.personalEntries = weights.cloneEntries(pie.entries); state.personalFallbackRules = weights.cloneFallbackRules(pie.fallbackRules);
            state.personalEditVersion++; state.personalSavePending = true; state.personalRankingDirty = true; api.schedule();
        },
        commit(index) {
            const item = writes[index];
            if (receipts.has(item.key)) return receipts.get(item.key);
            assert.equal(item.body.expectedUserID, ownerID, 'No wrong-owner mutation is permitted');
            if (item.body.expectedRevision !== fixture.revision) throw Object.assign(Error('pie_revision_conflict'),
                { status: 409, payload: { error: 'pie_revision_conflict' } });
            fixture.personalEntries = weightedEntries(item.body.entries); fixture.fallbackRules = item.body.fallbackRules;
            fixture.revision = item.body.entries.length ? fixture.revision + 1 : 0;
            const receipt = { saved: true, requestKey: item.key, userID: ownerID, categoryID: item.body.categoryID,
                contextValues: item.body.contextValues, personalPie: { revision: fixture.revision,
                    entries: item.body.entries, fallbackRules: item.body.fallbackRules } };
            receipts.set(item.key, receipt); return receipt;
        },
        async acknowledge(index) { try { writes[index].resolve(h.commit(index)); } catch (error) { writes[index].reject(error); } await drain(); },
        async fail(index, status = 503, code = 'fixture_failure') {
            writes[index].reject(Object.assign(Error(code), { status, payload: { error: code } })); await drain();
        },
        async close() {
            for (let turn = 0; turn < 10 && tasks.size; turn++) {
                for (const item of writes) item.reject(Object.assign(Error('fixture_closed'), { status: 503 }));
                await drain();
            }
            assert.equal(tasks.size, 0, 'No controlled operation may escape the test');
        }
    };
    return h;
}
