import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScalePlan, applyScalePlan, quantizeScaleScore, scaleConfigurationFields, validateScaleSnapshot } from '../scripts/import-scale-official.mjs';
import { SCALE_VERSIONS, scaleVersion } from '../scripts/scale-benchmark-catalogue.mjs';
import { SCALE_EXPORT_COLUMNS } from '../scripts/capture-scale-state.mjs';
import { canonicalScaleName, resolveScaleModel } from '../scripts/scale-model-identities.mjs';
import { scaleRunConfiguration, objectHash } from '../scripts/scale-official-data.mjs';
import { parseFlightObjects } from '../scripts/collect-scale-official.mjs';
import { loadBenchmarkConditions } from '../ranking-service.js';

const hash = 'a'.repeat(64), stamp = '2026-10-12 01:00:00.000000';
const boardIDs = ['hss', 'distressbench', 'hle-diamond', 'drugdiscoverybench', 'sweatlas-refactoring', 'sweatlas-tw', 'sweatlas-qna', 'hil', 'mcp_atlas',
    'swe_bench_pro_public_v2', 'swe_bench_pro_public_v2', 'swe_bench_pro', 'swe_bench_pro', 'scipredict', 'humanitys_last_exam',
    'humanitys_last_exam_text_only', 'audiomc', 'audiomc-audio', 'audiomc-text', 'prbench-finance', 'prbench-legal', 'rli', 'propensitybench', 'vtb',
    'multinrc', 'multichallenge', 'fortress', 'mask', 'enigma_eval', 'visual_language_understanding', 'tutorbench', 'adversarial_robustness',
    'tool_use_chat', 'tool_use_enterprise', 'humanitys_last_exam_preview', 'humanitys_last_exam_text_only_preview', 'instruction_following',
    'arabic', 'chinese', 'coding', 'japanese', 'korean', 'math', 'spanish'];
