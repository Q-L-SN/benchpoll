#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const BATCH_ID = 'aa-archive-2026-09-26';
const BENCHMARK_ID = 1795;
const CONDITION_ID = 20274;
const AA_RESULT_ID = 54942;
const APPLY = process.argv.includes('--apply');

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined && !process.env.BENCHPOLL_DB_SOCKET) {
        throw new Error('Database credentials are unavailable.');
    }
    return {
        socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks'
    };
}

function assertOne(rows, description) {
    if (rows.length !== 1) throw new Error(`Expected one ${description}; found ${rows.length}.`);
    return rows[0];
}

async function readState(connection, lockRows = false, hasRestoredAt = true) {
    const suffix = lockRows ? ' FOR UPDATE' : '';
    const restoredColumn = hasRestoredAt ? 'restored_at' : 'NULL AS restored_at';
    const [benchmarkRows] = await connection.execute(
        `SELECT ID, name, is_active FROM benchmarks WHERE ID = ?${suffix}`, [BENCHMARK_ID]);
    const [conditionRows] = await connection.execute(
        `SELECT ID, benchmark_ID, deleted_at FROM benchmark_conditions WHERE ID = ?${suffix}`,
        [CONDITION_ID]);
    const [resultRows] = await connection.execute(
        `SELECT ID, benchmark_ID, benchmark_condition_ID, status, source_url
         FROM benchmark_results WHERE ID = ?${suffix}`, [AA_RESULT_ID]);
    const [archiveRows] = await connection.execute(
        `SELECT entity_type, object_id, original_state, reason, ${restoredColumn}
         FROM aa_data_archive_items WHERE batch_id = ? AND
         ((entity_type = 'benchmark' AND object_id = ?) OR
          (entity_type = 'condition' AND object_id = ?))${suffix}`,
        [BATCH_ID, BENCHMARK_ID, CONDITION_ID]);

    const benchmark = assertOne(benchmarkRows, 'GDP.pdf benchmark');
    const condition = assertOne(conditionRows, 'GDP.pdf condition');
    const result = assertOne(resultRows, 'AA-sourced GDP.pdf result');
    if (benchmark.name !== 'gdp-pdf' || Number(condition.benchmark_ID) !== BENCHMARK_ID
        || Number(result.benchmark_ID) !== BENCHMARK_ID
        || Number(result.benchmark_condition_ID) !== CONDITION_ID
        || result.status !== 'archived'
        || new URL(result.source_url).hostname !== 'artificialanalysis.ai') {
        throw new Error('GDP.pdf objects or AA result differ from the audited archive.');
    }
    if (archiveRows.length !== 2) throw new Error('The two GDP.pdf archive entries are missing.');
    for (const row of archiveRows) {
        const original = typeof row.original_state === 'string'
            ? JSON.parse(row.original_state) : row.original_state;
        if (row.entity_type === 'benchmark' && Number(original.isActive) !== 1) {
            throw new Error(`Archive original state is not active: ${row.entity_type}.`);
        }
    }
    if (condition.deleted_at !== null) throw new Error('GDP.pdf condition was explicitly deleted.');
    const restored = Number(benchmark.is_active) === 1
        && archiveRows.every(row => row.restored_at !== null);
    const archived = Number(benchmark.is_active) === 0
        && archiveRows.every(row => row.restored_at === null);
    if (!restored && !archived) throw new Error('GDP.pdf is partially restored; inspect manually.');
    return { restored, benchmark, condition, result };
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [BATCH_ID]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire AA archive lock.');
    try {
        const [columnRows] = await connection.query(
            "SHOW COLUMNS FROM aa_data_archive_items LIKE 'restored_at'");
        let hasRestoredAt = columnRows.length === 1;
        if (APPLY && !hasRestoredAt) {
            await connection.query('ALTER TABLE aa_data_archive_items ADD COLUMN restored_at DATETIME NULL');
            hasRestoredAt = true;
        }
        if (APPLY) await connection.beginTransaction();
        try {
            const state = await readState(connection, APPLY, hasRestoredAt);
            if (APPLY && !state.restored) {
                const [benchmarkUpdate] = await connection.execute(
                    'UPDATE benchmarks SET is_active = 1 WHERE ID = ? AND is_active = 0',
                    [BENCHMARK_ID]);
                const [auditUpdate] = await connection.execute(
                    `UPDATE aa_data_archive_items SET restored_at = UTC_TIMESTAMP()
                     WHERE batch_id = ? AND restored_at IS NULL AND
                     ((entity_type = 'benchmark' AND object_id = ?) OR
                      (entity_type = 'condition' AND object_id = ?))`,
                    [BATCH_ID, BENCHMARK_ID, CONDITION_ID]);
                if (benchmarkUpdate.affectedRows !== 1 || auditUpdate.affectedRows !== 2) {
                    throw new Error('GDP.pdf restoration changed an unexpected number of rows.');
                }
            }
            if (APPLY) await connection.commit();
            console.log(JSON.stringify({ dryRun: !APPLY, restored: APPLY || state.restored,
                readyToRestore: !APPLY && !state.restored, auditColumnPresent: hasRestoredAt,
                benchmarkID: BENCHMARK_ID, conditionID: CONDITION_ID,
                aaResultID: AA_RESULT_ID, aaResultStatus: state.result.status }));
        } catch (error) {
            if (APPLY) await connection.rollback();
            throw error;
        }
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [BATCH_ID]);
    }
} finally {
    await connection.end();
}
