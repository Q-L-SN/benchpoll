import { estimationRequest, normalizeEstimationAlgorithm } from '../public/js/shared/estimation-algorithms.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
import { postJSON as actualPostJSON } from '../public/js/shared/http.js';
import { rankingReadBody } from '../public/js/shared/available-score.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { createGuestDraftStore } from '../public/js/workspace/guest-drafts.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { cloneEntries, cloneFallbackRules } from '../public/js/workspace/weights.js';
import { portableFamilyEntry } from '../public/js/shared/benchmark-families.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';

const root = resolve(process.env.GUEST_PREVIEW_REVIEW_SOURCE_DIR ?? '.');
const source = await readFile(join(root, 'public/js/home-workspace.js'), 'utf8');
function block(start, end) {
    const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
    assert.ok(left >= 0 && right > left, 'Actual source block: ' + start);
    return source.slice(left, right);
}
const code = [
    block('function snapshotPersonalPie()', 'function resetPieVisualState()'),
    block('async function flushPendingPersonalPieSave()', 'function adjustSelectedWeight('),
    block('async function previewGuestPersonalPie()', 'async function persistPersonalPie('),
    block('async function applyWorkspaceState(', "personalModeButton.addEventListener("),
    'async function persistPersonalPie() { return previewGuestPersonalPie(); }',
    '({ preview: previewGuestPersonalPie, transition: applyWorkspaceState, flush: flushPendingPersonalPieSave })'
].join('\n');
const drain = async () => { for (let turn = 0; turn < 80; turn++) await Promise.resolve(); };
const plain = value => JSON.parse(JSON.stringify(value));
function deferred() {
    let resolve, reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    return { promise, resolve, reject };
}
const response = value => ({ status: 200, ok: true,
    headers: new Headers({ 'Content-Type': 'application/json' }), json: async () => value });
const draft = weights => ({ entries: weights.map((weightBasisPoints, index) => ({
    conditionID: index + 1, weightBasisPoints
})), fallbackRules: [] });

