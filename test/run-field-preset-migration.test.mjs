import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { RUN_FIELD_PRESET_MIGRATION_ID, PRESERVED_EFFORT_OPTIONS, materializePresetReferences,
    planRunFieldPresetMigration, presetLabelKey, stableStringify } from '../run-field-preset-migration.js';
import { ARCHIVE_TABLE, migrationValueHash, parseMigrationArgs, runRunFieldPresetMigration } from '../scripts/migrate-run-field-presets-20261013.mjs';

const RUN_ID = '20261013-0000-4000-8000-000000000001';
const SECOND_RUN_ID = '20261013-0000-4000-8000-000000000002';
test('incremental fingerprints are byte-identical to the previous archive hashes', () => {
    const large = Array.from({ length: 4000 }, (_, ID) => ({ ID, notes: 'x'.repeat(1024), snapshot: { name: '\u4e2d\u6587', value: null } }));
    for (const value of [[], [null, false, 0, 'quoted"\n', [1, 2], { z: 1, a: 2 }], large, { count: '181131' }]) {
        assert.equal(migrationValueHash(value), createHash('sha256').update(stableStringify(value)).digest('hex'));
    }
});
const copy = structuredClone;
const field = (ID, name, field_type) => ({ ID, name, name_key: presetLabelKey(name), field_type,
    allow_empty: 0, exclude_missing: 1, exclude_empty: 0, revision: 1, is_active: 1, created_request_ID: null });
const score = (ID, score_fields) => ({ ID, model_ID: 71, benchmark_ID: 81, benchmark_condition_ID: 91,
    raw_score: 2, source_url: `https://example.test/${ID}`, status: 'accepted', notes: { keep: 'verbatim' }, score_fields });
function fixture() {
    return { fields: [field(1, 'Agent harness', 'text'), field(2, 'Agent harness version', 'text'),
        field(9, 'Image quality preset', 'text'), field(20, 'Reasoning effort', 'enum')],
    options: PRESERVED_EFFORT_OPTIONS.map(([ID, label]) => ({ ID, field_ID: 20, label, label_key: presetLabelKey(label),
        excluded: 0, is_active: 1, revision: 1, created_request_ID: null, created_option_index: null })),
    scores: [score(100, [{ fieldID: 1, value: 'codex-harness' }, { fieldID: 2, value: '1.7' },
        { fieldID: 9, value: 'high' }, { fieldID: 20, value: 3 }]), score(101, [{ fieldID: 9, value: 'HD' }])], profiles: [], pending: [] };
}
function materialized(input, plan) {
    const state = copy(input);
    const IDs = new Map();
    let ID = Math.max(...state.options.map(option => option.ID));
    for (const option of plan.optionCreates) {
        IDs.set(option.ref, ++ID);
        state.options.push({ ID, field_ID: option.fieldID, label: option.label, label_key: option.label_key,
            excluded: 0, is_active: 1, revision: 1, created_request_ID: null, created_option_index: null });
    }
    for (const change of plan.fieldChanges) state.fields[state.fields.findIndex(row => row.ID === change.ID)] = copy(change.after);
    for (const [kind, column, changes] of [['scores', 'score_fields', plan.scoreChanges], ['profiles', 'comparison', plan.profileChanges], ['pending', 'content', plan.pendingChanges]]) {
        for (const change of changes) {
            const row = state[kind].find(row => kind === 'profiles'
                ? row.user_ID === change.user_ID && row.profile_key === change.profile_key : row.ID === change.ID);
            row[column] = materializePresetReferences(change.after, IDs);
        }
    }
    return state;
}

test('pure plan keeps the old Effort option IDs, archives only the legacy field and is idempotent', () => {
    const input = fixture();
    const before = copy(input);
    const plan = planRunFieldPresetMigration(input);
    assert.deepEqual(input, before);
    assert.equal(plan.canApply, true, JSON.stringify(plan.blocked));
    assert.equal(plan.inventory.identicalEffortPairs, 1);
    const state = materialized(input, plan);
    assert.equal(state.fields.find(row => row.ID === 9).is_active, 0);
    assert.equal(state.fields.find(row => row.ID === 9).name, 'Image quality preset');
    assert.equal(state.fields.find(row => row.ID === 1).field_type, 'enum');
    assert.equal(state.fields.find(row => row.ID === 2).field_type, 'text');
    assert.deepEqual(state.options.slice(0, 8), before.options);
    assert.deepEqual(state.scores[0].score_fields.filter(row => row.fieldID === 20), [{ fieldID: 20, value: 3 }]);
    assert.equal(state.scores.some(row => row.score_fields.some(item => item.fieldID === 9)), false);
    assert.equal(planRunFieldPresetMigration(state).noop, true);
    assert.throws(() => materializePresetReferences({ presetOptionRef: 'missing' }, new Map()), /Unresolved/);
});

