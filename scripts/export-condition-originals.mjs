#!/usr/bin/env node

import 'dotenv/config';
import { writeFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { initPool, pool } from '../db.js';

const benchmarkName = process.argv[2];
const outputPath = process.argv[3];
if (!benchmarkName || !outputPath) {
    throw new Error('Usage: node scripts/export-condition-originals.mjs <benchmark-name> <output.json.gz>');
}

function originalName(notes) {
    try {
        const value = typeof notes === 'string' ? JSON.parse(notes) : notes;
        return typeof value?.original_benchmark_condition === 'string'
            ? value.original_benchmark_condition : null;
    } catch {
        return null;
    }
}

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const [rows] = await connection.query(`SELECT c.ID AS conditionID, c.name AS currentName,
        r.ID AS resultID, r.model_ID AS modelID, r.raw_score AS rawScore,
        r.source_url AS sourceURL, r.notes, r.score_fields AS scoreFields
        FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID
        LEFT JOIN benchmark_results r ON r.benchmark_condition_ID = c.ID
        WHERE b.name = ? AND c.deleted_at IS NULL ORDER BY c.ID, r.ID`, [benchmarkName]);
    const evidence = rows.map(row => ({ conditionID: Number(row.conditionID), currentName: row.currentName,
        resultID: row.resultID == null ? null : Number(row.resultID),
        modelID: row.modelID == null ? null : Number(row.modelID), rawScore: row.rawScore,
        sourceURL: row.sourceURL, originalName: originalName(row.notes), scoreFields: row.scoreFields }));
    await writeFile(outputPath, gzipSync(JSON.stringify({ benchmarkName, evidence })));
    await connection.commit();
    console.log(JSON.stringify({ benchmarkName, conditions: new Set(evidence.map(row => row.conditionID)).size,
        results: evidence.filter(row => row.resultID != null).length, outputPath }));
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    connection.release();
    await pool.end();
}
