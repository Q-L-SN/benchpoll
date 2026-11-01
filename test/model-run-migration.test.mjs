import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { arenaCanonicalModelName } from '../arena-import-plan.js';
import { mergeRunConfigurationFields, modelRunConfiguration, resolveModelRunMappings, runConfigurationFields } from '../model-run-configuration.js';

const source = readFileSync(new URL('../scripts/migrate-model-run-configurations.mjs', import.meta.url), 'utf8')
    .replace(/^import[^\r\n]*;\r?\n/gm, '');
const fields = [{ ID: 1, name: 'Agent harness', type: 'text', allowEmpty: false, options: [] },
    { ID: 2, name: 'Reasoning effort', type: 'enum', allowEmpty: false, options: [{ ID: 3, label: 'high' }] },
    { ID: 4, name: 'Search context size', type: 'enum', allowEmpty: false, options: [{ ID: 5, label: 'high' }] },
    { ID: 6, name: 'Reasoning mode', type: 'enum', allowEmpty: false,
        options: [{ ID: 7, label: 'enabled' }, { ID: 8, label: 'disabled' }] },
    { ID: 9, name: 'Tool configuration', type: 'text', allowEmpty: false, options: [] }];

async function migration(models, resolutions = []) {
    const state = { models: structuredClone(models), scores: models.map(model => ({ ID: 100 + model.ID,
        model_ID: model.ID, raw_score: 60 + model.ID, score_fields: [], source_URL: 'https://example.com', notes: {} })),
    profiles: [{ user_ID: 7, profile_key: 'last', comparison: { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: models[0].ID }] } }], committed: false };
    let report;
    const database = {
        async beginTransaction() {}, async rollback() {}, async commit() { state.committed = true; }, async end() {},
        async query(sql, parameters) {
            if (sql.includes('GET_LOCK(')) return [[{ acquired: 1 }]];
            if (sql.includes('RELEASE_LOCK(')) return [[{ released: 1 }]];
            if (sql.includes('FROM models m')) return [structuredClone(state.models)];
            if (sql.includes('FROM user_comparison_profiles')) return [structuredClone(state.profiles)];
            if (sql.startsWith('SELECT COUNT')) return [[{ count: state.scores.length, scoreSum: state.scores.reduce((sum, score) => sum + score.raw_score, 0) }]];
            if (sql.startsWith('UPDATE benchmark_results')) {
                for (const score of state.scores) if (parameters[2].includes(score.ID)) {
                    score.model_ID = parameters[0]; score.score_fields = JSON.parse(parameters[1]);
                }
                return [{ affectedRows: parameters[2].length }];
            }
            throw new Error(sql);
        },
        async execute(sql, parameters) {
            if (sql.startsWith('SELECT ID,score_fields')) return [structuredClone(state.scores.filter(score => score.model_ID === parameters[0]))];
            if (sql.startsWith('UPDATE models SET name')) state.models.find(model => model.ID === parameters[1]).name = parameters[0];
            else if (sql.startsWith('UPDATE models SET is_active')) state.models.find(model => model.ID === parameters[0]).is_active = 0;
            else if (sql.startsWith('UPDATE user_comparison_profiles')) state.profiles[0].comparison = JSON.parse(parameters[0]);
            else throw new Error(sql);
            return [{ affectedRows: 1 }];
        }
    };
    const context = vm.createContext({ process: { argv: ['node', 'script', '--apply', '--backup-confirmed', '--identity-resolutions', 'identities.json'], env: {} },
        mysql: { createConnection: async () => database }, mkdir: async () => {},
        readFile: async () => JSON.stringify(resolutions), writeFile: async (_path, text) => { report = JSON.parse(text); },
        resolve, arenaCanonicalModelName, loadScoreFieldCatalog: async () => fields,
        mergeRunConfigurationFields, modelRunConfiguration, resolveModelRunMappings, runConfigurationFields,
        structuredClone, console: { log() {} } });
    await vm.runInContext(`(async () => { ${source} })()`, context);
    return { state, report };
}

