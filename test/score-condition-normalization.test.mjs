import test from 'node:test';
import assert from 'node:assert/strict';
import { extractScoreConfiguration, buildScoreConfigurationPlan,
    REQUIRED_SCORE_FIELDS } from '../score-condition-normalization.js';

const fields = [
    { ID: 1, name: 'Agent harness', type: 'text', options: [] },
    { ID: 2, name: 'Agent harness version', type: 'text', options: [] },
    { ID: 29, name: 'Retriever', type: 'text', options: [] },
    { ID: 5, name: 'Configuration selection', type: 'text', options: [] },
    { ID: 20, name: 'Reasoning effort', type: 'enum', options: [{ ID: 3, label: 'high' }] },
    ...REQUIRED_SCORE_FIELDS.map(([name, type]) => ({ ID: null, name, type, options: [] }))
];
const fieldMap = new Map(fields.map(field => [field.name.toLowerCase(), field]));
const condition = (ID, name, extra = {}) => ({ ID, benchmark_ID: 9, name, is_default: 0, is_active: 1,
    score_direction: 'higher', target_value: null, uses_percentage_scale: 1,
    score_min: null, score_max: null, resultCount: 1, protected: false, ...extra });
const result = (resultID, conditionID, scoreFields = []) => ({ resultID, conditionID, scoreFields });

test('moves a harness into a score field and merges identical evaluation definitions', () => {
    const plan = buildScoreConfigurationPlan([
        condition(1, 'split=test; metric=accuracy; harness=Alpha'),
        condition(2, 'split=test; metric=accuracy; harness=Beta')
    ], [result(11, 1), result(12, 2)], fields);
    assert.equal(plan.merges.length, 1);
    assert.deepEqual(plan.merges[0], { sourceID: 2, targetID: 1, resultCount: 1 });
    assert.deepEqual(plan.renames, [{ ID: 1, name: 'split=test; metric=accuracy' }]);
    assert.deepEqual(plan.fieldUpdates.map(item => item.additions), [
        [{ fieldName: 'Agent harness', value: 'Alpha' }],
        [{ fieldName: 'Agent harness', value: 'Beta' }]
    ]);
});

test('keeps existing matching score fields and never overwrites conflicting ones', () => {
    const plan = buildScoreConfigurationPlan([
        condition(1, 'metric=accuracy; harness=Alpha'),
        condition(2, 'metric=accuracy; harness=Beta')
    ], [result(11, 1, [{ fieldID: 1, value: 'alpha' }]),
        result(12, 2, [{ fieldID: 1, value: 'Gamma' }])], fields);
    assert.equal(plan.skipped.conflictingScoreFields, 1);
    assert.equal(plan.merges.length, 0);
    assert.deepEqual(plan.renames, [{ ID: 1, name: 'metric=accuracy' }]);
    assert.equal(plan.fieldUpdates.length, 0);
});

test('different metrics or scoring schemas cannot be merged', () => {
    const plan = buildScoreConfigurationPlan([
        condition(1, 'metric=accuracy; harness=Alpha'),
        condition(2, 'metric=f1; harness=Beta'),
        condition(3, 'metric=accuracy; harness=Gamma', { score_direction: 'lower' })
    ], [result(11, 1), result(12, 2), result(13, 3)], fields);
    assert.equal(plan.merges.length, 0);
    assert.equal(plan.skipped.incompatibleScoreScale, 2);
    assert.deepEqual(plan.renames.map(item => item.ID), [2]);
    assert.deepEqual(plan.fieldUpdates.map(item => item.resultID), [12]);
});

test('typed values and known enum values are preserved, invalid values are rejected', () => {
    const parsed = extractScoreConfiguration(condition(1,
        'metric=accuracy; embedding_dim=768; reasoning effort=high'), fieldMap);
    assert.deepEqual(parsed.assignments, [
        { fieldName: 'Embedding dimension', value: '768e0' },
        { fieldName: 'Reasoning effort', value: 3 }
    ]);
    assert.equal(extractScoreConfiguration(condition(1, 'metric=accuracy; reasoning effort=unknown'), fieldMap), null);
    assert.equal(extractScoreConfiguration(condition(1, 'metric=accuracy; embedding_dim=many'), fieldMap), null);
});

test('PinchBench run IDs and display age are provenance, not score-comparison fields', () => {
    const plan = buildScoreConfigurationPlan([
        condition(1, 'run_id=one; bench_version=2.0; listed_time=3 months ago', { benchmark_name: 'PinchBench' }),
        condition(2, 'run_id=two; bench_version=2.0; listed_time=4 months ago', { benchmark_name: 'PinchBench' })
    ], [result(11, 1), result(12, 2)], fields);
    assert.equal(plan.merges.length, 1);
    assert.deepEqual(plan.renames, [{ ID: 1, name: 'bench_version=2.0' }]);
    assert.equal(plan.fieldUpdates.length, 0);
});

