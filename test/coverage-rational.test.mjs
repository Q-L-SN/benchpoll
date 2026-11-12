import test from 'node:test';
import assert from 'node:assert/strict';
import * as coveragePenalty from '../public/js/shared/coverage-penalty.js';
import { coverageMultiplier } from '../public/js/shared/coverage-penalty.js';
import { availableResultInference, storedAvailableResultInference, AVAILABLE_INFERENCE_VERSION, normalizeAvailableInferenceVersion, PAIRWISE_COVERAGE_FACTOR_METHOD, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD } from '../public/js/shared/available-score.js';
import { scoreModels } from '../ranking-service.js';
import { createTopicHomeService, normalizeTopicPreview } from '../topic-home-service.js';
import { createWorkspaceState } from '../public/js/workspace/state.js';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';
import { createFixtureState, workspace } from '../scripts/frontend/fixtures.mjs';

const close = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-10, `${actual} != ${expected}`);
const infer = (score, coverage) => availableResultInference(score, coverage, []);

test('rational a=5 has fixed endpoints, is smooth increasing and concave', () => {
    assert.equal(coverageMultiplier(0), 0);
    assert.equal(coverageMultiplier(1), 1);
    close(coverageMultiplier(.3), 1.5 / 2.2);
    for (let step = 1; step < 1000; step++) {
        const c = step / 1000, value = coverageMultiplier(c);
        assert.ok(value > coverageMultiplier(c - .001));
        assert.ok(value >= (coverageMultiplier(c - .001) + coverageMultiplier(c + .001)) / 2 - 1e-12);
    }
    for (const c of [-1, 1.1, Infinity, NaN]) assert.throws(() => coverageMultiplier(c));
});

test('the fixed rational multiplier keeps negative and tiny-coverage totals finite', () => {
    for (const score of [0, 80, -80, Number.MAX_VALUE, -Number.MAX_VALUE]) for (const coverage of [Number.MIN_VALUE, 1e-12, .3, .5, 1]) {
        const result = infer(score, coverage), factor = coverageMultiplier(coverage);
        assert.equal(result.method, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD);
        close(result.coverageFactor, factor);
        assert.equal(result.unpenalizedScore, score);
        assert.ok(Number.isFinite(result.totalScore));
        assert.ok(result.totalScore <= score || Math.abs(result.totalScore - score) < 1e-10);
        close(result.appliedFactor, score < 0 ? 2 - factor : factor);
    }
    assert.throws(() => infer(80, 0), /Invalid available/);
    close(infer(80, .3).totalScore, 80 * 1.5 / 2.2);
});

test('rational scoring keeps zero-coverage models unranked and never affects ranges', () => {
    const models = [
        { ID: 1, name: 'Measured', results: new Map([['1', { normalizedScore: 80, memberIDs: [1] }]]) },
        { ID: 2, name: 'No score', results: new Map() }
    ];
    const weights = [{ conditionID: 1, weightBasisPoints: 3000 }, { conditionID: 2, weightBasisPoints: 7000 }];
    const rational = scoreModels(models, weights, 10000, { scoreMode: 'available' });
    assert.equal(rational[0].availableInference.method, PAIRWISE_RATIONAL_COVERAGE_FACTOR_METHOD);
    close(rational[0].availableInference.coverageFactor, 1.5 / 2.2);
    assert.equal(rational[1].lower, null);
    assert.equal(rational[1].availableInference, null);
    assert.deepEqual(scoreModels(models, weights, 10000, { scoreMode: 'range', availableInferenceVersion: 5 }),
        scoreModels(models, weights, 10000, { scoreMode: 'range', availableInferenceVersion: 4 }));
});

test('coverage has no preference API and all supported stale request versions upgrade to v7', () => {
    assert.deepEqual(Object.keys(coveragePenalty).sort(), ['RATIONAL_COVERAGE_A', 'coverageMultiplier']);
    assert.equal(AVAILABLE_INFERENCE_VERSION, 7);
    assert.equal(createWorkspaceState().availableInferenceVersion, 7);
    assert.equal(normalizeAvailableInferenceVersion(), 7);
    for (const version of [1, 2, 3, 4, 5, 6, 7]) assert.equal(normalizeAvailableInferenceVersion(version), 7);
    for (const version of [0, 8, '5', null, NaN]) assert.throws(() => normalizeAvailableInferenceVersion(version));
});

test('the fresh inference API cannot opt back into the retired formula', () => {
    const fresh = infer(80, .3);
    assert.throws(() => availableResultInference(80, .3, [], null, 0, { method: PAIRWISE_COVERAGE_FACTOR_METHOD }), /Invalid estimation algorithm/);
    assert.notEqual(fresh.coverageFactor, .3 ** .35);
});

test('stored v4 evidence is still validated with its recorded factors, independently of new calculations', () => {
    const payload = workspace(createFixtureState(), { scoreMode: 'available' });
    for (const rows of Object.values(payload.modelLeaderboards)) for (const row of rows) {
        const trace = row.availableInference;
        row.availableInference = storedAvailableResultInference(trace.observedScore, trace.coverageFraction,
            row.inferredScores.map(score => ({ normalizedScore: score.normalizedScore, weightFraction: score.originalWeight / 100 })),
            trace.percentile, trace.sourceCount, { method: PAIRWISE_COVERAGE_FACTOR_METHOD });
        row.lower = row.upper = Math.round(row.availableInference.totalScore * 100) / 100;
    }
    assert.equal(validateWorkspacePayload(payload), payload);
    const changed = structuredClone(payload);
    changed.modelLeaderboards.public[0].availableInference.coverageFactor = coverageMultiplier(changed.modelLeaderboards.public[0].availableInference.coverageFraction);
    assert.throws(() => validateWorkspacePayload(changed), /Invalid workspace response/);
});

test('fresh and stale Home requests share only v7 cache and pagination, including concurrent reads', async () => {
    const versions = [];
    const db = { async execute(sql, parameters) {
        assert.match(sql, /SELECT ID FROM categories WHERE ID IN/);
        assert.deepEqual(parameters, [54, null]);
        return [[{ ID: 54, public_ID: 1, owner_user_ID: null, is_active: 1 }]];
    } };
    const service = createTopicHomeService({ db, loadTopic: async () => ({ ID: 54, categoryID: 54, publicID: 1, url: '/1', isPrivate: false }), loadFields: async () => [],
        loadWorkspace: async (_db, options) => {
            versions.push(options.availableInferenceVersion);
            return { context: { contextValues: {} }, comparison: { keys: ['model'], fields: [], availableKeys: ['model'], models: [] },
                publicPie: { entries: [], coverageIndex: 0 }, modelLeaderboards: { public: [{ ID: 1, name: 'A', lower: options.availableInferenceVersion, upper: options.availableInferenceVersion }] } };
        } });
    const [fresh, stale, explicit] = await Promise.all([service.preview(null, { categoryID: 54 }),
        service.preview(null, { categoryID: 54, availableInferenceVersion: 4 }),
        service.preview(null, { categoryID: 54, availableInferenceVersion: 5 })]);
    assert.deepEqual(versions, [7]);
    assert.equal(fresh, stale); assert.equal(fresh, explicit);
    assert.equal(fresh.models[0].lower, 7);
    const page = await service.preview(null, { categoryID: 54, availableInferenceVersion: 4, snapshotID: fresh.pagination.snapshotID });
    assert.equal(page.pagination.snapshotID, fresh.pagination.snapshotID);
    for (const value of [0, 8, '5', null]) assert.throws(() => normalizeTopicPreview({ categoryID: 54, availableInferenceVersion: value }));
});