test('the full migration rewrites chained identities and saved filters to an active final model without losing run fields', async () => {
    const models = [
        { ID: 1, name: 'GPT-6-high (codex-harness)', is_active: 1, vendor_ID: 1, vendorSlug: 'openai' },
        { ID: 2, name: 'gpt-6-high (codex-harness)', is_active: 1, vendor_ID: 1, vendorSlug: 'openai' },
        { ID: 3, name: 'gpt-6', is_active: 1, vendor_ID: 1, vendorSlug: 'openai' }
    ];
    const { state, report } = await migration(models, [{ fromID: 1, toID: 2, fromName: models[0].name,
        toName: models[1].name, vendorSlug: 'openai', evidenceURL: 'https://example.com/identity' }]);
    assert.equal(state.committed, true);
    assert.deepEqual(state.scores.map(score => score.model_ID), [3, 3, 3]);
    assert.deepEqual(state.scores.slice(0, 2).map(score => score.score_fields), [
        [{ fieldID: 1, value: 'codex-harness' }, { fieldID: 2, value: 3 }],
        [{ fieldID: 1, value: 'codex-harness' }, { fieldID: 2, value: 3 }]
    ]);
    assert.deepEqual(state.models.map(model => model.is_active), [0, 0, 1]);
    assert.deepEqual(state.profiles[0].comparison.filters, [
        { key: 'model', operator: 'eq', value: 3 }, { key: 'field:1', operator: 'eq', value: 'codex-harness' },
        { key: 'field:2', operator: 'eq', value: 3 }
    ]);
    assert.deepEqual(report.modelMappings.map(mapping => mapping.toID), [3, 3]);
    assert.deepEqual(state.scores.map(score => score.raw_score), [61, 62, 63]);
});

test('the actual migration keeps Imagen Ultra edition scores attached to their own model', async () => {
    const { state, report } = await migration([
        { ID: 1, name: 'Imagen 4', is_active: 1, vendor_ID: 2, vendorSlug: 'google' },
        { ID: 2, name: 'Imagen 4 (Ultra)', is_active: 1, vendor_ID: 2, vendorSlug: 'google' }
    ]);
    assert.deepEqual(report.modelMappings, []);
    assert.deepEqual(state.scores.map(score => score.model_ID), [1, 2]);
    assert.deepEqual(state.models.map(model => model.is_active), [1, 1]);
});

test('preview effort migrates without moving preview scores into the GA release', async () => {
    const { state, report } = await migration([
        { ID: 1, name: 'deepseek-v4-pro-high-preview', is_active: 1, vendor_ID: 1, vendorSlug: 'deepseek' },
        { ID: 2, name: 'deepseek-v4-pro', is_active: 1, vendor_ID: 1, vendorSlug: 'deepseek' }
    ]);
    assert.deepEqual(report.modelMappings.map(row => row.toID), [1]);
    assert.equal(state.models[0].name, 'deepseek-v4-pro-preview');
    assert.deepEqual(state.scores.map(score => score.model_ID), [1, 2]);
    assert.deepEqual(state.scores[0].score_fields, [{ fieldID: 2, value: 3 }]);
    assert.deepEqual(state.scores[1].score_fields, []);
});

test('Search Arena configured Sonar merges into Sonar Pro and saves only search context size', async () => {
    const { state, report } = await migration([
        { ID: 1, name: 'ppl-sonar-pro-high', is_active: 1, vendor_ID: 1, vendorSlug: 'perplexity-ai' },
        { ID: 2, name: 'Sonar Pro', is_active: 1, vendor_ID: 1, vendorSlug: 'perplexity-ai' }
    ]);
    assert.deepEqual(report.modelMappings.map(row => row.toID), [2]);
    assert.deepEqual(state.scores.map(score => score.model_ID), [2, 2]);
    assert.deepEqual(state.scores[0].score_fields, [{ fieldID: 4, value: 5 }]);
    assert.deepEqual(state.models.map(model => model.is_active), [0, 1]);
    assert.deepEqual(state.profiles[0].comparison.filters, [
        { key: 'model', operator: 'eq', value: 2 }, { key: 'field:4', operator: 'eq', value: 5 }
    ]);
});