test('Terminal-Bench operator rows become per-score harness and version fields', () => {
    const uuid = 'd72e8775-f4f1-4313-99e7-35b1cb499f24';
    const parsed = extractScoreConfiguration(condition(1,
        `Terminal-Bench4.0.0;66tasks;5trialspertask;8h;Claude Code@2.1.207;operator leaderboard row=${uuid};metric=accuracy`,
        { benchmark_name: 'Terminal-Bench 4.0' }), fieldMap);
    assert.equal(parsed.name, 'Terminal-Bench4.0.0; 66tasks; 5trialspertask; 8h; metric=accuracy');
    assert.deepEqual(parsed.assignments, [
        { fieldName: 'Agent harness', value: 'Claude Code' },
        { fieldName: 'Agent harness version', value: '2.1.207' }
    ]);
});

test('model label and sequence length do not split an MTEB metric by model', () => {
    const plan = buildScoreConfigurationPlan([
        condition(1, 'section=MTEB summary; metric=Retrieval; model_label=BAAI/bge-base-en-v1.5; sequence_length=512'),
        condition(2, 'section=MTEB summary; metric=Retrieval; model_label=all-mpnet-base-v2; sequence_length=514'),
        condition(3, 'section=MTEB summary; metric=Classification; model_label=all-mpnet-base-v2; sequence_length=514')
    ], [result(11, 1), result(12, 2), result(13, 3)], fields);
    assert.equal(plan.merges.length, 1);
    assert.deepEqual(plan.renames, [
        { ID: 1, name: 'section=MTEB summary; metric=Retrieval' },
        { ID: 3, name: 'section=MTEB summary; metric=Classification' }
    ]);
    assert.deepEqual(plan.fieldUpdates.find(item => item.resultID === 12).additions, [
        { fieldName: 'Model variant', value: 'all-mpnet-base-v2' },
        { fieldName: 'Sequence length', value: '514e0' }
    ]);
});

test('an undisclosed Context Arena reasoning mode is not an evaluation variant', () => {
    const plan = buildScoreConfigurationPlan([
        condition(1, 'needles=8; reasoning_mode=not_reported; context_bin=32768; metric=avg_score',
            { benchmark_name: 'Context Arena' }),
        condition(2, 'needles=8; context_bin=32768; metric=avg_score',
            { benchmark_name: 'Context Arena' })
    ], [result(11, 1), result(12, 2)], fields);
    assert.equal(plan.merges.length, 1);
    assert.deepEqual(plan.merges[0], { sourceID: 1, targetID: 2, resultCount: 1 });
    assert.equal(plan.fieldUpdates.length, 0);
});

test('AA-Omniscience source snapshots collapse by metric, never across index and accuracy', () => {
    const index = { benchmark_name: 'AA-Omniscience', uses_percentage_scale: 0,
        score_min: -100, score_max: 100 };
    const accuracy = { benchmark_name: 'AA-Omniscience' };
    const plan = buildScoreConfigurationPlan([
        condition(1, 'snapshot20260919;metric=index', index),
        condition(2, 'Omniscience index;not accuracy', index),
        condition(3, '2025-11-16 launch;metric=index', index),
        condition(4, 'snapshot20260919;metric=accuracy', accuracy),
        condition(5, 'accuracy;not Omniscience index;native radar radar-small', accuracy),
        condition(6, 'AA-Omniscience, accuracy;QAD study final recipe', accuracy),
        condition(7, 'AA-Omniscience', accuracy)
    ], [1, 2, 3, 4, 5, 6, 7].map(ID => result(ID + 10, ID)), fields);
    assert.deepEqual(plan.merges.map(item => [item.sourceID, item.targetID]), [
        [2, 1], [3, 1], [5, 4], [6, 4], [7, 4]
    ]);
    assert.deepEqual(plan.renames, [{ ID: 1, name: 'Index' }, { ID: 4, name: 'Accuracy' }]);
    assert.equal(plan.fieldUpdates.length, 0);
});

test('AA-Omniscience hallucination and non-hallucination remain separate', () => {
    const benchmark = { benchmark_name: 'AA-Omniscience' };
    const plan = buildScoreConfigurationPlan([
        condition(1, 'snapshot20260919;metric=hallucinationRate',
            { ...benchmark, score_direction: 'lower' }),
        condition(2, '2025-11-16 launch;metric=hallucination_rate',
            { ...benchmark, score_direction: 'lower' }),
        condition(3, 'Non-Hallucination', benchmark),
        condition(4, 'non-hallucination=1-hallucination;rounded chart percentage;2026-04-08 snapshot', benchmark)
    ], [1, 2, 3, 4].map(ID => result(ID + 10, ID)), fields);
    assert.deepEqual(plan.merges.map(item => [item.sourceID, item.targetID]), [[2, 1], [4, 3]]);
    assert.deepEqual(plan.renames, [
        { ID: 1, name: 'Hallucination rate' },
        { ID: 3, name: 'Non-hallucination rate' }
    ]);
});
