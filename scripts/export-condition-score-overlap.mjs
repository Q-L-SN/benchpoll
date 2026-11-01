#!/usr/bin/env node
import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { initPool, pool } from '../db.js';

const output = process.argv[2];
if (!output || process.argv.length !== 3) {
    throw new Error('Usage: node scripts/export-condition-score-overlap.mjs <snapshot.json.gz>');
}
initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [[clock]] = await connection.query('SELECT UTC_TIMESTAMP() AS snapshotTime');
    const [conditions] = await connection.query(`SELECT c.ID, c.benchmark_ID, b.name AS benchmark_name,
        c.name, c.is_default, c.score_direction, c.target_value, c.uses_percentage_scale, c.score_min, c.score_max,
        c.deleted_at AS deleted_at, b.is_active AS benchmark_active
        FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID
        ORDER BY c.benchmark_ID, c.ID`);
    const [results] = await connection.query(`SELECT r.ID, r.benchmark_condition_ID AS conditionID,
        r.model_ID AS modelID, m.name AS modelName, CAST(r.raw_score AS CHAR) AS rawScore,
        r.score_fields AS fields, r.source_url AS sourceURL, r.status AS scoreStatus
        FROM benchmark_results r JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
        JOIN benchmarks b ON b.ID = c.benchmark_ID JOIN models m ON m.ID = r.model_ID
        ORDER BY c.benchmark_ID, c.ID, r.model_ID, r.ID`);
    const [fields] = await connection.query('SELECT ID, name, field_type AS type FROM score_fields ORDER BY ID');
    const [options] = await connection.query('SELECT ID, field_ID AS fieldID, label FROM score_field_options ORDER BY ID');
    await connection.commit();
    await writeFile(output, gzipSync(JSON.stringify({ version: 2, snapshotTime: clock.snapshotTime,
        mode: 'all-conditions', conditions, results, fields, options })));
    console.log(JSON.stringify({ output, mode: 'all-conditions',
        conditions: conditions.length, results: results.length }));
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
    await pool.end();
}
