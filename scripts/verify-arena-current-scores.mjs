import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';
import { currentScoreSQL } from '../score-aggregation.js';

const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root',
    database: 'benchmarks', charset: 'utf8mb4', dateStrings: true, timezone: 'Z' });
const output = new URL('../artifacts/arena-current-verification/', import.meta.url);
const hash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
try {
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [tracked] = await connection.query(`SELECT a.row_key,a.result_ID,a.source_hash,a.source_revision,a.config,
        a.category,a.model_key,a.source_date,r.model_ID,r.benchmark_ID,r.benchmark_condition_ID,r.raw_score,
        r.source_url,r.source_type,r.source_title,r.notes,r.benchmark_condition_snapshot,r.score_fields,r.status
        FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID ORDER BY a.row_key`);
    const [statusCounts] = await connection.query('SELECT status,COUNT(*) count FROM benchmark_results GROUP BY status ORDER BY status');
    const [[weights]] = await connection.query('SELECT COUNT(*) count,COALESCE(SUM(weight_basis_points),0) total FROM personal_pie_weights');
    const [[fallbacks]] = await connection.query('SELECT COUNT(*) count FROM personal_pie_score_rule_components');
    const report = { trackedResults: tracked.length, currentTracked: tracked.filter(row => row.status === 'accepted').length,
        scoreDigest: hash(tracked), statusCounts, personalWeights: weights, fallbackCount: fallbacks.count };
    if (process.argv.includes('--after')) {
        const before = JSON.parse(await readFile(new URL('before.json', output), 'utf8'));
        assert.deepEqual(report, before, 'Migration must not alter scores, source identities or personal weights');
        const [current] = await connection.query(`SELECT b.* FROM arena_sync_state s
            JOIN arena_sync_batches b ON b.ID=s.current_batch_ID WHERE s.ID=1`);
        assert.equal(current.length, 1);
        assert.equal(current[0].status, 'succeeded');
        const [[managed]] = await connection.query(`SELECT COUNT(DISTINCT c.ID) count
            FROM benchmark_conditions c JOIN benchmark_results r ON r.benchmark_condition_ID=c.ID
            JOIN arena_import_rows a ON a.result_ID=r.ID WHERE c.score_source='arena_official'`);
        const [[missing]] = await connection.query(`SELECT COUNT(*) count FROM arena_import_rows a
            JOIN benchmark_results r ON r.ID=a.result_ID JOIN benchmark_conditions c ON c.ID=r.benchmark_condition_ID
            WHERE c.score_source IS NULL OR c.score_source<>'arena_official' OR a.manual_override<>'none'`);
        assert.equal(Number(missing.count), 0);
        const [[history]] = await connection.query(`SELECT COUNT(*) count FROM benchmark_results
            WHERE ${currentScoreSQL()} AND status IN ('superseded','archived')`);
        assert.equal(Number(history.count), 0);
        Object.assign(report, { passed: true, currentBatchID: current[0].ID,
            sourceRevision: current[0].source_revision, managedConditions: Number(managed.count),
            historicalRowsUsed: Number(history.count), existingScoresUnchanged: true });
    }
    await connection.commit();
    await mkdir(output, { recursive: true });
    await writeFile(new URL(process.argv.includes('--after') ? 'after.json' : 'before.json', output), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
} catch (error) {
    await connection.rollback();
    throw error;
} finally { await connection.end(); }