function fixtures() {
    const tables = Object.fromEntries(Object.keys(SCALE_EXPORT_COLUMNS).map(key => [key, []]));
    tables.columns = Object.entries(SCALE_EXPORT_COLUMNS).flatMap(([table, columns]) => columns.map(column => ({ table, column,
        type: column === 'raw_score' ? 'decimal(18,6)' : column === 'score_fields' ? 'json' : 'text' })));
    tables.engines = Object.keys(SCALE_EXPORT_COLUMNS).map(table => ({ table, engine: 'InnoDB' }));
    tables.organizations.push({ ID: 1, slug: 'openai', name: 'OpenAI', is_active: 1, is_model_vendor: 1, introduction_url: null });
    tables.models.push({ ID: 1, slug: 'openai-gpt-6-astra', name: 'GPT-6 Astra', vendor_ID: 1, is_active: 1, notes: null, introduction_url: null });
    for (const version of SCALE_VERSIONS.filter(v => v.benchmarkID)) {
        if (!tables.benchmarks.some(b => b.ID === version.benchmarkID)) tables.benchmarks.push({ ID: version.benchmarkID, name: version.benchmark,
            is_active: 1, scores_updated_at: null, description: null, notes: null, request_official_sync: 0, introduction_url: null });
        if (version.conditionID && !tables.benchmark_conditions.some(c => c.ID === version.conditionID)) tables.benchmark_conditions.push({
            ID: version.conditionID, benchmark_ID: version.benchmarkID, condition_key: `existing-${version.conditionID}`, name: version.name,
            score_direction: 'higher', uses_percentage_scale: 1, target_value: null, score_min: null, score_max: null, deleted_at: null,
            is_default: 0, is_primary: 1, score_source: null, difference_explanation: 'Previous explanation' });
    }
    const fieldDefinitions = [[1, 'Agent harness', 'text'], [5, 'Configuration selection', 'text'], [8, 'Generation mode', 'text'],
        [20, 'Reasoning effort', 'enum'], [22, 'Reasoning mode', 'enum']];
    for (const [ID, name, field_type] of fieldDefinitions) tables.score_fields.push({ ID, name, name_key: name.toLowerCase(), field_type,
        allow_empty: 0, exclude_missing: 1, exclude_empty: 1, is_active: 1, revision: 1 });
    for (const [ID, field_ID, label] of [[3, 20, 'high'], [5, 20, 'max'], [6, 20, 'medium'], [10, 20, 'xhigh'], [11, 22, 'disabled'], [12, 22, 'enabled']]) {
        tables.score_field_options.push({ ID, field_ID, label, label_key: label, is_active: 1, excluded: 0, revision: 1 });
    }
    const records = SCALE_VERSIONS.map(v => {
        const boardID = v.key.startsWith('rsi:') ? 'rsi' : v.key.startsWith('ready:') ? 'ready' : v.key.split(':')[0];
        const sourceURL = boardID === 'rsi' ? `https://rsi-benchmark.com/tasks/${v.key.split(':')[1]}`
            : boardID === 'showdown' ? 'https://static.scale.com/report.pdf' : `https://labs.scale.com/leaderboard/${boardID}`;
        return { metricKey: v.key, boardID, record: { model: 'GPT-6 Astra (max)', score: v.percentage ? 40 : (v.min + v.max) / 2, company: 'openai' },
            sourceURL, evidenceFile: `${boardID}.json`, evidenceHash: hash, fetchedAt: '2026-10-12T01:00:00Z', status: v.archived ? 'archived' : 'accepted' };
    });
    for (const boardID of ['audiomc-audio', 'audiomc-text']) records.push({ ...records.find(r => r.metricKey === 'audiomc:overall'), boardID,
        sourceURL: `https://labs.scale.com/leaderboard/${boardID}` });
    const sourceRows = {}; for (const r of records) sourceRows[r.metricKey] = (sourceRows[r.metricKey] ?? 0) + 1;
    return { state: { schemaVersion: 1, tables }, snapshot: { schemaVersion: 1, publisher: 'Scale Labs', collectedAt: '2026-10-12T01:00:00Z',
        versions: structuredClone(SCALE_VERSIONS), records, sourceRows, directoryEntries: boardIDs.map((ID, index) => ({ ID, name: `${ID} ${index}` })), warnings: [] } };
}
function addResult(state, source, notes, fields = [{ fieldID: 20, value: 5 }], ID = 100) {
    state.tables.benchmark_results.push({ ID, model_ID: 1, benchmark_ID: 1687, benchmark_condition_ID: 22196,
        raw_score: quantizeScaleScore(source.record.score), score_fields: fields, source_url: source.sourceURL,
        source_type: 'third_party_lab', source_title: 'Official benchmark publisher snapshot', benchmark_condition_snapshot: {},
        status: 'accepted', notes: JSON.stringify(notes), submitted_by: null, moderation_log_ID: null,
        accepted_at: stamp, created_at: stamp, updated_at: stamp });
}

