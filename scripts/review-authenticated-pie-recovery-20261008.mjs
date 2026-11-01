import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { createFixtureState, weightedEntries, workspace } from './frontend/fixtures.mjs';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const root = resolve(arg('source') ?? '.');
const actual = path => import(pathToFileURL(join(root, path)).href);
const { createWorkspaceState } = await actual('public/js/workspace/state.js');
const { createGuestDraftStore } = await actual('public/js/workspace/guest-drafts.js');
const { cloneEntries, cloneFallbackRules } = await actual('public/js/workspace/weights.js');
const { portableFamilyEntry, familyKey } = await actual('public/js/shared/benchmark-families.js');
const { validateWorkspacePayload } = await actual('public/js/workspace/contracts.js');
const { validatePersonalPieSave } = await actual('public/js/workspace/pie-save.js');
const { readRankingContext } = await actual('public/js/shared/ranking-url.js');
const { accountWriteError, isAccountWriteError } = await actual('public/js/shared/account-identity.js');
const source = await readFile(join(root, 'public/js/home-workspace.js'), 'utf8');
function block(start, end) {
    const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
    assert.ok(left >= 0 && right > left, start); return source.slice(left, right);
}
const code = [block('function snapshotPersonalPie()', 'function resetPieVisualState()'),
    block('function sameContextValues(', 'function syncContextValuesToURL()'),
    block('function scheduleSave()', 'async function flushPendingPersonalPieSave()'),
    block('async function loadWeightedWorkspace(', 'async function previewGuestPersonalPie('),
    block('async function persistPersonalPie(', 'async function applyWorkspaceState('),
    '({ load: loadWeightedWorkspace, save: persistPersonalPie, schedule: scheduleSave })'].join('\n');
