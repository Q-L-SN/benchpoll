#!/usr/bin/env node

import 'dotenv/config';
import { performance } from 'node:perf_hooks';
import { initPool, pool } from '../db.js';
const { loadBenchmarkConditions } = await import(process.env.CONDITION_RANKING_MODULE || '../ranking-service.js');

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
try {
    const [columns] = await connection.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_conditions'
          AND COLUMN_NAME IN ('is_active', 'deleted_at')`);
    const names = new Set(columns.map(row => row.COLUMN_NAME));
    if (names.has('is_active') || !names.has('deleted_at')) {
        throw new Error('Benchmark conditions are not on the statusless schema.');
    }
    const [[counts]] = await connection.query(`SELECT
        COUNT(*) AS total,
        SUM(b.is_active = 1 AND c.deleted_at IS NULL) AS visible,
        SUM(b.is_active = 1 AND c.deleted_at IS NULL AND EXISTS (
            SELECT 1 FROM benchmark_results r WHERE r.benchmark_condition_ID = c.ID
        ) AND NOT EXISTS (
            SELECT 1 FROM benchmark_results r WHERE r.benchmark_condition_ID = c.ID
              AND r.status = 'accepted'
        )) AS archivedOnlyVisible,
        SUM(c.deleted_at IS NOT NULL) AS deleted
        FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID`);
    const [[invalid]] = await connection.query(`SELECT COUNT(*) AS count FROM benchmark_results r
        JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
        WHERE r.status = 'accepted' AND c.deleted_at IS NOT NULL`);
    if (Number(invalid.count)) throw new Error(`${invalid.count} accepted scores reference deleted conditions.`);
    const started = performance.now();
    const candidates = await loadBenchmarkConditions(connection);
    const queryMs = Math.round(performance.now() - started);
    console.log(JSON.stringify({
        total: Number(counts.total), visible: Number(counts.visible),
        archivedOnlyVisible: Number(counts.archivedOnlyVisible), deleted: Number(counts.deleted),
        leaderboardCandidates: candidates.length, queryMs
    }));
} finally {
    connection.release();
    await pool.end();
}
