import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { createWorkspaceState } from '../public/js/workspace/state.js';

const source = await readFile(new URL('../public/js/home-workspace.js', import.meta.url), 'utf8');
const invalidator = source.slice(source.indexOf('function invalidateRankingPages()'), source.indexOf('async function loadNextRankingPage('));

test('workspace page invalidation retires every list without discarding the previous calculation', () => {
    const state = createWorkspaceState();
    const snapshot = { snapshotID: 'previous-calculation' };
    state.rankingPagination = snapshot;
    state.benchmarks.push({ ID: 1 });
    const keys = Object.keys(state.rankingPageSequence);
    for (const key of keys) {
        state.rankingPageSequence[key] = 5;
        state.rankingPageLoading[key] = true;
        state.rankingPageError[key] = 'Previous page failure';
    }
    vm.runInNewContext(`${invalidator}\ninvalidateRankingPages();`, { state });
    for (const key of keys) {
        assert.equal(state.rankingPageSequence[key], 6);
        assert.equal(state.rankingPageLoading[key], false);
        assert.equal(state.rankingPageError[key], '');
    }
    assert.equal(state.rankingPagination, snapshot);
    assert.deepEqual(state.benchmarks, [{ ID: 1 }]);
});

test('an accepted full refresh invalidates pending pages before dispatching replacement requests', () => {
    const refresh = source.slice(source.indexOf('async function loadWeightedWorkspace('), source.indexOf('async function previewGuestPersonalPie('));
    assert.ok(refresh.indexOf('invalidateRankingPages();') > refresh.indexOf('if (sequence !== state.loadSequence) return;'));
    assert.ok(refresh.indexOf('invalidateRankingPages();') < refresh.indexOf('state.loading = true;'));
    assert.ok(refresh.indexOf('invalidateRankingPages();') < refresh.indexOf("postJSON('/api/get_weighted_workspace'"));
});

test('terminal load failures invalidate pages and block paging or search reloads until a full retry', () => {
    const failure = source.slice(source.indexOf('function renderLoadError('), source.indexOf('async function loadWeightedWorkspace('));
    assert.match(failure, /workspaceLoadFailed = true;\s*invalidateRankingPages\(\);/);
    const page = source.slice(source.indexOf('async function loadNextRankingPage('), source.indexOf('function reloadBenchmarkPage('));
    assert.match(page, /state\.loading \|\| workspaceLoadFailed \|\| state\.rankingPageLoading\[key\]/);
    const reload = source.slice(source.indexOf('function reloadBenchmarkPage('), source.indexOf('function currentBenchmarkFilters('));
    assert.match(reload, /if \(!state\.rankingPagination \|\| workspaceLoadFailed\) return;/);
    const search = source.slice(source.indexOf("benchmarkSearch.addEventListener('input'"), source.indexOf("benchmarkPersonalPin.addEventListener('click'"));
    assert.match(search, /if \(!state\.rankingPagination \|\| state\.loading \|\| workspaceLoadFailed\) return;/);
});
