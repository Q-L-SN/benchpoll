#!/usr/bin/env node
import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { RUN_FIELD_PRESET_MIGRATION_ID as MIGRATION_ID, materializePresetReferences,
    parseMigrationJSON, planRunFieldPresetMigration, stableStringify } from '../run-field-preset-migration.js';

export const ARCHIVE_TABLE = 'run_field_preset_migration_archive';
const LOCKS = ['benchpoll_arena_latest_import', 'benchpoll_score_fields'];
const TABLES = ['score_fields', 'score_field_options', 'benchmark_results', 'user_comparison_profiles', 'moderation_logs', 'schema_migrations'];
const JSON_COLUMNS = { benchmark_results: 'score_fields', user_comparison_profiles: 'comparison', moderation_logs: 'content' };
const same = (left, right) => stableStringify(left) === stableStringify(right);
export function migrationValueHash(value) {
    const digest = createHash('sha256');
    if (Array.isArray(value)) {
        digest.update('[');
        for (let index = 0; index < value.length; index++) {
            if (index) digest.update(',');
            digest.update(stableStringify(value[index]) ?? '');
        }
        digest.update(']');
    } else digest.update(stableStringify(value));
    return digest.digest('hex');
}
const fingerprint = state => Object.fromEntries(['fields', 'options', 'scores', 'profiles', 'pending', 'stats']
    .map(key => [key, migrationValueHash(state[key])]));
// Rows are immutable: replacing array slots does not require cloning all notes and source snapshots.
const forkState = state => ({ ...state, ...Object.fromEntries(['fields', 'options', 'scores', 'profiles', 'pending']
    .map(key => [key, [...state[key]]])) });
const rowKey = (kind, row) => kind === 'profile' ? JSON.stringify([String(row.user_ID), row.profile_key]) : String(row.ID);
const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, ...details }); };
const normalizeRow = (table, row) => {
    const output = { ...row };
    const column = JSON_COLUMNS[table];
    if (column) output[column] = parseMigrationJSON(output[column]);
    return output;
};
const safeIdentifier = name => {
    if (!/^[a-zA-Z0-9_]+$/.test(name)) fail('unsafe_schema_identifier');
    return `\`${name}\``;
};

