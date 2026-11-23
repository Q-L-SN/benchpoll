import { FALLBACK_INFERENCE_METHOD } from '../public/js/shared/fallback-inference.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { rankingNumber } from '../public/js/shared/ranking-number.js';
import { isMissingInferenceMethod } from '../public/js/shared/estimation-algorithms.js';

const read = path => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const guide = read('private/how-it-works.html');
const scores = read('public/js/workspace/model-scores.js');
const start = scores.indexOf('function renderCalculationResults(');
const end = scores.indexOf('function openApprovedModelResults(', start);
assert.ok(start >= 0 && end > start, 'Exercise the current model calculation renderer');

function summary(inference, coverage = .5, comparable = true, overrides = {}) {
    const paragraphs = [];
    const modelScoresSummary = { textContent: '', append: detail => paragraphs.push(detail.textContent) };
    const render = vm.runInNewContext(`${scores.slice(start, end)}\nrenderCalculationResults`, {
        modelScoresSummary, modelScoresList: { append() {} },
        document: { createElement: () => ({ textContent: '', append(...nodes) { this.textContent += nodes.map(node => node.textContent).join(' '); } }) },
        rankingNumber, isMissingInferenceMethod, FALLBACK_INFERENCE_METHOD, syncExpand() {}, filterScores() {}, expansionNoun: ''
    });
    render({ lower: inference?.totalScore ?? null, coverage: coverage * 100,
        missingWeight: (1 - coverage) * 100, comparable, availableInference: inference, calculationScores: [], ...overrides });
    return [modelScoresSummary.textContent, ...paragraphs].join(' ');
}

function factorInference(raw, coverage, inferredFraction = 0) {
    const coverageFactor = 5 * coverage / (1 + 4 * coverage);
    const appliedFactor = raw < 0 ? 2 - coverageFactor : coverageFactor;
    return { version: 5, method: 'pairwise-anchored-rational-coverage-factor',
        inferredFraction, unresolvedFraction: 1 - coverage - inferredFraction,
        coverageFactor, appliedFactor, unpenalizedScore: raw, totalScore: raw * appliedFactor };
}

test('brief help distinguishes calibrated estimates from measured weighted coverage', () => {
    const brief = guide.match(/<section id="rankings"[\s\S]*?<\/section>/)?.[0];
    assert.ok(brief);
    assert.match(brief, /Estimated score[\s\S]*calibrated estimates at their full weights/);
    assert.match(brief, /neither a measurement nor a reliable estimate count as 0 at their full weight/);
    assert.match(brief, /Coverage is the share of weight with measured results/);
    assert.match(brief, /on selected versions/);
    assert.match(brief, /Version-based estimation/);
    assert.doesNotMatch(guide, /coverage factor|test algorithm|midpoint|Power 0\.35|experiment/i);
    assert.doesNotMatch(guide, /deduct(?:s|ion)?|2 points (?:for every|per) missing 10%|20\s*(?:points|\*)/i);
});

