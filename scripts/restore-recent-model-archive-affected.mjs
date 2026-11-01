#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const BATCH_ID = 'recent-model-archive-2026-09-27';
const RESTORE_LABEL = 'huggingface_model_identity_correction';
const args = new Map(process.argv.slice(2).map(arg => {
    const split = arg.indexOf('=');
    return split < 0 ? [arg, true] : [arg.slice(0, split), arg.slice(split + 1)];
}));
const apply = args.has('--apply');
const modelIDs = String(args.get('--model-ids') ?? '').split(',').map(Number);
const expectedConditions = Number(args.get('--expect-conditions'));
const expectedResults = Number(args.get('--expect-results'));
const expectedBenchmarks = Number(args.get('--expect-benchmarks'));
if (!modelIDs.length || modelIDs.some(id => !Number.isSafeInteger(id) || id < 1)
    || new Set(modelIDs).size !== modelIDs.length
    || ![expectedConditions, expectedResults, expectedBenchmarks]
        .every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error('Provide --model-ids and expected condition/result/benchmark counts.');
}

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
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks',
        charset: 'utf8mb4'
    };
}

function originalState(value) {
    return typeof value === 'string' ? JSON.parse(value) : value;
}

async function loadAffected(connection, lockRows = false) {
    const suffix = lockRows ? ' FOR UPDATE' : '';
    const [conditions] = await connection.query(`SELECT DISTINCT c.ID, c.benchmark_ID,
            c.deleted_at, a.original_state
        FROM benchmark_conditions c
        JOIN recent_model_archive_items a ON a.batch_id = ?
            AND a.entity_type = 'condition' AND a.object_id = c.ID
        JOIN benchmark_results r ON r.benchmark_condition_ID = c.ID
        WHERE r.model_ID IN (?)${suffix}`, [BATCH_ID, modelIDs]);
    if (conditions.some(row => row.deleted_at !== null
        || Number(originalState(row.original_state).benchmarkID) !== Number(row.benchmark_ID))) {
        throw new Error('Affected condition identity changed or was explicitly deleted.');
    }
    const conditionIDs = conditions.map(row => Number(row.ID));
    if (!conditionIDs.length) throw new Error('No affected archived conditions found.');
    const [results] = await connection.query(`SELECT r.ID, r.status, a.original_state
        FROM benchmark_results r JOIN recent_model_archive_items a
            ON a.batch_id = ? AND a.entity_type = 'result' AND a.object_id = r.ID
        WHERE r.benchmark_condition_ID IN (?)${suffix}`, [BATCH_ID, conditionIDs]);
    if (results.some(row => row.status !== 'archived'
        || originalState(row.original_state).status !== 'accepted')) {
        throw new Error('Affected score no longer has the expected archived state.');
    }
    const benchmarkIDs = [...new Set(conditions.map(row => Number(row.benchmark_ID)))];
    const [benchmarks] = await connection.query(`SELECT b.ID, b.is_active, a.original_state
        FROM benchmarks b JOIN recent_model_archive_items a
            ON a.batch_id = ? AND a.entity_type = 'benchmark' AND a.object_id = b.ID
        WHERE b.ID IN (?)${suffix}`, [BATCH_ID, benchmarkIDs]);
    if (benchmarks.some(row => Number(row.is_active) !== 0
        || Number(originalState(row.original_state).isActive) !== 1)) {
        throw new Error('Affected benchmark no longer has the expected archived state.');
    }
    if (conditions.length !== expectedConditions || results.length !== expectedResults
        || benchmarks.length !== expectedBenchmarks) {
        throw new Error(`Restoration candidates changed: ${JSON.stringify({
            conditions: conditions.length, results: results.length, benchmarks: benchmarks.length
        })}`);
    }
    return { conditions, results, benchmarks };
}

async function updateRows(connection, table, column, ids, before, after) {
    if (!ids.length) return;
    const [result] = await connection.query(`UPDATE ${table} SET ${column} = ?
        WHERE ${column} = ? AND ID IN (?)`, [after, before, ids]);
    if (result.affectedRows !== ids.length) {
        throw new Error(`${table}: updated ${result.affectedRows} rows, expected ${ids.length}.`);
    }
}

async function ensureRestoreLog(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS recent_model_archive_restorations (
        batch_id VARCHAR(64) NOT NULL,
        restore_label VARCHAR(64) NOT NULL,
        model_ids JSON NOT NULL,
        condition_count INT UNSIGNED NOT NULL,
        result_count INT UNSIGNED NOT NULL,
        benchmark_count INT UNSIGNED NOT NULL,
        restored_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (batch_id, restore_label),
        CONSTRAINT fk_recent_model_archive_restoration_batch FOREIGN KEY (batch_id)
            REFERENCES recent_model_archive_runs (batch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function restore(connection) {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [BATCH_ID]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire archive lock.');
    try {
        await ensureRestoreLog(connection);
        await connection.beginTransaction();
        try {
            const affected = await loadAffected(connection, true);
            await connection.execute(`INSERT INTO recent_model_archive_restorations
                (batch_id, restore_label, model_ids, condition_count, result_count, benchmark_count)
                VALUES (?, ?, ?, ?, ?, ?)`, [BATCH_ID, RESTORE_LABEL,
                JSON.stringify(modelIDs), affected.conditions.length, affected.results.length,
                affected.benchmarks.length]);
            await updateRows(connection, 'benchmarks', 'is_active',
                affected.benchmarks.map(row => Number(row.ID)), 0, 1);
            await updateRows(connection, 'benchmark_results', 'status',
                affected.results.map(row => Number(row.ID)), 'archived', 'accepted');
            const [[invalid]] = await connection.query(`SELECT COUNT(*) AS total
                FROM benchmark_results r JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
                JOIN benchmarks b ON b.ID = c.benchmark_ID
                WHERE r.status = 'accepted' AND (c.deleted_at IS NOT NULL OR b.is_active = 0)`);
            if (Number(invalid.total)) throw new Error('Restoration created accepted scores on inactive entities.');
            await connection.commit();
            return affected;
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [BATCH_ID]);
    }
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const affected = apply ? await restore(connection) : await loadAffected(connection);
    console.log(JSON.stringify({ restored: apply, batchID: BATCH_ID,
        modelIDs, conditions: affected.conditions.length, results: affected.results.length,
        benchmarks: affected.benchmarks.length }, null, 2));
} finally {
    await connection.end();
}