test('177 distinct recorded Harness labels and every nonreasoning image label survive exactly', () => {
    const state = fixture();
    state.scores = Array.from({ length: 177 }, (_, index) => score(index + 1000,
        [{ fieldID: 1, value: index === 176 ? 'h'.repeat(176) : `Harness ${index}` }]));
    let ID = 2000;
    for (const [label, optionID, count] of [['high', 3, 131], ['max', 5, 76], ['low', 4, 20], ['medium', 6, 52]]) {
        for (let index = 0; index < count; index++) state.scores.push(score(ID++, [{ fieldID: 9, value: label }, { fieldID: 20, value: optionID }]));
    }
    const extra = ['quality', 'standard', 'very low', 'HD', 'best-quality', 'extra_high', 'MEDIA_RESOLUTION_ULTRA_HIGH;2240 image tokens'];
    for (let index = 0; index < 108; index++) state.scores.push(score(ID++, [{ fieldID: 9, value: extra[index % extra.length] }]));
    const plan = planRunFieldPresetMigration(state);
    assert.equal(plan.canApply, true, JSON.stringify(plan.blocked));
    assert.equal(plan.summary.harnessDistinct, 177);
    assert.equal(plan.summary.harnessMaxLength, 176);
    assert.equal(plan.summary.imageAssignments, 387);
    assert.equal(plan.summary.identicalEffortPairs, 279);
    assert.deepEqual(plan.optionCreates.filter(row => row.fieldID === 20).map(row => row.label).sort(), extra.sort());
    const after = materialized(state, plan);
    for (const original of state.scores) {
        const migrated = after.scores.find(row => row.ID === original.ID);
        assert.equal(migrated.raw_score, original.raw_score);
        for (const assignment of original.score_fields.filter(row => [1, 9].includes(row.fieldID))) {
            const fieldID = assignment.fieldID === 9 ? 20 : 1;
            const value = migrated.score_fields.find(row => row.fieldID === fieldID).value;
            assert.equal(after.options.find(option => option.ID === value && option.field_ID === fieldID).label, assignment.value);
        }
    }
});

test('field identities are discovered by names and validated rather than hardcoded IDs', () => {
    const state = fixture();
    const remap = { 1: 41, 2: 42, 9: 49, 20: 60 };
    state.fields.forEach(row => { row.ID = remap[row.ID]; });
    state.options.forEach(row => { row.field_ID = 60; });
    state.scores.forEach(row => row.score_fields.forEach(item => { item.fieldID = remap[item.fieldID]; }));
    const plan = planRunFieldPresetMigration(state);
    assert.equal(plan.canApply, true);
    assert.deepEqual(plan.fieldIDs, { harness: 41, version: 42, image: 49, effort: 60 });
    state.fields[0].field_type = 'number';
    assert.equal(planRunFieldPresetMigration(state).blocked.some(row => row.code === 'unexpected_field_type'), true);
});

test('true Effort conflicts, normalized-label collisions, truncation and stale option identities fail closed', () => {
    for (const mutate of [
        state => { state.scores[0].score_fields.find(row => row.fieldID === 20).value = 5; },
        state => state.scores.push(score(102, [{ fieldID: 1, value: 'codex-\uFF48arness' }])),
        state => state.scores.push(score(102, [{ fieldID: 1, value: 'x'.repeat(513) }])),
        state => { state.options[0].label = 'max'; },
        state => state.fields.push(field(23, 'Harness', 'enum')),
        state => { state.scores[1].score_fields[0].value = ' high '; }
    ]) {
        const state = fixture(); mutate(state);
        assert.equal(planRunFieldPresetMigration(state).canApply, false);
    }
});
test('case-only aliases share a preset while all original spellings are retained in the before snapshots', () => {
    const state = fixture();
    state.scores.push(score(102, [{ fieldID: 1, value: 'CODEX-HARNESS' }]));
    state.scores.push(score(103, [{ fieldID: 9, value: 'HIGH' }]));
    const before = copy(state), plan = planRunFieldPresetMigration(state);
    assert.equal(plan.canApply, true, JSON.stringify(plan.blocked));
    const after = materialized(state, plan);
    assert.equal(after.scores[0].score_fields.find(row => row.fieldID === 1).value, after.scores[2].score_fields[0].value);
    assert.equal(after.scores[3].score_fields[0].value, 3);
    assert.deepEqual(state, before);
    assert.equal(plan.scoreChanges.find(row => row.ID === 100).before[0].value, 'codex-harness');
    assert.equal(plan.summary.caseAliases, 2);
    assert.equal(planRunFieldPresetMigration(after).noop, true);
});