async function readSchema(db) {
    const [tables] = await db.execute(`SELECT TABLE_NAME, ENGINE, ROW_FORMAT FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN (?,?,?,?,?,?,?) ORDER BY TABLE_NAME`, [...TABLES, ARCHIVE_TABLE]);
    const [columns] = await db.execute(`SELECT TABLE_NAME, COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
        CHARACTER_MAXIMUM_LENGTH, CHARACTER_SET_NAME, COLLATION_NAME, IS_NULLABLE, COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN (?,?,?,?,?,?,?) ORDER BY TABLE_NAME, ORDINAL_POSITION`, [...TABLES, ARCHIVE_TABLE]);
    const [indexes] = await db.execute(`SELECT TABLE_NAME, INDEX_NAME, NON_UNIQUE, SEQ_IN_INDEX, COLUMN_NAME, SUB_PART
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
        AND TABLE_NAME IN ('score_field_options', 'run_field_preset_migration_archive') ORDER BY TABLE_NAME, INDEX_NAME, SEQ_IN_INDEX`);
    const blocked = [];
    for (const name of TABLES) {
        const table = tables.find(table => table.TABLE_NAME === name);
        if (!table || table.ENGINE !== 'InnoDB') blocked.push({ code: 'missing_or_nontransactional_table', table: name });
    }
    const optionColumns = columns.filter(column => column.TABLE_NAME === 'score_field_options'
        && ['label', 'label_key'].includes(column.COLUMN_NAME));
    const widen = [];
    for (const name of ['label', 'label_key']) {
        const column = optionColumns.find(column => column.COLUMN_NAME === name);
        if (!column || column.DATA_TYPE !== 'varchar' || column.CHARACTER_SET_NAME !== 'utf8mb4'
            || column.IS_NULLABLE !== 'NO' || column.COLUMN_DEFAULT !== null || column.EXTRA
            || column.COLUMN_COMMENT || name === 'label_key' && column.COLLATION_NAME !== 'utf8mb4_bin') {
            blocked.push({ code: 'unsupported_option_column_schema', column: name }); continue;
        }
        if (Number(column.CHARACTER_MAXIMUM_LENGTH) < 512) widen.push(column);
    }
    const unique = indexes.filter(index => index.TABLE_NAME === 'score_field_options' && Number(index.NON_UNIQUE) === 0);
    const groups = new Map();
    for (const index of unique) groups.set(index.INDEX_NAME, [...(groups.get(index.INDEX_NAME) ?? []), index]);
    if (![...groups.values()].some(items => same(items.map(item => item.COLUMN_NAME), ['field_ID', 'label_key'])
        && items.every(item => item.SUB_PART === null))) blocked.push({ code: 'missing_full_option_unique_key' });
    if (widen.length && !['Dynamic', 'Compressed'].includes(tables.find(table => table.TABLE_NAME === 'score_field_options')?.ROW_FORMAT)) {
        blocked.push({ code: 'unsupported_option_index_row_format' });
    }
    for (const [table, column] of Object.entries(JSON_COLUMNS)) {
        if (!columns.some(item => item.TABLE_NAME === table && item.COLUMN_NAME === column && item.DATA_TYPE === 'json')) {
            blocked.push({ code: 'missing_expected_json_column', table, column });
        }
    }
    if (tables.some(table => table.TABLE_NAME === ARCHIVE_TABLE)) {
        for (const name of ['migration_id', 'run_id', 'kind', 'object_key', 'before_snapshot', 'after_snapshot', 'created_at']) {
            if (!columns.some(column => column.TABLE_NAME === ARCHIVE_TABLE && column.COLUMN_NAME === name)) {
                blocked.push({ code: 'incompatible_archive_table', column: name });
            }
        }
        if (tables.find(table => table.TABLE_NAME === ARCHIVE_TABLE).ENGINE !== 'InnoDB') blocked.push({ code: 'nontransactional_archive_table' });
    }
    return { tables, columns, indexes, widen, blocked };
}

async function readState(db, { locking = false } = {}) {
    // Current locking reads only at the final verification barrier prevent a commit-time insert gap.
    const tail = locking ? ' FOR SHARE' : '';
    const select = table => `SELECT /*+ MAX_EXECUTION_TIME(30000) */ * FROM ${table}`;
    const [fields] = await db.query(`${select('score_fields')} ORDER BY ID${tail}`);
    const [options] = await db.query(`${select('score_field_options')} ORDER BY ID${tail}`);
    const [scores] = await db.query(`${select('benchmark_results')} ORDER BY ID${tail}`);
    const [profiles] = await db.query(`${select('user_comparison_profiles')} ORDER BY user_ID, profile_key${tail}`);
    const [pending] = await db.query(`${select('moderation_logs')} WHERE status = 'pending' ORDER BY ID${tail}`);
    const [[stats]] = await db.query('SELECT CAST(COUNT(*) AS CHAR) AS resultCount, CAST(SUM(raw_score) AS CHAR) AS rawScoreSum FROM benchmark_results');
    const [markers] = await db.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [MIGRATION_ID]);
    return { fields, options, scores, profiles, pending, stats, applied: markers.length !== 0 };
}

function canonicalState(state) {
    return { ...state, scores: state.scores.map(row => normalizeRow('benchmark_results', row)),
        profiles: state.profiles.map(row => normalizeRow('user_comparison_profiles', row)),
        pending: state.pending.map(row => normalizeRow('moderation_logs', row)) };
}

