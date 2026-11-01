import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ARC_SOURCES, absoluteSourceURL, collectArcOfficial, fractionToPercent,
    normalizeArcSource, parseSourceJSON, sha256 } from '../scripts/collect-arc-official.mjs';
import { ARC_EXPORT_COLUMNS, SOURCE_TITLE, applyArcPlan, buildArcPlan, buildArcRollbackPlan, durableBackup,
    exportReadOnlySQL, fitsRawScore, loadArcSnapshot, normalizeDatabaseTables, objectHash,
    projectionSQL, quantizePercent, readDatabaseState, rollbackArcImport, verifyArcImport } from '../scripts/import-arc-official.mjs';
import { remoteModuleProgram, reviewedSSHMain } from '../scripts/reviewed-arc-ssh-apply.mjs';

const artifacts = fileURLToPath(new URL('../artifacts/arc-official-20261006/', import.meta.url));
const archivedInputs = (...paths) => ({ skip: paths.every(path => existsSync(resolve(artifacts, path)))
    ? false : 'Private historical audit inputs are not included in the source repository' });
const reviewedInputs = ['snapshot.json', 'canonical-read-v6/production-state.json', 'mapping-v6.json'];
const hashes = { snapshotHash: 'a'.repeat(64), mappingHash: 'b'.repeat(64) };
function sourceRow(overrides = {}) {
    return { datasetId: 'v1_Semi_Private', datasetDisplayName: 'ARC-AGI-1', modelId: 'fixture-high',
        modelDisplayName: 'Fixture (High)', modelType: 'CoT', modelGroup: 'fixture', modelReleaseDate: '2026-01-01T00:00:00Z',
        providerId: 'Fixture Provider', providerDisplayName: 'Fixture Provider', providerColor: '#000000',
        score: 0.5125, costPerTask: 0.025, resultsUrl: '/results/fixture', display: true, ...overrides };
}
function source(rows = [sourceRow()], version = 'v1', datasets = [{ id: `${version}_Semi_Private`, displayName: `ARC-AGI-${version.slice(1)}`, url: '' }]) {
    return normalizeArcSource(JSON.stringify({ version, generatedAt: '2026-10-01T12:00:00Z', datasets, evaluations: rows }),
        ARC_SOURCES.find(item => item.version === version));
}
function fixture() {
    const tables = Object.fromEntries(Object.keys(ARC_EXPORT_COLUMNS).map(table => [table, []]));
    tables.organizations = [{ ID: 1, slug: 'fixture-vendor', name: 'Fixture Vendor', is_active: 1, is_model_vendor: 1, introduction_url: null }];
    tables.models = [{ ID: 1, slug: 'fixture-model', name: 'Fixture', vendor_ID: 1, is_active: 1, introduction_url: null, notes: null }];
    tables.benchmarks = [{ ID: 1, name: 'ARC-AGI-1', introduction_url: 'https://arcprize.org/arc-agi/1', is_active: 1,
        scores_updated_at: '2026-10-01 12:00:00.123000' }];
    tables.benchmark_conditions = [{ ID: 1, benchmark_ID: 1, condition_key: 'semi-private-v1', name: 'Verified semi-private',
        score_direction: 'higher', target_value: null, uses_percentage_scale: 1, score_min: null, score_max: null,
        is_default: 0, is_primary: 1, deleted_at: null, score_source: null, difference_explanation: null }];
    tables.score_fields = [
        { ID: 19, name: 'Reasoning budget tokens', name_key: 'reasoning budget tokens', field_type: 'number', allow_empty: 0, exclude_missing: 1, exclude_empty: 0, is_active: 1, revision: 1 },
        { ID: 20, name: 'Reasoning effort', name_key: 'reasoning effort', field_type: 'enum', allow_empty: 0, exclude_missing: 1, exclude_empty: 0, is_active: 1, revision: 1 }
    ];
    tables.score_field_options = [{ ID: 3, field_ID: 20, label: 'high', label_key: 'high', is_active: 1, excluded: 0, revision: 1 }];
    tables.columns = Object.entries(ARC_EXPORT_COLUMNS).flatMap(([table, columns]) => columns.map(column => ({ table, column,
        type: column === 'raw_score' ? 'decimal(18,6)' : column === 'scores_updated_at' ? 'datetime(3)'
            : ['score_fields', 'benchmark_condition_snapshot'].includes(column) ? 'json' : 'varchar(2048)',
        nullable: 'YES', scale: column === 'raw_score' ? 6 : null, precision: column === 'raw_score' ? 18 : null })));
    tables.engines = Object.keys(ARC_EXPORT_COLUMNS).map(table => ({ table, engine: 'InnoDB' }));
    const snapshot = { schemaVersion: 1, publisher: 'ARC Prize', fetchedAt: '2026-10-06T00:00:00Z', sources: [source()] };
    const entry = snapshot.sources[0].entries[0];
    const mapping = { schemaVersion: 1, snapshotHash: hashes.snapshotHash,
        datasets: [{ sourceVersion: 'v1', datasetId: 'v1_Semi_Private', benchmarkID: 1, benchmarkName: 'ARC-AGI-1',
            conditionID: 1, conditionKey: 'semi-private-v1', conditionName: 'Verified semi-private', evidence: ['https://arcprize.org/policy'] }],
        identities: [{ providerId: 'Fixture Provider', sourceModelIds: ['fixture-high'], modelSlug: 'fixture-model',
            expectedName: 'Fixture', vendorSlug: 'fixture-vendor', evidence: [entry.evidencePointer] }],
        runs: [{ recordID: entry.recordID, fields: [{ fieldID: 20, value: 3 }], evidence: [entry.evidencePointer] }],
        expectedFields: { 19: { name: 'Reasoning budget tokens', type: 'number' },
            20: { name: 'Reasoning effort', type: 'enum', options: { 3: 'high' } } }, newModels: [], newOrganizations: [] };
    return { snapshot, state: { schemaVersion: 1, capturedAt: '2026-10-06T00:00:00Z', tables }, mapping };
}
const planFor = fixture => buildArcPlan(fixture.snapshot, fixture.state, fixture.mapping, hashes);
function storedResult(f, overrides = {}) {
    const planned = planFor(f).rows[0];
    return { ID: 41, model_ID: 1, benchmark_ID: 1, benchmark_condition_ID: 1, raw_score: '51.250000',
        source_url: planned.sourceURL, source_type: 'third_party_lab', source_title: SOURCE_TITLE,
        benchmark_condition_snapshot: planned.conditionSnapshot, status: 'accepted', notes: JSON.stringify(planned.evidence),
        score_fields: planned.fields, submitted_by: null, moderation_log_ID: null,
        accepted_at: '2026-10-06 00:00:00.000000', created_at: '2026-10-06 00:00:00.000000', updated_at: '2026-10-06 00:00:00.000000', ...overrides };
}
function memoryDatabase(state) {
    let committed = structuredClone(state), transaction = null;
    const calls = [], db = {
        calls,
        async query(sql) {
            calls.push(sql);
            if (sql.includes('GET_LOCK')) return [[{ acquired: 1 }]];
            return [[]];
        },
        async beginTransaction() { calls.push('BEGIN'); transaction = structuredClone(committed); },
        async rollback() { calls.push('ROLLBACK'); transaction = null; },
        async commit() { calls.push('COMMIT'); committed = transaction; transaction = null; },
        async readState() { return structuredClone(transaction ?? committed); },
        async execute(sql, values) {
            calls.push(sql);
            assert.ok(transaction, 'all mutations require a transaction');
            const tables = transaction.tables;
            if (sql.startsWith('INSERT INTO organizations')) {
                const ID = Math.max(0, ...tables.organizations.map(row => row.ID)) + 1;
                tables.organizations.push({ ID, slug: values[0], name: values[1], is_model_vendor: 1, is_active: 1, introduction_url: values[2] });
                return [{ insertId: ID }];
            }
            if (sql.startsWith('INSERT INTO models')) {
                const ID = Math.max(0, ...tables.models.map(row => row.ID)) + 1;
                tables.models.push({ ID, vendor_ID: values[0], slug: values[1], name: values[2], is_active: 1, introduction_url: values[3], notes: values[4] });
                return [{ insertId: ID }];
            }
            if (sql.startsWith('UPDATE benchmarks SET scores_updated_at')) {
                const isRestore = !sql.includes('UTC_TIMESTAMP(3)'), ID = values[isRestore ? 1 : 0];
                const row = tables.benchmarks.find(row => row.ID === ID && row.scores_updated_at === values[isRestore ? 2 : 1]);
                if (!row) return [{ affectedRows: 0 }];
                row.scores_updated_at = isRestore ? values[0] : '2026-10-06 12:34:56.789000';
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('UPDATE benchmark_results SET notes')) {
                const isRestore = sql.includes('updated_at = ?');
                const row = tables.benchmark_results.find(row => row.ID === values[isRestore ? 4 : 2]
                    && (isRestore || row.status === 'accepted'));
                if (!row) return [{ affectedRows: 0 }];
                row.notes = values[0]; row.score_fields = JSON.parse(values[1]);
                if (isRestore) { row.status = values[2]; row.updated_at = values[3]; }
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('UPDATE benchmark_results SET status')) {
                const row = tables.benchmark_results.find(row => row.ID === values[0] && row.status === 'accepted');
                if (!row) return [{ affectedRows: 0 }];
                row.status = sql.includes("'archived'") ? 'archived' : 'superseded'; return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('INSERT INTO benchmark_results')) {
                const ID = Math.max(0, ...tables.benchmark_results.map(row => row.ID)) + 1;
                tables.benchmark_results.push({ ID, model_ID: values[0], benchmark_ID: values[1], benchmark_condition_ID: values[2], raw_score: values[3],
                    source_url: values[4], source_type: 'third_party_lab', source_title: values[5], benchmark_condition_snapshot: JSON.parse(values[6]),
                    status: 'accepted', notes: values[7], score_fields: JSON.parse(values[8]) });
                return [{ insertId: ID }];
            }
            throw new Error(`Unexpected mutation: ${sql}`);
        }
    };
    return db;
}
async function temporary(t) {
    const prefix = resolve(tmpdir(), 'benchpoll-arc-test-');
    const path = await mkdtemp(prefix);
    t.after(async () => { assert.ok(path.startsWith(prefix)); await rm(path, { recursive: true, force: true }); });
    return path;
}
function applyOptions(f, approvedPlan, backupPath, overrides = {}) {
    return { snapshot: f.snapshot, mapping: f.mapping, hashes, approvedPlan, approvedPlanHash: objectHash(approvedPlan), backupPath, ...overrides };
}