const contextKey = '1:[["budget","standard"]]';
const draft = { entries: [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }], fallbackRules: [] };
const saved = { entries: [{ conditionID: 3, weightBasisPoints: 10000 }], fallbackRules: [] };
const plain = value => JSON.parse(JSON.stringify(value));
const portable = rows => rows.map(row => ({ conditionID: row.conditionID, weightBasisPoints: row.weightBasisPoints }));
const flush = async () => { for (let i = 0; i < 80; i++) await Promise.resolve(); };
function storage() {
    const values = new Map();
    return { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value),
        removeItem: key => values.delete(key) };
}
function deferred() { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; }
function document(sharedStorage, actor, { editing = false } = {}) {
    const state = createWorkspaceState();
    Object.assign(state, { categoryID: 1, categoryPath: 'Language-models', mode: 'personal',
        selectedContextValues: { budget: 'standard' }, comparisonRequest: { mode: 'best', keys: ['model'], filters: [] } });
    if (editing) Object.assign(state, { authenticated: true, userID: actor, personalEntries: weightedEntries(draft.entries),
        serverPersonalEntries: weightedEntries(saved.entries), personalRevision: 1, personalEditVersion: 1,
        personalSavePending: true, personalRankingDirty: true, hasSavedPersonalWeights: true });
    const fixture = createFixtureState({ authenticated: actor !== null, userID: actor ?? '1', personalEntries: weightedEntries(saved.entries) });
    const guestDrafts = createGuestDraftStore(() => sharedStorage), requests = [], writes = [], applied = [], errors = [];
    const globals = { state, guestDrafts, structuredClone, Map, Set, Number, Date, URL, URLSearchParams,
        cloneEntries, cloneFallbackRules, portableFamilyEntry, readRankingContext, validateWorkspacePayload, validatePersonalPieSave,
        accountWriteError, isAccountWriteError, FALLBACK_RULE_MODE: 'ordered', SAVE_DEBOUNCE_MS: 180,
        WORKSPACE_LOAD_RETRY_DELAYS_MS: [], pendingFallbackSave: false, fallbackSaveFailed: false,
        workspaceLoadFailed: false, comparisonProfileFailure: null, comparisonProfileLoadError: '',
        comparisonProfilesReady: Promise.resolve(true), benchmarkSearch: { value: '' },
        benchmarkFallbackCatalogue: { invalidate() {} },
        window: { location: { search: '' }, clearTimeout() {}, setTimeout() { return 1; } },
        console: { error() {} }, currentBenchmarkFilters: () => ({ benchmarkQuery: '', pinPersonal: false, groupVersions: false }),
        fallbackSignature: rules => rules.map(rule => familyKey(rule.primaryConditionID, rule.entries)).join('\n'),
        setStatus(message) { state.statusMessage = message; }, renderAll() {}, renderModels() {}, renderInlineFallback() {},
        renderModeState() {}, updateUndoState() {}, refreshChangedBenchmarkFilters() {},
        waitForGestureToSettle: async () => {}, flushPendingPersonalPieSave: async () => true,
        finishPendingWeightAdjustments: async () => true, invalidateRankingPages() {}, reloadBenchmarkPage() {},
        invalidSavedComparison: () => false, requestLogin() {},
        previewGuestPersonalPie() { throw new Error('Unexpected guest preview during an authenticated save'); },
        applyServerWorkspace(payload, options) {
            applied.push({ payload: plain(payload), options: plain(options) });
            state.userID = payload.userID; state.authenticated = payload.authenticated;
            state.personalEntries = cloneEntries(payload.personalPie.entries); state.usingGuestDraft = options.usingGuestDraft;
        },
        renderLoadError(error) { errors.push(error.message); state.loading = false; },
        async postJSON(path, body) {
            assert.equal(path, '/api/get_weighted_workspace'); requests.push(plain(body));
            return workspace(fixture, body);
        },
        postWriteJSON(path, body) {
            assert.equal(path, '/api/save_personal_pie'); const work = deferred(); writes.push({ path, body: plain(body), work }); return work.promise;
        }
    };
    const api = vm.runInNewContext(code, globals, { timeout: 1000 });
    return { state, requests, writes, applied, errors, guestDrafts, ...api };
}
async function failSave(sharedStorage) {
    const doc = document(sharedStorage, '7', { editing: true }), task = doc.save(); await flush();
    assert.equal(doc.writes.length, 1);
    doc.writes[0].work.reject(Object.assign(new Error('Synthetic lost confirmation'), { status: 503, payload: { error: 'fixture_failure' } }));
    assert.equal(await task, false); assert.deepEqual(portable(doc.state.personalEntries), draft.entries);
    return doc;
}
const observations = [];
for (let repetition = 1; repetition <= 2; repetition++) {
    for (const actor of ['8', null]) {
        const shared = storage(); await failSave(shared);
        const next = document(shared, actor); await next.load();
        assert.deepEqual(next.errors, []); assert.equal(next.applied.length, 1);
        const previews = next.requests.filter(body => body.previewPersonalPie);
        observations.push({ name: actor ? 'failed-account-draft-is-not-shown-to-another-account' : 'failed-account-draft-is-not-shown-after-logout',
            repetition, passed: previews.length === 0, expected: 'No request for another owner recovery draft',
            actual: { actor, previewRequests: previews.length, entries: portable(next.state.personalEntries), usingGuestDraft: next.state.usingGuestDraft } });
    }
    {
        const shared = storage(), current = document(shared, '7', { editing: true });
        current.schedule(); const pending = current.save(); await flush(); assert.equal(current.writes.length, 1);
        const reload = document(shared, '7'); await reload.load();
        assert.deepEqual(reload.errors, []);
        observations.push({ name: 'a-current-draft-survives-reload-while-save-response-is-pending', repetition,
            passed: JSON.stringify(portable(reload.state.personalEntries)) === JSON.stringify(draft.entries),
            expected: draft.entries, actual: portable(reload.state.personalEntries) });
        current.writes[0].work.reject(Object.assign(new Error('Cleanup controlled request'), { status: 503 }));
        assert.equal(await pending, false);
    }
    {
        const shared = storage(); await failSave(shared); const sameOwner = document(shared, '7'); await sameOwner.load();
        const passed = JSON.stringify(portable(sameOwner.state.personalEntries)) === JSON.stringify(draft.entries);
        assert.equal(passed, true, 'Same-owner failed draft must remain recoverable');
        observations.push({ name: 'healthy-same-owner-recovery', repetition, passed, control: true });
    }
    {
        const shared = storage(); createGuestDraftStore(() => shared).set(contextKey, draft);
        const login = document(shared, '8'); await login.load();
        const passed = JSON.stringify(portable(login.state.personalEntries)) === JSON.stringify(draft.entries);
        assert.equal(passed, true, 'A genuine guest draft must still be available for explicit adoption after login');
        observations.push({ name: 'healthy-genuine-guest-adoption', repetition, passed, control: true });
    }
    {
        const next = document(storage(), '8'); await next.load();
        const passed = next.requests.length === 1 && JSON.stringify(portable(next.state.personalEntries)) === JSON.stringify(saved.entries);
        assert.equal(passed, true);
        observations.push({ name: 'healthy-no-draft-load', repetition, passed, control: true });
    }
}
const fingerprints = {};
for (const path of ['public/js/home-workspace.js', 'public/js/workspace/guest-drafts.js', 'public/js/workspace/state.js']) {
    fingerprints[path] = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
}
const output = resolve(arg('output') ?? `artifacts/review-20261008/authenticated-pie-recovery-20261008/reproduction-${Date.now()}.json`);
await mkdir(dirname(output), { recursive: true });
await writeFile(output, JSON.stringify({ sourceRoot: root, fingerprints, observations,
    total: observations.length, violations: observations.filter(row => !row.passed).length,
    healthyControls: observations.filter(row => row.control && row.passed).length,
    applicationChanged: false, productionRequests: false,
    scope: 'Actual current save, scheduling, reload and guest-storage code with synthetic actors, an in-memory session store and controlled network fixtures. No production data or account session is used.' }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, total: observations.length, violations: observations.filter(row => !row.passed).length,
    healthyControls: observations.filter(row => row.control && row.passed).length }));
