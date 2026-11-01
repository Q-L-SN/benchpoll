import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModels, savePersonalPie } from '../ranking-service.js';

const models = [{ model_ID: 3, model_name: 'Model', vendor_name: 'Lab' },
    { model_ID: 4, model_name: 'No scores', vendor_name: 'Lab' }];
const fields = [{ ID: 1, name: 'Effort', type: 'number', allowEmpty: false, options: [] }];
const conditions = [21, 22, 99].map(benchmark_condition_ID => ({ benchmark_condition_ID,
    uses_percentage_scale: 1, score_direction: 'higher', score_min: null, score_max: null, target_value: null }));
const row = (result_ID, conditionID, raw_score, value) => ({ result_ID, model_ID: 3,
    benchmark_condition_ID: conditionID, raw_score, score_fields: [{ fieldID: 1, value }] });
const evidence = [row(10, 99, 99, '1.0'), row(11, 99, 90, '2'), row(12, 21, 20, '1'),
    row(13, 21, 80, '1e0'), row(14, 21, 0, '2'), row(15, 22, 50, '1')];

function fixture() {
    const queries = [];
    return { queries, async execute(sql, params = []) {
        queries.push({ sql, params });
        if (sql.includes('FROM models JOIN')) return [structuredClone(models)];
        if (sql.includes('FROM benchmark_conditions')) return [conditions.filter(condition =>
            sql.includes('0 = 1') ? false : !sql.includes('IN (') || params.includes(condition.benchmark_condition_ID))];
        if (sql.includes('MIN(benchmark_results.ID)')) {
            const groups = new Map();
            for (const observation of evidence) {
                const key = JSON.stringify([observation.model_ID, observation.score_fields]);
                if (!groups.has(key)) groups.set(key, { result_ID: observation.result_ID,
                    model_ID: observation.model_ID, score_fields: structuredClone(observation.score_fields) });
            }
            return [[...groups.values()]];
        }
        if (sql.includes('FROM benchmark_results')) return [structuredClone(evidence.filter(observation =>
            sql.includes('0 = 1') ? false : !sql.includes(' IN (') || params.includes(observation.benchmark_condition_ID)))];
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
}

test('scoping scores preserves global identities, canonical configurations, order, medians and evidence hashes', async () => {
    const full = await loadModels(fixture(), fields);
    const db = fixture();
    const scoped = await loadModels(db, fields, { conditionIDs: [21] });
    assert.deepEqual(scoped.map(model => model.ID), [10, 11, -4]);
    assert.deepEqual(scoped, full.map(model => ({ ...model,
        results: new Map([...model.results].filter(([key]) => key === '21')) })));
    assert.equal(scoped[0].results.get('21').normalizedScore, 50);
    assert.equal(scoped[1].results.get('21').normalizedScore, 0);
    assert.ok(db.queries.some(query => query.sql.includes('benchmark_condition_ID IN (?)')
        && query.params[0] === 21));
    assert.doesNotMatch(db.queries.find(query => query.sql.includes('MIN(benchmark_results.ID)')).sql,
        /benchmark_condition_ID IN/);
});

test('empty scope preserves every identity but never materializes unrelated score evidence', async () => {
    const db = fixture();
    const loaded = await loadModels(db, fields, { conditionIDs: [] });
    assert.deepEqual(loaded.map(model => model.ID), [10, 11, -4]);
    assert.ok(loaded.every(model => model.results.size === 0));
    assert.match(db.queries.find(query => query.sql.includes('raw_score')).sql, /AND 0 = 1/);
});

test('invalid score scopes fail before database access', async () => {
    const db = { execute() { throw new Error('Invalid scope reached SQL'); } };
    for (const conditionIDs of [0, {}, [-1], [1, 1], ['21'], [NaN]]) {
        await assert.rejects(loadModels(db, fields, { conditionIDs }),
            error => error.body?.error === 'invalid_score_scope');
    }
    for (const evidenceConditionIDs of [0, {}, [-1], [1, 1], ['21'], [NaN]]) {
        await assert.rejects(loadModels(db, null, { evidenceConditionIDs }),
            error => error.body?.error === 'invalid_score_scope');
    }
});

test('percentile references retain numeric results but hash only actual calculation evidence', async () => {
    const full = await loadModels(fixture(), fields);
    const reference = await loadModels(fixture(), fields, { conditionIDs: [21, 22, 99], evidenceConditionIDs: [21] });
    for (const [index, model] of reference.entries()) for (const [key, score] of model.results) {
        const original = full[index].results.get(key);
        assert.equal(score.normalizedScore, original.normalizedScore);
        assert.equal(score.sampleCount, original.sampleCount);
        assert.equal(score.evidenceHash, key === '21' ? original.evidenceHash : undefined);
    }
});

test('save validation reads metadata and field definitions, never full score observations', async () => {
    const queries = [];
    let rolledBack = false, released = false;
    const db = { async getConnection() { return {
        async execute(sql) {
            queries.push(sql);
            if (sql.includes('FROM models JOIN')) return [models];
            if (sql.includes('FROM score_fields') || sql.includes('FROM score_field_options')) return [[]];
            throw new Error(`Unexpected query: ${sql}`);
        },
        async rollback() { rolledBack = true; },
        release() { released = true; }
    }; } };
    await assert.rejects(savePersonalPie(db, { userID: 1, categoryID: 1, expectedRevision: 0,
        entries: [{ conditionID: 21, weightBasisPoints: 10000 }], fallbackRules: [],
        comparison: { mode: 'matched', keys: [] } }), error => error.body?.error === 'comparison_key_required');
    assert.ok(rolledBack && released);
    assert.ok(queries.every(sql => !sql.includes('FROM benchmark_results')));
});
