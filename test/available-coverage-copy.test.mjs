import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { rankingNumber } from '../public/js/shared/ranking-number.js';

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
        rankingNumber, syncExpand() {}, filterScores() {}, expansionNoun: ''
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

test('brief help distinguishes shared-test estimates from measured weighted coverage', () => {
    const brief = guide.match(/<section id="rankings"[\s\S]*?<\/section>/)?.[0];
    assert.ok(brief);
    assert.match(brief, /Estimated score:[\s\S]*shared-test estimates/);
    assert.match(brief, /Isolated extreme results have less influence on estimates/);
    assert.match(brief, /incomplete measured coverage reduces the total/);
    assert.match(brief, /Estimates do not increase coverage/);
    assert.match(brief, /Coverage is the share of weight with measured results/);
    assert.match(brief, /reduces the total, not just its estimated part/);
    assert.match(brief, /including successful fallbacks/);
    assert.match(brief, /5c\/\(1\+4c\)/);
    assert.match(brief, /Nonnegative totals use f\(c\), negatives 2-f\(c\)/);
    assert.match(brief, /full coverage is unchanged/);
    assert.doesNotMatch(guide, /Power 0\.35|experiment|<select|compares Power/i);
    assert.doesNotMatch(guide, /deduct(?:s|ion)?|2 points (?:for every|per) missing 10%|20\s*(?:points|\*)/i);
});

test('short score help preserves range endpoints, unresolved gaps and fallback-first evidence', () => {
    const brief = guide.match(/<section id="rankings"[\s\S]*?<\/section>/)?.[0];
    assert.ok(brief);
    assert.match(brief, /same qualifying measurements, converted using each test's score range and direction/);
    assert.match(brief, /Fallback is resolved first/);
    assert.match(brief, /missing scores count as 0 at the lower end and 100 at the upper end; measured scores stay fixed/);
    assert.match(brief, /Ranks by the lower end/);
    assert.match(brief, /Not a confidence interval/);
    assert.match(brief, /Unresolved gaps are left out of Estimated score/);
    assert.match(brief, /Without a real result on a weighted test, a model cannot rank/);
    const fallback = guide.match(/<section id="fallback"[\s\S]*?<\/section>/)?.[0];
    assert.ok(fallback);
    assert.match(fallback, /chosen version first, then backups in order/);
    assert.match(fallback, /first available score counts, not the highest, including zero and negative scores/);
    assert.match(fallback, /No fallback disables backups, not estimation/);
});

test('v5 model details show the rational factor and raw total without comparison wording', () => {
    const text = summary(factorInference(80, .5, .5));
    assert.match(text, /50\.00% of the weight uses estimated results from comparisons on shared tests, not measurements/);
    assert.match(text, /applies to the whole index, including its measured contribution/);
    assert.match(text, /does not change the recorded benchmark scores/);
    assert.match(text, /Coverage factor: x0\.8333 \(80\.00 before adjustment\)/);
    assert.ok(text.includes('Coverage formula: 5c/(1+4c)'));
    assert.doesNotMatch(text, /deduction|Negative scores|2 minus|Power|experiment/);
    const worked = summary(factorInference(68, .6, .4), .6);
    assert.match(worked, /Index score 60; measured results cover 60% of the weight/);
    assert.match(worked, /Coverage factor: x0\.8824 \(68\.00 before adjustment\)/);
});

test('negative v5 details explain the mirrored loss without improving toward zero', () => {
    const text = summary(factorInference(-20, .25), .25);
    assert.match(text, /Index score -28; measured results cover 25% of the weight/);
    assert.match(text, /75\.00% of the weight has no measurement or estimate and is left out of the average/);
    assert.match(text, /Coverage factor: x0\.6250 \(-20\.00 before adjustment\)/);
    assert.match(text, /Negative scores use x1\.3750 \(2 minus the coverage factor\) so missing coverage cannot improve them/);
    assert.doesNotMatch(text, /deduction/);
});

test('full coverage stays unchanged and zero scores do not need the negative exception', () => {
    for (const raw of [-20, 0, 80]) {
        const text = summary(factorInference(raw, 1), 1);
        assert.match(text, /Coverage factor: x1\.0000/);
        assert.doesNotMatch(text, /not enough connected evidence|Negative scores|not measured|deduction/);
    }
    assert.doesNotMatch(summary(factorInference(0, .25), .25), /Negative scores/);
    const incomparable = summary(null, 0, false);
    assert.match(incomparable, /Not ranked: no measured result matches these weights and settings/);
    assert.doesNotMatch(incomparable, /Coverage factor:|deduction/);
});

test('old v3 deduction summaries and v1/v2 summaries remain supported', () => {
    const legacy = { inferredFraction: .5, unresolvedFraction: 0, totalScore: 80 };
    const v3 = summary({ ...legacy, version: 3, method: 'pairwise-anchored-coverage',
        unpenalizedScore: 80, coveragePenalty: 10, totalScore: 70 });
    assert.match(v3, /Low coverage deduction: 10\.00 points \(80\.00 before deduction\)/);
    assert.doesNotMatch(v3, /Coverage factor:|Negative scores/);
    for (const version of [1, 2]) {
        const text = summary({ ...legacy, version });
        assert.match(text, /50\.00% of the weight uses estimated results from comparisons on shared tests, not measurements/);
        assert.doesNotMatch(text, /Coverage factor:|deduction|Negative scores/);
    }
});

test('range summaries show both endpoints and do not present the lower end as a point estimate', () => {
    const text = summary(null, .4, true, { lower: 32, upper: 92 });
    assert.match(text, /Score range 32 to 92; measured results cover 40% of the weight/);
    assert.match(text, /Measured results stay fixed/);
    assert.match(text, /Models rank by the lower end; this is not a confidence interval/);
    assert.doesNotMatch(text, /Index score|Coverage factor|whole index/);
    assert.doesNotMatch(summary(null, 0, false, { lower: 0, upper: 100 }), /Score range|Models rank/);
});
