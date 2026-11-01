import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { searchItems } from '../public/js/shared/search.js';
import { rankingNumber } from '../public/js/shared/ranking-number.js';

const source = readFileSync(new URL('../public/js/workspace/model-scores.js', import.meta.url), 'utf8');
const validateIndex = vm.runInNewContext(source.slice(source.indexOf('export function validateModelScoreConfigurationIndex('),
    source.indexOf('export function allScoresSearchResults(')).replace('export ', '') + '\nvalidateModelScoreConfigurationIndex', {
    invalidModelScoresResponse: (path, reason) => new TypeError(path + ': ' + reason)
});
const match = vm.runInNewContext(source.slice(source.indexOf('export function allScoresSearchResults('),
    source.indexOf('export function matchingScoreConfigurations(')).replace('export ', '') + '\nallScoresSearchResults', { searchItems });
const entry = (label, groups = null) => ({ searchFields: ['Model Alpha', label],
    payload: null, member: { scoreGroups: (groups ?? []).map(([ID, benchmarkName, benchmarkConditionName]) =>
        ({ benchmarkConditionID: ID, benchmarkName, benchmarkConditionName })) } });
const entries = () => [
    entry('Reasoning effort=High, Harness=Codex', [[1, 'Mathematics', 'v2'], [2, 'Logic', 'v1']]),
    entry('Reasoning effort=Low, Harness=Standard', [[3, 'Mathematics', 'v1'], [4, 'Language', 'v10']]),
    entry('Temperature=0.7')
];
const visible = results => results.filter(result => result.configurationMatch || result.groups.size);

test('All scores configuration-only matches include condition labels and stay configuration matches', () => {
    const data = entries();
    for (const query of ['high', 'reasoning high', 'Harness Codex']) {
        const found = visible(match(data, query));
        assert.equal(found.length, 1);
        assert.equal(found[0].entry, data[0]);
        assert.equal(found[0].configurationMatch, true);
        assert.equal(found[0].groups.size, 0, 'A configuration hit must not force every version open');
    }
    assert.equal(visible(match(data, 'Temperature 0.7'))[0].entry, data[2], 'Unloaded labels remain searchable');
});

test('All scores benchmark/version matches return only matching version IDs', () => {
    const found = visible(match(entries(), 'mathematics v1'));
    assert.equal(found.length, 1);
    assert.equal(found[0].configurationMatch, false);
    assert.deepEqual([...found[0].groups], [3]);
    assert.equal(visible(match(entries(), 'language v1')).length, 0, 'Version v1 must not match v10');
    assert.equal(visible(match(entries(), 'mathematics')).length, 2);
});

test('combined queries may span a configuration and one benchmark version, never separate versions', () => {
    const found = visible(match(entries(), 'high mathematics v2'));
    assert.equal(found.length, 1);
    assert.equal(found[0].configurationMatch, false);
    assert.deepEqual([...found[0].groups], [1]);
    assert.equal(visible(match(entries(), 'high mathematics v1')).length, 0);
    assert.equal(visible(match(entries(), 'low logic')).length, 0);
});

test('default versions are searchable by both their recorded and displayed names', () => {
    const data = [entry('High', [[1, 'Mathematics', 'Official release']])];
    data[0].member.scoreGroups[0].benchmarkConditionIsDefault = true;
    for (const query of ['Mathematics default version', 'Official release']) {
        assert.deepEqual([...visible(match(data, query))[0].groups], [1]);
    }
});

test('searching and clearing never mutate score groups, medians or evidence', () => {
    const data = entries(), snapshot = JSON.stringify(data);
    match(data, 'high mathematics');
    const found = match(data, '');
    assert.equal(found.length, data.length);
    assert.ok(found.every(result => result.configurationMatch));
    assert.equal(JSON.stringify(data), snapshot);
});

