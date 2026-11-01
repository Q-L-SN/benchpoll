import assert from 'node:assert/strict';
import test from 'node:test';
import { loadModels, scoreComparison } from '../ranking-service.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';

const model = { model_ID: 3, model_name: 'Model', introductionURL: null,
    vendor_name: 'Lab', vendor_slug: 'lab', logo_key: null };
const condition = { benchmark_condition_ID: 21, uses_percentage_scale: 1,
    score_min: null, score_max: null, score_direction: 'higher', target_value: null };
const field = { ID: 1, name: 'Harness', type: 'text', allowEmpty: false, excludeMissing: false, options: [] };
const row = (ID, score, fields = []) => ({ result_ID: ID, model_ID: 3,
    benchmark_condition_ID: 21, raw_score: score, score_fields: fields });
function connection(rows, conditions = [condition], models = [model]) {
    return { async execute(sql) {
        if (sql.includes('FROM models JOIN')) return [models];
        if (sql.includes('FROM benchmark_conditions')) return [conditions];
        if (sql.includes('FROM benchmark_results')) {
            // Provenance is required for AA exclusion; avoid sorting wide evidence rows or joining display metadata.
            assert.doesNotMatch(sql, /ORDER BY|vendors\.|model_name|vendor_name/);
            assert.match(sql, /benchmark_results\.source_url, benchmark_results\.source_title, benchmark_results\.notes/);
            return [structuredClone(rows)];
        }
        throw new Error(`Unexpected SQL: ${sql}`);
    } };
}

test('unordered evidence retains earliest IDs, SQL model order, and independent configuration medians', async () => {
    const fieldsA = [{ fieldID: 1, value: 'A' }];
    const fieldsB = [{ fieldID: 1, value: 'B' }];
    const models = [{ ...model, model_ID: 4, model_name: 'A without results' }, model];
    const loaded = await loadModels(connection([
        row(13, '20.0', fieldsA), row(12, 80, JSON.stringify(fieldsA)),
        row(10, 20, fieldsA), row(11, 90, fieldsB), row(14, 10, fieldsB)
    ], [condition], models), [field]);
    assert.deepEqual(loaded.map(item => item.ID), [-4, 10, 11]);
    assert.equal(loaded[0].results.size, 0);
    assert.equal(loaded[1].results.get('21').normalizedScore, 50);
    assert.equal(loaded[1].results.get('21').sampleCount, 2);
    assert.equal(loaded[2].results.get('21').normalizedScore, 50);
    assert.equal(loaded[2].results.get('21').sampleCount, 2);
    assert.match(loaded[1].results.get('21').evidenceHash, /^[a-f0-9]{64}$/);
    assert.notEqual(loaded[1].results.get('21').evidenceHash, loaded[2].results.get('21').evidenceHash);
    assert.notDeepEqual(loaded[1].condition, loaded[2].condition);
});

test('request-local field memoization never hides changed definitions or malformed data', async () => {
    const db = connection([row(1, 50, [{ fieldID: 1, value: 'text' }])]);
    await loadModels(db, [field]);
    await assert.rejects(loadModels(db, [{ ...field, type: 'number' }]));
    await assert.rejects(loadModels(connection([row(1, 50, '{invalid')]), [field]));
    await assert.rejects(loadModels(connection([row(1, 50, [{ fieldID: 99, value: 'x' }])]), [field]));
});

test('accepted scores with missing conditions or invalid numbers fail explicitly', async () => {
    await assert.rejects(loadModels(connection([row(1, 50)], []), []),
        error => error.body.error === 'accepted_result_condition_unavailable');
    for (const value of [null, '', undefined, Infinity, 'invalid']) {
        await assert.rejects(loadModels(connection([row(1, value)]), []),
            error => error.body.error === 'accepted_result_score_invalid');
    }
});

test('matched evidence is scoped independently for personal/public weights', () => {
    const models = [1, 2].map(ID => ({ ID, modelID: ID, modelName: `M${ID}`, condition: { parameters: {} },
        results: new Map([['21', { normalizedScore: ID * 20 }]]) }));
    const options = comparisonOptions(models, { mode: 'matched', keys: ['model'] });
    const personal = [{ conditionID: 21, weightBasisPoints: 10000 }];
    const publicEntries = [{ conditionID: 22, weightBasisPoints: 10000 }];
    for (const entries of [personal, publicEntries, [], personal]) {
        const prepared = groupComparisonModels(models, options, entries);
        assert.deepEqual(scoreComparison(models, entries, 10000, {}, options, prepared),
            scoreComparison(models, entries, 10000, {}, options));
    }
    assert.equal(scoreComparison(models, personal, 10000, {}, options)[0].comparable, true);
    assert.equal(scoreComparison(models, publicEntries, 10000, {}, options)[0].comparable, false);
});

test('deferred HTTP metadata retains exact scoring and fallback evidence in both modes', () => {
    const models = [1, 2].map(ID => ({ ID, modelID: ID, modelName: `M${ID}`, condition: { parameters: {} },
        results: new Map([[ID === 1 ? '21' : '22', { normalizedScore: ID * 30 }]]) }));
    const entries = [{ conditionID: 21, weightBasisPoints: 10000 }];
    const rules = { fallbackRules: [{ primaryConditionID: 21, mode: 'ordered', entries: [{ conditionID: 22 }] }] };
    const options = comparisonOptions(models, { mode: 'best', keys: ['model'] });
    const grouped = groupComparisonModels(models, options, entries);
    for (const scoreMode of ['range', 'available']) {
        const eager = scoreComparison(models, entries, 10000, { ...rules, scoreMode }, options, grouped);
        const deferred = scoreComparison(models, entries, 10000, { ...rules, scoreMode, jsonMemberMetadata: true }, options, grouped);
        assert.equal(typeof Object.getOwnPropertyDescriptor(deferred[0], 'calculationScores').get, 'function');
        assert.deepEqual(JSON.parse(JSON.stringify(deferred)), JSON.parse(JSON.stringify(eager)));
        deferred[1].calculationScores[0].memberIDs.length = 0;
        deferred[0].members[0].condition.parameters.unsafe = true;
        assert.deepEqual(JSON.parse(JSON.stringify(scoreComparison(models, entries, 10000,
            { ...rules, scoreMode, jsonMemberMetadata: true }, options, grouped))), JSON.parse(JSON.stringify(eager)));
    }
});
