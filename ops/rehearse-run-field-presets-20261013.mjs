import 'dotenv/config';
import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { randomUUID } from 'node:crypto';
import { runRunFieldPresetMigration } from '../scripts/migrate-run-field-presets-20261013.mjs';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';

if (process.platform !== 'linux' || process.cwd() !== '/home/ubuntu/benchpoll') throw new Error('Unexpected rehearsal host or directory');
const source = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
const target = `benchpoll_run_fields_20261013_${randomUUID().slice(0, 8)}`;
if (!/^[a-zA-Z0-9_]+$/.test(source) || !/^benchpoll_run_fields_20261013_[a-f0-9]{8}$/.test(target) || target === source) throw new Error('Unsafe rehearsal database');
const db = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database: source, charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, timezone: 'Z' });
try {
    const [before] = await db.query(`SELECT ID, name, field_type, revision, is_active FROM \`${source}\`.score_fields ORDER BY ID`);
    await db.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    for (const table of ['score_fields', 'score_field_options', 'benchmark_results', 'user_comparison_profiles', 'moderation_logs', 'schema_migrations']) {
        await db.query(`CREATE TABLE \`${target}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
    }
    for (const table of ['score_fields', 'score_field_options', 'schema_migrations']) {
        await db.query(`INSERT INTO \`${target}\`.\`${table}\` SELECT * FROM \`${source}\`.\`${table}\``);
    }
    const IDs = new Set();
    for (const fieldID of [1, 9, 20]) {
        const [rows] = await db.execute(`SELECT /*+ MAX_EXECUTION_TIME(10000) */ ID FROM \`${source}\`.benchmark_results
            WHERE JSON_CONTAINS(score_fields, JSON_OBJECT('fieldID', ?)) ORDER BY ID LIMIT 16`, [fieldID]);
        rows.forEach(row => IDs.add(String(row.ID)));
    }
    assert.ok(IDs.size >= 16);
    await db.execute(`INSERT INTO \`${target}\`.benchmark_results SELECT * FROM \`${source}\`.benchmark_results
        WHERE ID IN (${[...IDs].map(() => '?').join(',')})`, [...IDs]);
    await db.query(`USE \`${target}\``);
    const dry = await runRunFieldPresetMigration(db);
    assert.equal(dry.status, 'ready', JSON.stringify(dry.plan?.blocked));
    const applied = await runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true });
    assert.equal(applied.status, 'applied');
    assert.deepEqual(applied.stats, dry.stats);
    const fields = await loadScoreFieldCatalog(db);
    assert.equal(fields[0].name, 'Effort'); assert.equal(fields[1].name, 'Harness');
    const [scores] = await db.query('SELECT score_fields FROM benchmark_results ORDER BY ID');
    for (const score of scores) normalizeScoreFields(score.score_fields, fields);
    assert.equal((await runRunFieldPresetMigration(db)).status, 'already_applied');
    const restoreDry = await runRunFieldPresetMigration(db, { restoreRunID: applied.runID });
    assert.equal(restoreDry.status, 'restore_ready');
    const restored = await runRunFieldPresetMigration(db, { apply: true, backupConfirmed: true, restoreRunID: applied.runID });
    assert.equal(restored.status, 'restored'); assert.deepEqual(restored.stats, dry.stats);
    assert.equal((await runRunFieldPresetMigration(db)).status, 'ready');
    assert.equal((await runRunFieldPresetMigration(db, { restoreRunID: applied.runID })).status, 'already_restored');
    const [after] = await db.query(`SELECT ID, name, field_type, revision, is_active FROM \`${source}\`.score_fields ORDER BY ID`);
    assert.deepEqual(after, before, 'Production catalog must remain unchanged');
    console.log(JSON.stringify({ rehearsalDatabase: target, sampleScores: IDs.size, dryRun: true, applied: true,
        validAssignments: true, idempotent: true, archiveRestored: true, productionCatalogUnchanged: true, productionWrites: 0 }));
} finally { await db.end(); }
