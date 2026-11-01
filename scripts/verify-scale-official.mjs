#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { readScaleState, SCALE_EXPORT_COLUMNS } from './capture-scale-state.mjs';
import { buildScalePlan } from './import-scale-official.mjs';

const arg = name => process.argv.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
const socketPath = process.env.BENCHPOLL_DB_SOCKET, user = process.env.BENCHPOLL_DB_USER, database = process.env.BENCHPOLL_DB_NAME;
if (!socketPath || !user || !database || !arg('output')) throw new Error('Explicit database target and --output=<new audit> required.');
const connection = await mysql.createConnection({ socketPath, user, database, dateStrings: true, charset: 'utf8mb4' });
try {
    await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [triggers] = await connection.query('SHOW TRIGGERS');
    for (const table of Object.keys(SCALE_EXPORT_COLUMNS)) for (const event of ['INSERT', 'UPDATE', 'DELETE']) {
        const trigger = triggers.find(t => t.Trigger === `bp_rank_${table}_${event.toLowerCase()}`);
        assert.ok(trigger && trigger.Table === table && trigger.Event === event && trigger.Timing === 'AFTER'
            && /UPDATE ranking_cache_revisions SET data_revision/i.test(trigger.Statement), `Missing invalidation trigger: ${table} ${event}`);
    }
    const [cache] = await connection.query('SELECT * FROM ranking_cache_revisions ORDER BY ID');
    assert.equal(cache.length, 2); assert.ok(cache.every(c => Number(c.ready) === 1));
    const report = { schemaVersion: 1, verified: true, capturedAt: new Date().toISOString(),
        committedBusinessWrites: 0, cache, cacheTriggersVerified: Object.keys(SCALE_EXPORT_COLUMNS).length * 3 };
    if (arg('snapshot')) {
        const bytes = await readFile(arg('snapshot')), snapshot = JSON.parse(bytes.toString('utf8'));
        const snapshotHash = createHash('sha256').update(bytes).digest('hex');
        const state = await readScaleState(connection), plan = buildScalePlan(snapshot, state, snapshotHash);
        const conditionIDs = new Set(plan.rows.map(row => row.conditionRef));
        for (const condition of state.tables.benchmark_conditions.filter(row => conditionIDs.has(Number(row.ID)))) {
            const literalDefault = String(condition.name).trim().replace(/\s+/g, ' ').toLocaleLowerCase('en-US') === 'default';
            assert.equal(Boolean(Number(condition.is_default)), literalDefault, `Invalid default marker: ${condition.ID}`);
            assert.equal(condition.condition_key === 'default', literalDefault, `Invalid default key: ${condition.ID}`);
        }
        report.defaultInvariantsVerified = conditionIDs.size;
        assert.equal(plan.canApply, true); assert.ok(plan.rows.every(r => r.action === 'unchanged'));
        assert.ok(Object.values(plan.creates).every(rows => rows.length === 0));
        assert.ok(Object.values(plan.updates).every(rows => rows.length === 0)); assert.equal(plan.cleanup.length, 0);
        const receipt = JSON.parse(await readFile(arg('receipt'), 'utf8'));
        assert.equal(receipt.snapshotHash, snapshotHash); assert.equal(receipt.transactionState, 'committed');
        report.importCounts = receipt.counts;
        report.verifiedScores = plan.rows.length;
        report.acceptedScores = plan.rows.filter(r => r.status === 'accepted').length;
        report.archivedScores = plan.rows.filter(r => r.status === 'archived').length;
        report.idempotent = true;
        report.benchmarks = [...new Set(plan.rows.map(r => r.benchmarkRef))].map(ID => ({
            ID, name: state.tables.benchmarks.find(b => Number(b.ID) === ID).name,
            versions: snapshot.versions.filter(v => plan.rows.some(r => r.metricKey === v.key && r.benchmarkRef === ID)).map(v => {
                const rows = plan.rows.filter(r => r.metricKey === v.key), condition = state.tables.benchmark_conditions.find(c => Number(c.ID) === rows[0].conditionRef);
                return { key: v.key, ID: condition.ID, name: condition.name, scores: rows.length,
                    distinctModels: new Set(rows.map(r => r.modelRef)).size, isPrimary: Boolean(condition.is_primary), direction: v.direction,
                    archived: Boolean(v.archived), sourceURL: rows[0].sourceURL, explanation: condition.difference_explanation };
            })
        }));
    }
    await writeFile(arg('output'), JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    console.log(JSON.stringify({ verified: report.verified, cacheTriggersVerified: report.cacheTriggersVerified, cache,
        acceptedScores: report.acceptedScores, archivedScores: report.archivedScores, benchmarks: report.benchmarks?.length,
        versions: report.benchmarks?.reduce((n, b) => n + b.versions.length, 0), idempotent: report.idempotent }));
} finally { await connection.rollback(); await connection.end(); }
