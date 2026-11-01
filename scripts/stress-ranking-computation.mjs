import assert from 'node:assert/strict';
import { loadModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions } from '../model-comparison.js';

// No database writes: 300k evidence records, with duplicates, target scoring and shared controls.
const models = Array.from({ length: 1000 }, (_, index) => ({ model_ID: index + 1,
    model_name: `Model ${index}`, vendor_name: 'Lab', vendor_slug: 'lab', logo_key: null }));
const conditions = Array.from({ length: 100 }, (_, index) => ({ benchmark_condition_ID: index + 1,
    uses_percentage_scale: 1, score_min: null, score_max: null,
    score_direction: index % 3 === 2 ? 'closer_to_target' : index % 3 === 1 ? 'lower' : 'higher',
    target_value: index % 3 === 2 ? 50 : null }));
const fields = [{ ID: 1, name: 'Harness', type: 'text', allowEmpty: false, excludeMissing: false, options: [] }];
const rows = [];
for (const model of models) for (const condition of conditions) for (const value of [20, 20, 80]) {
    rows.push({ result_ID: rows.length + 1, model_ID: model.model_ID,
        benchmark_condition_ID: condition.benchmark_condition_ID, raw_score: value,
        score_fields: '[{"fieldID":1,"value":"same harness"}]' });
}
rows.reverse();
const connection = { async execute(sql) {
    if (sql.includes('FROM models JOIN')) return [models];
    if (sql.includes('FROM benchmark_conditions WHERE')) return [conditions];
    if (sql.includes('FROM benchmark_results')) return [rows];
    throw new Error('Unexpected query');
} };
const start = performance.now();
const loaded = await loadModels(connection, fields);
const loadMs = Math.round(performance.now() - start);
assert.equal(loaded.length, 1000);
for (const item of loaded) for (const [key, score] of item.results) {
    assert.equal(score.sampleCount, 2);
    assert.equal(score.normalizedScore, Number(key) % 3 === 0 ? 40 : 50);
}
const entries = conditions.map(condition => ({ conditionID: condition.benchmark_condition_ID, weightBasisPoints: 100 }));
const timings = [];
for (const input of [{ mode: 'best', keys: [] }, { mode: 'best', keys: ['model'] }, { mode: 'matched', keys: ['model'] }]) {
    const started = performance.now();
    const options = comparisonOptions(loaded, input, fields);
    const ranking = scoreComparison(loaded, entries, 10000, {}, options);
    assert.equal(ranking.length, input.mode === 'best' && input.keys.length ? 1 : 1000);
    for (const score of ranking) {
        assert.equal(score.comparable, true);
        assert.ok(Math.abs(score.lower - 46.7) < 0.00001);
        assert.equal(score.lower, score.upper);
    }
    timings.push({ mode: input, ms: Math.round(performance.now() - started) });
}
console.log(JSON.stringify({ evidence: rows.length, configurations: loaded.length, loadMs, timings,
    heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) }, null, 2));