test('source prefix normalization alone rewrites a model identity without inventing score fields', async () => {
    const { state, report } = await migration([
        { ID: 1, name: 'pplx-sonar-pro', is_active: 1, vendor_ID: 1, vendorSlug: 'perplexity-ai' },
        { ID: 2, name: 'Sonar Pro', is_active: 1, vendor_ID: 1, vendorSlug: 'perplexity-ai' }
    ]);
    assert.deepEqual(report.modelMappings.map(row => row.toID), [2]);
    assert.deepEqual(state.scores.map(score => score.model_ID), [2, 2]);
    assert.deepEqual(state.scores.map(score => score.score_fields), [[], []]);
});

test('thinking and grounding labels become fields and keep dated model version identity', async () => {
    const { state } = await migration([
        { ID: 1, name: 'gemini-2.5-flash-lite-preview-09-2025-no-thinking', is_active: 1, vendor_ID: 1, vendorSlug: 'google' },
        { ID: 2, name: 'gemini-3-pro-grounding', is_active: 1, vendor_ID: 1, vendorSlug: 'google' },
        { ID: 3, name: 'gemini-3-pro', is_active: 1, vendor_ID: 1, vendorSlug: 'google' }
    ]);
    assert.equal(state.models[0].name, 'gemini-2.5-flash-lite-preview-09-2025');
    assert.deepEqual(state.scores[0].score_fields, [{ fieldID: 6, value: 8 }]);
    assert.equal(state.scores[1].model_ID, 3);
    assert.deepEqual(state.scores[1].score_fields, [{ fieldID: 9, value: 'Google Search grounding' }]);
});

test('Kimi K2.5 modes migrate into the existing base model without changing K2 Thinking editions', async () => {
    const { state, report } = await migration([
        { ID: 1, name: 'kimi-k2.5-thinking', is_active: 1, vendor_ID: 1, vendorSlug: 'moonshot-ai' },
        { ID: 2, name: 'kimi-k2.5-instant', is_active: 1, vendor_ID: 1, vendorSlug: 'moonshot-ai' },
        { ID: 3, name: 'Kimi K2.5', is_active: 1, vendor_ID: 1, vendorSlug: 'moonshot-ai' },
        { ID: 4, name: 'Kimi K2 Thinking', is_active: 1, vendor_ID: 1, vendorSlug: 'moonshot-ai' },
        { ID: 5, name: 'kimi-k2-thinking-turbo', is_active: 1, vendor_ID: 1, vendorSlug: 'moonshot-ai' }
    ]);
    assert.deepEqual(report.modelMappings.map(row => row.toID), [3, 3]);
    assert.deepEqual(state.scores.map(score => score.model_ID), [3, 3, 3, 4, 5]);
    assert.deepEqual(state.scores.map(score => score.score_fields), [
        [{ fieldID: 6, value: 7 }], [{ fieldID: 6, value: 8 }], [], [], []
    ]);
    assert.deepEqual(state.models.map(model => model.is_active), [0, 0, 1, 1, 1]);
    assert.deepEqual(state.profiles[0].comparison.filters, [
        { key: 'model', operator: 'eq', value: 3 }, { key: 'field:6', operator: 'eq', value: 7 }
    ]);
    assert.deepEqual(state.scores.map(score => score.raw_score), [61, 62, 63, 64, 65]);
});

test('Qwen3 no-thinking maps only to the original hybrid model, not a later Instruct or Thinking checkpoint', async () => {
    const { state, report } = await migration([
        { ID: 1, name: 'qwen3-235b-a22b-no-thinking', is_active: 1, vendor_ID: 1, vendorSlug: 'qwen' },
        { ID: 2, name: 'Qwen3 235B A22B', is_active: 1, vendor_ID: 1, vendorSlug: 'qwen' },
        { ID: 3, name: 'Qwen3-235B-A22B-Instruct-2507', is_active: 1, vendor_ID: 1, vendorSlug: 'qwen' },
        { ID: 4, name: 'Qwen3-235B-A22B-Thinking-2507', is_active: 1, vendor_ID: 1, vendorSlug: 'qwen' }
    ]);
    assert.deepEqual(report.modelMappings.map(row => row.toID), [2]);
    assert.deepEqual(state.scores.map(score => score.model_ID), [2, 2, 3, 4]);
    assert.deepEqual(state.scores.map(score => score.score_fields), [[{ fieldID: 6, value: 8 }], [], [], []]);
    assert.deepEqual(state.models.map(model => model.is_active), [0, 1, 1, 1]);
});