test('comparison keys and eq labels remap and deduplicate without inventing approved options', () => {
    const state = fixture();
    state.profiles = [{ user_ID: 7, profile_key: 'last', comparison: { mode: 'best', keys: ['field:1', 'field:9', 'field:20'], filters: [
        { key: 'field:1', operator: 'eq', value: 'codex-harness' }, { key: 'field:9', operator: 'eq', value: 'high' },
        { key: 'field:20', operator: 'eq', value: 3 }
    ] } }];
    const plan = planRunFieldPresetMigration(state);
    assert.equal(plan.canApply, true);
    const after = materialized(state, plan).profiles[0].comparison;
    assert.deepEqual(after.keys, ['field:1', 'field:20']);
    assert.equal(after.filters.length, 2);
    assert.deepEqual(after.filters[1], { key: 'field:20', operator: 'eq', value: 3 });
    state.profiles[0].comparison.filters[0].value = 'profile-only-unapproved';
    const blocked = planRunFieldPresetMigration(state);
    assert.equal(blocked.canApply, false);
    assert.equal(blocked.optionCreates.some(row => row.label === 'profile-only-unapproved'), false);
    state.profiles[0].comparison.filters = [{ key: 'field:9', operator: 'present' }];
    assert.equal(planRunFieldPresetMigration(state).blocked.some(row => row.code === 'non_equality_image_filter'), true);
});

test('nested pending strings stay proposals, request references remap, and reviewed history is unchanged', () => {
    const state = fixture();
    state.pending = [
        { ID: 500, status: 'pending', user_id: 7, content: { type: 'batch', results: [{ scoreFields: [
            { fieldID: 1, value: 'pending-only-harness' }, { fieldID: 9, optionRequestID: 501 }
        ] }], changes: { score_fields: [{ fieldID: 9, value: 'HD' }] }, moderation: { history: [{ scoreFields: [{ fieldID: 9, value: 'historical' }] }] } } },
        { ID: 501, status: 'pending', user_id: 7, content: { type: 'score_field_option', operation: 'create', targetID: null,
            revision: null, fieldID: 9, label: 'pending-only-image', excluded: false, notes: '' } },
        { ID: 502, status: 'approved', user_id: 7, content: { scoreFields: [{ fieldID: 1, value: 'approved audit text' }] } }
    ];
    const plan = planRunFieldPresetMigration(state);
    assert.equal(plan.canApply, true, JSON.stringify(plan.blocked));
    assert.equal(plan.optionCreates.some(row => /pending-only/.test(row.label)), false);
    const after = materialized(state, plan);
    assert.deepEqual(after.pending[0].content.results[0].scoreFields[0], { fieldID: 1, newOption: 'pending-only-harness' });
    assert.deepEqual(after.pending[0].content.results[0].scoreFields[1], { fieldID: 20, optionRequestID: 501 });
    assert.equal(after.pending[1].content.fieldID, 20);
    assert.deepEqual(after.pending[0].content.moderation, state.pending[0].content.moderation);
    assert.deepEqual(after.pending[2], state.pending[2]);
    assert.equal(planRunFieldPresetMigration(after).noop, true);
    state.pending[1].user_id = 8;
    assert.equal(planRunFieldPresetMigration(state).blocked.some(row => row.code === 'incompatible_pending_option_reference'), true);
});

