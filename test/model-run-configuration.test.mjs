import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeRunConfigurationFields, modelRunConfiguration, resolveModelRunMappings, runConfigurationFields } from '../model-run-configuration.js';

const definitions = [{ ID: 20, name: 'Reasoning effort', type: 'enum', allowEmpty: false,
    options: [{ ID: 3, label: 'high' }, { ID: 5, label: 'max' }, { ID: 10, label: 'xhigh' }] },
{ ID: 1, name: 'Agent harness', type: 'text', allowEmpty: false, options: [] },
{ ID: 5, name: 'Configuration selection', type: 'text', allowEmpty: false, options: [] },
{ ID: 22, name: 'Reasoning mode', type: 'enum', allowEmpty: false,
    options: [{ ID: 11, label: 'disabled' }, { ID: 12, label: 'enabled' }] },
{ ID: 34, name: 'Tool configuration', type: 'text', allowEmpty: false, options: [] },
{ ID: 60, name: 'Search context size', type: 'enum', allowEmpty: false,
    options: [{ ID: 61, label: 'low' }, { ID: 62, label: 'medium' }, { ID: 63, label: 'high' }] }];

test('explicit effort annotations become score configuration, not separate model identities', () => {
    for (const [name, vendor, baseName, reasoningEffort] of [
        ['Claude Fable 5.1 (Max)', 'anthropic', 'Claude Fable 5.1', 'max'],
        ['gpt-5.1-high', 'openai', 'gpt-5.1', 'high'],
        ['Gemini 3 Pro High', 'google', 'Gemini 3 Pro', 'high'],
        ['deepseek-v4-pro-high-20260813', 'deepseek', 'deepseek-v4-pro-20260813', 'high'],
        ['GPT 5.6 Sol (xHigh)', 'openai', 'GPT 5.6 Sol', 'xhigh'],
        ['gemini-3-flash (thinking-high)', 'google', 'gemini-3-flash', 'high'],
        ['muse-spark-1.3-max', 'meta', 'muse-spark-1.3', 'max']
    ]) assert.deepEqual(modelRunConfiguration(name, vendor), { baseName, configuration: { reasoningEffort } });
});

test('nested harness and dated effort annotations do not hide the underlying run configuration', () => {
    assert.deepEqual(modelRunConfiguration('gpt-5.5-high (codex-harness)', 'openai'), {
        baseName: 'gpt-5.5', configuration: { agentHarness: 'codex-harness', reasoningEffort: 'high' }
    });
    assert.deepEqual(modelRunConfiguration('DeepSeek V4 Pro (High) (0813)', 'deepseek'), {
        baseName: 'DeepSeek V4 Pro (0813)', configuration: { reasoningEffort: 'high' }
    });
    const run = modelRunConfiguration('mimo-v2-flash (non-thinking)', 'xiaomi');
    assert.deepEqual(run, { baseName: 'mimo-v2-flash', configuration: { reasoningMode: 'disabled' } });
    assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 22, value: 11 }]);
    assert.deepEqual(runConfigurationFields({ agentHarness: 'codex-harness', reasoningEffort: 'high' }, definitions),
        [{ fieldID: 1, value: 'codex-harness' }, { fieldID: 20, value: 3 }]);
});

test('real model editions and ambiguous embedded labels are never stripped', () => {
    for (const [name, vendor] of [['Qwen3.8 Max', 'qwen'], ['GPT-5.1-Codex-Max', 'openai'],
        ['GPT-5.1 Codex Max', 'openai'], ['gpt-5.1-codex-max-20251216', 'openai'],
        ['Imagen 4 Ultra', 'google'], ['imagen-4-ultra', 'google'], ['Imagen 4 (Ultra)', 'google'],
        ['GPT-5.1-Codex (Max)', 'openai'], ['Qwen3.8 (Max)', 'qwen'],
        ['MiniMax-M3', 'minimax'], ['Kimi K2 Thinking', 'moonshot-ai'], ['deepseek-v5-pro-high-preview', 'deepseek'],
        ['grok-4-1-fast-reasoning', 'xai'], ['qwen3-next-80b-a3b-thinking', 'qwen']]) {
        assert.deepEqual(modelRunConfiguration(name, vendor), { baseName: name, configuration: {} });
    }
});

