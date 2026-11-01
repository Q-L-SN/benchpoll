import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createRankingPager, rankModels, RANKING_PAGE_SIZE } from '../ranking-pagination.js';
import { captureRankingResume, normalizeRankingResume } from '../public/js/shared/ranking-resume.js';
import { BENCHMARK_GROUPS, benchmarkConditionGroup } from '../public/js/shared/benchmark-condition-groups.js';
import { comparisonProfileKey } from '../public/js/shared/comparison-profile-key.js';
import { familyKey } from '../public/js/shared/benchmark-families.js';
import { validateWorkspacePayload, validateRankingPagePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';
import { recoveryCycleScenario } from '../scripts/review-snapshot-capacity-20261008.mjs';

function fullWorkspace(generation = 1) {
    const data = workspace(createFixtureState({ userID: '7', rankingStress: true }), {}, { paginate: false });
    const entrance = data.benchmarks[0];
    for (let index = 0; index < 48; index++) {
        data.benchmarks.push({ ...entrance, ID: 5001 + index, conditionID: 5001 + index,
            conditionName: `Variant ${index}`, conditionKey: `variant-${index}`, isPrimaryCondition: false,
            isDefaultCondition: false, lowCoverage: index >= 30, publicWeight: 0, publicWeightBasisPoints: 0, personalWeight: null });
    }
    for (let index = 0; index < 17; index++) {
        const entries = [data.benchmarks[index + 1]];
        data.benchmarks.push({ ...entrance, isFamily: true, familyID: 10000 + index,
            familyKey: familyKey(entrance.conditionID, entries), familyEntries: entries,
            publicWeightBasisPoints: 0, publicWeight: 0, personalWeight: null });
    }
    for (const list of ['personal', 'public']) {
        for (const row of data.modelLeaderboards[list]) row.name = `Revision ${generation}: ${row.name}`;
    }
    return data;
}

function plan(changes = {}) {
    return { benchmarks: { primary: 60, other: 15, lowCoverage: 12 }, personal: 38, public: 50,
        fallbacks: [{ conditionID: 1, depth: 12 }], ...changes };
}

test('normal first pages remain unchanged and do not preload closed groups or fallback configurations', () => {
    const response = createRankingPager().create(fullWorkspace(), { userID: '7', groupVersions: true });
    validateWorkspacePayload(response);
    assert.equal(response.benchmarks.length, 40);
    assert.equal(response.modelLeaderboards.public.length, 25);
    assert.equal(response.modelLeaderboards.personal.length, 0);
    assert.equal(response.rankingPagination.benchmarks.other.nextOffset, 0);
    assert.equal(response.rankingPagination.fallbacks, undefined);
});

test('one new calculation restores independent model, version group and fallback prefixes', () => {
    const pager = createRankingPager();
    const data = fullWorkspace(), resume = plan();
    const response = pager.create(data, { userID: '7', groupVersions: true, resume });
    validateWorkspacePayload(response, { resume });
    assert.equal(response.modelLeaderboards.personal.length, 38);
    assert.equal(response.modelLeaderboards.public.length, 50);
    assert.deepEqual(BENCHMARK_GROUPS.map(group => response.rankingPagination.benchmarks[group].nextOffset), [60, 15, 12]);
    assert.equal(response.benchmarks.length, 87);
    assert.equal(new Set(response.benchmarks.map(row => row.ID)).size, 87);
    assert.equal(response.rankingPagination.fallbacks[0].items.length, 12);
    const next = pager.getPage({ snapshotID: response.rankingPagination.snapshotID, userID: '7',
        list: 'fallbacks', conditionID: 1, offset: 12 });
    validateRankingPagePayload(next, { list: 'fallbacks', conditionID: 1, offset: 12 });
    assert.equal(next.items.length, 5);
    assert.equal(new Set([...response.rankingPagination.fallbacks[0].items, ...next.items].map(row => row.familyKey)).size, 17);
    assert.equal(next.hasMore, false);
});

test('a recovered calculation replaces old rows instead of concatenating a stale ordering', () => {
    const pager = createRankingPager(), original = fullWorkspace(1), latest = fullWorkspace(2);
    const first = pager.create(original, { userID: '7' });
    latest.benchmarks = latest.benchmarks.filter(row => row.conditionID !== 2);
    const removed = latest.modelLeaderboards.public.shift();
    const added = structuredClone(latest.modelLeaderboards.public[0]);
    Object.assign(added, { ID: 99001, name: 'A newly added model' });
    for (const score of added.calculationScores) {
        score.memberIDs = [added.ID];
        score.memberWeights = [{ ID: added.ID, weight: 1 }];
        score.memberEvidence = [{ ID: added.ID, hash: 'f'.repeat(64) }];
    }
    latest.modelLeaderboards.public.push(added);
    const resume = captureRankingResume(first.rankingPagination, { requests: [{ list: 'public', offset: 25 },
        { list: 'benchmarks', group: 'primary', offset: 40 }] });
    const response = pager.create(latest, { userID: '7', resume });
    validateWorkspacePayload(response, { resume });
    assert.ok(response.modelLeaderboards.public.every(row => row.name !== removed.name && row.ID !== removed.ID));
    assert.deepEqual(response.modelLeaderboards.public, rankModels(latest.modelLeaderboards.public).slice(0, 50));
    assert.ok(response.benchmarks.every(row => row.conditionID !== 2));
    assert.equal(response.modelLeaderboards.public.length, 50);
});

for (const initialMode of ['personal', 'public']) {
    test(`zero and maximal recovery depths clamp to actual result lengths in ${initialMode}`, () => {
        for (const requested of [0, Number.MAX_SAFE_INTEGER]) {
            const resume = plan({ benchmarks: Object.fromEntries(BENCHMARK_GROUPS.map(group => [group, requested])),
                personal: requested, public: requested, fallbacks: [{ conditionID: 1, depth: requested }] });
            const data = fullWorkspace();
            const response = createRankingPager().create(data, { userID: '7', groupVersions: true, initialMode, resume });
            validateWorkspacePayload(response, { resume, initialMode });
            assert.equal(response.modelLeaderboards[initialMode].length, requested ? 66 : 25);
            assert.equal(response.modelLeaderboards[initialMode === 'public' ? 'personal' : 'public'].length, requested ? 66 : 0);
            assert.equal(response.rankingPagination.fallbacks.length, requested ? 1 : 0);
            if (requested) assert.equal(response.rankingPagination.fallbacks[0].nextOffset, 17);
        }
    });
}

test('searched and pinned recovery uses the current full catalogue, not previously loaded matches', () => {
    const data = fullWorkspace(), resume = plan({ benchmarks: { primary: 120, other: 120, lowCoverage: 120 } });
    const pager = createRankingPager();
    const response = pager.create(data, { userID: '7', query: 'variant', pinPersonal: true, resume });
    validateWorkspacePayload(response, { resume });
    assert.equal(response.rankingPagination.benchmarkGrouping, 'versions');
    assert.equal(response.benchmarks.length, 48);
    assert.ok(response.benchmarks.every(row => row.conditionName.startsWith('Variant')));
    assert.equal(new Set(response.benchmarks.map(row => row.ID)).size, response.benchmarks.length);
});

test('removed fallback entrances and zero-depth configurations are omitted without restoring stale families', () => {
    const resume = plan({ fallbacks: [{ conditionID: 999999, depth: 10 }, { conditionID: 1, depth: 0 }] });
    const response = createRankingPager().create(fullWorkspace(), { userID: '7', groupVersions: true, resume });
    validateWorkspacePayload(response, { resume });
    assert.deepEqual(response.rankingPagination.fallbacks, []);
});

const invalidPlans = [false, [], 4, {}, { ...plan(), unknown: 1 }, { ...plan(), personal: -1 },
    { ...plan(), public: 1.5 }, { ...plan(), personal: '25' }, { ...plan(), public: Infinity },
    { ...plan(), benchmarks: { primary: 1, other: 0, lowCoverage: 0, unknown: 1 } },
    { ...plan(), benchmarks: { primary: 1, other: 0 } }, { ...plan(), fallbacks: {} },
    { ...plan(), fallbacks: [{ conditionID: 0, depth: 5 }] }, { ...plan(), fallbacks: [{ conditionID: 1, depth: -1 }] },
    { ...plan(), fallbacks: [{ conditionID: 1, depth: 5 }, { conditionID: 1, depth: 10 }] },
    { ...plan(), fallbacks: [{ conditionID: 1, depth: 5, unknown: true }] }];
for (const [index, resume] of invalidPlans.entries()) {
    test(`invalid recovery plan ${index + 1} is rejected before consuming a snapshot slot`, () => {
        const pager = createRankingPager();
        const handles = Array.from({ length: 12 }, () => pager.create(fullWorkspace(), { userID: '7' }).rankingPagination.snapshotID);
        assert.throws(() => normalizeRankingResume(resume), error => error.status === 400 && error.body.error === 'invalid_ranking_resume');
        assert.throws(() => pager.create(fullWorkspace(), { userID: '7', resume }), error => error.status === 400);
        for (const snapshotID of handles) assert.equal(pager.getPage({ snapshotID, userID: '7', list: 'public', offset: 25 }).items.length, 25);
    });
}

test('a failing recovered fallback prefix cannot evict any healthy snapshot', () => {
    const pager = createRankingPager();
    const handles = Array.from({ length: 12 }, () => pager.create(fullWorkspace(), { userID: '7' }).rankingPagination.snapshotID);
    const data = fullWorkspace();
    const family = data.benchmarks.find(row => row.isFamily);
    Object.defineProperty(family, 'familyKey', { get() { throw new Error('Synthetic family preparation failure'); } });
    assert.throws(() => pager.create(data, { userID: '7', resume: plan() }), /Synthetic family preparation failure/);
    for (const snapshotID of handles) assert.equal(pager.getPage({ snapshotID, userID: '7', list: 'public' }).items.length, 25);
});

test('recovered snapshots remain bound to the exact session owner', () => {
    const pager = createRankingPager(), response = pager.create(fullWorkspace(), { userID: '9007199254740992', resume: plan() });
    for (const args of [{ list: 'personal' }, { list: 'public' }, { list: 'benchmarks', group: 'primary' },
        { list: 'fallbacks', conditionID: 1 }]) {
        assert.throws(() => pager.getPage({ snapshotID: response.rankingPagination.snapshotID,
            userID: '9007199254740993', ...args }), error => error.status === 403);
    }
});

test('response validation rejects under-restored, duplicated or unrequested prefix data', () => {
    const resume = plan();
    const valid = createRankingPager().create(fullWorkspace(), { userID: '7', groupVersions: true, resume });
    assert.throws(() => validateWorkspacePayload(valid), /must start unloaded/);
    for (const mutate of [
        value => { value.benchmarks[1] = { ...value.benchmarks[0] }; },
        value => { value.modelLeaderboards.public.pop(); value.rankingPagination.public.nextOffset--; },
        value => { value.rankingPagination.fallbacks.push(value.rankingPagination.fallbacks[0]); },
        value => { value.rankingPagination.fallbacks[0].conditionID = 2; },
        value => { value.rankingPagination.fallbacks[0].items.pop(); value.rankingPagination.fallbacks[0].nextOffset--; }
    ]) {
        const corrupted = structuredClone(valid); mutate(corrupted);
        assert.throws(() => validateWorkspacePayload(corrupted, { resume }), error => error.code === 'invalid_workspace_response');
    }
    assert.throws(() => validateRankingPagePayload(valid.rankingPagination.fallbacks[0], { list: 'fallbacks', offset: 0, conditionID: 1 }),
        /requested configuration prefix/);
});

test('capture retains already viewed depths and includes every requested continuation exactly once', () => {
    const response = createRankingPager().create(fullWorkspace(), { userID: '7', resume: plan(), groupVersions: true });
    const resume = captureRankingResume(response.rankingPagination, { requests: [
        { list: 'public', offset: 50 }, { list: 'personal', offset: 38 },
        { list: 'benchmarks', group: 'other', offset: 15 }, { list: 'fallbacks', conditionID: 1, offset: 12 },
        { list: 'fallbacks', conditionID: 1, offset: 12 }
    ], fallbacks: [{ conditionID: 1, depth: 12 }] });
    assert.deepEqual(resume, { benchmarks: { primary: 60, other: 55, lowCoverage: 12 }, personal: 63, public: 75,
        fallbacks: [{ conditionID: 1, depth: 17 }] });
    assert.deepEqual(response.rankingPagination.benchmarks.other.nextOffset, 15);
});

test('simultaneous expiry callbacks share one refresh and restore all pending frontiers', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const start = source.indexOf('let rankingRecovery = null;'), end = source.indexOf('async function loadNextRankingPage(', start);
    const response = createRankingPager().create(fullWorkspace(), { userID: '7', groupVersions: true });
    const state = { rankingPagination: response.rankingPagination, scoreMode: 'range', personalEditVersion: 1,
        rankingPageLoading: { public: true, benchmarks: true, benchmarkOther: true } };
    const calls = []; let finish;
    const pending = new Promise(resolve => { finish = resolve; });
    const api = vm.runInNewContext(`${source.slice(start, end)}\n({ recoverRankingPages });`, {
        state, workspaceLoadFailed: false, BENCHMARK_GROUPS, captureRankingResume, comparisonProfileKey,
        Promise, workspaceContextFingerprint: () => 'context-1', currentBenchmarkFilters: () => ({ groupVersions: true }),
        benchmarkPageKey: group => ({ primary: 'benchmarks', other: 'benchmarkOther', lowCoverage: 'benchmarkLow' })[group],
        benchmarkFallbackCatalogue: { progress: () => [{ conditionID: 1, depth: 10 }] },
        loadWeightedWorkspace: options => { calls.push(options); return pending; }
    });
    const first = api.recoverRankingPages({ list: 'fallbacks', conditionID: 1, offset: 10 });
    const second = api.recoverRankingPages({ list: 'public', offset: 25 });
    assert.equal(first, second);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].pageRecovery.resume, { benchmarks: { primary: 80, other: 40, lowCoverage: 0 },
        personal: 0, public: 50, fallbacks: [{ conditionID: 1, depth: 15 }] });
    finish(); await first;
    await api.recoverRankingPages({ list: 'public', offset: 25 });
    assert.equal(calls.length, 2, 'A settled refresh releases the coordinator');
});

