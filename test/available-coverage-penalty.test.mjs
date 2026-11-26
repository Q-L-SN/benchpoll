import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { storedAvailableResultInference as availableResultInference, PAIRWISE_INFERENCE_METHOD, PAIRWISE_COVERAGE_METHOD, AVAILABLE_COVERAGE_PENALTY_POINTS,
    AVAILABLE_INFERENCE_VERSION, rankingReadBody } from '../public/js/shared/available-score.js';
import { scoreModels, scoreComparison } from '../ranking-service.js';
import { rankModels } from '../ranking-pagination.js';
import { comparisonOptions } from '../model-comparison.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { TREEMAP_ESTIMATION_METHOD } from '../public/js/shared/fallback-inference.js';
import { createFixtureState, weightedEntries, workspace } from '../scripts/frontend/fixtures.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-8, `${actual} != ${expected}`);
const model = (ID, values, parameters = {}) => ({ ID, modelID: ID, name: `M${ID}`, modelName: `M${ID}`,
    condition: { parameters, scoreFields: [] }, results: new Map(Object.entries(values).map(([key, normalizedScore]) => [key, { normalizedScore }])) });
const weights = [1, 2].map(conditionID => ({ conditionID, weightBasisPoints: 5000 }));
const infer = (observed, coverage, estimates = [], sourceCount = 0) => availableResultInference(
    observed, coverage, estimates, null, sourceCount, { method: PAIRWISE_COVERAGE_METHOD });
// Reconstruct archived v2/v3 evidence; the live backend no longer computes these totals.
function retiredTrace(row, method = PAIRWISE_COVERAGE_METHOD) {
    if (!row.availableInference) return row;
    const trace = row.availableInference;
    if (!trace.coverageFraction) return { ...row, availableInference: null };
    const inferredScores = row.inferredScores.filter(score => score.estimationMethod !== TREEMAP_ESTIMATION_METHOD);
    const supportedFraction = trace.coverageFraction + inferredScores.reduce((sum, score) => sum + score.originalWeight / 100, 0);
    const availableInference = availableResultInference(trace.observedScore, trace.coverageFraction,
        inferredScores.map(score => ({ normalizedScore: score.normalizedScore, weightFraction: score.originalWeight / 100 })),
        trace.percentile, trace.sourceCount, { method });
    const total = Math.round(availableInference.totalScore * 100) / 100;
    const archivedWeight = score => ({ ...score, effectiveWeight: score.effectiveWeight / supportedFraction,
        contribution: score.contribution / supportedFraction });
    return { ...row, availableInference, calculationScores: row.calculationScores.map(archivedWeight),
        inferredScores: inferredScores.map(archivedWeight), lower: row.lower === null ? null : total, upper: row.upper === null ? null : total };
}
const score = (models, entries = weights, rules = {}, comparison = {}) => scoreComparison(models, entries, 10000,
    { scoreMode: 'available', ...rules }, comparisonOptions(models, { mode: 'best', keys: ['model'], ...comparison }))
    .map(row => retiredTrace(row, rules.availableInferenceVersion === 2 ? PAIRWISE_INFERENCE_METHOD : PAIRWISE_COVERAGE_METHOD));

test('coverage penalty is two score points for each missing ten percent of weight', () => {
    assert.equal(AVAILABLE_COVERAGE_PENALTY_POINTS, 20);
    for (const coverage of [.01, .1, .25, .5, .75, .9, 1]) {
        const estimates = coverage === 1 ? [] : [{ normalizedScore: 40, weightFraction: 1 - coverage }];
        const result = infer(80, coverage, estimates, estimates.length ? 2 : 0);
        close(result.unpenalizedScore, 80 * coverage + 40 * (1 - coverage));
        close(result.coveragePenalty, 20 * (1 - coverage));
        close(result.totalScore, result.unpenalizedScore - result.coveragePenalty);
        close(result.observedContribution + result.inferredContribution, result.unpenalizedScore);
    }
});

