import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { loadApprovedModelConfigurations } from '../ranking-service.js';
import { scoreEvidenceHash } from '../score-evidence.js';
import { AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';
import { matchingScoreConfigurations } from '../public/js/workspace/model-scores.js';
import { fields, high, low, scale, resultRow, mixedRows, scoreAPI } from './helpers/model-scores-aa-display.mjs';

const indexPath = '/get_model_score_configurations', sourcePath = '/get_approved_benchmark_results';

test('both index modes omit AA benchmarks, key/name variants and direct/mirrored sources before counting', async () => {
    const rows = mixedRows(), before = JSON.stringify(rows), api = scoreAPI(rows);
    for (const includeVersions of [true, false]) {
        const payload = await api.request(indexPath, { modelIDs: [71], includeVersions });
        assert.equal(payload.displayPolicy, AA_DISPLAY_RESTRICTION);
        assert.equal(payload.configurations.length, 1);
        const configuration = payload.configurations[0];
        assert.equal(configuration.scoreCount, 4);
        assert.deepEqual(configuration.scoreFields, high);
        assert.deepEqual(payload.omittedConfigurations, [high, low].map(scoreFields => ({
            modelID: 71, scoreFields, displayRestriction: AA_DISPLAY_RESTRICTION })));
        if (includeVersions) {
            assert.deepEqual(configuration.scoreGroups.map(group => group.benchmarkConditionID).sort(), [10, 14]);
            const group = configuration.scoreGroups.find(group => group.benchmarkConditionID === 10);
            assert.equal(group.medianRawScore, 70);
            assert.equal(group.medianNormalizedScore, 70);
            assert.equal(group.sampleCount, 3);
            assert.equal(group.distinctScoreCount, 2);
            assert.equal(group.conditionKey, 'official');
        } else assert.equal(configuration.scoreGroups, undefined);
        assert.doesNotMatch(JSON.stringify(payload), /AA-Intelligence|Recorded run|CDN release|source_url|source_title|notes|"samples"/);
    }
    assert.equal(JSON.stringify(rows), before, 'Filtering never mutates stored records');
    assert.ok(api.queries.every(({ sql }) => /^SELECT/i.test(sql.trim())));
    const legacy = await loadApprovedModelConfigurations(api.db, [71], fields);
    assert.ok(Array.isArray(legacy), 'Non-API callers keep the array return contract');
    assert.equal(legacy[0].scoreCount, 4);
});

test('lazy source API removes AA rows before medians, duplicate flags and evidence hashes', async () => {
    const api = scoreAPI(mixedRows());
    const payload = await api.request(sourcePath, { modelID: 71, scoreFields: high });
    assert.equal(payload.displayPolicy, AA_DISPLAY_RESTRICTION);
    assert.equal(payload.displayRestriction, AA_DISPLAY_RESTRICTION);
    assert.deepEqual(payload.scoreGroups.map(group => group.benchmarkConditionID), [10, 14]);
    const group = payload.scoreGroups[0];
    assert.deepEqual(group.samples.map(sample => sample.ID), [1, 2, 3]);
    assert.deepEqual(group.samples.map(sample => sample.excludedAsDuplicate), [false, false, true]);
    assert.equal(group.sampleCount, 3);
    assert.equal(group.distinctScoreCount, 2);
    assert.equal(group.medianRawScore, 70);
    assert.equal(group.medianNormalizedScore, 70);
    assert.equal(group.evidenceHash, scoreEvidenceHash(scale, group.samples));
    assert.deepEqual(api.events.slice(-2), ['commit', 'release']);
});

test('empty, restricted-only and independent results have distinct omission metadata', async () => {
    for (const [rows, omitted, count] of [[[], false, 0], [[resultRow(1, { conditionKey: 'aa-only' })], true, 0],
        [[resultRow(1, { sourceURL: 'https://notartificialanalysis.ai/independent' })], false, 1]]) {
        const api = scoreAPI(rows);
        const index = await api.request(indexPath, { modelIDs: [71], includeVersions: true });
        const sources = await api.request(sourcePath, { modelID: 71, scoreFields: high });
        assert.equal(index.configurations.length, count);
        assert.equal(index.omittedConfigurations.length > 0, omitted);
        assert.equal(sources.scoreGroups.length, count);
        assert.equal(sources.displayRestriction, omitted ? AA_DISPLAY_RESTRICTION : null);
    }
});

test('renamed registry versions and explicit version-source metadata are filtered without banning independent namesakes', async () => {
    const key = 'crawl-6c6f1535abb4a0c68af896bc';
    const api = scoreAPI([
        resultRow(21, { benchmarkID: 1687, benchmarkConditionID: 9399, conditionKey: key, benchmarkConditionName: 'Republished release' }),
        resultRow(22, { benchmarkID: 3, benchmarkConditionID: 9398, conditionKey: key, benchmarkConditionName: 'Independent release' }),
        resultRow(23, { benchmarkConditionID: 9397, scoreSource: 'Artificial Analysis', benchmarkConditionName: 'Renamed run' })
    ]);
    for (const includeVersions of [true, false]) {
        const index = await api.request(indexPath, { modelIDs: [71], includeVersions });
        assert.equal(index.configurations[0].scoreCount, 1);
        assert.equal(index.omittedConfigurations.length, 1);
        if (includeVersions) assert.deepEqual(index.configurations[0].scoreGroups.map(group => group.benchmarkConditionID), [9398]);
    }
    const sources = await api.request(sourcePath, { modelID: 71, scoreFields: high });
    assert.deepEqual(sources.scoreGroups.flatMap(group => group.samples.map(sample => sample.ID)), [22]);
    assert.equal(sources.displayRestriction, AA_DISPLAY_RESTRICTION);
});

test('omission metadata respects effort, harness and selected-field restrictions', async () => {
    const api = scoreAPI([resultRow(1), resultRow(2, { scoreFields: low, conditionKey: 'aa-hidden' })]);
    const index = await api.request(indexPath, { modelIDs: [71], includeVersions: true });
    const model = { modelID: 71, condition: { scoreFields: high } };
    const comparison = { mode: 'best', keys: ['model', 'field:20', 'field:21'], fields };
    assert.equal(matchingScoreConfigurations(index.omittedConfigurations, model, comparison).length, 0);
    assert.equal(matchingScoreConfigurations(index.configurations, model, comparison).length, 1);
    assert.equal(matchingScoreConfigurations(index.omittedConfigurations, model, { ...comparison, keys: ['model'] }).length, 1);
    const independent = await api.request(sourcePath, { modelID: 71, scoreFields: high });
    assert.equal(independent.displayRestriction, null);
    const restricted = await api.request(sourcePath, { modelID: 71, scoreFields: low });
    assert.deepEqual(restricted.scoreGroups, []);
    assert.equal(restricted.displayRestriction, AA_DISPLAY_RESTRICTION);
});

test('the audited Solar score is removed from both model APIs while independent SciCode default scores remain', async () => {
    const api = scoreAPI([
        resultRow(173021, { benchmarkID: 1334, benchmarkName: 'SciCode', benchmarkConditionID: 24727,
            benchmarkConditionName: 'default', conditionKey: 'default', sourceURL: 'https://www.upstage.ai/blog/en/solar-mini-4', notes: '' }),
        resultRow(173022, { benchmarkID: 1334, benchmarkName: 'SciCode', benchmarkConditionID: 24727,
            benchmarkConditionName: 'default', conditionKey: 'default', sourceURL: 'https://www.inceptionlabs.ai/blog/introducing-mercury-2-5' })
    ]);
    const index = await api.request(indexPath, { modelIDs: [71], includeVersions: true });
    assert.equal(index.configurations[0].scoreCount, 1);
    assert.equal(index.configurations[0].scoreGroups[0].benchmarkConditionID, 24727);
    assert.equal(index.omittedConfigurations.length, 1);
    const sources = await api.request(sourcePath, { modelID: 71, scoreFields: high });
    assert.deepEqual(sources.scoreGroups[0].samples.map(row => row.ID), [173022]);
    assert.equal(sources.displayRestriction, AA_DISPLAY_RESTRICTION);
});

test('Used in this ranking validates eligible evidence after the same AA filtering as the ranking loader', async () => {
    const rows = mixedRows().filter(row => row.benchmarkConditionID === 10);
    const visible = rows.filter(row => row.ID <= 3);
    const expectedEvidence = { conditionID: 10, hash: scoreEvidenceHash(scale, visible) };
    const payload = await scoreAPI(rows).request(sourcePath, { modelID: 71, scoreFields: high, expectedEvidence });
    assert.equal(payload.scoreGroups[0].evidenceHash, expectedEvidence.hash);
    assert.equal(payload.scoreGroups[0].sampleCount, visible.length);
    assert.equal(payload.displayPolicy, undefined, 'Ranking evidence must not masquerade as filtered All scores data');
    await assert.rejects(scoreAPI(rows.slice(1)).request(sourcePath, { modelID: 71, scoreFields: high, expectedEvidence }),
        error => error.status === 409 && error.body.error === 'ranking_evidence_changed');
});

test('explicit evaluation-provider fields filter republished rows in both model APIs', async () => {
    const aa = [{ fieldID: 59, value: 'Artificial Analysis' }];
    const independent = [{ fieldID: 21, value: 'Artificial Analysis' }];
    const api = scoreAPI([resultRow(301, { scoreFields: aa }), resultRow(302, { scoreFields: independent })]);
    const index = await api.request(indexPath, { modelIDs: [71], includeVersions: true });
    assert.equal(index.configurations.length, 1);
    assert.deepEqual(index.configurations[0].scoreFields, independent);
    assert.deepEqual(index.omittedConfigurations[0].scoreFields, aa);
    const sources = await api.request(sourcePath, { modelID: 71, scoreFields: aa });
    assert.deepEqual(sources.scoreGroups, []);
    assert.equal(sources.displayRestriction, AA_DISPLAY_RESTRICTION);
    assert.equal((await api.request(sourcePath, { modelID: 71, scoreFields: independent })).scoreGroups[0].samples[0].ID, 302);
});

test('selectable conditions forward registry IDs and source metadata to the shared ranking policy', () => {
    const source = readFileSync(new URL('../ranking-service.js', import.meta.url), 'utf8');
    assert.match(source, /benchmark_conditions\.condition_key,\s*benchmark_conditions\.score_source,/);
    assert.match(source, /excludedFromRanking: isAACondition\(\{ benchmarkID: Number\(row\.benchmark_ID\), benchmarkName: row\.name,[\s\S]*?scoreSource: row\.score_source/);
});