test('ordinary first loads never treat two absent snapshot IDs as a recovery request', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const expression = source.match(/const resume = !resetTemplates[\s\S]*?;\n/)[0];
    const requested = plan();
    const cases = [
        { pageRecovery: null, state: {}, expected: null },
        { pageRecovery: undefined, state: { rankingPagination: undefined }, expected: null },
        { pageRecovery: null, state: { rankingPagination: { snapshotID: 'existing' } }, expected: null },
        { pageRecovery: { snapshotID: 'old', scope: 'current', resume: requested },
            state: { rankingPagination: { snapshotID: 'new' } }, expected: null },
        { pageRecovery: { snapshotID: 'current', scope: 'old', resume: requested },
            state: { rankingPagination: { snapshotID: 'current' } }, expected: null },
        { pageRecovery: { snapshotID: 'current', scope: 'current', resume: requested },
            state: { rankingPagination: { snapshotID: 'current' } }, expected: requested }
    ];
    for (const resetTemplates of [false, true]) for (const { pageRecovery, state, expected } of cases) {
        assert.deepEqual(vm.runInNewContext(`${expression}\nresume;`, {
            resetTemplates, pageRecovery, state, rankingRecoveryScope: () => 'current'
        }), resetTemplates ? null : expected);
    }
});

test('same-scope recovery keeps the benchmark DOM and scroll anchor while the replacement is pending', async () => {
    const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
    const start = source.indexOf('function renderBenchmarks() {');
    const end = source.indexOf('    if (state.benchmarks.length === 0 && state.rankingPageLoading.benchmarks)', start);
    const originalRows = [{ ID: 1 }, { ID: 2 }];
    const benchmarkRows = { scrollTop: 420, children: [...originalRows],
        replaceChildren() { this.scrollTop = 0; this.children = []; },
        append(value) { this.children.push(value); } };
    const element = { hidden: false, disabled: false, dataset: {}, classList: { toggle() {} }, setAttribute() {} };
    const body = {};
    vm.runInNewContext(`${source.slice(start, end)}\n}\nrenderBenchmarks();`, {
        state: { loading: true, mode: 'public', personalEntries: [], pinPersonalBenchmarks: false,
            rankingPagination: { snapshotID: 'old' } },
        rankingRecovery: { snapshotID: 'old', scope: 'current', mode: 'public' }, rankingRecoveryScope: () => 'current',
        benchmarkRows, pendingBenchmarkFocus: null, benchmarkRowFocus: { captureFocus: () => null },
        referenceSearch: { render() {} }, benchmarkSearch: { value: '' },
        document: { activeElement: body, body, createElement: () => ({}) }, benchmarkVersionGrouping: element,
        benchmarkCard: element, benchmarkPersonalPin: element, stylePreviews: { setPersonal() {} },
        isInlineFallbackTargetActive: () => false, selectedInlineFallbackPrimary: () => null, fallbackRuleFor: () => null
    });
    assert.equal(benchmarkRows.scrollTop, 420);
    assert.deepEqual(benchmarkRows.children, originalRows);

    for (const change of [
        { recovery: null },
        { recovery: { snapshotID: 'new', scope: 'current', mode: 'public' } },
        { recovery: { snapshotID: 'old', scope: 'different-context-or-filters', mode: 'public' } },
        { recovery: { snapshotID: 'old', scope: 'current', mode: 'personal' } },
        { loading: false }
    ]) {
        const rows = { ...benchmarkRows, scrollTop: 420, children: [...originalRows] };
        vm.runInNewContext(`${source.slice(start, end)}\n}\nrenderBenchmarks();`, {
            state: { loading: change.loading ?? true, mode: 'public', personalEntries: [], pinPersonalBenchmarks: false,
                rankingPagination: { snapshotID: 'old' } },
            rankingRecovery: Object.hasOwn(change, 'recovery') ? change.recovery
                : { snapshotID: 'old', scope: 'current', mode: 'public' },
            rankingRecoveryScope: () => 'current', benchmarkRows: rows,
            referenceSearch: { render() {} }, benchmarkSearch: { value: '' },
            pendingBenchmarkFocus: null, benchmarkRowFocus: { captureFocus: () => null },
            document: { activeElement: body, body, createElement: () => ({}) }, benchmarkVersionGrouping: element,
            benchmarkCard: element, benchmarkPersonalPin: element, stylePreviews: { setPersonal() {} },
            isInlineFallbackTargetActive: () => false, selectedInlineFallbackPrimary: () => null, fallbackRuleFor: () => null
        });
        assert.equal(rows.scrollTop, 0, 'Other scopes or completed loads must render normally');
        assert.ok(rows.children.every(row => !originalRows.includes(row)));
    }
});

