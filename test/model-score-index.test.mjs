import test from 'node:test';
import assert from 'node:assert/strict';
import { loadApprovedModelConfigurations, normalizedResultScore, medianOfFiniteNumbers } from '../ranking-service.js';

const version = (ID = 10) => ({ benchmarkID: 4, benchmarkName: 'Test', benchmarkConditionID: ID,
    benchmarkConditionName: ID === 10 ? 'Overall' : 'Target', benchmarkConditionIsDefault: ID === 10,
    usesPercentageScale: 1, scoreMin: 0, scoreMax: 100, scoreDirection: 'higher', targetValue: null });
const fields = [{ ID: 1, name: 'Effort', type: 'number', allowEmpty: false }];

test('compact index contains exact distinct-value medians and counts, without source payloads', async () => {
    const rows = [
        { ...version(), modelID: 7, modelName: 'A', scoreFields: '[]', rawScore: 20, scoreCount: 3 },
        { ...version(), modelID: 7, modelName: 'A', scoreFields: '[]', rawScore: 80, scoreCount: 1 },
        { ...version(11), modelID: 7, modelName: 'A', scoreFields: '[]', rawScore: 30, scoreCount: 1 },
        { ...version(11), modelID: 7, modelName: 'A', scoreFields: '[]', rawScore: 60, scoreCount: 2 },
        { ...version(11), modelID: 7, modelName: 'A', scoreFields: '[]', rawScore: 70, scoreCount: 1 }
    ];
    let queries = 0;
    const db = { execute: async (sql, args) => {
        queries++; assert.deepEqual(args, [7]); assert.match(sql, /r\.status = 'accepted'/);
        assert.match(sql, /b\.is_active = 1/); assert.match(sql, /c\.deleted_at IS NULL/);
        assert.match(sql, /1 AS scoreCount/);
        assert.doesNotMatch(sql, /GROUP BY/);
        assert.match(sql, /r\.source_url, r\.source_title, r\.notes/, 'Provenance is read only for server-side display filtering');
        return [rows];
    } };
    const [configuration] = await loadApprovedModelConfigurations(db, [7], fields, { includeVersions: true });
    assert.equal(queries, 1); assert.equal(configuration.scoreCount, 8);
    const [first, second] = configuration.scoreGroups;
    assert.equal(first.sampleCount, 4); assert.equal(first.distinctScoreCount, 2); assert.equal(first.medianRawScore, 50);
    assert.equal(first.medianNormalizedScore, 50);
    assert.equal(second.sampleCount, 4); assert.equal(second.distinctScoreCount, 3); assert.equal(second.medianRawScore, 60);
    assert.ok(configuration.scoreGroups.every(group => !('samples' in group) && !('evidenceHash' in group)));
    assert.doesNotMatch(JSON.stringify(configuration), /source_url|source_title|notes/, 'Provenance is not exposed in the index');
});

test('canonical run-field aliases merge before deduplicating raw observations', async () => {
    const rows = [
        { ...version(), modelID: 7, modelName: 'A', scoreFields: [{ fieldID: 1, value: 500 }], rawScore: 20, scoreCount: 2 },
        { ...version(), modelID: 7, modelName: 'A', scoreFields: [{ fieldID: 1, value: '5e2' }], rawScore: 20, scoreCount: 1 },
        { ...version(), modelID: 7, modelName: 'A', scoreFields: [{ fieldID: 1, value: '500' }], rawScore: 80, scoreCount: 1 }
    ];
    const configs = await loadApprovedModelConfigurations({ execute: async () => [rows] }, [7], fields, { includeVersions: true });
    assert.equal(configs.length, 1); assert.equal(configs[0].scoreGroups[0].medianRawScore, 50);
    assert.equal(configs[0].scoreGroups[0].sampleCount, 4); assert.equal(configs[0].scoreGroups[0].distinctScoreCount, 2);
});

test('target and lower-is-better medians use the same conversion as actual evidence', async () => {
    for (const scoreDirection of ['lower', 'closer_to_target']) {
        const scale = { ...version(), scoreDirection, targetValue: scoreDirection === 'closer_to_target' ? 50 : null };
        const raw = [0, 25, 80];
        const rows = raw.map(rawScore => ({ ...scale, modelID: 7, modelName: 'A', scoreFields: [], rawScore, scoreCount: 1 }));
        const [configuration] = await loadApprovedModelConfigurations({ execute: async () => [rows] }, [7], [], { includeVersions: true });
        assert.equal(configuration.scoreGroups[0].medianNormalizedScore,
            medianOfFiniteNumbers(raw.map(rawScore => normalizedResultScore({ ...scale, rawScore }))));
    }
});

test('index requests reject invalid modes and large fanout before accessing data', async () => {
    const db = { execute() { throw Error('Unexpected data read'); } };
    for (const includeVersions of [null, 'true', 1]) await assert.rejects(loadApprovedModelConfigurations(db, [7], [], { includeVersions }), error => error.status === 400);
    await assert.rejects(loadApprovedModelConfigurations(db, Array.from({ length: 33 }, (_, i) => i + 1), [], { includeVersions: true }), error => error.status === 400);
    for (const rawScore of [null, NaN, Infinity]) await assert.rejects(loadApprovedModelConfigurations({ execute: async () => [[{
        ...version(), modelID: 7, modelName: 'A', scoreFields: [], rawScore, scoreCount: 1
    }]] }, [7], [], { includeVersions: true }), error => error.status === 409);
});