test('unreliable pending field intents and unknown references block rather than being rebased', () => {
    const state = fixture();
    state.pending = [{ ID: 600, status: 'pending', user_id: 7, content: { type: 'score_field', operation: 'update',
        targetID: 1, revision: 1, definition: { name: 'Agent harness', type: 'text', options: [] } } }];
    assert.equal(planRunFieldPresetMigration(state).blocked.some(row => row.code === 'pending_field_intent_requires_review'), true);
    state.pending[0].content = { scoreFields: [{ fieldID: 1, optionRequestID: 999 }] };
    assert.equal(planRunFieldPresetMigration(state).blocked.some(row => row.code === 'unresolved_option_request'), true);
    state.pending[0].content = { type: 'score_field', operation: 'update', targetID: 2, revision: 1,
        definition: { name: 'Agent harness version', type: 'text', options: [] } };
    const plan = planRunFieldPresetMigration(state);
    assert.equal(plan.canApply, true);
    assert.equal(plan.pendingChanges[0].after.definition.name, 'Harness version');
    assert.equal(plan.pendingChanges[0].after.revision, 2);
});

function fakeDatabase(input = fixture(), behavior = {}) {
    let state = { ...copy(input), archive: [], markers: [], labelLength: 160, archiveExists: false };
    let snapshot;
    let nextID = Math.max(...state.options.map(option => option.ID)) + 1;
    const externalScores = [];
    const commands = [];
    const calls = { commits: 0, rollbacks: 0, dataWrites: 0 };
    let injected = false;
    const tableRows = table => ({ score_fields: state.fields, score_field_options: state.options,
        benchmark_results: state.scores, user_comparison_profiles: state.profiles,
        moderation_logs: state.pending, [ARCHIVE_TABLE]: state.archive })[table];
    const schema = () => {
        const names = ['score_fields', 'score_field_options', 'benchmark_results', 'user_comparison_profiles', 'moderation_logs', 'schema_migrations'];
        if (state.archiveExists) names.push(ARCHIVE_TABLE);
        const tables = names.map(TABLE_NAME => ({ TABLE_NAME, ENGINE: 'InnoDB', ROW_FORMAT: 'Dynamic' }));
        const columns = [];
        const add = (TABLE_NAME, COLUMN_NAME, DATA_TYPE = 'json', length = null, collation = null) => columns.push({ TABLE_NAME, COLUMN_NAME,
            DATA_TYPE, COLUMN_TYPE: DATA_TYPE, CHARACTER_MAXIMUM_LENGTH: length, CHARACTER_SET_NAME: DATA_TYPE === 'varchar' ? 'utf8mb4' : null,
            COLLATION_NAME: collation, IS_NULLABLE: 'NO', COLUMN_DEFAULT: null, EXTRA: '', COLUMN_COMMENT: '' });
        add('score_field_options', 'label', 'varchar', state.labelLength, 'utf8mb4_0900_ai_ci');
        add('score_field_options', 'label_key', 'varchar', state.labelLength, 'utf8mb4_bin');
        add('benchmark_results', 'score_fields'); add('user_comparison_profiles', 'comparison'); add('moderation_logs', 'content');
        if (state.archiveExists) for (const name of ['migration_id', 'run_id', 'kind', 'object_key', 'before_snapshot', 'after_snapshot', 'created_at']) add(ARCHIVE_TABLE, name);
        const indexes = ['field_ID', 'label_key'].map((COLUMN_NAME, index) => ({ TABLE_NAME: 'score_field_options', INDEX_NAME: 'field_label',
            NON_UNIQUE: 0, SEQ_IN_INDEX: index + 1, COLUMN_NAME, SUB_PART: null }));
        return { tables, columns, indexes };
    };
    const db = {
        get state() { return state; }, commands, calls,
        async commit() { commands.push('COMMIT'); snapshot = undefined; calls.commits++; },
        async rollback() {
            commands.push('ROLLBACK'); calls.rollbacks++;
            if (snapshot) {
                state = snapshot; snapshot = undefined;
                for (const row of externalScores) if (!state.scores.some(score => score.ID === row.ID)) state.scores.push(copy(row));
            }
        },
        async query(sql, parameters = []) {
            commands.push(sql);
            if (sql.startsWith('SET ')) return [[]];
            if (sql.startsWith('START TRANSACTION')) { assert.equal(snapshot, undefined); snapshot = copy(state); return [[]]; }
            if (sql.startsWith('CREATE TABLE')) { assert.equal(snapshot, undefined); state.archiveExists = true; return [{ affectedRows: 0 }]; }
            if (sql.startsWith('ALTER TABLE')) { assert.equal(snapshot, undefined); state.labelLength = 512; return [{ affectedRows: 0 }]; }
            if (sql.includes('FOR SHARE') && behavior.concurrentInsert && !injected) {
                const row = score(9000, [{ fieldID: 1, value: 'concurrent legacy harness' }]);
                state.scores.push(row); externalScores.push(row); injected = true;
            }
            if (sql.includes(' AS resultCount')) return [[{ resultCount: String(state.scores.length), rawScoreSum: String(state.scores.reduce((sum, row) => sum + row.raw_score, 0)) }]];
            const table = sql.match(/FROM (\w+)/)?.[1];
            const rows = tableRows(table);
            if (rows) return [copy(rows.filter(row => table !== 'moderation_logs' || row.status === 'pending'))];
            throw new Error(`Unsupported query: ${sql}, ${JSON.stringify(parameters)}`);
        },
        async execute(sql, parameters = []) {
            commands.push(sql);
            if (sql.includes('GET_LOCK')) return [[{ acquired: behavior.lockUnavailable === parameters[0] ? 0 : 1 }]];
            if (sql.includes('RELEASE_LOCK')) return [[{ released: 1 }]];
            if (sql.includes('information_schema.TABLES')) return [schema().tables];
            if (sql.includes('information_schema.COLUMNS')) return [schema().columns];
            if (sql.includes('information_schema.STATISTICS')) return [schema().indexes];
            if (sql.startsWith('SELECT migration_id')) return [state.markers.filter(item => item === parameters[0]).map(migration_id => ({ migration_id }))];
            if (sql.startsWith(`SELECT * FROM ${ARCHIVE_TABLE}`)) return [copy(state.archive.filter(row => row.migration_id === parameters[0] && row.run_id === parameters[1]))];
            if (sql.startsWith(`INSERT INTO ${ARCHIVE_TABLE}`)) {
                const [migration_id, run_id, kind, object_key, before, after] = parameters;
                assert.equal(state.archive.some(row => row.run_id === run_id && row.kind === kind && row.object_key === object_key), false);
                state.archive.push({ migration_id, run_id, kind, object_key, before_snapshot: before === null ? null : JSON.parse(before), after_snapshot: after === null ? null : JSON.parse(after) });
                return [{ affectedRows: 1 }];
            }
            if (sql.startsWith(`UPDATE ${ARCHIVE_TABLE}`)) {
                const row = state.archive.find(row => row.migration_id === parameters[1] && row.run_id === parameters[2] && row.kind === parameters[3] && row.object_key === parameters[4]);
                if (!row) return [{ affectedRows: 0 }];
                row.after_snapshot = JSON.parse(parameters[0]); return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('SELECT * FROM ')) {
                const table = sql.match(/FROM (\w+)/)[1];
                const rows = tableRows(table).filter(row => table === 'user_comparison_profiles'
                    ? String(row.user_ID) === String(parameters[0]) && row.profile_key === parameters[1] : String(row.ID) === String(parameters[0]));
                if (behavior.optimisticConflict && table === 'benchmark_results' && sql.includes('FOR UPDATE')) return [rows.map(row => ({ ...copy(row), raw_score: 999 }))];
                return [copy(rows)];
            }
            if (sql.startsWith('INSERT INTO score_field_options')) {
                assert.equal(state.archive.some(row => row.kind === 'new_option' && row.after_snapshot.label === parameters[1]), true);
                const [field_ID, label, label_key, excluded] = parameters;
                const ID = nextID++;
                state.options.push({ ID, field_ID, label, label_key, excluded, revision: 1, is_active: 1, created_request_ID: null, created_option_index: null });
                calls.dataWrites++; return [{ affectedRows: 1, insertId: ID }];
            }
            if (sql.startsWith('UPDATE score_fields')) {
                const row = state.fields.find(row => String(row.ID) === String(parameters[5]) && row.revision === parameters[6]);
                if (!row) return [{ affectedRows: 0 }];
                assert.equal(state.archive.some(entry => entry.kind === 'field' && String(entry.before_snapshot.ID) === String(row.ID)), true);
                [row.name, row.name_key, row.field_type, row.is_active, row.revision] = parameters;
                calls.dataWrites++; return [{ affectedRows: 1 }];
            }
            if (/^UPDATE (benchmark_results|user_comparison_profiles|moderation_logs)/.test(sql)) {
                const table = sql.match(/^UPDATE (\w+)/)[1];
                const column = { benchmark_results: 'score_fields', user_comparison_profiles: 'comparison', moderation_logs: 'content' }[table];
                const row = tableRows(table).find(row => table === 'user_comparison_profiles'
                    ? row.user_ID === parameters[1] && row.profile_key === parameters[2] : String(row.ID) === String(parameters[1]));
                if (!row || stableStringify(row[column]) !== stableStringify(JSON.parse(parameters.at(-1)))
                    || table === 'moderation_logs' && row.status !== 'pending') return [{ affectedRows: 0 }];
                const kind = { benchmark_results: 'score', user_comparison_profiles: 'profile', moderation_logs: 'pending' }[table];
                assert.equal(state.archive.some(entry => entry.kind === kind && (kind === 'profile'
                    ? entry.before_snapshot.profile_key === row.profile_key : String(entry.before_snapshot.ID) === String(row.ID))), true);
                row[column] = JSON.parse(parameters[0]); calls.dataWrites++; return [{ affectedRows: 1 }];
            }
            if (sql.startsWith('INSERT INTO schema_migrations')) { state.markers.push(parameters[0]); calls.dataWrites++; return [{ affectedRows: 1 }]; }
            if (sql.startsWith('DELETE FROM schema_migrations')) {
                const before = state.markers.length; state.markers = state.markers.filter(item => item !== parameters[0]);
                calls.dataWrites++; return [{ affectedRows: before - state.markers.length }];
            }
            if (sql.startsWith('DELETE FROM score_field_options')) {
                const before = state.options.length; state.options = state.options.filter(row => String(row.ID) !== String(parameters[0]) || row.revision !== parameters[1]);
                calls.dataWrites++; return [{ affectedRows: before - state.options.length }];
            }
            throw new Error(`Unsupported execute: ${sql}`);
        }
    };
    return db;
}