test('short score help preserves range endpoints, unresolved gaps and direct-first evidence', () => {
    const brief = guide.match(/<section id="rankings"[\s\S]*?<\/section>/)?.[0];
    assert.ok(brief);
    assert.match(brief, /same qualifying measurements, converted using each test's score range and direction/);
    assert.match(brief, /chosen benchmark version takes priority/);
    assert.match(brief, /uses 0 at the lower end and 100 at the upper end for missing measurements\. Measured scores stay fixed/);
    assert.match(brief, /Models rank by the lower end/);
    assert.match(brief, /count as 0 at their full weight/);
    assert.match(brief, /direct score or a reliable estimate qualifies a model to rank/);
    const fallback = guide.match(/<section id="fallback"[\s\S]*?<\/section>/)?.[0];
    assert.ok(fallback);
    assert.match(fallback, /automatically considers other versions of the same benchmark/);
    assert.match(fallback, /Votes determine which sources are eligible\. Paired measurements determine the estimate\./);
    assert.match(fallback, /Direct scores count, including zero and negative scores/);
});

test('model details display archived before and after scores', () => {
    const text = summary(factorInference(80, .5, .5));
    assert.match(text, /50\.00% of the weight uses estimates from shared-test comparisons/);
    assert.match(text, /Before adjustment: 80/);
    assert.match(text, /After adjustment: 67/);
    assert.match(text, /How it works/);
    assert.doesNotMatch(text, /Coverage factor:|Coverage formula:|5c\/|2 minus|Power|experiment/);
    const worked = summary(factorInference(68, .6, .4), .6);
    assert.match(worked, /Index score 60; measured results cover 60% of the weight/);
    assert.match(worked, /Before adjustment: 68/);
    assert.match(worked, /After adjustment: 60/);
});

test('version-based details report estimates separately from coverage and zero-fill unresolved weight', () => {
    const inference = { method: FALLBACK_INFERENCE_METHOD, weightPolicy: 'original', inferredFraction: .25,
        unresolvedFraction: .25, unpenalizedScore: 53, totalScore: 53 };
    const text = summary(inference);
    assert.match(text, /measured results cover 50% of the weight/);
    assert.match(text, /25\.00% of the weight uses estimates calibrated with paired model results/);
    assert.match(text, /25\.00% of the weight has no reliable estimate and counts as 0 at its full weight/);
    assert.match(text, /How it works/);
    assert.doesNotMatch(text, /adjustment|fallback chains|left out|starts at 50/);
    const zero = summary({ ...inference, inferredFraction: 0, totalScore: 0, unresolvedFraction: 1 }, 0, false);
    assert.match(zero, /No qualifying ranking evidence/);
    assert.match(zero, /100\.00% of the weight has no reliable estimate and counts as 0/);
});

test('negative scores retain their before and after values without algorithm details', () => {
    const text = summary(factorInference(-20, .25), .25);
    assert.match(text, /Index score -28; measured results cover 25% of the weight/);
    assert.match(text, /75\.00% of the weight has no measurement or estimate and is left out of the average/);
    assert.match(text, /Before adjustment: -20/);
    assert.match(text, /After adjustment: -28/);
    assert.doesNotMatch(text, /deduction|Coverage factor:|Negative scores|2 minus/);
});

test('full coverage stays unchanged and zero scores do not need the negative exception', () => {
    for (const raw of [-20, 0, 80]) {
        const text = summary(factorInference(raw, 1), 1);
        assert.ok(text.includes(`Before adjustment: ${raw}`));
        assert.ok(text.includes(`After adjustment: ${raw}`));
        assert.doesNotMatch(text, /not enough connected evidence|Negative scores|not measured|deduction/);
    }
    assert.doesNotMatch(summary(factorInference(0, .25), .25), /Negative scores/);
    const incomparable = summary(null, 0, false);
    assert.match(incomparable, /No qualifying ranking evidence/);
    assert.doesNotMatch(incomparable, /Coverage factor:|deduction/);
});

test('adjustment details match ranked two-decimal precision at integer-rounding boundaries', () => {
    for (const [raw, endpoint, expected] of [[49.499, 49.5, '50'], [-49.499, -49.5, '-50'],
        [49.494, 49.49, '49'], [-49.494, -49.49, '-49']]) {
        const text = summary(factorInference(raw, 1), 1, true, { lower: endpoint });
        assert.ok(text.includes(`Index score ${expected};`));
        assert.ok(text.includes(`Before adjustment: ${expected}`));
        assert.ok(text.includes(`After adjustment: ${expected}`));
    }
});

test('old v3 deduction summaries and v1/v2 summaries remain supported', () => {
    const legacy = { inferredFraction: .5, unresolvedFraction: 0, totalScore: 80 };
    const v3 = summary({ ...legacy, version: 3, method: 'pairwise-anchored-coverage',
        unpenalizedScore: 80, coveragePenalty: 10, totalScore: 70 });
    assert.match(v3, /Before adjustment: 80. After adjustment: 70/);
    assert.doesNotMatch(v3, /Coverage factor:|Negative scores/);
    for (const version of [1, 2]) {
        const text = summary({ ...legacy, version });
        assert.match(text, /50\.00% of the weight uses estimates from shared-test comparisons/);
        assert.doesNotMatch(text, /Coverage factor:|deduction|Negative scores/);
    }
});

test('range summaries show both endpoints and do not present the lower end as a point estimate', () => {
    const text = summary(null, .4, true, { lower: 32, upper: 92 });
    assert.match(text, /Score range 32 to 92; measured results cover 40% of the weight/);
    assert.match(text, /Measured results stay fixed/);
    assert.match(text, /Models rank by the lower end/);
    assert.doesNotMatch(text, /Index score|Coverage factor|whole index/);
    assert.doesNotMatch(summary(null, 0, false, { lower: 0, upper: 100 }), /Score range|Models rank/);
});
