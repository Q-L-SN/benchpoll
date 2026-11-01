import assert from 'node:assert/strict';
import test from 'node:test';
import { benchmarkConditionGroup } from '../public/js/shared/benchmark-condition-groups.js';
import { createSearchIndex, searchItems, searchText } from '../public/js/shared/search.js';
import { scoreModels, scoreComparison, buildBenchmarkList, loadApprovedModelConfigurations } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';
import { createRankingPager } from '../ranking-pagination.js';

test('folding follows all four decisions in priority order, without display rounding', () => {
    const condition = { isPrimaryCondition: false, lowCoverage: true, personalWeight: 0, publicWeight: 0 };
    assert.equal(benchmarkConditionGroup({ ...condition, isPrimaryCondition: true }), 'primary');
    assert.equal(benchmarkConditionGroup({ ...condition, personalWeight: 0.01 }), 'primary');
    assert.equal(benchmarkConditionGroup({ ...condition, publicWeight: 3 }), 'primary');
    assert.equal(benchmarkConditionGroup({ ...condition, publicWeight: 3, publicWeightBasisPoints: 299.9 }), 'lowCoverage');
    assert.equal(benchmarkConditionGroup({ ...condition, publicWeight: 2.99 }), 'lowCoverage');
    assert.equal(benchmarkConditionGroup({ ...condition, lowCoverage: false }), 'other');
    assert.throws(() => benchmarkConditionGroup({}), /require primary/);
});

test('weighted exceptions appear on the first page and remain disjoint from secondary pages', () => {
    const conditions = Array.from({ length: 6 }, (_, i) => ({ conditionID: i + 1, ID: i + 1, benchmarkID: 1,
        name: 'ARC-AGI', conditionName: i ? `variant ${i}` : 'default', tags: [], isPrimaryCondition: !i,
        scoreCount: [100, 2, 2, 50, 2, 40][i] }));
    const benchmarks = buildBenchmarkList(conditions, [{ conditionID: 2, weightBasisPoints: 300 },
        { conditionID: 5, weightBasisPoints: 299.9 }], [{ conditionID: 3, weightBasisPoints: 100 }]);
    const pager = createRankingPager();
    const initial = pager.create({ benchmarks, personalPie: { fallbackRules: [], entries: [{ conditionID: 3, weightBasisPoints: 100 }] },
        modelLeaderboards: { personal: [], public: [] } }, { groupVersions: true });
    assert.deepEqual(new Set(initial.benchmarks.map(row => row.ID)), new Set([1, 2, 3]));
    const { snapshotID } = initial.rankingPagination;
    const other = pager.getPage({ snapshotID, list: 'benchmarks', group: 'other', groupVersions: true });
    const low = pager.getPage({ snapshotID, list: 'benchmarks', group: 'lowCoverage', groupVersions: true });
    assert.deepEqual(other.items.map(row => row.ID), [4, 6]);
    assert.deepEqual(low.items.map(row => row.ID), [5]);
    assert.deepEqual(low.groupTotals, { primary: 3, other: 2, lowCoverage: 1 });
});

const models = [
    { ID: 1, modelID: 1, modelName: 'A', name: 'A, high', condition: { parameters: { effort: 'high' } },
        results: new Map([['1', { normalizedScore: 90 }], ['2', { normalizedScore: 20 }], ['3', { normalizedScore: -10 }]]) },
    { ID: 2, modelID: 1, modelName: 'A', name: 'A, low', condition: { parameters: { effort: 'low' } },
        results: new Map([['1', { normalizedScore: 30 }], ['2', { normalizedScore: 80 }]]) }
];

test('all-score configurations canonicalize assignments and count accepted sources without filter restrictions', async () => {
    const fields = [{ ID: 1, name: 'Budget', type: 'number', allowEmpty: false },
        { ID: 2, name: 'Thinking', type: 'presence', allowEmpty: false }];
    const assignments = [{ fieldID: 1, value: 500 }, { fieldID: 2, value: null }];
    const connection = { execute: async (sql, IDs) => {
        assert.deepEqual(IDs, [7]);
        assert.match(sql, /r.status = 'accepted'/);
        assert.match(sql, /b.is_active = 1/);
        assert.match(sql, /c.deleted_at IS NULL/);
        return [[{ modelID: 7, modelName: 'A', scoreFields: '[]', scoreCount: 3 },
            { modelID: 7, modelName: 'A', scoreFields: JSON.stringify(assignments), scoreCount: 2 },
            { modelID: 7, modelName: 'A', scoreFields: [...assignments].reverse(), scoreCount: 4 }]];
    } };
    const configurations = await loadApprovedModelConfigurations(connection, [7], fields);
    assert.equal(configurations.length, 2);
    assert.equal(configurations[0].scoreCount, 3);
    assert.equal(configurations[1].scoreCount, 6);
    assert.deepEqual(configurations[1].scoreFields, [{ fieldID: 1, value: '5e2' }, { fieldID: 2, value: null }]);
    for (const IDs of [[], [7, 7], ['7'], [-1], null]) {
        await assert.rejects(loadApprovedModelConfigurations(connection, IDs, fields),
            error => error.status === 400 && error.body.error === 'invalid_model_ids');
    }
});

