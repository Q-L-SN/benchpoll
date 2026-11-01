import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import mysql from 'mysql2/promise';
import { migrateArenaSyncSchema } from './migrate-arena-sync-state.mjs';
import { ARENA_DATASET_URL, ARENA_SNAPSHOT_VERSION } from '../arena-sync.js';
import { loadModels, loadBenchmarkConditions } from '../ranking-service.js';
import { assertScoreSourcePolicy, recordSyncedScoreEdit, recordSyncedScoreDeletion } from '../score-source-policy.js';

const database = 'benchpoll_arena_rehearsal_20261003';
const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock',
    user: 'root', database: 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z' });
const output = new URL('../artifacts/arena-rehearsal/', import.meta.url);
await mkdir(output, { recursive: true });
let created = false;
const checks = [];
function fixture({ revision = 'a'.repeat(40), date = '2026-09-24', rating = 1300,
    sourceModifiedAt = '2026-09-24T12:00:00.000Z', names = ['sync-fixture-a', 'sync-fixture-b', 'sync-fixture-c'] } = {}) {
    const rows = names.map((model_name, index) => ({ model_name, organization: 'openai', category: 'overall',
        rating: rating + index, leaderboard_publish_date: date }));
    return { schemaVersion: ARENA_SNAPSHOT_VERSION, source: ARENA_DATASET_URL, license: 'CC-BY-4.0', revision,
        sourceModifiedAt, fetchedAt: '2026-10-03T12:00:00.000Z', expectedConfigs: ['text_style_control'],
        configs: [{ config: 'text_style_control', rows,
            checksums: [{ filename: 'latest/fixture.parquet', sha256: '1'.repeat(64), size: 100, rows: rows.length }] }] };
}
async function runImport(snapshot, failure = null) {
    const file = new URL(`batch-${snapshot.revision}.json`, output);
    await writeFile(file, JSON.stringify(snapshot));
    const child = spawnSync(process.execPath, ['scripts/import-arena-latest.mjs', file.pathname,
        '--apply', '--backup-confirmed'], { cwd: new URL('../', import.meta.url), encoding: 'utf8',
        env: { ...process.env, BENCHPOLL_DB_NAME: database, BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_PASSWORD: '' } });
    if (failure) {
        assert.notEqual(child.status, 0, 'Expected import failure');
        assert.match(child.stderr, failure);
        return;
    }
    assert.equal(child.status, 0, child.stderr);
    return JSON.parse(child.stdout);
}
async function state() {
    const [rows] = await connection.query('SELECT ID,raw_score,status FROM benchmark_results ORDER BY ID');
    const [current] = await connection.query('SELECT current_batch_ID FROM arena_sync_state');
    const [tracked] = await connection.query('SELECT result_ID,source_hash,source_revision,manual_override FROM arena_import_rows ORDER BY row_key');
    return { rows, current, tracked };
}
try {
    await connection.query(`CREATE DATABASE ${database}`);
    created = true;
    for (const table of ['organizations', 'models', 'benchmarks', 'benchmark_conditions', 'benchmark_tags',
        'benchmark_tag_links', 'benchmark_results', 'personal_pie_weights', 'personal_pie_score_rule_components']) {
        await connection.query(`CREATE TABLE ${database}.${table} LIKE benchmarks.${table}`);
    }
    await connection.query(`USE ${database}`);
    await migrateArenaSyncSchema(connection);
    await connection.execute("INSERT INTO benchmark_tags (tag_key,name) VALUES ('arena','Arena')");
    const first = await runImport(fixture());
    assert.equal(first.insertedResults, 3);
    const repeated = await runImport(fixture());
    assert.equal(repeated.insertedResults, 0);
    assert.equal(repeated.unchangedResults, 3);
    checks.push('complete import and idempotent repeat');

    const changedSnapshot = fixture({ revision: 'b'.repeat(40), sourceModifiedAt: '2026-09-25T12:00:00.000Z',
        rating: 1400, names: ['sync-fixture-a', 'sync-fixture-b'] });
    const changed = await runImport(changedSnapshot);
    assert.equal(changed.replacedResults, 2);
    assert.equal(changed.retiredResults, 1);
    const afterChanged = await state();
    assert.equal(afterChanged.rows.filter(row => row.status === 'accepted').length, 2);
    assert.equal(afterChanged.rows.filter(row => row.status === 'superseded').length, 3);
    const models = await loadModels(connection, []);
    const scored = models.filter(model => model.results.size);
    assert.equal(scored.length, 2);
    assert.equal(models.find(model => model.modelName === 'sync-fixture-c').results.size, 0);
    for (const model of scored) assert.equal([...model.results.values()][0].sampleCount, 1);
    const [[condition]] = await connection.query('SELECT * FROM benchmark_conditions');
    const conditions = await loadBenchmarkConditions(connection, { includeConditionIDs: [Number(condition.ID)] });
    assert.equal(conditions[0].scoreCount, 2);
    checks.push('replacement and retirement exclude historical scores from ranking and coverage');

    const [external] = await connection.execute(`INSERT INTO benchmark_results
        (model_ID,benchmark_ID,benchmark_condition_ID,raw_score,source_url,source_type,benchmark_condition_snapshot,score_fields)
        SELECT model_ID,benchmark_ID,benchmark_condition_ID,999,source_url,source_type,benchmark_condition_snapshot,score_fields
        FROM benchmark_results WHERE status='accepted' LIMIT 1`);
    const withExternal = await state();
    await runImport(changedSnapshot, /untracked current scores; explicit review/);
    assert.deepEqual(await state(), withExternal);
    await connection.execute('DELETE FROM benchmark_results WHERE ID=?', [external.insertId]);
    checks.push('untracked manual samples cannot silently mix into a managed leaderboard');

    await runImport(fixture(), /Older or unordered/);
    assert.deepEqual(await state(), afterChanged);
    const partial = fixture({ revision: 'c'.repeat(40), sourceModifiedAt: '2026-09-26T12:00:00.000Z' });
    partial.expectedConfigs.push('vision');
    await runImport(partial, /manifest is incomplete/);
    assert.deepEqual(await state(), afterChanged);
    checks.push('older and incomplete batches preserve the last published batch');

    await connection.query(`CREATE TRIGGER fail_arena_fixture BEFORE INSERT ON benchmark_results
        FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='fixture write failure'`);
    await runImport(fixture({ revision: 'c'.repeat(40), sourceModifiedAt: '2026-09-26T12:00:00.000Z', rating: 1450 }), /fixture write failure/);
    assert.deepEqual(await state(), afterChanged);
    const [[failed]] = await connection.query("SELECT COUNT(*) count FROM arena_sync_batches WHERE status='failed'");
    assert.ok(Number(failed.count) >= 2);
    await connection.query('DROP TRIGGER fail_arena_fixture');
    checks.push('real SQL write failures roll back scores and keep failure audit records');

    await assert.rejects(assertScoreSourcePolicy(connection, condition), error => error.body?.error === 'dynamic_scores_are_synced');
    const oldID = Number(afterChanged.tracked[0].result_ID);
    await connection.beginTransaction();
    await assertScoreSourcePolicy(connection, condition, { editingResultID: oldID });
    await connection.execute("UPDATE benchmark_results SET status='superseded' WHERE ID=?", [oldID]);
    const [inserted] = await connection.execute(`INSERT INTO benchmark_results
        (model_ID,benchmark_ID,benchmark_condition_ID,raw_score,source_url,source_type,benchmark_condition_snapshot,score_fields)
        SELECT model_ID,benchmark_ID,benchmark_condition_ID,1200,source_url,source_type,benchmark_condition_snapshot,score_fields
        FROM benchmark_results WHERE ID=?`, [oldID]);
    await recordSyncedScoreEdit(connection, oldID, Number(inserted.insertId));
    await connection.commit();
    const corrected = await runImport(changedSnapshot);
    assert.equal(corrected.manualCorrections, 1);
    assert.equal(corrected.insertedResults, 0);
    const [[other]] = await connection.query('SELECT result_ID FROM arena_import_rows WHERE result_ID<>?', [inserted.insertId]);
    await connection.beginTransaction();
    await connection.execute("UPDATE benchmark_results SET status='superseded' WHERE ID=?", [other.result_ID]);
    await recordSyncedScoreDeletion(connection, other.result_ID);
    await connection.commit();
    const deleted = await runImport(changedSnapshot);
    assert.equal(deleted.manualCorrections, 1);
    assert.equal(deleted.suppressedResults, 1);
    assert.equal(deleted.insertedResults, 0);
    const manuallyReviewed = await state();
    await runImport(fixture({ revision: 'd'.repeat(40), sourceModifiedAt: '2026-09-27T12:00:00.000Z', rating: 1460 }), /manual correction; review required/);
    assert.deepEqual(await state(), manuallyReviewed);
    checks.push('manual corrections and deletions survive unchanged syncs; changed source requires review');
    console.log(JSON.stringify({ passed: true, isolatedDatabase: database, checks, productionScoresChanged: 0 }));
} finally {
    await connection.query('USE benchmarks');
    if (created) await connection.query(`DROP DATABASE ${database}`);
    await connection.end();
}
