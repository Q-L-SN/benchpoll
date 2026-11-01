#!/usr/bin/env node

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { initPool, pool } from '../db.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: node scripts/profile-score-configuration.mjs <output.json.gz>');

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [rows] = await connection.query(`
        SELECT c.ID AS conditionID, c.benchmark_ID AS benchmarkID, c.name AS conditionName,
               b.name AS benchmarkName, c.score_direction, c.target_value,
               c.uses_percentage_scale, c.score_min, c.score_max,
               r.ID AS resultID, r.model_ID AS modelID, r.score_fields AS scoreFields
        FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID AND b.is_active = 1
        JOIN benchmark_results r ON r.benchmark_condition_ID = c.ID
        WHERE c.deleted_at IS NULL
          AND c.name REGEXP '(^|;[[:space:]]*)(harness|first_stage|configuration|model_variant|agent|route|tools|client)='
        ORDER BY c.ID, r.ID`);
    await writeFile(outputPath, gzipSync(JSON.stringify(rows)));
    await connection.commit();
    console.log(JSON.stringify({ results: rows.length, conditions: new Set(rows.map(row => Number(row.conditionID))).size,
        outputPath }));
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
    await pool.end();
}