test('DeepSeek preview effort is a score field while preview remains a separate release identity', () => {
    for (const edition of ['pro', 'flash']) {
        const run = modelRunConfiguration(`deepseek-v4-${edition}-high-preview`, 'deepseek');
        assert.deepEqual(run, { baseName: `deepseek-v4-${edition}-preview`, configuration: { reasoningEffort: 'high' } });
        assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 20, value: 3 }]);
        assert.deepEqual(modelRunConfiguration(run.baseName, 'deepseek'), { baseName: run.baseName, configuration: {} });
    }
});

test('Search Arena Sonar high means search context size, never reasoning effort', () => {
    for (const prefix of ['ppl-', 'pplx-', '']) {
        for (const model of ['sonar-pro', 'sonar-reasoning-pro']) {
            const run = modelRunConfiguration(`${prefix}${model}-high`, 'perplexity-ai');
            assert.deepEqual(run, { baseName: model, configuration: { searchContextSize: 'high' } });
            assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 60, value: 63 }]);
        }
    }
    assert.deepEqual(modelRunConfiguration('ppl-sonar', 'perplexity-ai'), { baseName: 'sonar', configuration: {} });
    assert.deepEqual(modelRunConfiguration('ppl-sonar-pro-high', 'unknown'), { baseName: 'ppl-sonar-pro-high', configuration: {} });
    assert.throws(() => runConfigurationFields({ searchContextSize: 'high' }, []), /Search context size/);
});

test('only verified switchable thinking models lose their thinking annotation', () => {
    for (const name of ['deepseek-v3.1-thinking', 'deepseek-v3.1-terminus-thinking',
        'deepseek-v3.2-thinking', 'deepseek-v3.2-exp-thinking']) {
        const run = modelRunConfiguration(name, 'deepseek');
        assert.deepEqual(run, { baseName: name.replace(/-thinking$/, ''), configuration: { reasoningMode: 'enabled' } });
        assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 22, value: 12 }]);
    }
    assert.deepEqual(modelRunConfiguration('gemini-2.5-flash-lite-preview-09-2025-no-thinking', 'google'), {
        baseName: 'gemini-2.5-flash-lite-preview-09-2025', configuration: { reasoningMode: 'disabled' }
    });
    assert.deepEqual(modelRunConfiguration('gemini-2.5-flash-lite-preview-06-17-thinking', 'google'), {
        baseName: 'gemini-2.5-flash-lite-preview-06-17', configuration: { reasoningMode: 'enabled' }
    });
});

test('Gemini search grounding becomes a tool field, not an independent model', () => {
    for (const name of ['gemini-2.5-pro', 'gemini-3-pro', 'gemini-3.1-pro', 'gemini-3-flash']) {
        const run = modelRunConfiguration(`${name}-grounding`, 'google');
        assert.deepEqual(run, { baseName: name, configuration: { toolConfiguration: 'Google Search grounding' } });
        assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 34, value: 'Google Search grounding' }]);
    }
});

test('Kimi K2.5 thinking and instant modes share one identity but remain distinct score configurations', () => {
    for (const [mode, value, optionID] of [['thinking', 'enabled', 12], ['instant', 'disabled', 11]]) {
        const run = modelRunConfiguration(`kimi-k2.5-${mode}`, 'moonshot-ai');
        assert.deepEqual(run, { baseName: 'kimi-k2.5', configuration: { reasoningMode: value } });
        assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 22, value: optionID }]);
        assert.deepEqual(modelRunConfiguration(run.baseName, 'moonshot-ai'), { baseName: run.baseName, configuration: {} });
    }
    for (const name of ['kimi-k2-thinking', 'kimi-k2-thinking-turbo', 'kimi-k2.6-thinking']) {
        assert.deepEqual(modelRunConfiguration(name, 'moonshot-ai'), { baseName: name, configuration: {} });
    }
    assert.deepEqual(modelRunConfiguration('kimi-k2.5-thinking', 'unknown'),
        { baseName: 'kimi-k2.5-thinking', configuration: {} });
    assert.throws(() => mergeRunConfigurationFields([{ fieldID: 22, value: 11 }],
        runConfigurationFields({ reasoningMode: 'enabled' }, definitions), definitions), /conflicts/);
});

test('original Qwen3 thinking annotations are runtime fields, not later Thinking release identities', () => {
    for (const [suffix, value, optionID] of [['thinking', 'enabled', 12], ['no-thinking', 'disabled', 11]]) {
        const run = modelRunConfiguration(`qwen3-235b-a22b-${suffix}`, 'qwen');
        assert.deepEqual(run, { baseName: 'qwen3-235b-a22b', configuration: { reasoningMode: value } });
        assert.deepEqual(runConfigurationFields(run.configuration, definitions), [{ fieldID: 22, value: optionID }]);
    }
    for (const name of ['Qwen3-235B-A22B-Thinking-2507', 'Qwen3-VL-235B-A22B-Thinking',
        'qwen3-next-80b-a3b-thinking', 'Qwen3-235B-A22B-Instruct-2507']) {
        assert.deepEqual(modelRunConfiguration(name, 'qwen'), { baseName: name, configuration: {} });
    }
});