test('calculation evidence identifies the winning configuration for each weighted benchmark', () => {
    const weights = [{ conditionID: 1, weightBasisPoints: 4000 }, { conditionID: 2, weightBasisPoints: 6000 }];
    const [score] = scoreComparison(models, weights, 10000, {}, comparisonOptions(models));
    assert.equal(score.lower, 84);
    assert.deepEqual(score.calculationScores.map(item => [item.conditionID, item.memberIDs, item.contribution]),
        [[1, [1], 36], [2, [2], 48]]);
    assert.equal(score.calculationScores.some(item => item.conditionID === 3), false);
    assert.equal(score.missingWeight, 0);
});

test('trace reflects direct fallback weights and available-result renormalization', () => {
    const model = { ...models[0], results: new Map([['2', { normalizedScore: -10 }]]) };
    const entries = [{ conditionID: 1, weightBasisPoints: 8000 }, { conditionID: 4, weightBasisPoints: 2000 },
        { conditionID: 3, weightBasisPoints: 0 }];
    const rule = { primaryConditionID: 1, mode: 'ordered', entries: [
        { conditionID: 2 }, { conditionID: 3 }] };
    const [range] = scoreModels([model], entries, 10000, { fallbackRules: [rule] });
    assert.equal(range.lower, -8);
    assert.equal(range.calculationScores[0].fallbackFor, 1);
    assert.equal(range.calculationScores[0].effectiveWeight, 80);
    assert.equal(range.missingWeight, 20);
    const [available] = scoreModels([model], entries, 10000, { fallbackRules: [rule], scoreMode: 'available' });
    assert.equal(available.lower, Number((-10 * (2 - 5 * .8 / (1 + 4 * .8))).toFixed(2)));
    assert.equal(available.availableInference.unpenalizedScore, -10);
    assert.equal(available.availableInference.observedScore, -10);
    assert.ok(Math.abs(available.availableInference.unresolvedFraction - .2) < 1e-9);
    assert.deepEqual(available.inferredScores, []);
    assert.equal(available.calculationScores[0].effectiveWeight, 100);
    assert.equal(available.calculationScores[0].contribution, -10);
});

test('search ranks exact names above prefixes, accepts reordered terms and conservative typos', () => {
    const items = ['SWE-bench Verified Extended', 'SWE-bench Verified', 'SWE-bench Lite', 'ARC-AGI-3', 'Résumé'];
    const index = createSearchIndex(items, value => value);
    assert.equal(index.search('swe bench verified')[0], 'SWE-bench Verified');
    assert.equal(index.search('verified swe')[0], items[0]);
    assert.deepEqual(index.search('arcagi3'), ['ARC-AGI-3']);
    assert.deepEqual(index.search('verifed'), items.slice(0, 2));
    assert.deepEqual(index.search('resume'), ['Résumé']);
    assert.deepEqual(index.search('unrelated imaginary'), []);
    assert.equal(searchText('ＳＷＥ－bench'), 'swe bench');
});

test('search never blurs numeric model versions and requires every term', () => {
    const items = ['GPT-5', 'GPT-5.1', 'GPT-5.10', 'GPT-6 Astra', 'Model 10', 'Model 1'];
    const index = createSearchIndex(items, item => item);
    assert.deepEqual(index.search('gpt 5.1'), ['GPT-5.1']);
    assert.deepEqual(index.search('gpt5.1'), ['GPT-5.1']);
    assert.deepEqual(index.search('gpt 5'), ['GPT-5']);
    assert.deepEqual(index.search('gpt 6 astra'), ['GPT-6 Astra']);
    assert.deepEqual(index.search('model1'), ['Model 1']);
    assert.deepEqual(index.search('gpt 6 verified'), []);
});

test('indexes preserve input order for empty searches and invalidate when catalogs are replaced', () => {
    const fields = item => item.name;
    const items = [{ name: 'Alpha' }, { name: 'Beta' }];
    assert.deepEqual(searchItems(items, '', fields), items);
    assert.deepEqual(searchItems(items, 'alpha', fields), [items[0]]);
    const replacement = [{ name: 'Gamma' }];
    assert.deepEqual(searchItems(replacement, 'gamma', fields), replacement);
    for (let i = 0; i < 80; i++) searchItems(items, `query ${i}`, fields);
    assert.deepEqual(searchItems(items, 'beta', fields), [items[1]]);
});
