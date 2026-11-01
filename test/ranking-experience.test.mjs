import test from 'node:test';
import assert from 'node:assert/strict';
import { availableResultInference } from '../public/js/shared/available-score.js';
import { benchmarkVersionTieOrder } from '../public/js/shared/benchmark-version-order.js';
import { createRankingPager } from '../ranking-pagination.js';
import { comparisonOptions, groupComparisonModels } from '../model-comparison.js';
import { scoreComparison } from '../ranking-service.js';
import { workspace, createFixtureState } from '../scripts/frontend/fixtures.mjs';
import { validateWorkspacePayload, validateRankingPagePayload } from '../public/js/workspace/contracts.js';
import { readFileSync } from 'node:fs';

test('full coverage is unchanged and absent references still receive the rational coverage penalty', () => {
    for (const score of [-200, -10, 0, 40, 50, 80, 100, 150, 1000]) {
        assert.equal(availableResultInference(score, 1, []).totalScore, score);
        for (const coverage of [.000001, .01, .1, .3, .5, .8, 1]) {
            const inference = availableResultInference(score, coverage, []);
            const factor = 5 * coverage / (1 + 4 * coverage);
            assert.equal(inference.totalScore, score * (score < 0 ? 2 - factor : factor));
            assert.equal(inference.unresolvedFraction, 1 - coverage);
        }
    }
    for (const [score, coverage] of [[NaN, 1], [Infinity, 1], [1, 0], [1, -1], [1, 1.1]]) {
        assert.throws(() => availableResultInference(score, coverage, []), TypeError);
    }
});

const recordedModel = (ID, scores) => ({ ID, modelID: ID, modelName: `M${ID}`, name: `M${ID}`,
    condition: { parameters: { harness: 'same' } },
    results: new Map(Object.entries(scores).map(([key, normalizedScore]) => [key, { normalizedScore }])) });

test('missing-score inference is followed by the fixed rational coverage factor', () => {
    const models = [recordedModel(1, { 1: 100 }), recordedModel(2, { 1: 75, 2: 75 })];
    const options = comparisonOptions(models);
    const weights = [{ conditionID: 1, weightBasisPoints: 100 }, { conditionID: 2, weightBasisPoints: 9900 }];
    const scores = scoreComparison(models, weights, 10000, { scoreMode: 'available' }, options);
    assert.equal(scores[0].lower, 4.81);
    assert.equal(scores[0].availableInference.unpenalizedScore, 100);
    assert.equal(scores[0].availableInference.coverageFactor, .05 / 1.04);
    assert.equal(scores[0].availableInference.unresolvedFraction, .99);
    assert.deepEqual(scores[0].inferredScores, []);
    assert.equal(scores[1].lower, 75);
    assert.equal(scores[0].calculationScores[0].normalizedScore, 100);
});

test('Available trace validates missing-score inference separately from real evidence', () => {
    const payload = workspace(createFixtureState(), { scoreMode: 'available' });
    assert.equal(validateWorkspacePayload(payload), payload);
    const wrong = structuredClone(payload);
    wrong.modelLeaderboards.public[0].availableInference.totalScore += 1;
    assert.throws(() => validateWorkspacePayload(wrong), /missing-score estimate/);
    const old = structuredClone(payload);
    delete old.modelLeaderboards.public[0].availableInference;
    assert.throws(() => validateWorkspacePayload(old), /must be an object/);
    const pager = createRankingPager();
    const page = pager.create(workspace(createFixtureState({ rankingStress: true }), { scoreMode: 'available' }, { paginate: false }));
    const response = validateRankingPagePayload(pager.getPage({ snapshotID: page.rankingPagination.snapshotID,
        list: 'public', offset: 25 }), { list: 'public', offset: 25, scoreMode: 'available' });
    assert.equal(response.scoreMode, 'available');
    assert.ok(response.items.length);
});