test('dry-run is read-only, reports the plan, and never widens schema or takes a full-result lock', async () => {
    const db = fakeDatabase(); const before = copy(db.state); const reports = [];
    const result = await runRunFieldPresetMigration(db, { runID: RUN_ID, report: async value => reports.push(value) });
    assert.equal(result.status, 'ready'); assert.equal(result.dryRun, true);
    assert.deepEqual(db.state, before); assert.equal(db.calls.dataWrites, 0); assert.equal(db.calls.commits, 0);
    assert.equal(db.commands.some(sql => /^(ALTER|CREATE|INSERT|UPDATE|DELETE)/.test(sql)), false);
    assert.equal(db.commands.some(sql => sql.includes('FOR SHARE') || sql.includes('FOR UPDATE')), false);
    assert.equal(reports.length, 1);
});

test('apply without backup is rejected before any DB call, and blocked plans precede any schema DDL', async () => {
    const db = fakeDatabase();
    await assert.rejects(runRunFieldPresetMigration(db, { apply: true, runID: RUN_ID }), /backup_required/);
    assert.equal(db.commands.length, 0);
    const bad = fixture(); bad.scores[0].score_fields.find(row => row.fieldID === 20).value = 5;
    const blocked = fakeDatabase(bad); const reports = [];
    await assert.rejects(runRunFieldPresetMigration(blocked, { apply: true, backupConfirmed: true, runID: RUN_ID, report: async value => reports.push(value) }), /blocked_migration_plan/);
    assert.equal(reports[0].status, 'blocked'); assert.equal(blocked.state.labelLength, 160);
    assert.equal(blocked.commands.some(sql => /^(CREATE|ALTER|INSERT|UPDATE|DELETE)/.test(sql)), false);
});

