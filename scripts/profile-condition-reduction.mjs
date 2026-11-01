#!/usr/bin/env node

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { initPool, pool } from '../db.js';

const outputPath = process.argv[2];
if (!outputPath) throw new Error('Usage: node scripts/profile-condition-reduction.mjs <output.json.gz>');

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [conditions] = await connection.query(`
        SELECT c.ID, c.benchmark_ID, b.name AS benchmark_name, c.name,
               c.is_default, c.deleted_at, c.score_direction, c.target_value,
               c.uses_percentage_scale, c.score_min, c.score_max,
               COUNT(r.ID) AS result_count,
               COUNT(DISTINCT CASE WHEN r.status = 'accepted' AND m.is_active = 1
                   THEN r.model_ID END) AS model_count
        FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID AND b.is_active = 1
        LEFT JOIN benchmark_results r ON r.benchmark_condition_ID = c.ID
        LEFT JOIN models m ON m.ID = r.model_ID
        WHERE c.deleted_at IS NULL
        GROUP BY c.ID
        ORDER BY c.benchmark_ID, c.ID`);
    await writeFile(outputPath, gzipSync(JSON.stringify(conditions)));
    await connection.commit();
    console.log(JSON.stringify({ conditions: conditions.length, outputPath }));
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
    await pool.end();
}
