import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { assertRankingEvidence, normalizeExpectedEvidence, scoreEvidenceHash } from '../score-evidence.js';
import { loadModels, normalizedResultScore, medianOfFiniteNumbers } from '../ranking-service.js';
import { normalizeScoreFields, fieldDisplayValue } from '../public/js/shared/score-fields.js';
import { currentScoreSQL, scoreValueKey } from '../score-aggregation.js';
import * as transactionCleanup from '../db-transaction.js';
import { aaResultReason } from '../aa-archive-policy.js';
import { isAACondition, AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';

const scale = { usesPercentageScale: true, scoreDirection: 'higher', scoreMin: null, scoreMax: null, targetValue: null };
const samples = [{ ID: 11, rawScore: '80.00' }, { ID: 12, rawScore: 60 }];
const changed = error => error.status === 409 && error.body.error === 'ranking_evidence_changed';

test('evidence identity includes every accepted row and its normalization contract, not row order or formatting', () => {
    const hash = scoreEvidenceHash(scale, samples);
    assert.equal(hash, scoreEvidenceHash(scale, [{ ID: 12, rawScore: '60.0' }, { ID: 11, rawScore: 80 }]));
    assert.notEqual(hash, scoreEvidenceHash(scale, [...samples, { ID: 13, rawScore: 80 }]));
    assert.notEqual(hash, scoreEvidenceHash(scale, [{ ID: 21, rawScore: 80 }, samples[1]]));
    assert.notEqual(hash, scoreEvidenceHash(scale, [{ ID: 11, rawScore: 81 }, samples[1]]));
    assert.notEqual(hash, scoreEvidenceHash({ ...scale, scoreDirection: 'lower' }, samples));
    assert.notEqual(hash, scoreEvidenceHash({ ...scale, usesPercentageScale: false, scoreMin: 0, scoreMax: 200 }, samples));
    assert.throws(() => normalizeExpectedEvidence({ conditionID: 1, hash: 'bad' }));
    const expected = normalizeExpectedEvidence({ conditionID: 1, hash });
    assert.doesNotThrow(() => assertRankingEvidence(expected, [{ benchmarkConditionID: 1, evidenceHash: hash }]));
    assert.throws(() => assertRankingEvidence(expected, []), changed);
    assert.throws(() => assertRankingEvidence(expected, [{ benchmarkConditionID: 1, evidenceHash: 'f'.repeat(64) }]), changed);
});

const server = readFileSync(new URL('../server.js', import.meta.url), 'utf8');
const start = server.indexOf("API.post('/get_approved_benchmark_results'");
const end = server.indexOf("API.post('/save_personal_pie'", start);

function sourceAPI(rows) {
    const events = [];
    const connection = {
        query: async sql => { events.push(sql); return [[]]; },
        async execute(sql) {
            if (sql.includes('FROM models JOIN')) return [[{ modelID: 1, modelName: 'M', vendorName: 'Lab' }]];
            assert.match(sql, /status = 'accepted'/);
            return [rows];
        },
        commit: async () => events.push('commit'), rollback: async () => events.push('rollback'), release: () => events.push('release')
    };
    let callback;
    const context = vm.createContext({ ...transactionCleanup, db: { getConnection: async () => connection },
        API: { post: (_url, handler) => { callback = handler; } },
        normalizeRequiredPositiveInteger: value => value, normalizeExpectedEvidence,
        loadScoreFieldCatalog: async () => [], normalizeScoreFields, fieldDisplayValue,
        parseJSONColumn: value => value, currentScoreSQL, scoreValueKey, normalizedResultScore,
        selectableBenchmarkConditionSQL: () => 'benchmark_conditions.deleted_at IS NULL',
        medianOfFiniteNumbers, assertRankingEvidence, scoreEvidenceHash, aaResultReason, isAACondition, AA_DISPLAY_RESTRICTION });
    vm.runInContext(server.slice(start, end), context);
    return { events, async request(expectedEvidence) {
        let result;
        const response = { set: () => {}, json: payload => { result = payload; } };
        await callback({ body: { modelID: 1, scoreFields: [], ...(expectedEvidence ? { expectedEvidence } : {}) } }, response);
        return result;
    } };
}

test('source API and ranking loader fingerprint the same rows, and reject a later source revision', async () => {
    const rows = samples.map(item => ({ ...item, benchmarkID: 2, benchmarkName: 'B', benchmarkConditionID: 1,
        benchmarkConditionName: 'default', benchmarkConditionIsDefault: 1, ...scale, scoreFields: [] }));
    const [model] = await loadModels({ async execute(sql) {
        if (sql.includes('FROM models JOIN')) return [[{ model_ID: 1, model_name: 'M' }]];
        if (sql.includes('FROM benchmark_conditions')) return [[{ benchmark_condition_ID: 1,
            uses_percentage_scale: 1, score_min: null, score_max: null, score_direction: 'higher', target_value: null }]];
        return [samples.map(item => ({ result_ID: item.ID, model_ID: 1, benchmark_condition_ID: 1, raw_score: item.rawScore, score_fields: [] }))];
    } }, []);
    const expected = { conditionID: 1, hash: model.results.get('1').evidenceHash };
    const api = sourceAPI(rows);
    const response = await api.request(expected);
    assert.equal(response.scoreGroups[0].evidenceHash, expected.hash);
    assert.equal(response.scoreGroups[0].medianNormalizedScore, model.results.get('1').normalizedScore);
    assert.deepEqual(api.events.slice(-2), ['commit', 'release']);
    assert.ok(api.events.some(event => event.includes('CONSISTENT SNAPSHOT')));
    const refreshed = sourceAPI([{ ...rows[0], ID: 21, rawScore: 61 }]);
    await assert.rejects(refreshed.request(expected), changed);
    assert.deepEqual(refreshed.events.slice(-2), ['rollback', 'release']);
    const current = await refreshed.request();
    assert.equal(current.scoreGroups[0].medianRawScore, 61);
});

test('ranking calculations and Used in this ranking exclude AA source rows before hashing', async () => {
    const stored = [{ ID: 11, rawScore: 60 }, { ID: 12, rawScore: 100, sourceURL: 'https://artificialanalysis.ai/result' },
        { ID: 13, rawScore: 90, notes: '{"original_evaluator":"Artificial Analysis"}' }];
    const [model] = await loadModels({ async execute(sql) {
        if (sql.includes('FROM models JOIN')) return [[{ model_ID: 1, model_name: 'M' }]];
        if (sql.includes('FROM benchmark_conditions')) return [[{ benchmark_condition_ID: 1,
            uses_percentage_scale: 1, score_min: null, score_max: null, score_direction: 'higher', target_value: null }]];
        return [stored.map(row => ({ result_ID: row.ID, model_ID: 1, benchmark_ID: 2, benchmark_condition_ID: 1,
            raw_score: row.rawScore, score_fields: [], source_url: row.sourceURL, notes: row.notes }))];
    } }, []);
    assert.equal(model.results.get('1').normalizedScore, 60);
    const expected = { conditionID: 1, hash: model.results.get('1').evidenceHash };
    const api = sourceAPI(stored.map(row => ({ ...row, benchmarkID: 2, benchmarkName: 'B', benchmarkConditionID: 1,
        benchmarkConditionName: 'default', benchmarkConditionIsDefault: 1, ...scale, scoreFields: [] })));
    const response = await api.request(expected);
    assert.deepEqual(Array.from(response.scoreGroups[0].samples, row => row.ID), [11]);
    assert.equal(response.scoreGroups[0].evidenceHash, expected.hash);
});