test('stub transaction archives before changes, preserves score identity and source, then becomes a no-op', async () => {
    const db = fakeDatabase(); const before = copy(db.state);
    const result = await runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, runID: RUN_ID });
    assert.equal(result.status, 'applied'); assert.equal(db.state.labelLength, 512);
    assert.deepEqual(db.state.markers, [RUN_FIELD_PRESET_MIGRATION_ID]);
    assert.equal(db.state.archive.some(row => row.kind === 'schema'), true);
    assert.equal(db.state.archive.filter(row => row.kind === 'field').length, 4);
    assert.equal(db.state.archive.filter(row => row.kind === 'option').length, 8);
    assert.equal(db.state.archive.some(row => row.kind === 'manifest'), true);
    assert.deepEqual(db.state.scores.map(({ score_fields: _, ...row }) => row), before.scores.map(({ score_fields: _, ...row }) => row));
    assert.deepEqual(db.state.options.slice(0, 8), before.options);
    const writes = db.calls.dataWrites; const committed = copy(db.state);
    const again = await runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, runID: SECOND_RUN_ID });
    assert.equal(again.status, 'already_applied'); assert.equal(db.calls.dataWrites, writes);
    assert.deepEqual(db.state, committed);
    const firstFullScoreLock = db.commands.findIndex(sql => sql.includes('FROM benchmark_results ORDER BY ID FOR SHARE'));
    const lastScoreWrite = db.commands.findLastIndex(sql => sql.startsWith('UPDATE benchmark_results'));
    assert.equal(firstFullScoreLock > lastScoreWrite, true);
    assert.equal(db.commands.some(sql => sql.includes('FROM benchmark_results ORDER BY ID FOR UPDATE')), false);
});