function harness(t, { gesture = null } = {}) {
    const state = createWorkspaceState();
    Object.assign(state, { categoryID: 1, categoryPath: 'Language-models', mode: 'personal',
        selectedContextValues: { budget: 'standard' }, personalEntries: draft([6000, 4000]).entries,
        personalRankingDirty: true, personalEditVersion: 1,
        comparisonRequest: { mode: 'best', keys: ['model'], filters: [] } });
    const values = new Map(), timers = new Map(), requests = [], applied = [], tasks = [], loads = [];
    let now = 0, nextTimer = 0;
    const setTimeout = (callback, delay) => {
        const ID = ++nextTimer; timers.set(ID, { callback, at: now + delay }); return ID;
    };
    const clearTimeout = ID => timers.delete(ID);
    t.mock.method(globalThis, 'setTimeout', setTimeout);
    t.mock.method(globalThis, 'clearTimeout', clearTimeout);
    const storage = { getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value) };
    const guestDrafts = createGuestDraftStore(() => storage);
    const fixture = createFixtureState({ authenticated: false });
    const globals = { estimationRequest, normalizeEstimationAlgorithm,
        state, structuredClone, Map, Set, Date, Number, guestDrafts,
        cloneEntries, cloneFallbackRules, portableFamilyEntry, FALLBACK_RULE_MODE: 'ordered',
        validateWorkspacePayload, pendingFallbackSave: false,
        window: { setTimeout, clearTimeout }, renderAll() {}, renderModeState() {},
        renderInlineFallback() {}, updateUndoState() {}, updateLastUpdated() {},
        currentBenchmarkFilters: () => ({ benchmarkQuery: '', pinPersonal: false, groupVersions: false }),
        refreshChangedBenchmarkFilters() {}, finishPendingWeightAdjustments: async () => true,
        waitForGestureToSettle: () => gesture?.promise ?? Promise.resolve(),
        setStatus(message) { state.statusMessage = message; },
        applyServerWorkspace(payload, options) {
            applied.push({ payload, options });
            state.personalEntries = cloneEntries(payload.personalPie.entries);
            state.personalFallbackRules = cloneFallbackRules(payload.personalPie.fallbackRules);
            state.personalRankingDirty = false; state.personalRankingError = '';
        },
        async loadWeightedWorkspace() { loads.push({ categoryID: state.categoryID,
            contextValues: plain(state.selectedContextValues) }); },
        postJSON(path, body, options) {
            body = rankingReadBody(path, body);
            assert.equal(path, '/api/get_weighted_workspace', 'Preview must never write a Pie.');
            const request = { ...deferred(), path, body: plain(body), options,
                payload: workspace(fixture, body), phase: 'headers' };
            requests.push(request);
            return actualPostJSON(path, body, options);
        }
    };
    t.mock.method(globalThis, 'fetch', async (path, options) => {
        const request = requests.at(-1);
        assert.equal(path, request.path);
        assert.deepEqual(JSON.parse(options.body), request.body, 'Actual HTTP body must match the captured draft.');
        request.signal = options.signal;
        return request.promise;
    });
    const api = vm.runInNewContext(code, globals, { timeout: 1000 });
    const h = {
        state, requests, applied, guestDrafts, loads, timers,
        key: () => `${state.categoryID}:${JSON.stringify(Object.entries(state.selectedContextValues).sort())}`,
        start() {
            const task = { settled: false, value: null };
            task.promise = api.preview();
            task.promise.then(value => { task.settled = true; task.value = value; }, error => {
                task.settled = true; task.error = error;
            });
            tasks.push(task); return task;
        },
        transition: detail => api.transition(detail),
        tick(milliseconds) {
            now += milliseconds;
            for (const [ID, timer] of [...timers]) if (timer.at <= now) {
                timers.delete(ID); timer.callback();
            }
        },
        async bodyStall(index = 0) {
            const request = requests[index]; request.phase = 'body'; request.bodyRead = deferred();
            request.resolve({ ...response(request.payload), json: () => request.bodyRead.promise });
            await drain();
        },
        async succeed(index = 0) { requests[index].resolve(response(requests[index].payload)); await drain(); },
        async fail(index = 0) { requests[index].reject(new TypeError('Controlled interrupted transport')); await drain(); }
    };
    t.after(async () => {
        gesture?.resolve();
        for (let turn = 0; turn < 8 && tasks.some(task => !task.settled); turn++) {
            for (const request of requests) {
                request.resolve(response(request.payload)); request.bodyRead?.resolve(request.payload);
            }
            await drain();
        }
        assert.ok(tasks.every(task => task.settled), 'All baseline and repaired operations must be drained.');
    });
    return h;
}