test('stores exact half-up decimals, including exponents and signed zero', () => {
    for (const [input, expected] of [['78.1000', '78.100000'], ['.1', null], ['1.0000005', '1.000001'], ['1.000000499', '1.000000'],
        ['-1.0000005', '-1.000001'], ['1e-7', '0.000000'], ['-0.0000001', '0.000000'], ['8.18e-1', '0.818000'], ['426.38', '426.380000']]) {
        if (expected === null) assert.throws(() => quantizeScaleScore(input)); else assert.equal(quantizeScaleScore(input), expected);
    }
    assert.throws(() => quantizeScaleScore('NaN')); assert.throws(() => quantizeScaleScore('1e12'));
});
test('preserves provider editions while splitting effort and harness', () => {
    for (const [model, baseName, configuration] of [
        ['Qwen3.8-Max (max)', 'Qwen3.8-Max', { reasoningEffort: 'max' }],
        ['Manus_1.6 (Max)', 'Manus_1.6 Max', {}], ['Nemotron 3 Ultra', 'Nemotron 3 Ultra', {}],
        ['Claude-Opus-5.5 (xhigh)', 'Claude-Opus-5.5', { reasoningEffort: 'xhigh' }],
        ['gpt-5.4 (xhigh thinking)', 'gpt-5.4', { reasoningEffort: 'xhigh', reasoningMode: 'enabled' }],
        ['GPT 5.4 (Codex) xHigh', 'GPT 5.4', { agentHarness: 'Codex', reasoningEffort: 'xhigh' }]
    ]) {
        const actual = scaleRunConfiguration({ model }, 'hss'); assert.equal(actual.baseName, baseName); assert.deepEqual(actual.configuration, configuration);
    }
});
test('SWE stars indicate harness only in that board; Atlas stars are not harness', () => {
    assert.equal(scaleRunConfiguration({ model: 'GPT-5.4*' }, 'swe_bench_pro').configuration.agentHarness, 'mini-swe-agent');
    assert.equal(scaleRunConfiguration({ model: 'GPT-5.4*' }, 'sweatlas-qna').configuration.agentHarness, undefined);
});
test('audio modality is a run field and typed pages remain distinct', () => {
    assert.equal(scaleRunConfiguration({ model: 'gpt-realtime-2' }, 'audiomc-audio').configuration.generationMode, 'Audio output');
    assert.equal(scaleRunConfiguration({ model: 'gpt-realtime-2*' }, 'audiomc').configuration.generationMode, 'Text output');
    assert.equal(scaleRunConfiguration({ model: 'Gemini-3.8-Flash (high)' }, 'audiomc').configuration.generationMode, undefined);
});
test('transitive curated aliases are stable and unverified checkpoint dates stay separate', () => {
    assert.equal(canonicalScaleName('Gemini 2.5 Pro Experimental (March 2025)'), 'gemini-2.5-pro-preview-03-25');
    assert.equal(canonicalScaleName('Gemini 2.0 Flash'), 'Gemini 2.0 Flash');
    assert.equal(canonicalScaleName('o3-2025-04-03'), 'o3-2025-04-03');
    assert.notEqual(canonicalScaleName('o3-2025-04-03'), canonicalScaleName('o3-2025-04-16'));
});
test('provider is determined by explicit model identity, not erroneous company text', () => {
    assert.equal(scaleRunConfiguration({ model: 'Gemini 3.1 Pro', company: 'openai' }, 'hss').vendorSlug, 'google');
    assert.equal(scaleRunConfiguration({ model: 'Manus 1.5', company: 'DeepSeek' }, 'rli').vendorSlug, 'manus');
    assert.equal(scaleRunConfiguration({ model: 'HuatuoGPT-o1-8B' }, 'ready').vendorSlug, 'freedomintelligence');
    assert.equal(scaleRunConfiguration({ model: 'MiniMax M3' }, 'ready').vendorSlug, 'minimax');
});
test('API/name contradictions fail rather than silently dropping settings', () => {
    const { state } = fixtures();
    assert.throws(() => resolveScaleModel({ model: 'GPT-5.4 (high)', version: 'gpt-5.4-2026-03-05 (max)' }, 'hss', state), /Conflicting/);
});
test('validates all official directory entries and complete metric inventory', () => {
    const { snapshot } = fixtures(); validateScaleSnapshot(snapshot);
    snapshot.directoryEntries.pop(); assert.throws(() => validateScaleSnapshot(snapshot), /inventory/);
});
test('rejects changed metric definitions, incomplete boards and nonofficial evidence', () => {
    for (const mutate of [s => { s.versions[0].direction = 'lower'; }, s => { s.records.pop(); },
        s => { s.records[0].sourceURL = 'https://scale.com.attacker.invalid/board'; }, s => { s.records[0].record.score = 100.1; }]) {
        const { snapshot } = fixtures(); mutate(snapshot); assert.throws(() => validateScaleSnapshot(snapshot));
    }
});
test('metric directions are explicit, raw counts/Elo/rewards are not percentages', () => {
    for (const key of ['fortress:overall', 'fortress:ors', 'propensitybench:overall', 'humanitys_last_exam:calibration',
        'adversarial_robustness:overall', 'rsi:nano-gpt-data-curation', 'ready:clinicare:cost']) assert.equal(scaleVersion(key).direction, 'lower');
    for (const key of ['coding:overall', 'adversarial_robustness:overall', 'rsi:agent-swarm-optimization']) assert.equal(scaleVersion(key).percentage, false);
    assert.equal(scaleVersion('korean:overall').percentage, true);
    assert.equal(scaleVersion('showdown:style-controlled').archived, true);
    assert.match(scaleVersion('multinrc:overall').explanation, /French, Spanish, and Chinese/);
    assert.doesNotMatch(scaleVersion('multinrc:overall').explanation, /multi-turn reasoning/);
});
test('metadata corrections require the exact previous importer-owned text', () => {
    const { snapshot, state } = fixtures(), version = scaleVersion('multinrc:overall');
    state.tables.benchmarks.push({ ID: 30000, name: version.benchmark, is_active: 1, description: version.previousBenchmarkDescription,
        notes: JSON.stringify({ scale_import: true }), scores_updated_at: null, request_official_sync: 0, introduction_url: null });
    state.tables.benchmark_conditions.push({ ID: 30001, benchmark_ID: 30000, condition_key: 'scale-multinrc-overall', name: version.previousName,
        score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null, is_default: 1, is_primary: 1,
        deleted_at: null, score_source: 'scale-labs', difference_explanation: version.previousBenchmarkDescription });
    const plan = buildScalePlan(snapshot, state, hash); assert.equal(plan.canApply, true);
    assert.deepEqual(plan.updates.benchmarks.find(r => r.ID === 30000).changes, { description: version.explanation });
    assert.deepEqual(plan.updates.conditions.find(r => r.ID === 30001).changes, { is_default: 0, name: version.name, difference_explanation: version.explanation });
    state.tables.benchmarks.at(-1).description = 'Human-written replacement';
    assert.equal(buildScalePlan(snapshot, state, hash).canApply, false);
});
test('builds a full plan without modifying its input and preserves existing primary versions', () => {
    const { snapshot, state } = fixtures(), original = objectHash(state);
    const plan = buildScalePlan(snapshot, state, hash); assert.equal(plan.canApply, true); assert.equal(objectHash(state), original);
    assert.equal(plan.rows.length, snapshot.records.length);
    assert.ok(plan.creates.conditions.filter(c => c.benchmarkRef === 1687 || c.benchmarkRef === 2166).every(c => c.is_primary === 0));
    const first = plan.creates.conditions.find(c => c.benchmarkRef === 'new:benchmark:fortress'); assert.equal(first.is_primary, 1);
    assert.equal(plan.creates.conditions.filter(c => c.benchmarkRef === first.benchmarkRef && c.is_primary).length, 1);
    assert.ok(plan.creates.conditions.every(c => c.is_default === 0));
});