async function startSnapshot(db, readOnly = false) {
    await db.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await db.query(`START TRANSACTION WITH CONSISTENT SNAPSHOT${readOnly ? ', READ ONLY' : ''}`);
}
async function archive(db, runID, kind, key, before, after) {
    await db.execute(`INSERT INTO ${ARCHIVE_TABLE}
        (migration_id, run_id, kind, object_key, before_snapshot, after_snapshot) VALUES (?,?,?,?,?,?)`,
    [MIGRATION_ID, runID, kind, key, before === null ? null : JSON.stringify(before), after === null ? null : JSON.stringify(after)]);
}
async function archiveAfter(db, runID, kind, key, after) {
    const [result] = await db.execute(`UPDATE ${ARCHIVE_TABLE} SET after_snapshot = ?
        WHERE migration_id = ? AND run_id = ? AND kind = ? AND object_key = ?`,
    [JSON.stringify(after), MIGRATION_ID, runID, kind, key]);
    if (result.affectedRows !== 1) fail('archive_update_failed');
}
async function prepareSchema(db, runID, schema) {
    await db.query(`CREATE TABLE IF NOT EXISTS ${ARCHIVE_TABLE} (
        migration_id VARCHAR(128) CHARACTER SET ascii NOT NULL,
        run_id CHAR(36) CHARACTER SET ascii NOT NULL,
        kind VARCHAR(32) CHARACTER SET ascii NOT NULL,
        object_key VARCHAR(256) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL,
        before_snapshot JSON NULL, after_snapshot JSON NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (migration_id, run_id, kind, object_key)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 ROW_FORMAT=DYNAMIC`);
    // This durable archive precedes auto-committing DDL, not just the data transaction.
    await startSnapshot(db);
    try {
        await archive(db, runID, 'schema', 'option_columns', schema, { widenedColumns: schema.widen.map(column => column.COLUMN_NAME), minimumLength: 512 });
        await db.commit();
    } catch (error) { await db.rollback(); throw error; }
    if (schema.widen.length) {
        const changes = schema.widen.map(column => `MODIFY ${safeIdentifier(column.COLUMN_NAME)} VARCHAR(512)
            CHARACTER SET utf8mb4 COLLATE ${safeIdentifier(column.COLLATION_NAME)} NOT NULL`);
        await db.query(`ALTER TABLE score_field_options ${changes.join(', ')}`);
    }
    const after = await readSchema(db);
    if (after.blocked.length || after.widen.length) fail('schema_expansion_verification_failed', { blocked: after.blocked });
    return after;
}

function keyFor(table, row) {
    return table === 'user_comparison_profiles'
        ? { where: 'user_ID = ? AND profile_key = ?', parameters: [row.user_ID, row.profile_key] }
        : { where: 'ID = ?', parameters: [row.ID] };
}
async function lockedOriginal(db, table, before) {
    const key = keyFor(table, before);
    const [rows] = await db.execute(`SELECT * FROM ${table} WHERE ${key.where} FOR UPDATE`, key.parameters);
    if (rows.length !== 1 || !same(normalizeRow(table, rows[0]), before)) fail('optimistic_concurrency_conflict', { table, key: key.parameters });
}
const timestampPreservation = (schema, table) => schema.columns.filter(column => column.TABLE_NAME === table
    && /on update/i.test(column.EXTRA)).map(column => `${safeIdentifier(column.COLUMN_NAME)} = ${safeIdentifier(column.COLUMN_NAME)}`);