test('concurrent score creation rolls back the whole data transaction without removing the new external score', async () => {
    const db = fakeDatabase(fixture(), { concurrentInsert: true }); const before = copy(db.state);
    await assert.rejects(runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, runID: RUN_ID }), /concurrent_or_unexpected_state_change/);
    assert.deepEqual(db.state.fields, before.fields); assert.deepEqual(db.state.options, before.options);
    assert.deepEqual(db.state.scores.slice(0, 2), before.scores);
    assert.equal(db.state.scores.at(-1).ID, 9000); assert.equal(db.state.markers.length, 0);
    assert.equal(db.state.labelLength, 512); assert.deepEqual(db.state.archive.map(row => row.kind), ['schema']);
});

test('row-level optimistic conflicts roll back and both locks release, including partial lock acquisition', async () => {
    const db = fakeDatabase(fixture(), { optimisticConflict: true });
    await assert.rejects(runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, runID: RUN_ID }), /optimistic_concurrency_conflict/);
    assert.equal(db.state.markers.length, 0);
    assert.equal(db.commands.filter(sql => sql.includes('RELEASE_LOCK')).length, 2);
    const locked = fakeDatabase(fixture(), { lockUnavailable: 'benchpoll_score_fields' });
    await assert.rejects(runRunFieldPresetMigration(locked, { runID: RUN_ID }), /migration_advisory_lock_unavailable/);
    assert.equal(locked.commands.filter(sql => sql.includes('RELEASE_LOCK')).length, 1);
});

test('archive restore is dry by default, lossless, idempotent and refuses postmigration changes', async () => {
    const db = fakeDatabase(); const before = copy(db.state);
    await runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, runID: RUN_ID });
    const applied = copy(db.state); const writes = db.calls.dataWrites;
    const preview = await runRunFieldPresetMigration(db, { restoreRunID: RUN_ID, runID: SECOND_RUN_ID });
    assert.equal(preview.status, 'restore_ready'); assert.deepEqual(db.state, applied); assert.equal(db.calls.dataWrites, writes);
    const restored = await runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, restoreRunID: RUN_ID, runID: SECOND_RUN_ID });
    assert.equal(restored.status, 'restored');
    for (const key of ['fields', 'options', 'scores', 'profiles', 'pending']) assert.deepEqual(db.state[key], before[key]);
    assert.equal(db.state.labelLength, 512); assert.deepEqual(db.state.markers, []);
    const again = await runRunFieldPresetMigration(db, { restoreRunID: RUN_ID, runID: SECOND_RUN_ID });
    assert.equal(again.status, 'already_restored');
    const changed = fakeDatabase();
    await runRunFieldPresetMigration(changed, { apply: true, backupConfirmed: true, runID: RUN_ID });
    changed.state.scores[0].raw_score = 999;
    await assert.rejects(runRunFieldPresetMigration(changed, { apply: true, backupConfirmed: true, restoreRunID: RUN_ID, runID: SECOND_RUN_ID }), /archive_restore_current_state_has_changed/);
    assert.equal(changed.state.scores[0].raw_score, 999);
});

test('CLI rejects unsafe and contradictory flags', () => {
    assert.throws(() => parseMigrationArgs(['--apply']), /backup_required/);
    assert.throws(() => parseMigrationArgs(['--apply', '--backup-confirmed', '--dry-run']), /mutually_exclusive/);
    assert.throws(() => parseMigrationArgs(['--output']), /missing_argument_value/);
    assert.throws(() => parseMigrationArgs(['--force']), /unknown_migration_argument/);
    assert.equal(parseMigrationArgs([]).apply, false);
});