test('lower coverage cannot improve a fixed score, including zero, negative and above-100 values', () => {
    for (const value of [-100, -20, 0, 20, 80, 150]) {
        let previous = -Infinity;
        for (const coverage of [.01, .1, .5, .9, 1]) {
            const result = infer(value, coverage);
            close(result.unpenalizedScore, value);
            assert.ok(result.totalScore >= previous && result.totalScore <= value);
            previous = result.totalScore;
        }
    }
    for (const coverage of [0, -.1, 1.1, NaN, Infinity]) assert.throws(() => infer(80, coverage), TypeError);
});

test('weighted coverage, not number of tests, determines the deduction; a measured zero counts', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 9000 }, { conditionID: 2, weightBasisPoints: 1000 },
        { conditionID: 3, weightBasisPoints: 0 }];
    const rows = score([model(1, { 1: 0, 3: 100 }), model(2, { 2: 0 })], entries);
    assert.deepEqual(rows.map(row => row.coverage), [90, 10]);
    close(rows[0].availableInference.coveragePenalty, 2);
    close(rows[1].availableInference.coveragePenalty, 18);
    assert.deepEqual(rows.map(row => row.resultCount), [1, 1]);
});

test('a high score on one low-weight test no longer outranks a better-supported close competitor', () => {
    const entries = [{ conditionID: 1, weightBasisPoints: 1000 }, { conditionID: 2, weightBasisPoints: 9000 }];
    const models = [model(1, { 1: 88 }), model(2, { 1: 80, 2: 80 })];
    const old = score(models, entries, { availableInferenceVersion: 2 });
    const current = score(models, entries);
    assert.deepEqual(old.map(row => row.lower), [88, 80]);
    assert.deepEqual(current.map(row => row.lower), [70, 80]);
    assert.deepEqual(rankModels(current).map(row => row.modelID), [2, 1]);
});

test('version 3 retains exact pairwise predictions and real traces, subtracting only the coverage deduction', () => {
    const models = [model(1, { 1: 95 }), model(2, { 1: 90, 3: 20, 2: 10 }),
        model(3, { 3: 80, 2: 70 }), model(4, { 2: 60 }), model(5, { 2: 90 })];
    const before = structuredClone(models), legacy = score(models, weights, { availableInferenceVersion: 2 });
    const current = score(models);
    current.forEach((row, index) => {
        assert.deepEqual(row.inferredScores, legacy[index].inferredScores);
        assert.deepEqual(row.calculationScores, legacy[index].calculationScores);
        assert.deepEqual(row.comparisonScores, legacy[index].comparisonScores);
        close(row.availableInference.unpenalizedScore, legacy[index].availableInference.totalScore);
        close(row.availableInference.coveragePenalty, row.missingWeight / 100 * 20);
        close(row.availableInference.totalScore, legacy[index].availableInference.totalScore - row.availableInference.coveragePenalty);
    });
    assert.deepEqual(models, before);
});

test('the archived deduction formula can still express fractional historical coverage', () => {
    for (const [coverage, penalty] of [[.3, 14], [.5, 10]]) {
        const trace = infer(25, coverage, [{ normalizedScore: 60, weightFraction: 1 - coverage }], 2);
        close(trace.coveragePenalty, penalty);
        close(trace.inferredFraction, 1 - coverage);
    }
});

test('unresolved shares are still penalized and extra unweighted sources never increase coverage', () => {
    const [alone] = score([model(1, { 1: 80, 3: 100, 4: 100 })]);
    assert.equal(alone.availableInference.unresolvedFraction, .5);
    assert.equal(alone.availableInference.coveragePenalty, 10);
    assert.equal(alone.lower, 70);
    const [zero] = score([model(1, { 3: 100 }), model(2, { 1: 80, 2: 90, 3: 80 })]);
    assert.equal(zero.comparable, false);
    assert.equal(zero.lower, null);
    assert.equal(zero.availableInference, null);
});

test('unrounded coverage determines the penalty even for tiny Public shares', () => {
    const coverage = .123456789;
    const [row] = score([model(1, { 1: 80 })], [{ conditionID: 1, weightBasisPoints: coverage * 10000 },
        { conditionID: 2, weightBasisPoints: (1 - coverage) * 10000 }]);
    close(row.availableInference.coveragePenalty, 20 * (1 - coverage));
    assert.notEqual(row.availableInference.coveragePenalty, 20 * (1 - row.coverage / 100));
});