async function updateJSON(db, schema, table, before, afterJSON) {
    await lockedOriginal(db, table, before);
    const column = JSON_COLUMNS[table];
    const key = keyFor(table, before);
    const sets = [`${column} = ?`, ...timestampPreservation(schema, table)];
    // Pending preview tokens must expire after content is mechanically remapped.
    if (table === 'moderation_logs' && schema.columns.some(column => column.TABLE_NAME === table && column.COLUMN_NAME === 'updated_at')) {
        const index = sets.findIndex(item => item.startsWith('`updated_at`'));
        if (index !== -1) sets.splice(index, 1);
        sets.push('updated_at = CURRENT_TIMESTAMP(3)');
    }
    const [result] = await db.execute(`UPDATE ${table} SET ${sets.join(', ')} WHERE ${key.where}
        AND ${column} <=> CAST(? AS JSON)${table === 'moderation_logs' ? " AND status = 'pending'" : ''}`,
    [JSON.stringify(afterJSON), ...key.parameters, JSON.stringify(before[column])]);
    if (result.affectedRows !== 1) fail('optimistic_json_update_failed', { table, key: key.parameters });
    const [rows] = await db.execute(`SELECT * FROM ${table} WHERE ${key.where}`, key.parameters);
    const after = normalizeRow(table, rows[0]);
    const expected = { ...before, [column]: afterJSON };
    if (table === 'moderation_logs') expected.updated_at = after.updated_at;
    if (!same(after, expected)) fail('unexpected_update_side_effect', { table, key: key.parameters });
    return after;
}
async function updateField(db, before, after) {
    await lockedOriginal(db, 'score_fields', before);
    const [result] = await db.execute(`UPDATE score_fields SET name = ?, name_key = ?, field_type = ?, is_active = ?, revision = ?
        WHERE ID = ? AND revision = ?`, [after.name, after.name_key, after.field_type, after.is_active, after.revision, before.ID, before.revision]);
    if (result.affectedRows !== 1) fail('optimistic_field_update_failed', { fieldID: before.ID });
}
const stateIndexes = new WeakMap();
function stateIndex(state, kind) {
    if (!stateIndexes.has(state)) stateIndexes.set(state, new Map());
    const indexes = stateIndexes.get(state);
    if (!indexes.has(kind)) indexes.set(kind, new Map(state[kind].map((row, index) => [rowKey(kind === 'profiles' ? 'profile' : kind, row), index])));
    return indexes.get(kind);
}
function replaceRow(state, kind, before, after) {
    const index = stateIndex(state, kind).get(rowKey(kind === 'profiles' ? 'profile' : kind, before));
    if (index === undefined) fail('missing_expected_state_row', { kind });
    state[kind][index] = after;
}
const changedGroups = plan => [['score', 'scores', 'benchmark_results', plan.scoreChanges],
    ['profile', 'profiles', 'user_comparison_profiles', plan.profileChanges],
    ['pending', 'pending', 'moderation_logs', plan.pendingChanges]];
function stateRow(state, kind, change) {
    return state[kind][stateIndex(state, kind).get(rowKey(kind === 'profiles' ? 'profile' : kind, change))];
}
function verifyNoLegacy(state) {
    const plan = planRunFieldPresetMigration(state);
    if (!plan.canApply || !plan.noop) fail('post_migration_legacy_or_invalid_data', { blocked: plan.blocked, summary: plan.summary });
}
async function finalVerification(db, expected, { migrated = true } = {}) {
    const current = canonicalState(await readState(db, { locking: true }));
    if (!same(fingerprint(current), fingerprint(expected))) fail('concurrent_or_unexpected_state_change');
    if (!same(current.stats, expected.stats)) fail('raw_score_count_or_sum_changed');
    if (migrated) verifyNoLegacy(current);
    return current;
}