test('All scores searches only the compact index and queues evidence only on version source expansion', () => {
    const all = source.slice(source.indexOf('async function showAllScores('), source.indexOf('    return { openApprovedModelResults }'));
    assert.doesNotMatch(all, /await loadSourceScores|location\.|history\./);
    assert.match(all, /createElement\('details'\)/);
    assert.match(all, /view\.active < 3/);
    assert.match(all, /signal: view\.controller\.signal, timeoutMs: 20000/);
    assert.match(all, /payload\.model\.modelID !== Number\(member\.modelID\)/);
    assert.match(all, /JSON\.stringify\(payload\.model\.scoreFields\)/);
    assert.match(all, /modelIDs, includeVersions: true/);
    assert.match(all, /matchingScoreConfigurations\(results\.flat\(\), model, state\.comparison\)/);
    const filter = all.slice(all.indexOf('function filterAllConfigurations('), all.indexOf('function addConfigurationGroups('));
    assert.doesNotMatch(filter, /requestConfiguration|pumpConfigurations|postJSON|setTimeout/);
    const render = all.slice(all.indexOf('function renderAllConfigurations('), all.indexOf('function filterAllConfigurations('));
    assert.doesNotMatch(render, /requestConfiguration|pumpConfigurations/);
    assert.match(all, /isDisclosureOpen\(record\.row\)[\s\S]*requestConfiguration\(view, entry\)/);
    assert.match(source, /activeModel === model/);
    assert.match(source, /state\.userID === userID && state\.loadSequence === loadSequence/);
});

test('index validation requires complete real version summaries rather than falling back to full evidence fanout', () => {
    const group = { benchmarkID: 1, benchmarkName: 'Mathematics', benchmarkConditionID: 101,
        benchmarkConditionName: 'v2', benchmarkConditionIsDefault: false, usesPercentageScale: true,
        sampleCount: 3, distinctScoreCount: 2, medianRawScore: 70, medianNormalizedScore: 70 };
    const record = { modelID: 71, modelName: 'Model Alpha', configurationName: 'High', scoreFields: [],
        scoreCount: 3, scoreGroups: [group] };
    assert.equal(validateIndex({ configurations: [record] }, [71]).configurations[0], record);
    for (const mutate of [item => { delete item.scoreGroups; }, item => { item.scoreGroups = []; },
        item => { item.scoreGroups[0].medianRawScore = null; }, item => { item.scoreCount = 2; },
        item => { item.scoreGroups[0].distinctScoreCount = 4; }, item => { item.modelID = 72; },
        item => { item.scoreGroups.push({ ...item.scoreGroups[0] }); item.scoreCount = 6; }]) {
        const item = structuredClone(record); mutate(item);
        assert.throws(() => validateIndex({ configurations: [item] }, [71]), /invalid approved version summaries/);
    }
    assert.throws(() => validateIndex({ configurations: [record, record] }, [71]), /invalid approved version summaries/);
    assert.equal(validateIndex({ configurations: [] }, [71]).configurations.length, 0);
});

test('fresh approved evidence supersedes the compact index for subsequent version searches', () => {
    const item = entry('High', [[101, 'Old benchmark', 'v1']]);
    assert.equal(visible(match([item], 'Old benchmark')).length, 1);
    item.payload = { scoreGroups: [{ benchmarkConditionID: 102, benchmarkName: 'Current benchmark', benchmarkConditionName: 'v2' }] };
    assert.equal(visible(match([item], 'Old benchmark')).length, 0);
    assert.deepEqual([...visible(match([item], 'Current benchmark v2'))[0].groups], [102]);
});