test('unsearched versions are flat, globally public-weight sorted with shared tie rules', () => {
    const version = (conditionID, weight, primary, count) => ({ ID: conditionID, conditionID, benchmarkID: 1,
        name: 'Benchmark', conditionName: `Version ${conditionID}`, tags: [], isPrimaryCondition: primary,
        lowCoverage: !primary, scoreCount: count, publicWeightBasisPoints: weight });
    const versions = [version(1, 100, true, 1), version(2, 200, false, 1), version(3, 100, false, 10),
        version(4, 100, true, 4), version(5, 100, false, 10), version(6, 0, false, 5)];
    const data = { scoreMode: 'range', benchmarks: versions, personalPie: { entries: [], fallbackRules: [] },
        modelLeaderboards: { personal: [], public: [] } };
    const pager = createRankingPager();
    const result = pager.create(data);
    assert.equal(result.rankingPagination.benchmarkGrouping, 'flat');
    assert.deepEqual(result.benchmarks.map(row => row.conditionID), [2, 4, 1, 3, 5, 6]);
    assert.equal(result.rankingPagination.benchmarks.lowCoverage.total, 0);
    const grouped = pager.create(data, { groupVersions: true });
    assert.equal(grouped.rankingPagination.benchmarkGrouping, 'versions');
    assert.ok(grouped.rankingPagination.benchmarks.lowCoverage.total > 0);
    assert.throws(() => benchmarkVersionTieOrder({ conditionID: 1 }, versions[0]), TypeError);
});

test('matched cohort maximizes participant count without relaxing any control or depending on input order', () => {
    const models = [1, 2, 3, 4, 5].map(ID => recordedModel(ID, { 10: 50 + ID }));
    models[3].condition.parameters.harness = 'other';
    models[4].condition.parameters.harness = 'other';
    const weights = [{ conditionID: 10, weightBasisPoints: 10000 }];
    const normalize = input => groupComparisonModels(input, comparisonOptions(input, { mode: 'matched', keys: ['model'] }), weights)
        .sort((a, b) => a.modelID - b.modelID).map(row => [row.modelID, row.comparable,
            row.comparisonScores.map(score => [score.conditionID, score.normalizedScore, score.memberIDs])]);
    const first = normalize(models);
    assert.deepEqual(first.map(row => row[1]), [true, true, true, false, false]);
    assert.deepEqual(normalize([...models].reverse()), first);
});

test('explicit Fallback add destination suppresses main-Pie actions and uses its own palette', () => {
    const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    const html = read('private/home.html');
    const home = read('public/js/home-workspace.js');
    const css = read('public/css/ui/fallback.css');
    assert.match(html, /bp-inline-fallback-frame[\s\S]*id="inline-fallback-chart"[\s\S]*bp-fallback-add-actions[\s\S]*id="inline-fallback-add-benchmark"/);
    assert.doesNotMatch(html, /inline-fallback-add-other-versions|All Other Versions/);
    assert.match(home, /addFallbackBenchmarkButton\.addEventListener\('click'[\s\S]*activateInlineFallbackTarget\(\)/);
    assert.match(home, /personalControlsActive && inPersonalPie && !fallbackTargetActive/);
    assert.match(home, /benchmarkPersonalPin\.hidden = !canPinPersonal \|\| fallbackTargetActive/);
    assert.match(css, /is-fallback-target-active[^}]+--bp-accent: #166575/);
    assert.match(home, /fallbackTargetActive \? ' to Fallback' : ' to Pie'/);
    assert.equal((home.match(/\bactivateInlineFallbackTarget\(\)/g) ?? []).length, 2, 'Only the declaration and Add button may activate');
    assert.doesNotMatch(home, /inlineFallbackChart\.addEventListener\('click'/);
    assert.match(css, /\.bp-inline-fallback-chart\.is-target-active[^}]*border-color: var\(--bp-purple\)/);
});

test('save responses refresh a changed catalogue request and input focus stays inside controls', () => {
    const read = name => readFileSync(new URL('../' + name, import.meta.url), 'utf8');
    const home = read('public/js/home-workspace.js');
    assert.equal((home.match(/refreshChangedBenchmarkFilters\(requestedBenchmarkFilters\)/g) ?? []).length, 2);
    assert.match(home, /current\[key\] !== requested\[key\]/);
    const css = read('public/css/ui/control-policy.css');
    assert.match(css, /outline: none !important/);
    assert.match(css, /:focus-visible \{[^}]*box-shadow: none !important/);
    assert.match(css, /background-color: var\(--bp-surface-soft\) !important/);
    assert.match(css, /:not\(\[aria-invalid="true"\]\):not\(\.has-error \*\)/);
});