async function applyPlan(db, schema, initial, plan, runID) {
    const expected = forkState(initial);
    const targetIDs = Object.values(plan.fieldIDs);
    for (const field of initial.fields.filter(field => targetIDs.includes(Number(field.ID)))) {
        await archive(db, runID, 'field', String(field.ID), field, plan.fieldChanges.find(change => change.ID === Number(field.ID))?.after ?? field);
    }
    for (const option of initial.options.filter(option => targetIDs.includes(Number(option.field_ID)))) {
        await archive(db, runID, 'option', String(option.ID), option, option);
    }
    for (const option of plan.optionCreates) await archive(db, runID, 'new_option', option.ref, null, option);
    for (const [kind, stateKey, , changes] of changedGroups(plan)) {
        for (const change of changes) await archive(db, runID, kind, rowKey(kind, change), stateRow(initial, stateKey, change), change.after);
    }
    const optionIDs = new Map();
    for (const option of plan.optionCreates) {
        const [insert] = await db.execute(`INSERT INTO score_field_options (field_ID, label, label_key, excluded)
            VALUES (?,?,?,?)`, [option.fieldID, option.label, option.label_key, option.excluded]);
        const ID = Number(insert.insertId);
        if (!Number.isSafeInteger(ID) || ID <= 0) fail('unsafe_inserted_option_id');
        optionIDs.set(option.ref, ID);
        const [rows] = await db.execute('SELECT * FROM score_field_options WHERE ID = ?', [insert.insertId]);
        if (rows.length !== 1 || rows[0].label !== option.label || rows[0].label_key !== option.label_key
            || Number(rows[0].field_ID) !== option.fieldID || Number(rows[0].is_active) !== 1 || Number(rows[0].excluded) !== 0
            || rows[0].created_request_ID !== null) fail('created_option_verification_failed');
        expected.options.push(rows[0]);
        await archiveAfter(db, runID, 'new_option', option.ref, rows[0]);
    }
    expected.options.sort((a, b) => BigInt(a.ID) < BigInt(b.ID) ? -1 : BigInt(a.ID) > BigInt(b.ID) ? 1 : 0);
    for (const change of plan.fieldChanges) {
        await updateField(db, change.before, change.after);
        replaceRow(expected, 'fields', change.before, change.after);
    }
    for (const [kind, stateKey, table, changes] of changedGroups(plan)) {
        for (const change of changes) {
            const before = stateRow(initial, stateKey, change);
            const after = await updateJSON(db, schema, table, before, materializePresetReferences(change.after, optionIDs));
            replaceRow(expected, stateKey, before, after);
            await archiveAfter(db, runID, kind, rowKey(kind, change), after);
        }
    }
    const final = await finalVerification(db, expected);
    await archive(db, runID, 'manifest', 'applied',
        { fingerprints: fingerprint(initial), stats: initial.stats },
        { fingerprints: fingerprint(final), stats: final.stats, summary: plan.summary, state: 'applied' });
    await db.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [MIGRATION_ID]);
    await db.commit();
    return { status: 'applied', runID, summary: plan.summary, stats: final.stats };
}

async function readArchive(db, runID) {
    const [rows] = await db.execute(`SELECT * FROM ${ARCHIVE_TABLE} WHERE migration_id = ? AND run_id = ? ORDER BY kind, object_key`, [MIGRATION_ID, runID]);
    return rows.map(row => ({ ...row, before_snapshot: row.before_snapshot === null ? null : parseMigrationJSON(row.before_snapshot),
        after_snapshot: row.after_snapshot === null ? null : parseMigrationJSON(row.after_snapshot) }));
}
async function restoreArchive(db, schema, state, entries, runID, apply) {
    const manifest = entries.find(entry => entry.kind === 'manifest' && entry.object_key === 'applied');
    if (!manifest) fail('archive_has_no_committed_data_manifest');
    if (entries.some(entry => entry.kind === 'restoration')) {
        if (state.applied) fail('restored_archive_does_not_match_current_marker');
        return { status: 'already_restored', runID, dryRun: !apply };
    }
    if (!state.applied || !same(fingerprint(state), manifest.after_snapshot.fingerprints)) fail('archive_restore_current_state_has_changed');
    const validKinds = new Set(['schema', 'field', 'option', 'new_option', 'score', 'profile', 'pending', 'manifest']);
    if (entries.some(entry => !validKinds.has(entry.kind))) fail('unsupported_archive_kind');
    const report = { status: apply ? 'restoring' : 'restore_ready', dryRun: !apply, runID,
        archiveRows: entries.length, schemaAction: 'Keep widened VARCHAR columns; never truncate labels.' };
    if (!apply) return report;
    const expected = forkState(state);
    for (const [kind, stateKey, table] of [['score', 'scores', 'benchmark_results'], ['profile', 'profiles', 'user_comparison_profiles'], ['pending', 'pending', 'moderation_logs']]) {
        for (const entry of entries.filter(entry => entry.kind === kind)) {
            const before = entry.after_snapshot;
            const old = entry.before_snapshot;
            const after = await updateJSON(db, schema, table, before, old[JSON_COLUMNS[table]]);
            // Restoring pending content still invalidates preview tokens; the audit archive stays immutable.
            replaceRow(expected, stateKey, before, after);
        }
    }
    for (const entry of entries.filter(entry => entry.kind === 'field')) {
        if (!same(entry.before_snapshot, entry.after_snapshot)) {
            await updateField(db, entry.after_snapshot, entry.before_snapshot);
            replaceRow(expected, 'fields', entry.after_snapshot, entry.before_snapshot);
        }
    }
    for (const entry of entries.filter(entry => entry.kind === 'new_option')) {
        const option = entry.after_snapshot;
        await lockedOriginal(db, 'score_field_options', option);
        const [result] = await db.execute('DELETE FROM score_field_options WHERE ID = ? AND revision = ?', [option.ID, option.revision]);
        if (result.affectedRows !== 1) fail('restore_option_delete_failed');
        expected.options = expected.options.filter(row => String(row.ID) !== String(option.ID));
    }
    const final = await finalVerification(db, expected, { migrated: false });
    if (!same(final.stats, manifest.before_snapshot.stats)) fail('archive_restore_raw_score_changed');
    const restoredFingerprints = fingerprint(final);
    // The pending timestamp is intentionally renewed. Everything else must exactly recover the baseline.
    for (const key of ['fields', 'options', 'scores', 'profiles', 'stats']) {
        if (restoredFingerprints[key] !== manifest.before_snapshot.fingerprints[key]) fail('archive_restore_baseline_mismatch', { key });
    }
    await archive(db, runID, 'restoration', 'restored', manifest.after_snapshot, { fingerprints: restoredFingerprints, stats: final.stats, state: 'restored' });
    const [deleted] = await db.execute('DELETE FROM schema_migrations WHERE migration_id = ?', [MIGRATION_ID]);
    if (deleted.affectedRows !== 1) fail('archive_restore_marker_delete_failed');
    await db.commit();
    return { ...report, status: 'restored', stats: final.stats };
}

