import test from 'node:test';
import assert from 'node:assert/strict';

test('explicit provider fields identify AA republished scores, but an AA-named harness alone does not', () => {
    const fields = [
        { ID: 59, name: 'Published evaluation provider', type: 'text' },
        { ID: 60, name: 'Evaluator', type: 'enum', options: [{ ID: 7, label: 'Artificial Analysis' }] },
        { ID: 61, name: 'Harness', type: 'text' }
    ];
    for (const assignments of [[{ fieldID: 59, value: 'Artificial Analysis' }], [{ fieldID: 60, value: 7 }]]) {
        for (const score_fields of [assignments, JSON.stringify(assignments)]) {
            assert.equal(aaResultReason({ score_fields }, undefined, fields), 'aa_mirrored_result');
        }
    }
    assert.equal(aaResultReason({ scoreFields: [{ fieldID: 61, value: 'Artificial Analysis' }] }, undefined, fields), null);
    assert.equal(aaResultReason({ scoreFields: [{ fieldID: 59, value: 'Not Artificial Analysis' }] }, undefined, fields), null);
    assert.equal(aaResultReason({ scoreFields: [{ fieldID: 999, value: 'Artificial Analysis' }] }, undefined, fields), null);
    assert.equal(aaResultReason({ score_fields: 'invalid' }, undefined, fields), null);
});
import { aaBenchmarkReason, aaResultReason } from '../aa-archive-policy.js';

test('AA-specific evaluations are archived without hiding their upstream benchmarks', () => {
    assert.ok(aaBenchmarkReason('GDPval-AA'));
    assert.ok(aaBenchmarkReason('Artificial Analysis image preference'));
    assert.ok(aaBenchmarkReason('Terminal-Bench Hard'));
    assert.equal(aaBenchmarkReason('GDPval (Wins only)'), null);
    assert.equal(aaBenchmarkReason('gdp-pdf'), null);
    assert.equal(aaBenchmarkReason('GPQA Diamond'), null);
    assert.equal(aaBenchmarkReason('CritPt'), null);
});

test('direct and clearly mirrored AA scores are identified', () => {
    assert.equal(aaResultReason({ benchmark_ID: 1795,
        source_url: 'https://artificialanalysis.ai/models/releases/nova-2-0-pro-preview' }),
    'aa_direct_source');
    assert.equal(aaResultReason({ benchmark_ID: 1,
        source_url: 'https://artificialanalysis.ai/evaluations/gpqa-diamond' }), 'aa_direct_source');
    assert.equal(aaResultReason({ benchmark_ID: 1,
        source_url: 'https://openrouter.ai/model',
        source_title: 'Artificial Analysis comparison values' }), 'aa_mirrored_result');
    assert.equal(aaResultReason({ benchmark_ID: 1,
        source_url: 'https://huggingface.co/vendor/model',
        notes: '{"original_model_condition":"Artificial Analysis operator-reported comparator"}' }),
    'aa_mirrored_result');
});

test('independent scores using AA methods are not mistaken for AA-produced scores', () => {
    assert.equal(aaResultReason({ benchmark_ID: 1,
        source_url: 'https://www.minimax.io/news/model',
        notes: 'internal tests based on Artificial Analysis public evaluation sets and methods' }), null);
    assert.equal(aaResultReason({ benchmark_ID: 1,
        source_url: 'https://openai.com/model', source_title: 'Independent GDPval results' }), null);
});

test('structured AA attribution survives formatting and nested provenance', () => {
    for (const notes of [JSON.stringify({ harness: { operator: 'Artificial Analysis' } }, null, 2),
        { sourceDetails: { original_evaluator: 'Artificial Analysis' } },
        { sourceDetails: { original_source_host: 'artificialanalysis.ai' } },
        { sourceDetails: { original_source_url: 'https://artificialanalysis.ai/api/v2/data/llms/models' } }]) {
        assert.equal(aaResultReason({ source_url: 'https://example.org/mirror', notes }), 'aa_mirrored_result');
    }
    assert.equal(aaResultReason({ source_url: 'https://example.org/independent',
        notes: { sourceDetails: { protocol: 'QnA, AA prerelease harness', attribution: 'Self-reported result; not an AA rerun.' } } }), null);
});

test('audited Solar AA republication does not hide other SciCode default scores', () => {
    const result = { benchmark_ID: 1334, source_url: 'https://www.upstage.ai/blog/en/solar-mini-4',
        notes: JSON.stringify({ post_astra_import: { nativeID: 'solar-mini4:SciCode' } }) };
    assert.equal(aaResultReason(result), 'aa_mirrored_result');
    assert.equal(aaResultReason({ ...result, notes: '', ID: 173021 }), 'aa_mirrored_result');
    assert.equal(aaResultReason({ ...result, notes: '', ID: 173022 }), null);
    assert.equal(aaResultReason({ ...result, benchmark_ID: 1000 }), null);
    assert.equal(aaResultReason({ ...result, source_url: 'https://www.inceptionlabs.ai/blog/introducing-mercury-2-5' }), null);
});