test('JSON numeric lexemes survive without IEEE-754 truncation', () => {
    const parsed = parseSourceJSON('{"score":0.123456789012345678901,"cost":1.234567890123456789,"display":true}');
    assert.equal(parsed.score, '0.123456789012345678901');
    assert.equal(parsed.cost, '1.234567890123456789');
    assert.equal(parsed.display, true);
    assert.equal(fractionToPercent(parsed.score), '12.3456789012345678901');
});

test('fraction conversion is exact for decimals, exponents and boundaries', () => {
    for (const [fraction, percent] of [['0', '0'], ['1', '100'], ['0.6083', '60.83'],
        ['0.3333333333333333', '33.33333333333333'], ['1e-8', '0.000001'], ['5.125e-1', '51.25']]) {
        assert.equal(fractionToPercent(fraction), percent);
    }
    for (const value of ['-0.01', '1.001', null, 0.5, 'NaN']) assert.throws(() => fractionToPercent(value));
});

test('relative result URLs resolve against the publisher origin; unsafe URLs fail', () => {
    assert.equal(absoluteSourceURL('/results/model'), 'https://arcprize.org/results/model');
    assert.equal(absoluteSourceURL('results/model'), 'https://arcprize.org/results/model');
    assert.equal(absoluteSourceURL(''), null);
    assert.throws(() => absoluteSourceURL('javascript:alert(1)'));
    assert.throws(() => absoluteSourceURL('https://user:password@example.com/'));
});

test('all displayed algorithm points are collected, including false/absent labels and zero', () => {
    const rows = [sourceRow({ displayLabel: false, score: 0 }), sourceRow({ modelId: 'custom', modelType: 'Custom', modelGroup: 'Kaggle' }),
        sourceRow({ modelId: 'human', providerId: 'Human', modelGroup: 'Human' }), sourceRow({ modelId: 'hidden', display: false })];
    const result = source(rows);
    assert.equal(result.entries.length, 2);
    assert.equal(result.entries[0].scorePercent, '0');
    assert.equal(result.entries[1].modelType, 'Custom');
    assert.deepEqual(result.excluded.map(row => row.reason), ['human reference', 'display=false']);
    assert.equal(result.entries[0].costPerTaskUSD, '0.025');
    assert.equal(result.entries[0].sourceRecord.costPerTask, '0.025');
    assert.equal(result.entries[0].tokenusage, undefined);
});

test('dataset/version mismatch is a hard error', () => {
    assert.throws(() => source([sourceRow({ datasetId: 'v2_Semi_Private' })]), /dataset/);
    assert.throws(() => normalizeArcSource(JSON.stringify({ version: 'v2', datasets: [], evaluations: [] }), ARC_SOURCES[0]), /schema/);
    assert.throws(() => source([sourceRow()], 'v1', [{ id: 'v1_Semi_Private', displayName: 'ARC-AGI-2', url: '' }]), /dataset/);
});

test('exact duplicate source points are retained and later coalesced', () => {
    const f = fixture(); f.snapshot.sources = [source([sourceRow(), sourceRow()])];
    const duplicate = f.snapshot.sources[0].entries[1];
    f.mapping.runs.push({ ...f.mapping.runs[0], recordID: duplicate.recordID });
    const plan = planFor(f);
    assert.equal(plan.rows.length, 2);
    assert.equal(plan.counts.actions.insert, 1);
    assert.equal(plan.counts.actions.source_duplicate, 1);
    assert.equal(duplicate.duplicateOf, plan.rows[0].recordID);
});

test('conflicting repeated source model IDs do not silently overwrite', () => {
    const f = fixture(); f.snapshot.sources = [source([sourceRow(), sourceRow({ score: 0.9 })])];
    f.mapping.runs.push({ ...f.mapping.runs[0], recordID: f.snapshot.sources[0].entries[1].recordID });
    const plan = planFor(f);
    assert.equal(plan.canApply, false);
    assert.ok(plan.blockers.some(issue => issue.code === 'source_identity_collision'));
});

test('real raw evidence accounts for all 510 evaluations, 11 unlabelled and one duplicate', archivedInputs('snapshot.json'), async () => {
    const { snapshot } = await loadArcSnapshot(resolve(artifacts, 'snapshot.json'));
    assert.deepEqual(snapshot.sources.map(item => item.entries.length), [253, 257]);
    const rows = snapshot.sources.flatMap(item => item.entries);
    assert.equal(rows.filter(row => row.displayLabel === false).length, 11);
    assert.equal(rows.filter(row => row.duplicateOf).length, 1);
    assert.equal(rows.filter(row => row.providerId === 'Human').length, 0);
    assert.equal(rows.some(row => row.modelType === 'Custom'), true);
    assert.equal(rows.some(row => row.modelType === 'Refinement'), true);
    assert.equal(rows.filter(row => quantizePercent(row.scorePercent).changed).length, 95);
});