export async function runRunFieldPresetMigration(db, { apply = false, backupConfirmed = false,
    restoreRunID = null, runID = randomUUID(), report = async () => {} } = {}) {
    if (apply && !backupConfirmed) fail('verified_external_database_backup_required');
    if (![runID, ...(restoreRunID ? [restoreRunID] : [])].every(value => /^[a-f0-9-]{36}$/i.test(value))) fail('invalid_archive_run_id');
    const acquired = [];
    let transaction = false;
    let dataCommitted = false;
    try {
        await db.query('SET SESSION innodb_lock_wait_timeout = 10');
        for (const name of LOCKS) {
            const [[lock]] = await db.execute('SELECT GET_LOCK(?, 10) AS acquired', [name]);
            if (Number(lock.acquired) !== 1) fail('migration_advisory_lock_unavailable', { lock: name });
            acquired.push(name);
        }
        await startSnapshot(db, true);
        transaction = true;
        const schema = await readSchema(db);
        if (schema.blocked.length) {
            const result = { status: 'blocked', dryRun: !apply, runID, blocked: schema.blocked };
            await report(result);
            if (apply) fail('blocked_migration_schema', { report: result });
            return result;
        }
        const raw = await readState(db);
        if (restoreRunID) {
            const state = canonicalState(raw);
            raw.scores = [];
            const entries = await readArchive(db, restoreRunID);
            const result = await restoreArchive(db, schema, state, entries, restoreRunID, false);
            await report(result);
            if (!apply || result.status === 'already_restored') return result;
            await db.rollback(); transaction = false;
            await startSnapshot(db); transaction = true;
            const fresh = canonicalState(await readState(db));
            if (!same(fingerprint(fresh), fingerprint(state)) || fresh.applied !== state.applied) fail('state_changed_since_restore_preflight');
            state.scores = [];
            const outcome = await restoreArchive(db, schema, fresh, entries, restoreRunID, true);
            transaction = false;
            dataCommitted = true;
            await report(outcome);
            return outcome;
        }
        const plan = planRunFieldPresetMigration(raw);
        const result = { status: plan.canApply ? raw.applied ? 'already_applied' : 'ready' : 'blocked',
            dryRun: !apply, runID, plan, schemaChanges: schema.widen.map(column => ({ column: column.COLUMN_NAME,
                from: Number(column.CHARACTER_MAXIMUM_LENGTH), to: 512 })), stats: raw.stats };
        if (raw.applied && (!plan.noop || schema.widen.length)) {
            result.status = 'blocked';
            result.plan.blocked.push({ code: 'migration_marker_disagrees_with_current_state' });
            result.plan.canApply = false;
            result.plan.noop = false;
            result.plan.summary.blocked = result.plan.blocked.length;
        }
        await report(result);
        if (result.status === 'blocked') {
            if (apply) fail('blocked_migration_plan', { report: result });
            return result;
        }
        if (!apply || raw.applied) return result;
        const initial = canonicalState(raw);
        raw.scores = [];
        await db.rollback(); transaction = false;
        const expanded = await prepareSchema(db, runID, schema);
        await startSnapshot(db); transaction = true;
        const fresh = canonicalState(await readState(db));
        if (!same(fingerprint(fresh), fingerprint(initial)) || fresh.applied) fail('state_changed_since_preflight');
        initial.scores = [];
        const outcome = await applyPlan(db, expanded, fresh, plan, runID);
        transaction = false;
        dataCommitted = true;
        await report(outcome);
        return outcome;
    } catch (error) {
        if (transaction) { await db.rollback(); transaction = false; }
        error.dataCommitted = dataCommitted;
        throw error;
    } finally {
        if (transaction) await db.rollback();
        for (const name of acquired.reverse()) await db.execute('SELECT RELEASE_LOCK(?) AS released', [name]);
    }
}

