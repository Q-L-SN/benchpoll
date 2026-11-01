import assert from 'node:assert/strict';
import test from 'node:test';
import { auditConditionScoreOverlap, roundedScoreVariants } from '../condition-score-overlap.js';

function snapshot(scores, fields = []) {
    const IDs = [...new Set(scores.map(row => row.conditionID))];
    return { version: 1, snapshotTime: '2026-09-28', fields, options: [],
        conditions: IDs.map(ID => ({ ID, benchmark_ID: 1, benchmark_name: 'Example', name: `condition ${ID}`,
            score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null })),
        results: scores.map((row, index) => ({ ID: index + 1, modelID: 1, modelName: 'Model', fields: [], sourceURL: '', ...row })) };
}

test('decimal rounding is exact at binary floating point boundaries', () => {
    assert.ok(roundedScoreVariants('1.005000').some(v => v.score === '1.01' && v.precision === 2 && v.methods.includes('round')));
    assert.ok(roundedScoreVariants('99.999999').some(v => v.score === '100' && v.precision === 0));
    assert.equal(roundedScoreVariants('42.000000').length, 0);
    assert.throws(() => roundedScoreVariants('NaN'), /Invalid/);
});

test('negative floor means toward negative infinity, not truncation toward zero', () => {
    const variants = roundedScoreVariants('-1.239');
    assert.ok(variants.some(v => v.score === '-1.24' && v.methods.includes('floor')));
    assert.ok(!variants.some(v => v.score === '-1.23'));
    assert.ok(roundedScoreVariants('-1.25').some(v => v.score === '-1.3' && v.methods.includes('round')));
});

test('same numeric value on different models or configurations is not matching evidence', () => {
    const data = snapshot([
        { conditionID: 1, rawScore: '12.34', modelID: 1 },
        { conditionID: 2, rawScore: '12.3', modelID: 2 },
        { conditionID: 3, rawScore: '12.3', modelID: 1, fields: [{ fieldID: 1, value: 'custom' }] }
    ], [{ ID: 1, name: 'Harness', type: 'text' }]);
    assert.equal(auditConditionScoreOverlap(data).pairs.length, 0);
});

test('source duplicates are consolidated before overlap ratios and independent model checks', () => {
    const data = snapshot([
        { conditionID: 1, modelID: 1, rawScore: '12.30', sourceURL: 'https://a.example' },
        { conditionID: 1, modelID: 1, rawScore: '12.300000', sourceURL: 'https://b.example' },
        { conditionID: 2, modelID: 1, rawScore: '12.3' }
    ]);
    const report = auditConditionScoreOverlap(data);
    assert.equal(report.pairs[0].exactMatchCount, 1);
    assert.equal(report.pairs[0].category, 'single-exact');
    assert.deepEqual(report.pairs[0].counts, [1, 1]);
    assert.equal(report.summary.sourceDuplicates, 1);
    assert.equal(report.samples[0].sources.length, 2);
});

test('75 percent alone does not suppress conflicts; confirmed merges suppress only their own group', () => {
    const data = snapshot([
        ...[1, 2, 3].flatMap(modelID => [
            { conditionID: 1, modelID, rawScore: `${modelID * 10}` },
            { conditionID: 2, modelID, rawScore: `${modelID * 10}` }
        ]),
        { conditionID: 1, modelID: 4, rawScore: '44.44' },
        { conditionID: 2, modelID: 4, rawScore: '44.4' },
        { conditionID: 3, modelID: 4, rawScore: '44' }
    ]);
    const report = auditConditionScoreOverlap(data);
    const exactPair = report.pairs.find(pair => pair.conditionIDs.join() === '1,2');
    assert.equal(exactPair.exactThresholdMet, true);
    assert.equal(exactPair.roundingNeedsReview, true);
    assert.equal(exactPair.rounding.length, 1);
    assert.equal(exactPair.conflictingConfigs, 1);
    assert.equal(exactPair.numericChecksPassed, false);
    assert.equal(report.pairs.find(pair => pair.conditionIDs.join() === '2,3').roundingNeedsReview, true);
    const approved = auditConditionScoreOverlap(data, { confirmedMergeGroups: [{ targetID: 1, sourceIDs: [2] }] });
    assert.equal(approved.pairs.find(pair => pair.conditionIDs.join() === '1,2').roundingNeedsReview, false);
    assert.equal(approved.pairs.find(pair => pair.conditionIDs.join() === '2,3').roundingNeedsReview, true);
});

test('unit interval rounding is recorded but marked as low-information evidence', () => {
    const report = auditConditionScoreOverlap(snapshot([
        { conditionID: 1, rawScore: '0.8' }, { conditionID: 2, rawScore: '1' }
    ]));
    assert.equal(report.pairs[0].rounding[0].lowInformation, true);
    assert.equal(report.pairs[0].roundingNeedsReview, true);
    assert.equal(report.summary.roundingOnlyLowInformation, 1);
});

test('fields are order independent and numeric field values use exact canonical identity', () => {
    const data = snapshot([
        { conditionID: 1, rawScore: '91.28', fields: [{ fieldID: 2, value: null }, { fieldID: 1, value: '1.00' }] },
        { conditionID: 2, rawScore: '91.3', fields: [{ fieldID: 1, value: '1e0' }, { fieldID: 2, value: null }] }
    ], [{ ID: 1, name: 'Budget', type: 'number' }, { ID: 2, name: 'Search', type: 'presence' }]);
    const report = auditConditionScoreOverlap(data);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].rounding[0].precision, 1);
    assert.deepEqual(report.pairs[0].rounding[0].methods, ['round']);
});

test('different benchmark families never match and incompatible scales are visible', () => {
    const data = snapshot([
        { conditionID: 1, modelID: 1, rawScore: '1.25' },
        { conditionID: 2, modelID: 1, rawScore: '1.3' },
        { conditionID: 3, modelID: 1, rawScore: '1.25' }
    ]);
    data.conditions[1].score_direction = 'lower';
    data.conditions[2].benchmark_ID = 2;
    const report = auditConditionScoreOverlap(data);
    assert.equal(report.pairs.length, 1);
    assert.equal(report.pairs[0].sameScale, false);
});

test('multiple scores from one model cannot satisfy the independent model check', () => {
    const report = auditConditionScoreOverlap(snapshot([
        { conditionID: 1, rawScore: '10' }, { conditionID: 1, rawScore: '20' },
        { conditionID: 2, rawScore: '10' }, { conditionID: 2, rawScore: '20' }
    ]));
    assert.equal(report.pairs[0].exactThresholdMet, true);
    assert.equal(report.pairs[0].numericChecksPassed, false);
});