test('compound Anthropic run labels retain literal token settings without inventing token counts', () => {
    const high = modelRunConfiguration('claude-sonnet-4-5-20250929-high-32k', 'anthropic');
    assert.deepEqual(high, { baseName: 'claude-sonnet-4-5-20250929',
        configuration: { configurationSelection: '32k', reasoningEffort: 'high' } });
    assert.deepEqual(runConfigurationFields(high.configuration, definitions), [
        { fieldID: 5, value: '32k' }, { fieldID: 20, value: 3 }
    ]);
    const thinking = modelRunConfiguration('claude-opus-4-1-20250805-thinking-16k', 'anthropic');
    assert.deepEqual(thinking, { baseName: 'claude-opus-4-1-20250805',
        configuration: { configurationSelection: '16k', reasoningMode: 'enabled' } });
    assert.deepEqual(runConfigurationFields(thinking.configuration, definitions), [
        { fieldID: 5, value: '16k' }, { fieldID: 22, value: 12 }
    ]);
    assert.deepEqual(modelRunConfiguration('phi-3-medium-4k-instruct', 'microsoft').configuration, {});
    assert.deepEqual(modelRunConfiguration('claude-test-thinking-128k', 'anthropic').configuration, {});
    assert.throws(() => mergeRunConfigurationFields([{ fieldID: 5, value: '16k' }],
        runConfigurationFields(high.configuration, definitions), definitions), /conflicts/);
});

test('inferred effort uses the registered global field and option IDs, with strict conflicts', () => {
    const inferred = runConfigurationFields({ reasoningEffort: 'high' }, definitions);
    assert.deepEqual(inferred, [{ fieldID: 20, value: 3 }]);
    assert.deepEqual(mergeRunConfigurationFields([], inferred, definitions), inferred);
    assert.deepEqual(mergeRunConfigurationFields(inferred, inferred, definitions), inferred);
    assert.throws(() => mergeRunConfigurationFields([{ fieldID: 20, value: 5 }], inferred, definitions), /conflicts/);
    assert.throws(() => runConfigurationFields({ reasoningEffort: 'high' }, []), /Register/);
    assert.throws(() => runConfigurationFields({ reasoningEffort: 'unknown' }, definitions), /unambiguous/);
});

test('MySQL JSON object key ordering does not create configuration changes on every sync', () => {
    const stored = [{ value: 3, fieldID: 20 }];
    const normalized = mergeRunConfigurationFields(stored, [], definitions);
    const sameEffort = mergeRunConfigurationFields(normalized, [{ fieldID: 20, value: 3 }], definitions);
    assert.equal(JSON.stringify(normalized), JSON.stringify(sameEffort));
});

test('migration chains resolve scores and saved filters to the final identity with all fields', () => {
    const mappings = [
        { fromID: 1, toID: 2, baseName: 'Middle', fields: [{ fieldID: 1, value: 'codex-harness' }] },
        { fromID: 2, toID: 3, baseName: 'Final (high)', fields: [{ fieldID: 20, value: 3 }] },
        { fromID: 3, toID: 3, baseName: 'Final', fields: [{ fieldID: 5, value: '32k' }] }
    ];
    const resolved = resolveModelRunMappings(mappings, definitions);
    assert.deepEqual(resolved.map(item => item.toID), [3, 3, 3]);
    assert.deepEqual(resolved[0].fields, [{ fieldID: 1, value: 'codex-harness' },
        { fieldID: 5, value: '32k' }, { fieldID: 20, value: 3 }]);
    assert.equal(resolved[0].baseName, 'Final');
    assert.equal(mappings[0].toID, 2);
    assert.throws(() => resolveModelRunMappings([
        { fromID: 1, toID: 2, fields: [] }, { fromID: 2, toID: 1, fields: [] }
    ], definitions), /Cyclic/);
    assert.throws(() => resolveModelRunMappings([
        { fromID: 1, toID: 2, fields: [{ fieldID: 20, value: 3 }] },
        { fromID: 2, toID: 3, fields: [{ fieldID: 20, value: 5 }] }
    ], definitions), /conflicts/);
});
