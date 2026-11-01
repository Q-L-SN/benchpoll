import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { loadApprovedModelConfigurations, normalizedResultScore, medianOfFiniteNumbers } from '../../ranking-service.js';
import { aaResultReason } from '../../aa-archive-policy.js';
import { AA_DISPLAY_RESTRICTION, isAACondition } from '../../public/js/shared/aa-ranking-policy.js';
import { normalizeScoreFields, fieldDisplayValue } from '../../public/js/shared/score-fields.js';
import { assertRankingEvidence, normalizeExpectedEvidence, scoreEvidenceHash } from '../../score-evidence.js';
import { currentScoreSQL, scoreValueKey } from '../../score-aggregation.js';
import * as transaction from '../../db-transaction.js';

export const fields = [
    { ID: 20, name: 'Reasoning effort', type: 'enum', allowEmpty: true,
        options: [{ ID: 1, label: 'High' }, { ID: 2, label: 'Low' }, { ID: 3, label: 'Excluded', excluded: true }] },
    { ID: 21, name: 'Harness', type: 'text', allowEmpty: true, options: [] },
    { ID: 59, name: 'Published evaluation provider', type: 'text', allowEmpty: true, options: [] }
];
export const high = [{ fieldID: 20, value: 1 }, { fieldID: 21, value: 'Codex' }];
export const low = [{ fieldID: 20, value: 2 }, { fieldID: 21, value: 'Other' }];
export const scale = { usesPercentageScale: true, scoreMin: null, scoreMax: null,
    scoreDirection: 'higher', targetValue: null };

export const resultRow = (ID, overrides = {}) => ({ ID, modelID: 71, modelName: 'Evidence Model',
    benchmarkID: 1, benchmarkName: 'Mathematics', benchmarkConditionID: 10,
    benchmarkConditionName: 'Official', benchmarkConditionIsDefault: false, conditionKey: 'official',
    scoreSource: 'https://example.org/official', scoreFields: high, rawScore: 60,
    sourceURL: 'https://example.org/independent', sourceTitle: 'Independent report', sourceType: 'official',
    notes: null, createdAt: '2026-10-31T00:00:00Z', ...scale, ...overrides });

export function mixedRows() {
    return [resultRow(1), resultRow(2, { rawScore: 80 }), resultRow(3),
        resultRow(4, { rawScore: 99, sourceURL: 'https://artificialanalysis.ai/models/example' }),
        resultRow(5, { rawScore: 98, sourceTitle: 'Artificial Analysis comparison values' }),
        resultRow(6, { rawScore: 97, notes: '{"original_evaluator":"Artificial Analysis"}' }),
        resultRow(7, { benchmarkID: 2, benchmarkName: 'AA-Intelligence', benchmarkConditionID: 20 }),
        resultRow(8, { benchmarkConditionID: 11, conditionKey: 'aa_harness', benchmarkConditionName: 'Recorded run' }),
        resultRow(9, { benchmarkConditionID: 12, conditionKey: 'recorded', benchmarkConditionName: 'Official; AA: release' }),
        resultRow(10, { benchmarkConditionID: 13, conditionKey: 'derived', benchmarkConditionName: 'Artificial Analysis 2026' }),
        resultRow(11, { benchmarkID: 2, benchmarkName: 'AA-Intelligence', benchmarkConditionID: 20, scoreFields: low }),
        resultRow(12, { benchmarkConditionID: 14, conditionKey: 'independent', benchmarkConditionName: 'Independent v2', rawScore: 55 }),
        resultRow(13, { benchmarkConditionID: 15, conditionKey: 'cdn', benchmarkConditionName: 'CDN release',
            sourceURL: 'https://cdn.artificialanalysiscdn.com/result.json' })];
}

const server = readFileSync(new URL('../../server.js', import.meta.url), 'utf8');
const endpointSource = server.slice(server.indexOf("API.post('/get_model_score_configurations'"),
    server.indexOf("API.post('/save_personal_pie'"));

export function scoreAPI(rows) {
    const events = [], queries = [], handlers = new Map();
    const connection = {
        query: async sql => { events.push(sql); return [[]]; },
        async execute(sql, args) {
            queries.push({ sql, args });
            if (sql.includes('FROM models JOIN')) return [[{ modelID: args[0], modelName: 'Evidence Model', vendorName: 'Lab' }]];
            assert.match(sql, /status = 'accepted'/);
            assert.match(sql, /benchmark_conditions\.condition_key AS conditionKey/);
            assert.match(sql, /benchmark_conditions\.score_source AS scoreSource/);
            return [rows.filter(row => row.modelID === args[0])];
        },
        commit: async () => events.push('commit'), rollback: async () => events.push('rollback'), release: () => events.push('release')
    };
    const db = { getConnection: async () => connection,
        async execute(sql, IDs) {
            queries.push({ sql, args: IDs });
            assert.match(sql, /c\.condition_key AS conditionKey/);
            assert.match(sql, /c\.score_source AS scoreSource/);
            assert.match(sql, /b\.ID AS benchmarkID/);
            assert.match(sql, /r\.source_url, r\.source_title, r\.notes/);
            assert.match(sql, /r\.status = 'accepted'/);
            return [rows.filter(row => IDs.includes(row.modelID)).map(row => ({ ...row, scoreCount: 1, benchmark_ID: row.benchmarkID,
                source_url: row.sourceURL, source_title: row.sourceTitle }))];
        } };
    const context = vm.createContext({ ...transaction, db,
        API: { post: (path, handler) => handlers.set(path, handler) },
        loadApprovedModelConfigurations: (connection, IDs, _fields, options) => loadApprovedModelConfigurations(connection, IDs, fields, options),
        normalizeRequiredPositiveInteger: value => value, normalizeExpectedEvidence,
        loadScoreFieldCatalog: async () => fields, normalizeScoreFields, fieldDisplayValue,
        parseJSONColumn: value => typeof value === 'string' ? JSON.parse(value) : value,
        currentScoreSQL, scoreValueKey, normalizedResultScore, medianOfFiniteNumbers,
        selectableBenchmarkConditionSQL: () => 'benchmark_conditions.deleted_at IS NULL',
        assertRankingEvidence, scoreEvidenceHash, isAACondition, aaResultReason, AA_DISPLAY_RESTRICTION });
    vm.runInContext(endpointSource, context);
    return { events, queries, db, async request(path, body) {
        let payload;
        const headers = {};
        await handlers.get(path)({ body }, { set: (key, value) => { headers[key] = value; },
            json: value => { payload = JSON.parse(JSON.stringify(value)); } });
        assert.equal(headers['Cache-Control'], 'no-store');
        return payload;
    } };
}