test('collector archives raw sources and importer rejects derived snapshot tampering', async t => {
    const path = await temporary(t), output = resolve(path, 'snapshot.json');
    await collectArcOfficial(output, async url => {
        const version = url.includes('v1.json') ? 'v1' : 'v2';
        return JSON.stringify({ version, generatedAt: '2026-10-01T12:00:00Z',
            datasets: [{ id: `${version}_Semi_Private`, displayName: `ARC-AGI-${version.slice(1)}`, url: '' }],
            evaluations: [sourceRow({ datasetId: `${version}_Semi_Private`, datasetDisplayName: `ARC-AGI-${version.slice(1)}` })] });
    });
    const { snapshot } = await loadArcSnapshot(output);
    snapshot.sources[0].entries[0].scorePercent = '99';
    await writeFile(output, JSON.stringify(snapshot), 'utf8');
    await assert.rejects(loadArcSnapshot(output), /raw official/);
});

test('six-place quantization preserves the entire fraction, exact percent and signed difference', () => {
    const f = fixture(); f.snapshot.sources = [source([sourceRow({ score: 0.3333333333333333 })])];
    const plan = planFor(f);
    assert.equal(plan.canApply, true);
    assert.equal(plan.rows[0].scorePercent, '33.33333333333333');
    assert.equal(plan.rows[0].evidence.arc_score_fraction, '0.3333333333333333');
    assert.equal(plan.rows[0].evidence.arc_score_percent_exact, '33.33333333333333');
    assert.deepEqual(plan.rows[0].evidence.arc_score_quantization, quantizePercent('33.33333333333333'));
    assert.equal(plan.rows[0].quantization.storedPercent, '33.333333');
    assert.equal(plan.rows[0].quantization.difference, '-0.00000033333333');
    assert.equal(plan.counts.quantized, 1);
    assert.equal(fitsRawScore('51.25', { type: 'decimal(18,6)', scale: 6, precision: 18 }), true);
    assert.equal(fitsRawScore('51.1234567', { type: 'decimal(18,6)', scale: 6, precision: 18 }), false);
});

test('round half up uses decimal arithmetic for ties, carry, tiny values and boundaries', () => {
    for (const [input, stored, difference] of [['0', '0.000000', '0'], ['100', '100.000000', '0'],
        ['0.0000005', '0.000001', '0.0000005'], ['0.000000499999999', '0.000000', '-0.000000499999999'],
        ['99.9999995', '100.000000', '0.0000005'], ['33.33333333333333', '33.333333', '-0.00000033333333'],
        ['66.66666666666666', '66.666667', '0.00000033333334'], ['51.25', '51.250000', '0']]) {
        const result = quantizePercent(input);
        assert.equal(result.storedPercent, stored); assert.equal(result.difference, difference);
        assert.equal(result.rule, 'ROUND_HALF_UP'); assert.equal(result.decimalPlaces, 6);
    }
    assert.throws(() => quantizePercent('-0.1')); assert.throws(() => quantizePercent('100.1'));
    const f = fixture(); f.state.tables.columns.find(row => row.column === 'raw_score').type = 'decimal(18,5)';
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'raw_score_storage_contract_changed'));
});

test('each official dataset needs its own explicit benchmark condition', () => {
    const f = fixture(), second = sourceRow({ datasetId: 'v1_Public', modelId: 'fixture-public' });
    f.snapshot.sources = [source([sourceRow(), second], 'v1', [
        { id: 'v1_Semi_Private', displayName: 'ARC-AGI-1', url: '' }, { id: 'v1_Public', displayName: 'ARC-AGI-1', url: '' }
    ])];
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'dataset_mapping_required'));
    f.mapping.datasets.push({ ...f.mapping.datasets[0], datasetId: 'v1_Public' });
    assert.throws(() => planFor(f), /must not share/);
});

test('primary condition invariant and dataset target contracts are checked', () => {
    const f = fixture(); f.state.tables.benchmark_conditions[0].is_primary = 0;
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'primary_condition_invariant'));
    f.state.tables.benchmark_conditions[0].is_primary = 1;
    f.state.tables.benchmark_conditions[0].uses_percentage_scale = 0;
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'dataset_target_contract_changed'));
});

test('model/provider mismatches are unresolved, never guessed from display name', () => {
    const f = fixture(); f.mapping.identities[0].providerId = 'Other Provider';
    assert.throws(() => planFor(f), /nonexistent evidence/);
    f.mapping.identities = [];
    const plan = planFor(f);
    assert.equal(plan.unresolvedIdentities.length, 1);
    assert.equal(plan.rows[0].modelID, null);
});

test('inactive model, wrong vendor and duplicate mappings are hard failures', () => {
    const f = fixture(); f.state.tables.models[0].is_active = 0;
    assert.throws(() => planFor(f), /Mapped identity differs/);
    f.state.tables.models[0].is_active = 1; f.state.tables.models[0].vendor_ID = 2;
    assert.throws(() => planFor(f), /Mapped identity differs/);
    f.state.tables.models[0].vendor_ID = 1;
    f.mapping.identities.push(structuredClone(f.mapping.identities[0]));
    assert.throws(() => planFor(f), /Duplicate explicit identity/);
});

test('same vendor/name under a new slug is not accepted as a new model', () => {
    const f = fixture();
    f.mapping.newModels.push({ slug: 'duplicate-fixture', name: 'Fixture', vendorSlug: 'fixture-vendor', evidenceURL: 'https://arcprize.org/leaderboard' });
    assert.throws(() => planFor(f), /already exists under another slug/);
});

test('configuration fields use exact ID/type/option contracts and canonical numeric strings', () => {
    const f = fixture(); f.mapping.runs[0].fields.unshift({ fieldID: 19, value: '1.024e3' });
    assert.deepEqual(planFor(f).rows[0].fields, [{ fieldID: 19, value: '1024e0' }, { fieldID: 20, value: 3 }]);
    f.mapping.expectedFields[20].options[3] = 'low';
    assert.throws(() => planFor(f), /Enum option contract/);
});

test('identical runtime configurations cannot be disguised as two different model IDs', () => {
    const f = fixture(); f.snapshot.sources = [source([sourceRow(), sourceRow({ modelId: 'fixture-alias' })])];
    f.mapping.identities[0].sourceModelIds.push('fixture-alias');
    f.mapping.runs.push({ ...f.mapping.runs[0], recordID: f.snapshot.sources[0].entries[1].recordID });
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'source_configuration_collision'));
});

test('audited imports are unchanged only when identity, dataset, fields, URL and exact fraction match', () => {
    const f = fixture(); f.state.tables.benchmark_results.push(storedResult(f));
    assert.equal(planFor(f).rows[0].action, 'unchanged');
    f.state.tables.benchmark_results[0].source_url = 'https://other.example/';
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'existing_import_identity_changed'));
});

test('duplicate accepted import keys and archived imports block apply', () => {
    const f = fixture(), row = storedResult(f);
    f.state.tables.benchmark_results.push(row, { ...row, ID: 42 });
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'existing_import_status_conflict'));
    f.state.tables.benchmark_results = [{ ...row, status: 'archived' }];
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'existing_import_status_conflict'));
});

test('exact existing scores are adopted, while ambiguous official overlaps are listed', () => {
    const f = fixture(), row = storedResult(f, { source_title: 'Earlier evidence', notes: 'original free text' });
    f.state.tables.benchmark_results.push(row);
    assert.equal(planFor(f).rows[0].action, 'adopt');
    row.score_fields = [];
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'legacy_official_score_overlap'));
    f.mapping.existingScoreResolutions = [{ resultID: 41, recordIDs: [f.mapping.runs[0].recordID], classification: 'distinct_run',
        expectedRowHash: objectHash(row), evidence: ['explicit reviewed distinct run evidence'] }];
    assert.equal(planFor(f).rows[0].action, 'insert');
    row.raw_score = '50';
    assert.ok(planFor(f).blockers.some(issue => issue.code === 'legacy_official_score_overlap'));
});