for (let repetition = 1; repetition <= 2; repetition++) {
    for (const phase of ['headers', 'body']) {
        test(`guest preview bounds an uncooperative ${phase} read and keeps its draft (${repetition})`, async t => {
            const h = harness(t), task = h.start(); await drain();
            if (phase === 'body') await h.bodyStall();
            h.tick(59999); await drain(); assert.equal(task.settled, false);
            h.tick(1); await drain();
            assert.equal(task.settled, true, 'A stalled preview must settle at its deadline.');
            assert.equal(task.value, false);
            assert.equal(h.requests[0].options?.timeoutMs, 60000);
            assert.equal(h.requests[0].signal.aborted, true);
            assert.equal(h.state.saving, false); assert.equal(h.state.savePromise, null);
            assert.equal(h.state.persistPromise, null); assert.equal(h.state.guestPreviewError, true);
            assert.deepEqual(plain(h.guestDrafts.get(h.key())), draft([6000, 4000]));
            assert.deepEqual(plain(h.state.personalEntries), draft([6000, 4000]).entries);
            const previousMessage = h.state.statusMessage;
            h.requests[0].resolve(response(h.requests[0].payload));
            h.requests[0].bodyRead?.resolve(h.requests[0].payload); await drain();
            assert.equal(h.applied.length, 0, 'Late transport cannot apply an abandoned calculation.');
            assert.equal(h.state.statusMessage, previousMessage);
            const retry = h.start(); await drain(); await h.succeed(1); await retry.promise;
            assert.equal(retry.value, true); assert.equal(h.applied.length, 1);
            assert.equal(h.timers.size, 0, 'No deadline survives completion.');
        });
    }
    test(`a category transition is released after failed preview and succeeds on explicit retry (${repetition})`, async t => {
        const h = harness(t), task = h.start(); await drain();
        const transition = h.transition({ currentCategoryID: 2, categoryPath: 'Language-models/Reasoning',
            contextValues: { budget: 'extended' } });
        h.tick(60000); await drain();
        assert.equal(task.settled, true, 'Transition must not await a preview forever.');
        await transition;
        assert.equal(h.state.categoryID, 1, 'Failed pending preview must not discard a local draft by navigating.');
        assert.equal(h.loads.length, 0);
        const retry = h.start(); await drain(); await h.succeed(1); await retry.promise;
        await h.transition({ currentCategoryID: 2, categoryPath: 'Language-models/Reasoning',
            contextValues: { budget: 'extended' } });
        assert.equal(h.state.categoryID, 2); assert.equal(h.loads.length, 1);
    });
    test(`old preview failure cannot mark a replacement context as failed (${repetition})`, async t => {
        const h = harness(t), task = h.start(); await drain();
        h.state.categoryID = 2; h.state.selectedContextValues = { budget: 'extended' };
        h.state.statusMessage = 'Replacement context is ready';
        await h.fail(); await task.promise;
        assert.equal(h.state.guestPreviewError, false);
        assert.equal(h.state.personalRankingError, '');
        assert.equal(h.state.statusMessage, 'Replacement context is ready');
        assert.equal(h.applied.length, 0);
    });
    test(`a preview cannot apply after its context changes while a gesture settles (${repetition})`, async t => {
        const gesture = deferred(), h = harness(t, { gesture }), task = h.start(); await drain();
        await h.succeed(); assert.equal(task.settled, false);
        h.state.categoryID = 2; h.state.selectedContextValues = { budget: 'extended' };
        gesture.resolve(); await drain(); await task.promise;
        assert.equal(h.applied.length, 0, 'Recheck the context after the asynchronous gesture boundary.');
    });
    test(`an obsolete failure calculates the newer draft instead of consuming its queued save (${repetition})`, async t => {
        const h = harness(t), task = h.start(); await drain();
        h.state.personalEntries = draft([7500, 2500]).entries; h.state.personalEditVersion++;
        const queued = h.start(); await drain(); assert.equal(h.requests.length, 1);
        await h.fail();
        assert.equal(h.requests.length, 2, 'The running preview must catch up to edits made during its failed read.');
        assert.deepEqual(h.requests[1].body.previewPersonalPie, draft([7500, 2500]));
        await h.succeed(1); await task.promise; await queued.promise;
        assert.equal(task.value, true); assert.equal(queued.value, true);
        assert.deepEqual(plain(h.guestDrafts.get(h.key())), draft([7500, 2500]));
        assert.equal(h.applied.length, 1);
    });
    test(`healthy preview joins queued work and sends only one read (${repetition})`, async t => {
        const h = harness(t), first = h.start(), second = h.start(); await drain();
        assert.equal(h.requests.length, 1); await h.succeed();
        await first.promise; await second.promise;
        assert.equal(first.value, true); assert.equal(second.value, true);
        assert.equal(h.applied.length, 1); assert.equal(h.state.saving, false);
        assert.equal(h.state.persistPromise, null); assert.equal(h.timers.size, 0);
    });
}
