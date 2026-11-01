import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { currentScoreSQL } from '../score-aggregation.js';
import { loadModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';

test('current-score predicates only admit accepted results and validate table aliases', () => {
    assert.equal(currentScoreSQL(), "benchmark_results.status = 'accepted'");
    assert.equal(currentScoreSQL('r'), "r.status = 'accepted'");
    for (const alias of ['', 'r.status', 'r OR 1=1', null, 1]) assert.throws(() => currentScoreSQL(alias));
    assert.doesNotMatch(currentScoreSQL(), /superseded|archived|\bOR\b|\bIN\b/);
});

test('calculation, coverage, configuration and detail queries share the current-score contract', async () => {
    const ranking = await readFile(new URL('../ranking-service.js', import.meta.url), 'utf8');
    const server = await readFile(new URL('../server.js', import.meta.url), 'utf8');
    const viewer = await readFile(new URL('../moderation-admin.js', import.meta.url), 'utf8');
    assert.equal((ranking.match(/\$\{currentScoreSQL\(/g) ?? []).length, 4);
    assert.equal((server.match(/\$\{currentScoreSQL\(/g) ?? []).length, 4);
    assert.equal((viewer.match(/\$\{currentScoreSQL\(/g) ?? []).length, 3);
    assert.match(ranking, /WITH model_coverage AS[\s\S]*?WHERE \$\{currentScoreSQL\(\)\}/);
    assert.match(ranking, /1 AS scoreCount[\s\S]*?WHERE \$\{currentScoreSQL\('r'\)\}/);
    assert.match(ranking, /SELECT MIN\(benchmark_results\.ID\) AS result_ID[\s\S]*?WHERE \$\{currentScoreSQL\(\)\}[\s\S]*?GROUP BY benchmark_results\.model_ID/);
    assert.match(server, /API.post\('\/get_approved_benchmark_results'[\s\S]*?AND \$\{currentScoreSQL\(\)\}/);
    assert.match(server, /COUNT\(\*\) AS scoreCount[\s\S]*?WHERE \$\{currentScoreSQL\(\)\}/);
});

test('historical results cannot affect medians, coverage, fallback or available-results totals', async () => {
    const all = [
        { result_ID: 101, model_ID: 3, benchmark_condition_ID: 21, score_fields: [], raw_score: 20, status: 'accepted' },
        { result_ID: 102, model_ID: 3, benchmark_condition_ID: 21, score_fields: [], raw_score: 100, status: 'superseded' },
        { result_ID: 103, model_ID: 3, benchmark_condition_ID: 22, score_fields: [], raw_score: 90, status: 'superseded' },
        { result_ID: 104, model_ID: 3, benchmark_condition_ID: 22, score_fields: [], raw_score: 80, status: 'archived' }
    ];
    const connection = {
        async execute(sql) {
            if (sql.includes('FROM models JOIN')) return [[{ model_ID: 3, model_name: 'Model A', vendor_name: 'Lab' }]];
            if (sql.includes('FROM benchmark_conditions')) return [[21, 22].map(ID => ({ benchmark_condition_ID: ID,
                uses_percentage_scale: 1, score_min: null, score_max: null, score_direction: 'higher', target_value: null }))];
            assert.ok(sql.includes(currentScoreSQL()));
            return [all.filter(row => row.status === 'accepted')];
        }
    };
    const models = await loadModels(connection, []);
    assert.equal(models[0].results.get('21').normalizedScore, 20);
    assert.equal(models[0].results.get('21').sampleCount, 1);
    assert.match(models[0].results.get('21').evidenceHash, /^[a-f0-9]{64}$/);
    assert.equal(models[0].results.has('22'), false);
    const weights = [{ conditionID: 21, weightBasisPoints: 5000 }, { conditionID: 22, weightBasisPoints: 5000 }];
    const [bounded] = scoreComparison(models, weights, 10000, {}, comparisonOptions(models));
    assert.equal(bounded.lower, 10);
    assert.equal(bounded.upper, 60);
    assert.equal(bounded.coverage, 50);
    const [available] = scoreComparison(models, weights, 10000, { scoreMode: 'available' }, comparisonOptions(models));
    const expected = Number((20 * 5 * .5 / (1 + 4 * .5)).toFixed(2));
    assert.equal(available.lower, expected);
    assert.equal(available.upper, expected);
    assert.equal(available.availableInference.observedScore, 20);
    assert.equal(available.availableInference.sourceCount, 0);
    assert.deepEqual(available.inferredScores, []);
    const fallback = { fallbackRules: [{ primaryConditionID: 23, mode: 'ordered',
        entries: [{ conditionID: 22 }] }] };
    const [missing] = scoreComparison(models, [{ conditionID: 23, weightBasisPoints: 10000 }],
        10000, fallback, comparisonOptions(models));
    assert.equal(missing.lower, null);
    assert.equal(missing.upper, null);
    assert.equal(missing.comparable, false);
    assert.equal(missing.resultCount, 0);
    assert.deepEqual(missing.calculationScores, []);
    assert.equal(missing.coverage, 0);
});