test('equal numbers from a different source are not silently adopted as official evidence', () => {
    const f = fixture(); f.state.tables.benchmark_results.push(storedResult(f,
        { source_url: 'https://independent.example/results', source_title: 'Independent source', notes: null }));
    assert.equal(planFor(f).rows[0].action, 'insert');
});

test('same-run field enrichment requires explicit source, row hash and evidence', async t => {
    const path = await temporary(t), f = fixture();
    const row = storedResult(f, { source_title: 'Earlier official evidence', notes: 'old evidence', score_fields: [] });
    f.state.tables.benchmark_results.push(row);
    assert.equal(planFor(f).canApply, false);
    f.mapping.existingScoreResolutions = [{ resultID: 41, recordIDs: [f.mapping.runs[0].recordID],
        classification: 'same_run', expectedRowHash: objectHash(row), evidence: ['native ID in original evidence verified'] }];
    const approved = planFor(f); assert.equal(approved.rows[0].action, 'adopt');
    const db = memoryDatabase(f.state);
    await applyArcPlan(db, applyOptions(f, approved, resolve(path, 'backup.json'), { readState: db.readState }));
    const stored = (await db.readState()).tables.benchmark_results[0];
    assert.deepEqual(stored.score_fields, approved.rows[0].fields);
    assert.deepEqual(JSON.parse(stored.notes).arc_previous_score_fields, []);
    assert.equal(JSON.parse(stored.notes).previous_notes, 'old evidence');
    row.source_url = 'https://other.example/results';
    assert.equal(planFor(f).rows[0].action, 'insert');
});

test('fetch date is audit metadata, never benchmark identity or runtime fields', () => {
    const f = fixture(), before = planFor(f);
    f.snapshot.fetchedAt = '2026-10-07T00:00:00Z';
    const after = planFor(f);
    assert.deepEqual(before.datasets, after.datasets);
    assert.deepEqual(before.rows[0].fields, after.rows[0].fields);
    assert.equal(before.intentHash, after.intentHash);
    assert.notEqual(before.rows[0].evidence.source_fetched_at, after.rows[0].evidence.source_fetched_at);
});

test('SSH export contains only SELECT and read-only transaction controls', () => {
    const sql = exportReadOnlySQL();
    assert.match(sql, /WITH CONSISTENT SNAPSHOT, READ ONLY/);
    assert.doesNotMatch(sql, /\b(CREATE|ALTER|DROP|INSERT|UPDATE|DELETE|INTO OUTFILE|LOAD DATA)\b/i);
    assert.match(sql, /CAST\(raw_score AS CHAR\)/);
    assert.doesNotMatch(sql, /users|password|credentials|app_sessions/i);
    assert.match(sql, /DATE_FORMAT\(`accepted_at`, '%Y-%m-%d %H:%i:%s.%f'\)/);
    assert.match(sql, /DATE_FORMAT\(`scores_updated_at`, '%Y-%m-%d %H:%i:%s.%f'\)/);
});

