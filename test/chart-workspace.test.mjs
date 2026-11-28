import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { readWorkspaceDisplay, writeWorkspaceDisplay } from '../public/js/workspace/preferences.js';
import { sortedWeightEntries, chartWeightMode } from '../public/js/workspace/chart-workspace.js';
import { columnGeometry, modelBarColor, modelBarTextColor, modelChartTicks, modelChartNeedsMore } from '../public/js/workspace/model-bar-chart.js';
import { modelScoreScale } from '../public/js/workspace/model-list.js';

test('chart preference is device-wide and accepts only supported displays', () => {
    const entries = new Map();
    const storage = { getItem: key => entries.get(key), setItem: (key, value) => entries.set(key, value) };
    assert.equal(readWorkspaceDisplay(storage), 'charts');
    assert.equal(writeWorkspaceDisplay('charts', storage), true);
    assert.equal(readWorkspaceDisplay(storage), 'charts');
    assert.equal(entries.size, 1);
    assert.equal(writeWorkspaceDisplay('unsupported', storage), true);
    assert.equal(readWorkspaceDisplay(storage), 'standard');
    assert.equal(writeWorkspaceDisplay('standard', storage), true);
    assert.equal(readWorkspaceDisplay(storage), 'standard');
    entries.set('benchpoll-workspace-display-v1', 'unsupported');
    assert.equal(readWorkspaceDisplay(storage), 'charts');
});

test('blocked browser storage does not block chart use', () => {
    const storage = { getItem() { throw Error(); }, setItem() { throw Error(); } };
    assert.equal(readWorkspaceDisplay(storage), 'charts');
    assert.equal(writeWorkspaceDisplay('charts', storage), false);
    assert.equal(readWorkspaceDisplay(null), 'charts');
    assert.equal(writeWorkspaceDisplay('charts', null), false);
});

test('chart view uses public weights when the current context has no personal weights', () => {
    const state = { workspaceDisplay: 'charts', mode: 'personal', personalEntries: [], contextIsPrivate: false };
    assert.equal(chartWeightMode(state), 'public');
    assert.equal(state.mode, 'personal');
    assert.equal(chartWeightMode({ ...state, personalEntries: [{ conditionID: 1 }] }), 'personal');
    assert.equal(chartWeightMode({ ...state, workspaceDisplay: 'standard' }), 'personal');
    assert.equal(chartWeightMode({ ...state, contextIsPrivate: true }), 'personal');
    assert.equal(chartWeightMode({ ...state, mode: 'public', personalEntries: [{ conditionID: 1 }] }), 'public');
});

test('the root directory uses its own preview snapshots instead of the retired workspace overview loader', async () => {
    const source = await readFile(new URL('../public/js/topics-home.js', import.meta.url), 'utf8');
    assert.match(source, /postJSON\('\/api\/get_topic_preview'/);
    assert.match(source, /snapshotID: pagination\.snapshotID, offset: pagination\.nextOffset/);
    assert.match(source, /count <= desired && preview\?\.pagination\?\.hasMore/);
    assert.doesNotMatch(source, /loadOverviewFirstPage|loadNextRankingPage|get_ranking_page|rankingPager/);
});

test('weight bars sort weights first, then primary, coverage and stable IDs without mutation', () => {
    const rows = [
        { conditionID: 5, weightBasisPoints: 2000, isPrimaryCondition: false, scoredModelCount: 60 },
        { conditionID: 4, weightBasisPoints: 2000, isPrimaryCondition: true, scoredModelCount: 20 },
        { conditionID: 3, weightBasisPoints: 2000, isPrimaryCondition: true, scoredModelCount: 30 },
        { conditionID: 2, weightBasisPoints: 2000, isPrimaryCondition: true, scoredModelCount: 30 },
        { conditionID: 1, weightBasisPoints: 3000, isPrimaryCondition: false, scoredModelCount: 1 }
    ];
    const before = structuredClone(rows);
    assert.deepEqual(sortedWeightEntries(rows).map(row => row.conditionID), [1, 2, 3, 4, 5]);
    assert.deepEqual(rows, before);
});

test('the leading model fills its column', () => {
    const model = { lower: 60, upper: 60 };
    const scale = modelScoreScale([model], { min: 0, max: 100 });
    assert.deepEqual(columnGeometry(model, scale), { known: { bottom: 0, height: 100 }, zero: 0 });
});

test('horizontal pagination starts only close to the end of an overflowing chart', () => {
    const chart = { clientWidth: 600, scrollWidth: 1800, scrollLeft: 0 };
    const container = { querySelector: () => chart };
    assert.equal(modelChartNeedsMore(container), false);
    chart.scrollLeft = 1000; assert.equal(modelChartNeedsMore(container), false);
    chart.scrollLeft = 1120; assert.equal(modelChartNeedsMore(container), true);
    chart.scrollWidth = 600; assert.equal(modelChartNeedsMore(container), false);
    chart.scrollWidth = 656; chart.scrollLeft = 1; assert.equal(modelChartNeedsMore(container), false);
    chart.scrollLeft = 50; assert.equal(modelChartNeedsMore(container), true);
});

test('the scale positions negative and zero scores below a positive leader', () => {
    const [leader, zero, negative] = [{ lower: 50 }, { lower: 0 }, { lower: -25 }];
    const scale = modelScoreScale([leader, zero, negative], { min: -50, max: 50 });
    assert.deepEqual(columnGeometry(negative, scale), { known: { bottom: 0, height: 25 }, zero: 50 });
    assert.deepEqual(columnGeometry(zero, scale), { known: { bottom: 0, height: 50 }, zero: 50 });
});

test('Estimated score retains the existing leader-relative visual scale', () => {
    const models = [{ lower: 80, upper: 80 }, { lower: 40, upper: 40 }];
    const scale = modelScoreScale(models, { min: 0, max: 100 });
    assert.equal(columnGeometry(models[0], scale).known.height, 100);
    assert.equal(columnGeometry(models[1], scale).known.height, 50);
});

test('creator colors use canonical slugs and retain a fallback for unknown creators', () => {
    assert.notEqual(modelBarColor({ vendorSlug: 'openai' }), modelBarColor({ vendorSlug: 'anthropic' }));
    assert.equal(modelBarColor({ vendorName: 'Google' }), '#287c51');
    assert.equal(modelBarColor({}), '#64707d');
});

test('in-bar score labels use contrasting text, including lighter creator colors', () => {
    assert.equal(modelBarTextColor('#262626'), '#ffffff');
    assert.equal(modelBarTextColor('#e6971a'), '#000000');
    assert.equal(modelBarTextColor('#cc8062'), '#000000');
    assert.equal(modelBarTextColor('#ffffff'), '#000000');
    assert.equal(modelBarTextColor('#000000'), '#ffffff');
});

test('chart ticks stay finite for extreme signed scores and include zero when crossing it', () => {
    const ticks = modelChartTicks({ min: -1e308, max: 1e308 });
    assert.ok(ticks.every(Number.isFinite));
    assert.ok(ticks.includes(0));
    assert.deepEqual(modelChartTicks({ min: -1, max: 100 }), [0, 25, 50, 75, 100]);
});