test('new named primary versions pass the real ranking catalogue validator', async () => {
    const { snapshot, state } = fixtures(), plan = buildScalePlan(snapshot, state, hash);
    const rows = plan.creates.conditions.map((condition, index) => ({ ...condition, condition_ID: index + 40000,
        benchmark_ID: index + 50000, condition_name: condition.name, name: 'Scale benchmark', tags: null,
        introduction_url: null, scored_model_count: 10, approved_score_count: 10 }));
    const versions = await loadBenchmarkConditions({ execute: async () => [rows] });
    assert.equal(versions.length, rows.length);
    assert.ok(versions.some(v => v.isPrimaryCondition));
    assert.ok(versions.every(v => !v.isDefaultCondition));
    const broken = structuredClone(rows); broken[0].is_default = 1;
    await assert.rejects(() => loadBenchmarkConditions({ execute: async () => [broken] }),
        error => error.body?.error === 'benchmark_condition_default_invariant_failed');
});

test('repairs importer-owned default markers without changing primary status or contributed scores', () => {
    const { snapshot, state } = fixtures(), version = scaleVersion('hss:overall');
    state.tables.benchmarks.push({ ID: 30000, name: version.benchmark, is_active: 1, notes: null, description: version.explanation });
    state.tables.benchmark_conditions.push({ ID: 30001, benchmark_ID: 30000, condition_key: 'scale-hss-overall', name: version.name,
        score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null,
        is_default: 1, is_primary: 1, deleted_at: null, score_source: 'scale-labs', difference_explanation: version.explanation });
    const before = objectHash(state), plan = buildScalePlan(snapshot, state, hash);
    assert.equal(plan.canApply, true);
    assert.deepEqual(plan.updates.conditions.find(r => r.ID === 30001).changes, { is_default: 0 });
    assert.equal(objectHash(state), before);
    state.tables.benchmark_conditions.at(-1).score_source = null;
    assert.equal(buildScalePlan(snapshot, state, hash).canApply, false);
});
test('coalesces identical source rows but blocks conflicting scores for one run', () => {
    const { snapshot, state } = fixtures();
    snapshot.records.push(structuredClone(snapshot.records[0])); snapshot.sourceRows[snapshot.records[0].metricKey]++;
    const plan = buildScalePlan(snapshot, state, hash); assert.equal(plan.canApply, true); assert.equal(plan.duplicates.length, 1);
    snapshot.records.at(-1).record.score++; assert.equal(buildScalePlan(snapshot, state, hash).canApply, false);
});
test('retains distinct explicit RSI run IDs and does not put them in fields', () => {
    const { snapshot, state } = fixtures(), original = snapshot.records.find(r => r.metricKey.startsWith('rsi:'));
    original.measurementID = 'run-one'; snapshot.records.push({ ...structuredClone(original), measurementID: 'run-two' }); snapshot.sourceRows[original.metricKey]++;
    const plan = buildScalePlan(snapshot, state, hash); assert.equal(plan.canApply, true);
    const runs = plan.rows.filter(r => r.metricKey === original.metricKey); assert.equal(runs.length, 2);
    assert.deepEqual(runs[0].fields, [{ fieldID: 20, value: 5 }]); assert.notEqual(runs[0].key, runs[1].key);
});
test('invalid run fields block the plan, rather than creating new enum options silently', () => {
    const { snapshot, state } = fixtures(); snapshot.records[0].configuration = { reasoningEffort: 'unregistered' };
    assert.equal(buildScalePlan(snapshot, state, hash).canApply, false);
    assert.throws(() => scaleConfigurationFields({ runID: 'abc' }, []), /Invalid run field/);
});
test('adopts verified legacy source rows, supersedes duplicate imports, and leaves user reports alone', () => {
    const { snapshot, state } = fixtures(), source = snapshot.records.find(r => r.metricKey === 'humanitys_last_exam:overall');
    addResult(state, source, { official_import_key: 'scale-hle:old', official_model_name: source.record.model });
    addResult(state, source, { post_astra_import: { nativeID: 'scale:HLE:old' }, sourceDetails: { sourceRow: { name: source.record.model } } }, undefined, 101);
    addResult(state, source, { user_note: 'Independent report' }, undefined, 102);
    const plan = buildScalePlan(snapshot, state, hash), row = plan.rows.find(r => r.metricKey === source.metricKey);
    assert.equal(row.action, 'adopt'); assert.equal(row.existingID, 100); assert.deepEqual(plan.cleanup.map(r => r.ID), [101]);
    assert.ok(!plan.rows.some(r => r.existingID === 102));
});
test('fixes a legacy misparsed effort only when original official row is verifiable', () => {
    const { snapshot, state } = fixtures(), source = snapshot.records.find(r => r.metricKey === 'humanitys_last_exam:overall');
    addResult(state, source, { official_import_key: 'scale-hle:old', official_model_name: source.record.model }, [{ fieldID: 20, value: 6 }]);
    const plan = buildScalePlan(snapshot, state, hash); assert.equal(plan.rows.find(r => r.metricKey === source.metricKey).action, 'adopt_replace');
});
test('UTF8 length-framed Flight text does not swallow the following chart JSON', () => {
    const text = 'Chart description: \u6d4b\u8bd5';
    const flight = `a:T${Buffer.byteLength(text).toString(16)},${text}b:{"chart":{"dataJson":"[{\\"model\\":\\"GPT\\"}]"}}\n`;
    assert.deepEqual(parseFlightObjects(flight), [text, { chart: { dataJson: '[{"model":"GPT"}]' } }]);
});