for (const [owners, list, total] of [[13, 'public', 401], [24, 'public', 401], [13, 'benchmarks', 337]]) {
    test(`${owners} interleaved owners can reach the final ${list} page without increasing capacity`, async () => {
        const result = await recoveryCycleScenario(owners, list, 18);
        for (const row of result.records) {
            assert.equal(row.loadedCounts.at(-1), total);
            assert.ok(row.loadedCounts.every((count, index) => !index || count >= row.loadedCounts[index - 1]));
        }
        assert.ok(result.totalRefreshes <= owners * Math.ceil(total / RANKING_PAGE_SIZE[list]));
    });
}

test('the workspace route validates recovery input before database-backed calculation and keeps session ownership', async () => {
    const source = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const route = source.slice(source.indexOf("API.post('/get_weighted_workspace'"), source.indexOf("API.post('/get_ranking_page'"));
    assert.ok(route.indexOf('normalizeRankingResume(') < route.indexOf('await getRankingWorkspace('));
    assert.match(route, /const userID = await activeSessionUserID\(req\)/);
    assert.match(route, /userID\s*\n\s*\}\)/);
    assert.match(route, /resume: rankingResume/);
});

test('restored benchmark groups contain exactly their own rows', () => {
    const resume = plan(), response = createRankingPager().create(fullWorkspace(), { groupVersions: true, resume });
    for (const group of BENCHMARK_GROUPS) {
        assert.equal(response.benchmarks.filter(row => benchmarkConditionGroup(row) === group).length,
            response.rankingPagination.benchmarks[group].nextOffset);
    }
});
