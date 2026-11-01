import assert from 'node:assert/strict';
import test from 'node:test';
import {
    arenaBenchmarkName, arenaCondition, arenaModelKey, arenaResultVendorSlug,
    arenaScore, arenaTrackedIdentities, arenaVendorSlug, buildArenaPlan
} from '../arena-import-plan.js';

test('maps official Arena categories to existing benchmark families', () => {
    assert.equal(arenaBenchmarkName('text_style_control', 'coding'), 'Text Arena (Coding)');
    assert.equal(arenaBenchmarkName('text_factuality', 'coding'), 'Text Arena Factuality (Coding)');
    assert.equal(arenaBenchmarkName('image_edit', 'multi_image_edit'), 'Image Edit Arena (Multi; Overall)');
    assert.equal(arenaBenchmarkName('webdev', 'webdev-react'), 'Code Arena WebDev (React)');
    assert.equal(arenaBenchmarkName('agent_task_outcome_explicit', 'overall'),
        'Agent Arena (Explicit Task Outcome)');
    assert.equal(arenaBenchmarkName('text', 'unknown'), null);
});

test('source identities survive benchmark and condition renames across independently synced feeds', () => {
    const benchmarks = [{ ID: 51, name: 'Renamed text benchmark' }];
    const conditions = [
        { ID: 71, benchmark_ID: 51, condition_key: 'renamed-raw', deleted_at: null },
        { ID: 72, benchmark_ID: 51, condition_key: 'renamed-adjusted', deleted_at: null }
    ];
    const tracked = [
        { config: 'text', category: 'overall', benchmark_ID: 51, benchmark_condition_ID: 71 },
        { config: 'text_style_control', category: 'overall', benchmark_ID: 51, benchmark_condition_ID: 72 }
    ];
    const identities = arenaTrackedIdentities(tracked, benchmarks, conditions);
    assert.equal(identities.benchmarkIDs.get(arenaBenchmarkName('text', 'overall')), 51);
    assert.equal(identities.conditionIDs.get('51:unadjusted').ID, 71);
    assert.equal(identities.conditionIDs.get('51:default').ID, 72);
    assert.throws(() => arenaTrackedIdentities([...tracked, { ...tracked[0], benchmark_condition_ID: 72 }], benchmarks, conditions), /Conflicting/);
    assert.throws(() => arenaTrackedIdentities(tracked, benchmarks, [{ ...conditions[0], deleted_at: '2026-10-04' }, conditions[1]]), /Invalid/);
    assert.throws(() => arenaTrackedIdentities([{ ...tracked[0], category: 'unknown' }], benchmarks, conditions), /Invalid/);
});

test('keeps adjusted and unadjusted scores in distinct conditions', () => {
    assert.equal(arenaCondition('text_style_control'), 'default');
    assert.equal(arenaCondition('text'), 'unadjusted');
    assert.equal(arenaCondition('agent'), 'default');
    assert.equal(arenaScore('agent', { score: -0.123456789 }), -12.345679);
    assert.equal(arenaScore('text', { rating: 1234.5678912 }), 1234.567891);
});

test('canonicalizes equivalent Arena model labels within one organization', () => {
    assert.equal(arenaModelKey('anthropic', 'Claude Fable 5.1 (Max)'),
        arenaModelKey('anthropic', 'claude-fable-5.1-max'));
    assert.notEqual(arenaModelKey('openai', 'claude-fable-5.1-max'),
        arenaModelKey('anthropic', 'claude-fable-5.1-max'));
    assert.notEqual(arenaModelKey('cohere', 'Command R 08-2024'),
        arenaModelKey('cohere', 'Command R+ 08-2024'));
    assert.equal(arenaVendorSlug('bfl'), 'black-forest-labs');
    assert.equal(arenaVendorSlug('Stability AI'), 'stability-ai');
    assert.equal(arenaResultVendorSlug('alibaba', 'qwen3.8-max'), 'qwen');
    assert.equal(arenaResultVendorSlug('alibaba', 'wan3.0'), 'alibaba');
});

test('skips a WebDev alias and quarantines conflicting duplicate scores', () => {
    const row = (category, modelName, rating) => ({
        organization: 'openai', model_name: modelName, category, rating,
        leaderboard_publish_date: '2026-09-24'
    });
    const snapshot = { configs: [{ config: 'webdev', rows: [
        row('overall', 'gpt-6-astra', 1400), row('webdev', 'gpt-6-astra', 1400),
        row('webdev-react', 'gpt-5.3-codex', 1300),
        row('webdev-react', 'gpt-5.3-codex', 1200)
    ] }] };
    const plan = buildArenaPlan(snapshot);
    assert.equal(plan.entries.length, 1);
    assert.equal(plan.skippedAliases.length, 1);
    assert.equal(plan.conflicts.length, 1);
    assert.deepEqual(plan.conflicts[0].map(item => item.score), [1300, 1200]);
});