test('SQL JSON export and direct driver use the same date projections and JSON shapes', async () => {
    const f = fixture(), row = storedResult(f, { accepted_at: '2026-10-06 01:02:03.000000',
        created_at: '2026-10-06 01:02:03.123456', updated_at: '2026-10-06 01:02:03.000000' });
    f.state.tables.benchmark_results.push(row);
    const offline = normalizeDatabaseTables(structuredClone(f.state.tables));
    const sql = [];
    const connection = { async query(statement) {
        sql.push(statement);
        if (statement.includes('information_schema.COLUMNS')) return [f.state.tables.columns];
        if (statement.includes('information_schema.TABLES')) return [f.state.tables.engines];
        const table = /FROM `([^`]+)`/.exec(statement)[1];
        return [structuredClone(f.state.tables[table])];
    } };
    const direct = await readDatabaseState(connection);
    assert.equal(objectHash(direct.tables), objectHash(offline));
    assert.ok(sql.some(value => value.includes(projectionSQL('benchmark_conditions', 'deleted_at'))));
    assert.ok(sql.some(value => value.includes(projectionSQL('benchmark_results', 'updated_at'))));
    assert.ok(sql.some(value => value.includes(projectionSQL('benchmarks', 'scores_updated_at'))));
    assert.equal(typeof direct.tables.benchmark_results[0].score_fields, 'object');
    row.updated_at = '2026-10-06 01:02:03';
    assert.throws(() => normalizeDatabaseTables(f.state.tables), /Noncanonical database date/);
});

test('durable backup is hashed, complete, verified and never overwritten', async t => {
    const path = await temporary(t), f = fixture(), backupPath = resolve(path, 'backup.json');
    const hash = await durableBackup(backupPath, f.state, 'c'.repeat(64));
    const result = JSON.parse(await readFile(backupPath, 'utf8'));
    assert.equal(hash, result.sha256);
    assert.deepEqual(result.state.tables, f.state.tables);
    await assert.rejects(durableBackup(backupPath, f.state, 'c'.repeat(64)), { code: 'EEXIST' });
});

test('transactional apply backs up before writes and a rerun inserts nothing', async t => {
    const path = await temporary(t), f = fixture(), approved = planFor(f), db = memoryDatabase(f.state);
    let backups = 0;
    const backup = async (...args) => { backups++; assert.equal(db.calls.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE')), false); return durableBackup(...args); };
    const options = applyOptions(f, approved, resolve(path, 'backup.json'), { readState: db.readState, backup });
    const result = await applyArcPlan(db, options);
    assert.equal(result.applied, true);
    assert.equal(result.receipt.length, 1);
    assert.equal(backups, 1);
    assert.equal((await db.readState()).tables.benchmark_results[0].raw_score, '51.250000');
    const rerun = await applyArcPlan(db, options);
    assert.equal(rerun.idempotent, true);
    assert.equal(backups, 1);
    assert.equal((await db.readState()).tables.benchmark_results.length, 1);
});

test('dry-run schedules score-update timestamps only for benchmarks with actual changes', () => {
    const f = fixture();
    f.state.tables.benchmarks.push({ ...f.state.tables.benchmarks[0], ID: 2, name: 'ARC-AGI-2', scores_updated_at: null });
    const pending = planFor(f);
    assert.deepEqual(pending.benchmarkTimestampUpdates.map(row => [row.benchmarkID, row.before]),
        [[1, '2026-10-01 12:00:00.123000']]);
    assert.match(pending.benchmarkTimestampUpdates[0].afterRule, /UTC_TIMESTAMP\(3\).*not fetchedAt/);
    f.state.tables.benchmark_results.push(storedResult(f));
    assert.deepEqual(planFor(f).benchmarkTimestampUpdates, []);
    delete f.state.tables.benchmarks[0].scores_updated_at;
    assert.throws(() => planFor(f), /Missing\/noncanonical benchmark score-update timestamp/);
});

test('apply receipts preserve exact benchmark timestamps and idempotent replay does not touch them', async t => {
    const path = await temporary(t), f = fixture();
    f.state.tables.benchmarks.push({ ...f.state.tables.benchmarks[0], ID: 2, name: 'ARC-AGI-2', scores_updated_at: null });
    const approved = planFor(f), db = memoryDatabase(f.state), options = applyOptions(f, approved, resolve(path, 'backup.json'), {
        readState: db.readState, persistReceipt: async receipt => {
            assert.equal(db.calls.includes('COMMIT'), false);
            assert.deepEqual(receipt.benchmarkMutations, [{ benchmarkID: 1,
                before: '2026-10-01 12:00:00.123000', after: '2026-10-06 12:34:56.789000' }]);
        }
    });
    const receipt = await applyArcPlan(db, options), after = await db.readState();
    const backup = JSON.parse(await readFile(options.backupPath, 'utf8'));
    assert.deepEqual(backup.state.tables.benchmarks, f.state.tables.benchmarks);
    assert.equal(after.tables.benchmarks[1].scores_updated_at, null);
    assert.equal(after.tables.benchmarks[0].scores_updated_at, receipt.benchmarkMutations[0].after);
    const writes = () => db.calls.filter(sql => sql.startsWith('UPDATE benchmarks')).length;
    assert.equal(writes(), 1);
    assert.ok(db.calls.findIndex(sql => sql.startsWith('INSERT INTO benchmark_results'))
        < db.calls.findIndex(sql => sql.startsWith('UPDATE benchmarks')));
    assert.equal((await applyArcPlan(db, options)).idempotent, true);
    assert.equal(writes(), 1);
    assert.deepEqual((await db.readState()).tables.benchmarks, after.tables.benchmarks);
});

test('timestamp update guard failure rolls back all score mutations', async t => {
    const path = await temporary(t), f = fixture(), db = memoryDatabase(f.state), execute = db.execute;
    db.execute = async (sql, values) => sql.startsWith('UPDATE benchmarks') ? [{ affectedRows: 0 }] : execute(sql, values);
    await assert.rejects(applyArcPlan(db, applyOptions(f, planFor(f), resolve(path, 'backup.json'), { readState: db.readState })),
        /Benchmark score-update timestamp changed/);
    assert.equal(db.calls.includes('COMMIT'), false);
    assert.deepEqual((await db.readState()).tables, f.state.tables);
});

test('timestamp drift after dry-run is rejected before backup or writes', async () => {
    const f = fixture(), approved = planFor(f);
    f.state.tables.benchmarks[0].scores_updated_at = '2026-10-05 12:00:00.123000';
    const db = memoryDatabase(f.state);
    await assert.rejects(applyArcPlan(db, applyOptions(f, approved, '/unused', { readState: db.readState,
        backup: () => { throw new Error('backup must not be called'); } })), /Database changed/);
    assert.equal(db.calls.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE')), false);
});

test('changed ARC1 and ARC2 benchmarks each get one clock update and exact rollback restoration', async t => {
    const path = await temporary(t), f = fixture();
    f.state.tables.benchmarks.push({ ...f.state.tables.benchmarks[0], ID: 2, name: 'ARC-AGI-2', scores_updated_at: null });
    f.state.tables.benchmark_conditions.push({ ...f.state.tables.benchmark_conditions[0], ID: 2,
        benchmark_ID: 2, condition_key: 'semi-private-v2' });
    f.snapshot.sources.push(source([sourceRow({ datasetId: 'v2_Semi_Private', datasetDisplayName: 'ARC-AGI-2', score: 0.6 })], 'v2'));
    f.mapping.datasets.push({ ...f.mapping.datasets[0], sourceVersion: 'v2', datasetId: 'v2_Semi_Private',
        benchmarkID: 2, benchmarkName: 'ARC-AGI-2', conditionID: 2, conditionKey: 'semi-private-v2' });
    f.mapping.runs.push({ ...f.mapping.runs[0], recordID: f.snapshot.sources[1].entries[0].recordID });
    const db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    assert.deepEqual(receipt.benchmarkMutations, [
        { benchmarkID: 1, before: '2026-10-01 12:00:00.123000', after: '2026-10-06 12:34:56.789000' },
        { benchmarkID: 2, before: null, after: '2026-10-06 12:34:56.789000' }
    ]);
    assert.equal(db.calls.filter(sql => sql.startsWith('UPDATE benchmarks')).length, 2);
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8'));
    const rollbackHashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(await db.readState(), savedBackup, receipt, rollbackHashes);
    await rollbackArcImport(db, { savedBackup, receipt, hashes: rollbackHashes, approvedPlan,
        approvedPlanHash: objectHash(approvedPlan), backupPath: resolve(path, 'rollback-backup.json'), readState: db.readState });
    assert.deepEqual((await db.readState()).tables.benchmarks, f.state.tables.benchmarks);
});

test('post-write verification rejects any unrelated benchmark clock change', async t => {
    const path = await temporary(t), f = fixture();
    f.state.tables.benchmarks.push({ ...f.state.tables.benchmarks[0], ID: 2, name: 'ARC-AGI-2', scores_updated_at: null });
    const db = memoryDatabase(f.state); let reads = 0;
    const readState = async () => {
        const state = await db.readState();
        if (++reads > 1) state.tables.benchmarks[1].scores_updated_at = '2026-10-06 12:34:56.789000';
        return state;
    };
    await assert.rejects(applyArcPlan(db, applyOptions(f, planFor(f), resolve(path, 'backup.json'), { readState })),
        /benchmark timestamp scope verification failed/);
    assert.deepEqual((await db.readState()).tables, f.state.tables);
});

test('quantized score is stored with full audit notes and an idempotent second apply', async t => {
    const path = await temporary(t), f = fixture(); f.snapshot.sources = [source([sourceRow({ score: 0.6666666666666666 })])];
    const approved = planFor(f), db = memoryDatabase(f.state), options = applyOptions(f, approved, resolve(path, 'backup.json'), { readState: db.readState });
    await applyArcPlan(db, options);
    const row = (await db.readState()).tables.benchmark_results[0], notes = JSON.parse(row.notes);
    assert.equal(row.raw_score, '66.666667');
    assert.equal(notes.arc_score_fraction, '0.6666666666666666');
    assert.equal(notes.arc_score_percent_exact, '66.66666666666666');
    assert.equal(notes.arc_score_quantization.difference, '0.00000033333334');
    assert.equal((await applyArcPlan(db, options)).idempotent, true);
    assert.equal(verifyArcImport(f.snapshot, await db.readState(), f.mapping, hashes).verified, true);
});

test('verify is read-only and requires every selected point to be accounted for', () => {
    const f = fixture();
    assert.equal(verifyArcImport(f.snapshot, f.state, f.mapping, hashes).verified, false);
    f.state.tables.benchmark_results.push(storedResult(f));
    assert.equal(verifyArcImport(f.snapshot, f.state, f.mapping, hashes).verified, true);
    const notes = JSON.parse(f.state.tables.benchmark_results[0].notes); delete notes.arc_score_quantization;
    f.state.tables.benchmark_results[0].notes = JSON.stringify(notes);
    assert.equal(verifyArcImport(f.snapshot, f.state, f.mapping, hashes).verified, false);
});

test('receipt is persisted before commit; a receipt disk failure rolls back the transaction', async t => {
    const path = await temporary(t), f = fixture(), db = memoryDatabase(f.state);
    await assert.rejects(applyArcPlan(db, applyOptions(f, planFor(f), resolve(path, 'backup.json'), {
        readState: db.readState, persistReceipt: async receipt => {
            assert.equal(receipt.transactionState, 'prepared-for-commit');
            assert.equal(db.calls.includes('COMMIT'), false); throw new Error('receipt disk full');
        }
    })), /receipt disk full/);
    assert.deepEqual((await db.readState()).tables, f.state.tables);
});

test('adoption preserves all existing source fields and free-text notes', async t => {
    const path = await temporary(t), f = fixture();
    f.state.tables.benchmark_results.push(storedResult(f, { source_title: 'Earlier evidence', notes: 'original evidence text' }));
    const approved = planFor(f), db = memoryDatabase(f.state);
    const receipt = await applyArcPlan(db, applyOptions(f, approved, resolve(path, 'backup.json'), { readState: db.readState }));
    const row = (await db.readState()).tables.benchmark_results[0], notes = JSON.parse(row.notes);
    assert.equal(row.source_title, 'Earlier evidence');
    assert.equal(row.raw_score, '51.250000');
    assert.equal(notes.previous_notes, 'original evidence text');
    assert.equal(notes.arc_score_fraction, '0.5125');
    assert.deepEqual(receipt.benchmarkMutations.map(row => row.benchmarkID), [1]);
});

test('changed owned scores are superseded transactionally, not overwritten', async t => {
    const path = await temporary(t), f = fixture(), row = storedResult(f), notes = JSON.parse(row.notes);
    notes.arc_score_fraction = '0.5'; notes.arc_score_percent_exact = '50'; row.notes = JSON.stringify(notes); row.raw_score = '50.000000';
    f.state.tables.benchmark_results.push(row);
    const approved = planFor(f); assert.equal(approved.rows[0].action, 'supersede');
    const db = memoryDatabase(f.state);
    const receipt = await applyArcPlan(db, applyOptions(f, approved, resolve(path, 'backup.json'), { readState: db.readState }));
    const rows = (await db.readState()).tables.benchmark_results;
    assert.equal(rows.length, 2); assert.equal(rows[0].raw_score, '50.000000'); assert.equal(rows[0].status, 'superseded');
    assert.equal(rows[1].status, 'accepted');
    assert.deepEqual(receipt.benchmarkMutations.map(row => row.benchmarkID), [1]);
});

test('explicit new vendor/model creation is included in the backup and idempotent replay', async t => {
    const path = await temporary(t), f = fixture();
    f.mapping.newOrganizations.push({ slug: 'new-vendor', name: 'New Vendor', evidenceURL: 'https://arcprize.org/leaderboard' });
    f.mapping.newModels.push({ slug: 'new-model', name: 'New Model', vendorSlug: 'new-vendor', evidenceURL: 'https://arcprize.org/leaderboard' });
    Object.assign(f.mapping.identities[0], { modelSlug: 'new-model', expectedName: 'New Model', vendorSlug: 'new-vendor' });
    const approved = planFor(f), db = memoryDatabase(f.state), options = applyOptions(f, approved, resolve(path, 'backup.json'), { readState: db.readState });
    await applyArcPlan(db, options);
    const state = await db.readState();
    assert.equal(state.tables.models.length, 2); assert.equal(state.tables.organizations.length, 2);
    assert.equal(state.tables.benchmark_results[0].model_ID, 2);
    assert.equal((await applyArcPlan(db, options)).idempotent, true);
});

test('blocked review plans never open a transaction or acquire a write lock', async () => {
    const f = fixture(); f.mapping.identities = []; const approved = planFor(f), db = memoryDatabase(f.state);
    await assert.rejects(applyArcPlan(db, applyOptions(f, approved, '/unused', { readState: db.readState })), /unblocked reviewed/);
    assert.equal(db.calls.length, 0);
});

test('database drift after review is rejected before backup or mutations', async () => {
    const f = fixture(), approved = planFor(f); f.state.tables.models[0].notes = 'concurrent edit';
    const db = memoryDatabase(f.state);
    await assert.rejects(applyArcPlan(db, applyOptions(f, approved, '/unused', { readState: db.readState,
        backup: () => { throw new Error('backup must not be called'); } })), /Database changed/);
    assert.equal(db.calls.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE')), false);
});

test('backup failure rolls back before the first mutation', async () => {
    const f = fixture(), approved = planFor(f), db = memoryDatabase(f.state);
    await assert.rejects(applyArcPlan(db, applyOptions(f, approved, '/unused', { readState: db.readState,
        backup: async () => { throw new Error('disk full'); } })), /disk full/);
    assert.deepEqual((await db.readState()).tables, f.state.tables);
    assert.equal(db.calls.some(sql => sql.startsWith('INSERT') || sql.startsWith('UPDATE')), false);
});

test('post-write verification failure restores all transactional mutations', async t => {
    const path = await temporary(t), f = fixture(), approved = planFor(f), db = memoryDatabase(f.state); let reads = 0;
    const readState = async () => {
        const state = await db.readState(); if (++reads > 1) state.tables.benchmark_results[0].raw_score = '1'; return state;
    };
    await assert.rejects(applyArcPlan(db, applyOptions(f, approved, resolve(path, 'backup.json'), { readState })), /Post-write/);
    assert.deepEqual((await db.readState()).tables, f.state.tables);
});

test('approved input hashes gate apply even when no mutations would be needed', async () => {
    const f = fixture(); f.state.tables.benchmark_results.push(storedResult(f));
    const approved = planFor(f), db = memoryDatabase(f.state);
    await assert.rejects(applyArcPlan(db, applyOptions(f, approved, '/unused', { hashes: { ...hashes, mappingHash: sha256('changed') }, readState: db.readState })), /identical input hashes/);
});

test('missing/nontransactional schema is a hard failure with no permissive fallback', () => {
    const f = fixture(); f.state.tables.engines[0].engine = 'MyISAM';
    assert.throws(() => planFor(f), /Nontransactional/);
    f.state.tables.engines[0].engine = 'InnoDB'; f.state.tables.columns = f.state.tables.columns.filter(row => row.column !== 'score_fields');
    assert.throws(() => planFor(f), /Missing benchmark_results.score_fields/);
});

test('rollback archives only inserted rows, restores old evidence and is idempotent', async t => {
    const path = await temporary(t), f = fixture();
    const previous = storedResult(f), notes = JSON.parse(previous.notes);
    previous.raw_score = '50.000000'; notes.arc_score_fraction = '0.5'; previous.notes = JSON.stringify(notes);
    f.state.tables.benchmark_results.push(previous);
    const db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8'));
    const rollbackHashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(await db.readState(), savedBackup, receipt, rollbackHashes);
    assert.deepEqual(approvedPlan.counts, { restore: 1, archive: 1, unchanged: 0, blocked: 0 });
    assert.deepEqual(approvedPlan.benchmarkTimestampCounts, { restore: 1, unchanged: 0, blocked: 0 });
    const options = { savedBackup, receipt, hashes: rollbackHashes, approvedPlan, approvedPlanHash: objectHash(approvedPlan),
        backupPath: resolve(path, 'rollback-safety-backup.json'), readState: db.readState };
    const rollbackReceipt = await rollbackArcImport(db, options);
    assert.equal(rollbackReceipt.rolledBack, true);
    assert.deepEqual(rollbackReceipt.benchmarkMutations, [{ benchmarkID: 1,
        before: '2026-10-06 12:34:56.789000', after: '2026-10-01 12:00:00.123000' }]);
    const rows = (await db.readState()).tables.benchmark_results;
    assert.deepEqual(rows[0], previous); assert.equal(rows[1].status, 'archived');
    assert.deepEqual((await db.readState()).tables.benchmarks, f.state.tables.benchmarks);
    const timestampWrites = db.calls.filter(sql => sql.startsWith('UPDATE benchmarks')).length;
    assert.equal((await rollbackArcImport(db, options)).idempotent, true);
    assert.equal(db.calls.filter(sql => sql.startsWith('UPDATE benchmarks')).length, timestampWrites);
    assert.equal(db.calls.some(sql => /\bDELETE\b/.test(sql)), false);
});

test('rollback detects row drift, tampered backups and mismatching input hashes', async t => {
    const path = await temporary(t), f = fixture(), db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8')), state = await db.readState();
    const hashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(state, savedBackup, receipt, hashes);
    state.tables.benchmark_results[0].source_url = 'https://edited.example/';
    assert.equal(buildArcRollbackPlan(state, savedBackup, receipt, hashes).canApply, false);
    await assert.rejects(rollbackArcImport(db, { savedBackup, receipt, hashes: { ...hashes, receiptHash: 'different' },
        approvedPlan, approvedPlanHash: objectHash(approvedPlan), backupPath: '/unused', readState: db.readState }), /matching reviewed rollback/);
    const corrupted = structuredClone(savedBackup); corrupted.state.tables.models[0].name = 'tampered';
    assert.throws(() => buildArcRollbackPlan(state, corrupted, receipt, hashes), /verified original backup/);
});

test('rollback restores adopted notes and enriched fields without losing previous evidence', async t => {
    const path = await temporary(t), f = fixture(), previous = storedResult(f, { source_title: 'Previous source', notes: 'original notes', score_fields: [] });
    f.state.tables.benchmark_results.push(previous);
    f.mapping.existingScoreResolutions = [{ resultID: 41, recordIDs: [f.mapping.runs[0].recordID], classification: 'same_run',
        expectedRowHash: objectHash(previous), evidence: ['verified native ID'] }];
    const db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8')), hashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(await db.readState(), savedBackup, receipt, hashes);
    await rollbackArcImport(db, { savedBackup, receipt, hashes, approvedPlan, approvedPlanHash: objectHash(approvedPlan),
        backupPath: resolve(path, 'rollback-backup.json'), readState: db.readState });
    assert.deepEqual((await db.readState()).tables.benchmark_results, [previous]);
    assert.deepEqual((await db.readState()).tables.benchmarks, f.state.tables.benchmarks);
});

test('rollback blocks later benchmark timestamp changes and rejects incomplete or forged timestamp receipts', async t => {
    const path = await temporary(t), f = fixture(), db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8')), state = await db.readState();
    const hashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(state, savedBackup, receipt, hashes);
    state.tables.benchmarks[0].scores_updated_at = '2026-10-07 00:00:00.001000';
    const drifted = buildArcRollbackPlan(state, savedBackup, receipt, hashes);
    assert.equal(drifted.canApply, false);
    assert.deepEqual(drifted.blockers, [{ code: 'rollback_benchmark_timestamp_changed', benchmarkID: 1 }]);
    const changedDB = memoryDatabase(state);
    await assert.rejects(rollbackArcImport(changedDB, { savedBackup, receipt, hashes, approvedPlan,
        approvedPlanHash: objectHash(approvedPlan), backupPath: '/unused', readState: changedDB.readState,
        backup: () => { throw new Error('must not back up blocked rollback'); } }), /Rollback rows changed/);
    assert.equal(changedDB.calls.some(sql => sql.startsWith('UPDATE')), false);
    for (const mutations of [[], [receipt.benchmarkMutations[0], receipt.benchmarkMutations[0]],
        [{ ...receipt.benchmarkMutations[0], before: null }], [{ ...receipt.benchmarkMutations[0], benchmarkID: 999 }]]) {
        assert.throws(() => buildArcRollbackPlan(state, savedBackup, { ...receipt, benchmarkMutations: mutations }, hashes),
            /benchmark timestamp receipt mutation/);
    }
});

test('rollback restores a null benchmark timestamp even when score rows were already restored', async t => {
    const path = await temporary(t), f = fixture(); f.state.tables.benchmarks[0].scores_updated_at = null;
    const db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8')), state = await db.readState();
    state.tables.benchmark_results[0].status = 'archived';
    const partial = memoryDatabase(state), hashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(state, savedBackup, receipt, hashes);
    assert.deepEqual(approvedPlan.counts, { restore: 0, archive: 0, unchanged: 1, blocked: 0 });
    assert.equal(approvedPlan.benchmarkTimestampCounts.restore, 1);
    const options = { savedBackup, receipt, hashes, approvedPlan, approvedPlanHash: objectHash(approvedPlan),
        backupPath: resolve(path, 'rollback-backup.json'), readState: partial.readState };
    const result = await rollbackArcImport(partial, options);
    assert.equal(result.rolledBack, true);
    assert.deepEqual(result.benchmarkMutations, [{ benchmarkID: 1, before: '2026-10-06 12:34:56.789000', after: null }]);
    assert.equal(partial.calls.some(sql => sql.startsWith('UPDATE benchmark_results')), false);
    assert.equal((await partial.readState()).tables.benchmarks[0].scores_updated_at, null);
    assert.equal((await rollbackArcImport(partial, options)).idempotent, true);
});

test('failed benchmark timestamp restoration rolls back score restoration in the same transaction', async t => {
    const path = await temporary(t), f = fixture(), db = memoryDatabase(f.state), backupPath = resolve(path, 'backup.json');
    const receipt = await applyArcPlan(db, applyOptions(f, planFor(f), backupPath, { readState: db.readState }));
    const savedBackup = JSON.parse(await readFile(backupPath, 'utf8')), state = await db.readState();
    const hashes = { receiptHash: objectHash(receipt), backupFileHash: objectHash(savedBackup) };
    const approvedPlan = buildArcRollbackPlan(state, savedBackup, receipt, hashes), execute = db.execute;
    db.execute = async (sql, values) => sql.startsWith('UPDATE benchmarks') ? [{ affectedRows: 0 }] : execute(sql, values);
    await assert.rejects(rollbackArcImport(db, { savedBackup, receipt, hashes, approvedPlan,
        approvedPlanHash: objectHash(approvedPlan), backupPath: resolve(path, 'rollback-backup.json'), readState: db.readState }),
        /Benchmark timestamp changed before rollback/);
    assert.deepEqual((await db.readState()).tables, state.tables);
});

test('reviewed SSH runner rejects a blocked plan before SSH or local output creation', async t => {
    const path = await temporary(t), f = fixture(); f.mapping.identities = [];
    const approved = planFor(f), bytes = Buffer.from(JSON.stringify(approved)), planPath = resolve(path, 'blocked.json'),
        output = resolve(path, 'receipt.json'), backupOutput = resolve(path, 'backup.json');
    await writeFile(planPath, bytes);
    await assert.rejects(reviewedSSHMain(['--apply', '--ssh-host=ubuntu@18.226.222.18', '--ssh-key=missing-key.pem',
        `--reviewed-plan=${planPath}`, `--expect-plan-sha256=${sha256(bytes)}`,
        '--backup-remote=/home/ubuntu/arc-official-review/20261006/test.json', `--backup-output=${backupOutput}`, `--output=${output}`]), /no SSH connection/);
    await assert.rejects(stat(output), { code: 'ENOENT' }); await assert.rejects(stat(backupOutput), { code: 'ENOENT' });
});

test('in-memory SSH module bundle parses and removes relative imports without copying remote files', async () => {
    const root = resolve(artifacts, '../..');
    const program = remoteModuleProgram(await readFile(resolve(root, 'public/js/shared/score-fields.js'), 'utf8'),
        await readFile(resolve(root, 'scripts/collect-arc-official.mjs'), 'utf8'),
        await readFile(resolve(root, 'scripts/import-arc-official.mjs'), 'utf8'), { operation: 'apply' });
    const check = spawnSync(process.execPath, ['--check', '--input-type=module'], { input: program, encoding: 'utf8', windowsHide: true });
    assert.equal(check.status, 0, check.stderr);
    const encoded = /from 'data:text\/javascript;base64,([A-Za-z0-9+/=]+)';\nconst input/.exec(program)[1];
    const importer = Buffer.from(encoded, 'base64').toString('utf8');
    assert.doesNotMatch(importer, /from '\.\.?\//);
    assert.match(importer, /from 'file:\/\/\/home\/ubuntu\/benchpoll\/node_modules\/mysql2\/promise.js'/);
    const driverURL = new URL('../node_modules/mysql2/promise.js', import.meta.url).href;
    const localImporter = importer.replace('file:///home/ubuntu/benchpoll/node_modules/mysql2/promise.js', driverURL);
    const loaded = await import(`data:text/javascript;base64,${Buffer.from(localImporter).toString('base64')}`);
    assert.equal(typeof loaded.applyArcPlan, 'function');
    assert.equal(typeof loaded.rollbackArcImport, 'function');
});

test('reviewed real identities keep LLM harnesses on their base and Deep Think variants separate', archivedInputs(...reviewedInputs), async () => {
    const { snapshot, hash: snapshotHash } = await loadArcSnapshot(resolve(artifacts, 'snapshot.json'));
    const state = JSON.parse(await readFile(resolve(artifacts, 'canonical-read-v6/production-state.json'), 'utf8'));
    const mappingBytes = await readFile(resolve(artifacts, 'mapping-v6.json')), mapping = JSON.parse(mappingBytes.toString('utf8'));
    const plan = buildArcPlan(snapshot, state, mapping, { snapshotHash, mappingHash: sha256(mappingBytes) });
    assert.equal(plan.canApply, true); assert.equal(plan.counts.mapped, 510); assert.equal(plan.counts.actions.blocked, 0);
    assert.deepEqual(plan.unresolvedIdentities, []);
    assert.deepEqual(plan.benchmarkTimestampUpdates.map(row => row.benchmarkID), [1027, 1057]);
    for (const row of plan.rows.filter(row => ['gemini-3-pro-preview', 'poetiq-arc-agi-gemini-3-d_v1'].includes(row.modelId))) {
        assert.equal(row.modelID, 337);
        assert.equal(row.fields.find(field => field.fieldID === 48).value, 'gemini-3-pro-preview');
        if (row.providerId === 'poetiq') assert.equal(row.fields.find(field => field.fieldID === 1).value, 'Poetiq ARC-AGI solver');
    }
    const deepThink = plan.rows.filter(row => ['gemini-3-deep-think-preview', 'gemini_3_deep_think_022026'].includes(row.modelId));
    assert.equal(deepThink.length, 4);
    for (const row of deepThink) {
        assert.equal(row.modelSlug, 'google-gemini-3-deep-think');
        assert.equal(row.fields.find(field => field.fieldID === 4).value, 'Deep Think');
        assert.equal(row.fields.find(field => field.fieldID === 22).value, 12);
        assert.equal(row.fields.find(field => field.fieldID === 48).value, row.modelId.includes('preview')
            ? 'Preview (December 2025)' : 'February 2026 upgrade');
        assert.equal(row.evidence.arc_model_id, row.modelId);
        if (row.modelId === 'gemini_3_deep_think_022026') {
            const upgrade = row.evidence.arc_configuration_evidence.find(evidence => evidence.detail.includes('publisher-reported upgrade'));
            assert.match(upgrade.detail, /no checkpoint\/weight equivalence with Preview or Pro is asserted/);
            assert.doesNotMatch(upgrade.detail, /not the same checkpoint/);
        }
    }
    const berman = plan.rows.find(row => row.providerId === 'j_berman');
    assert.equal(berman.modelSlug, 'arena-xai-grok40709-d');
    assert.match(berman.fields.find(field => field.fieldID === 1).value, /Berman/);
    const land = plan.rows.find(row => row.providerId === 'johan_land');
    assert.equal(land.modelSlug, 'johan-land-arc-solver');
    assert.match(land.fields.find(field => field.fieldID === 34).value, /Multi-model/);
    assert.equal(state.tables.models.find(row => row.ID === 171).is_active, 0);
    assert.equal(plan.creates.organizations.some(row => /poetiq|berman/.test(row.slug)), false);
});

test('generic Gemini baseline aliases retain explicit approved inference without unbound run parameters',
    archivedInputs(...reviewedInputs, 'arc-launch-config-reference.json', 'arc-launch-models-1870664.yml'), async () => {
    const { snapshot, hash: snapshotHash } = await loadArcSnapshot(resolve(artifacts, 'snapshot.json'));
    const state = JSON.parse(await readFile(resolve(artifacts, 'canonical-read-v6/production-state.json'), 'utf8'));
    const mappingBytes = await readFile(resolve(artifacts, 'mapping-v6.json')), mapping = JSON.parse(mappingBytes.toString('utf8'));
    const reference = JSON.parse(await readFile(resolve(artifacts, 'arc-launch-config-reference.json'), 'utf8'));
    assert.equal(reference.commit, '1870664a11c3b250f32c7c7b54a90b2723a8ab0d');
    assert.equal(sha256(await readFile(resolve(artifacts, 'arc-launch-models-1870664.yml'))), reference.fileSHA256);
    assert.equal(reference.fileSHA256, 'd1fc38aead412d10e559d81174d029972e58f88b0846a050937a7ef7d65b11f8');
    const plan = buildArcPlan(snapshot, state, mapping, { snapshotHash, mappingHash: sha256(mappingBytes) });
    for (const alias of reference.parentApprovedAliases) {
        const rows = plan.rows.filter(row => row.modelId === alias.leaderboardID);
        assert.equal(rows.length, 1);
        const row = rows[0];
        assert.equal(row.modelID, alias.selectedID); assert.equal(row.sourceVersion, 'v2');
        assert.equal(row.evidence.arc_model_name, alias.leaderboardID);
        assert.equal(row.evidence.arc_model_id, alias.leaderboardID);
        assert.equal(row.sourceURL, ARC_SOURCES[1].url);
        assert.deepEqual(row.fields.map(field => field.fieldID), [22]);
        const inferred = row.evidence.arc_configuration_evidence.find(evidence => evidence.inference === true);
        assert.equal(inferred.url, reference.url); assert.equal(inferred.apiModelName, alias.apiModelName);
        assert.equal(inferred.historicalFileSHA256, reference.fileSHA256);
        assert.equal(inferred.perRunRawResponsePublished, false); assert.equal(inferred.runParameterBinding, false);
        assert.match(inferred.detail, /inference.*not a published per-run raw response/);
        const identity = mapping.identities.find(item => item.sourceModelIds.includes(alias.leaderboardID));
        assert.equal(identity.inference.authorizedByParent, true);
        assert.equal(identity.inference.apiModelName, alias.apiModelName);
    }
});

test('refreshed live read paths include score-update dates and match the pinned v6 plan exactly',
    archivedInputs(...reviewedInputs, 'canonical-read-v6/direct-state.json', 'canonical-read-v6/read-path-comparison.json', 'plan-v6.json'), async () => {
    const { snapshot, hash: snapshotHash } = await loadArcSnapshot(resolve(artifacts, 'snapshot.json'));
    const state = JSON.parse(await readFile(resolve(artifacts, 'canonical-read-v6/production-state.json'), 'utf8'));
    const direct = JSON.parse(await readFile(resolve(artifacts, 'canonical-read-v6/direct-state.json'), 'utf8'));
    const comparison = JSON.parse(await readFile(resolve(artifacts, 'canonical-read-v6/read-path-comparison.json'), 'utf8'));
    const mappingBytes = await readFile(resolve(artifacts, 'mapping-v6.json')), mapping = JSON.parse(mappingBytes.toString('utf8'));
    const saved = JSON.parse(await readFile(resolve(artifacts, 'plan-v6.json'), 'utf8'));
    assert.equal(comparison.readOnly, true); assert.equal(comparison.equal, true);
    assert.equal(objectHash(state.tables), objectHash(direct.tables));
    assert.equal(comparison.offlineHash, objectHash(state.tables));
    assert.ok(state.tables.benchmarks.every(row => Object.hasOwn(row, 'scores_updated_at')));
    assert.equal(objectHash(buildArcPlan(snapshot, state, mapping, { snapshotHash, mappingHash: sha256(mappingBytes) })), objectHash(saved));
});
