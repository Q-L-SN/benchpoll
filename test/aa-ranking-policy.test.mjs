import assert from 'node:assert/strict';

test('SciCode Verified is an AA variant, independent classic SciCode is not', () => {
    assert.equal(isAACondition({ benchmarkID: 1334, conditionKey: 'verified-pass-1', conditionName: 'Verified pass@1' }), true);
    assert.equal(isAACondition({ benchmarkID: 1334, conditionKey: 'default' }), false);
    assert.equal(isAACondition({ benchmarkID: 1000, conditionKey: 'verified-pass-1' }), false);
});
import test from 'node:test';
import { isAABenchmark, isAACondition } from '../public/js/shared/aa-ranking-policy.js';
import { scoreModels } from '../ranking-service.js';

test('AA benchmarks and marked conditions are excluded without excluding unrelated versions', () => {
    for (const name of ['AA-LCR', 'AA Speech Arena', 'AA Pronunciation Robustness', 'Artificial Analysis Image Arena',
        'Artificial-Analysis Image Arena', 'GDPval-AA v2', 'APEX-Agents-AA', 'Terminal-Bench Hard']) {
        assert.equal(isAABenchmark(name), true, name);
    }
    assert.equal(isAABenchmark('GPQA Diamond'), false);
    assert.equal(isAACondition({ name: 'CritPt', conditionKey: 'aa-official-score', conditionName: 'Challenge accuracy' }), true);
    assert.equal(isAACondition({ name: 'GPQA Diamond', conditionKey: 'other', conditionName: 'Artificial Analysis zero-shot protocol' }), true);
    assert.equal(isAACondition({ name: 'GPQA Diamond', conditionKey: 'default', conditionName: 'default' }), false);
});

test('renamed AA versions use audited benchmark and version identities, not generic descriptions', () => {
    for (const [benchmarkID, conditionKey] of [
        [1152, 'crawl-5fbb9c71e353ee518fb5ccba'], [1152, 'crawl-a18a684f6a452ca14ea603b6'],
        [1313, 'verified-anthropic-120-held-out-tasks-all-pass'],
        [1313, 'verified-anthropic-120-held-out-tasks-criteria-pass-rate'],
        [1428, 'crawl-151562e6b464d951cfafd948'], [1489, 'end-to-end-reproduction-and-patching'],
        [1655, 'crawl-2c79c5b97186b2b435e8cf01'], [1687, 'crawl-6c6f1535abb4a0c68af896bc']
    ]) {
        assert.equal(isAACondition({ benchmarkID, conditionKey, conditionName: 'Renamed version' }), true);
        assert.equal(isAACondition({ benchmark_ID: benchmarkID, condition_key: conditionKey, condition_name: 'Renamed version' }), true);
        assert.equal(isAACondition({ benchmarkID: 999999, conditionKey, conditionName: 'Independent version' }), false);
    }
    assert.equal(isAACondition({ benchmarkID: 1152, conditionKey: 'default', conditionName: 'default' }), false);
    assert.equal(isAACondition({ benchmarkID: 1768, conditionKey: 'crawl-451dbcf1c35bdb0597d38337',
        conditionName: 'Codebase QnA; full task set; task resolution rate (mean pass@1)' }), false);
    assert.equal(isAACondition({ benchmarkID: 1313, conditionKey: 'vals-1-1', conditionName: 'v1.1 all-pass',
        differenceExplanation: 'This differs from Artificial Analysis grading.' }), false);
    assert.equal(isAACondition({ name: 'NVIDIA run', conditionName: 'Independent accuracy',
        differenceExplanation: 'An AA-style prompt independently run by NVIDIA.' }), false);
});

test('AA version tokens and explicit source tags cover aliases without matching ordinary words', () => {
    for (const name of ['Overall [AA]', 'Overall, AA', 'LAB-AA single judge', 'AA', 'Artificial_Analysis run']) {
        assert.equal(isAACondition({ benchmarkName: 'Bench', benchmarkConditionName: name }), true, name);
    }
    for (const scoreSource of ['aa', 'aa_official', 'artificial_analysis', 'artificial-analysis']) {
        assert.equal(isAACondition({ name: 'Bench', conditionName: 'default', scoreSource }), true);
    }
    for (const name of ['AAAI', 'SaaS benchmark', 'CAA test']) assert.equal(isAABenchmark(name), false, name);
});


for (const scope of ['personal', 'public']) test(`${scope} scoring skips AA fallback before the next valid condition`, () => {
    const model = { ID: 1, modelID: 1, name: 'Example', results: new Map([
        ['2', { normalizedScore: 99 }], ['3', { normalizedScore: 73 }]
    ]) };
    const entries = [{ conditionID: 1, weightBasisPoints: 10000 }];
    const chain = [{ conditionID: 2 }, { conditionID: 3 }];
    const rules = scope === 'personal' ? { fallbackRules: [{ primaryConditionID: 1, mode: 'ordered', entries: chain }] }
        : { fallbackScope: 'public', familyComposition: [{ primaryConditionID: 1, families: [{ primaryConditionID: 1, entries: chain, weightBasisPoints: 10000 }] }] };
    const [result] = scoreModels([model], entries, 10000, { ...rules, excludedConditionIDs: new Set([2]) });
    assert.equal(result.lower, 73);
    assert.deepEqual(result.fallbackResolutions[0].attemptedConditionIDs, [1, 3]);
});