function memoryDatabase(initial) {
    let state = structuredClone(initial), before; const calls = [];
    const connection = {
        async query(sql) { calls.push(sql); if (/GET_LOCK/.test(sql)) return [[{ acquired: 1 }]];
            if (/UTC_TIMESTAMP/.test(sql)) return [[{ stamp }]]; return [[]]; },
        async beginTransaction() { before = structuredClone(state); calls.push('BEGIN'); },
        async rollback() { if (before) state = before; calls.push('ROLLBACK'); },
        async commit() { calls.push('COMMIT'); },
        async execute(sql, values) {
            calls.push(sql);
            const inserted = sql.match(/^INSERT INTO `([a-z_]+)` \(([^)]+)\)/);
            if (inserted) {
                const table = inserted[1], columns = [...inserted[2].matchAll(/`([A-Za-z_]+)`/g)].map(m => m[1]);
                const ID = Math.max(0, ...state.tables[table].map(r => Number(r.ID))) + 1;
                const row = { ID, ...Object.fromEntries(columns.map((key, index) => [key, values[index]])) };
                if (table === 'benchmark_results') {
                    assert.ok(row.accepted_at, 'accepted_at is NOT NULL even for archived source history');
                    row.score_fields = JSON.parse(row.score_fields); row.benchmark_condition_snapshot = JSON.parse(row.benchmark_condition_snapshot);
                    row.submitted_by = null; row.moderation_log_ID = null; row.created_at = stamp; row.updated_at = stamp;
                }
                if (table === 'benchmarks') { row.scores_updated_at = null; row.request_official_sync = 0; }
                if (table === 'benchmark_conditions') {
                    row.deleted_at = null;
                    assert.equal(Boolean(row.is_default), row.name.toLowerCase() === 'default');
                    assert.equal(row.condition_key === 'default', row.name.toLowerCase() === 'default');
                }
                state.tables[table].push(row); return [{ insertId: ID, affectedRows: 1 }];
            }
            const updated = sql.match(/^UPDATE `?([a-z_]+)`? SET (.+) WHERE ID=\?/);
            if (updated) {
                const row = state.tables[updated[1]].find(r => Number(r.ID) === values.at(-1));
                const columns = updated[2].split(',').map(s => s.trim().replace(/`|=\?/g, ''));
                for (const [index, column] of columns.entries()) row[column] = values[index];
                return [{ affectedRows: 1 }];
            }
            throw new Error(`Unexpected mutation: ${sql}`);
        }
    };
    return { connection, calls, readState: async () => structuredClone(state), state: () => structuredClone(state) };
}
test('full transaction becomes idempotent, with durable backup/receipt before commit', async () => {
    const { snapshot, state } = fixtures(), plan = buildScalePlan(snapshot, state, hash), db = memoryDatabase(state), events = [];
    const receipt = await applyScalePlan(db.connection, { snapshot, snapshotHash: hash, approvedPlan: plan, approvedPlanHash: hash,
        backupPath: 'unused', readState: db.readState, backup: async (_, saved) => { events.push('BACKUP'); assert.deepEqual(saved.state, state); return hash; },
        persistReceipt: async r => { events.push('RECEIPT'); assert.equal(r.transactionState, 'prepared-for-commit'); assert.ok(!db.calls.includes('COMMIT')); } });
    assert.deepEqual(events, ['BACKUP', 'RECEIPT']); assert.equal(receipt.transactionState, 'committed');
    const next = buildScalePlan(snapshot, db.state(), hash); assert.equal(next.canApply, true); assert.ok(next.rows.every(r => r.action === 'unchanged'));
    const example = db.state().tables.benchmark_results[0].benchmark_condition_snapshot;
    assert.equal(example.usesPercentageScale, true); assert.equal(typeof example.benchmarkID, 'number'); assert.equal(example.scoreDirection, 'higher');
    assert.ok(db.state().tables.benchmark_results.filter(r => r.status === 'archived').every(r => r.accepted_at));
});
test('stale plans and failed backups never execute mutations', async () => {
    for (const failure of ['stale', 'backup']) {
        const { snapshot, state } = fixtures(), plan = buildScalePlan(snapshot, state, hash);
        if (failure === 'stale') state.tables.models[0].notes = 'concurrent change';
        const db = memoryDatabase(state);
        await assert.rejects(() => applyScalePlan(db.connection, { snapshot, snapshotHash: hash, approvedPlan: plan, approvedPlanHash: hash,
            backupPath: 'unused', readState: db.readState, backup: async () => { throw new Error('backup failed'); }, persistReceipt: async () => {} }));
        assert.ok(!db.calls.some(sql => /^(INSERT|UPDATE)/.test(sql))); assert.ok(db.calls.includes('ROLLBACK'));
    }
});
test('receipt persistence failure rolls all mutations back', async () => {
    const { snapshot, state } = fixtures(), plan = buildScalePlan(snapshot, state, hash), db = memoryDatabase(state);
    await assert.rejects(() => applyScalePlan(db.connection, { snapshot, snapshotHash: hash, approvedPlan: plan, approvedPlanHash: hash,
        backupPath: 'unused', readState: db.readState, backup: async () => hash, persistReceipt: async () => { throw new Error('disk full'); } }), /disk full/);
    assert.deepEqual(db.state(), state); assert.ok(!db.calls.includes('COMMIT'));
});