function calculationSummary(inference, coverage = 50) {
    const details = [], modelScoresSummary = { textContent: '', append: detail => details.push(detail.textContent) };
    const start = source.indexOf('function renderCalculationResults(');
    const end = source.indexOf('function openApprovedModelResults(', start);
    const render = vm.runInNewContext(`${source.slice(start, end)}\nrenderCalculationResults`, {
        modelScoresSummary, modelScoresList: { append() {} }, document: { createElement: () => ({ textContent: '', append(...nodes) { this.textContent += nodes.map(node => node.textContent).join(' '); } }) },
        rankingNumber, syncExpand() {}, filterScores() {}, expansionNoun: ''
    });
    render({ lower: inference.totalScore, coverage, missingWeight: 100 - coverage,
        availableInference: inference, calculationScores: [] });
    return [modelScoresSummary.textContent, ...details].join(' ');
}

test('coverage summaries use reported factors without gating supported data by version or method', () => {
    for (const [version, method] of [[4, 'pairwise-anchored-coverage-factor'],
        [5, 'pairwise-anchored-rational-coverage-factor'], [6, 'future-coverage-adjustment']]) {
        const text = calculationSummary({ version, method, inferredFraction: .5, unresolvedFraction: 0,
            unpenalizedScore: 80, coverageFactor: .5, appliedFactor: .5, totalScore: 40 });
        assert.match(text, /Index score 40; measured results cover 50% of the weight/);
        assert.match(text, /Coverage factor: x0\.5000 \(80\.00 before adjustment\)/);
        assert.doesNotMatch(text, /deduction|2 minus/);
    }
    const start = source.indexOf('function renderCalculationResults(');
    const end = source.indexOf('function openApprovedModelResults(', start);
    assert.doesNotMatch(source.slice(start, end), /inference\.version/);
});

test('current coverage summaries identify only the rational formula without recomputing factors', () => {
    for (const [version, method] of [[4, 'pairwise-anchored-coverage-factor'],
        [5, 'pairwise-anchored-rational-coverage-factor']]) {
        const text = calculationSummary({ version, method, inferredFraction: 0, unresolvedFraction: .5,
            coverageFactor: .75, appliedFactor: .75, unpenalizedScore: 80, totalScore: 60 });
        assert.equal(text.includes('Coverage formula: 5c/(1+4c)'), version === 5);
        assert.doesNotMatch(text, /Power coverage formula|c\^0\.35/);
        if (version === 5) assert.match(text, /where c is measured coverage \(0 to 1\)/);
        assert.match(text, /Coverage factor: x0\.7500 \(80\.00 before adjustment\)/);
        const negative = calculationSummary({ version, method, inferredFraction: 0, unresolvedFraction: .5,
            coverageFactor: .75, appliedFactor: 1.25, unpenalizedScore: -20, totalScore: -25 });
        assert.match(negative, /Negative scores use x1\.2500 \(2 minus the coverage factor\) so missing coverage cannot improve them/);
    }
    const unknown = calculationSummary({ version: 6, method: 'future-coverage-adjustment',
        inferredFraction: 0, unresolvedFraction: .5, coverageFactor: .75, appliedFactor: .75,
        unpenalizedScore: 80, totalScore: 60 });
    assert.doesNotMatch(unknown, /Rational coverage formula|Power coverage formula/);
});

test('rational coverage details do not assume the previous negative-score formula', () => {
    // Deliberately distinct reported factors verify display behavior, not the backend formula.
    const text = calculationSummary({ version: 5, method: 'pairwise-anchored-rational-coverage-factor',
        inferredFraction: 0, unresolvedFraction: .5, unpenalizedScore: -20,
        coverageFactor: .5, appliedFactor: 2, totalScore: -40 });
    assert.match(text, /Index score -40/);
    assert.match(text, /Negative scores use x2\.0000 so missing coverage cannot improve them/);
    assert.doesNotMatch(text, /2 minus/);
    const full = calculationSummary({ version: 5, method: 'pairwise-anchored-rational-coverage-factor',
        inferredFraction: 0, unresolvedFraction: 0, unpenalizedScore: 80,
        coverageFactor: 1, appliedFactor: 1, totalScore: 80 }, 100);
    assert.match(full, /Coverage factor: x1\.0000/);
    assert.doesNotMatch(full, /not measured|Negative scores|deduction/);
});