export function parseMigrationArgs(argv) {
    const args = { apply: false, backupConfirmed: false, output: 'artifacts/run-field-presets-20261013', restoreRunID: null };
    for (let index = 0; index < argv.length; index++) {
        const item = argv[index];
        if (item === '--apply') args.apply = true;
        else if (item === '--backup-confirmed') args.backupConfirmed = true;
        else if (item === '--dry-run') args.dryRun = true;
        else if (item === '--help') args.help = true;
        else if (item === '--output' || item === '--restore-archive') {
            const value = argv[++index];
            if (!value || value.startsWith('--')) fail('missing_argument_value', { argument: item });
            args[item === '--output' ? 'output' : 'restoreRunID'] = value;
        } else fail('unknown_migration_argument', { argument: item });
    }
    if (args.apply && args.dryRun) fail('apply_and_dry_run_are_mutually_exclusive');
    if (args.apply && !args.backupConfirmed) fail('verified_external_database_backup_required');
    return args;
}
async function main() {
    const args = parseMigrationArgs(process.argv.slice(2));
    if (args.help) {
        console.log('Usage: node scripts/migrate-run-field-presets-20261013.mjs [--dry-run | --apply --backup-confirmed] [--output DIR] [--restore-archive RUN_UUID]');
        return;
    }
    const runID = randomUUID();
    const directory = resolve(args.output, runID);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
        user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4', dateStrings: true,
        timezone: 'Z', supportBigNumbers: true, bigNumberStrings: true });
    try {
        const result = await runRunFieldPresetMigration(db, { ...args, runID, report: async value => {
            const name = ['applied', 'restored'].includes(value.status) ? 'outcome.json' : 'plan.json';
            await writeFile(resolve(directory, name), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        } });
        console.log(JSON.stringify({ status: result.status, dryRun: !args.apply, runID: result.runID, summary: result.plan?.summary ?? result.summary,
            blocked: (result.plan?.blocked ?? result.blocked ?? []).slice(0, 20), reportDirectory: directory }));
        if (result.status === 'blocked') process.exitCode = 2;
    } catch (error) {
        await writeFile(resolve(directory, 'failure.json'), `${JSON.stringify({ code: error.code, message: error.message,
            runID, restoreRunID: args.restoreRunID, dataCommitted: error.dataCommitted ?? null,
            note: 'Schema DDL may have committed; retain the backup and schema archive. A committed outcome/report-write failure requires inspection.' }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        throw error;
    } finally { await db.end(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    main().catch(error => { console.error(JSON.stringify({ code: error.code, message: error.message })); process.exitCode = 1; });
}