test('fully measured totals and Score range do not change; lazy metadata preserves the raw trace', () => {
    const models = [model(1, { 1: -20, 2: 120 }), model(2, { 1: -10, 2: 130 })];
    assert.deepEqual(score(models).map(row => row.lower), [50, 60]);
    assert.ok(score(models).every(row => row.availableInference.coveragePenalty === 0));
    const ranged = score(models, weights, { scoreMode: 'range' });
    assert.ok(ranged.every(row => row.availableInference === null));
    assert.deepEqual(ranged.map(row => row.lower), [50, 60]);
    const [eager] = scoreModels(models, weights, 10000, { scoreMode: 'available' });
    const [lazy] = scoreModels(models, weights, 10000, { scoreMode: 'available', deferMetadata: true });
    assert.deepEqual(JSON.parse(JSON.stringify(lazy)), JSON.parse(JSON.stringify(eager)));
});

test('fresh legacy-version requests no longer select archived deduction algorithms', () => {
    const models = [model(1, { 1: 80 }, { harness: 'same' }), model(2, { 1: 60 }, { harness: 'same' })];
    for (const mode of ['best', 'matched']) {
        for (const availableInferenceVersion of [1, 2, 3, 4, 5, 6, 7, 8]) {
            const rows = scoreComparison(models, weights, 10000, { scoreMode: 'available', availableInferenceVersion },
                comparisonOptions(models, { mode, keys: ['model'] }));
            assert.deepEqual(rows.map(row => row.lower), [80, 60]);
            assert.ok(rows.every(row => !Object.hasOwn(row.availableInference, 'coveragePenalty')));
        }
    }
    assert.equal(AVAILABLE_INFERENCE_VERSION, 13);
    assert.equal(rankingReadBody('/api/get_weighted_workspace', {}).availableInferenceVersion, 13);
    for (const version of [1, 2, 5, 6, 8]) assert.equal(rankingReadBody('/api/get_weighted_workspace', { availableInferenceVersion: version }).availableInferenceVersion, 13);
});

test('workspace validation requires an accurate separate deduction and pre-deduction contribution trace', () => {
    const models = [model(1, { 1: 80 }), model(2, { 1: 60, 2: 70 }), model(3, { 1: 90, 2: 95 })];
    const payload = workspace(createFixtureState({ comparisonModels: models, personalEntries: weightedEntries(weights), publicWeights: weights }),
        { scoreMode: 'available', initialMode: 'personal', availableInferenceVersion: 3 });
    for (const mode of ['personal', 'public']) payload.modelLeaderboards[mode] = payload.modelLeaderboards[mode].map(row => retiredTrace(row));
    assert.equal(validateWorkspacePayload(payload), payload);
    for (const mutation of [row => { row.availableInference.coveragePenalty = 0; },
        row => { row.availableInference.coveragePenalty = -10; },
        row => { delete row.availableInference.coveragePenalty; },
        row => { row.availableInference.unpenalizedScore++; },
        row => { row.availableInference.totalScore++; }, row => { row.calculationScores[0].contribution--; }]) {
        const changed = structuredClone(payload);
        mutation(changed.modelLeaderboards.personal.find(row => row.missingWeight > 0));
        assert.throws(() => validateWorkspacePayload(changed), /Invalid workspace response/);
    }
});

test('current help explains version-based estimates and full-weight gaps', () => {
    const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
    assert.match(read('private/home.html'), /Nominated external versions can supply an estimate/);
    const guide = read('private/how-it-works.html');
    assert.match(guide, /Version-based estimation/);
    assert.match(guide, /version estimates and treemap estimates at their full weights/);
    assert.match(guide, /their weights scaled to sum to 100%/);
    assert.match(guide, /uses 0 at the lower end and 100 at the upper end for missing measurements/);
    assert.doesNotMatch(guide, /coverage factor|coverage penalty|excluded from the average/i);
    const details = read('public/js/workspace/model-scores.js');
    assert.match(details, /weighted average of measured and version-estimated scores in the treemap/);
});
