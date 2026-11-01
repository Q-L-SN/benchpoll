#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';

const BATCH_ID = 'aa-archive-2026-09-26';
const EXPECTED_COUNTS = { benchmark: 20, condition: 116, result: 4390 };
const DEPENDENCY_CONDITIONS = new Map([
    [870, { benchmarkID: 1334,
        name: 'SciCode; Artificial Analysis Intelligence Benchmarking Methodology v3.0; as labelled in official table' }],
    [13133, { benchmarkID: 1159,
        name: 'LiveCodeBench (LCB); Artificial Analysis Intelligence Benchmarking Methodology v3.0; as labelled in official table' }],
    [14058, { benchmarkID: 1029,
        name: 'GPQA-Diamond; Artificial Analysis Intelligence Benchmarking Methodology v3.0; as labelled in official table' }],
    [14585, { benchmarkID: 1870,
        name: 'IFBench; Artificial Analysis Intelligence Benchmarking Methodology v3.0; as labelled in official table' }]
]);
const APPLY = process.argv.includes('--apply');

if (process.argv.slice(2).some(arg => arg !== '--apply')) {
    throw new Error('Only --apply is supported; omit it for a dry run.');
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
        dateStrings: true,
        charset: 'utf8mb4'
    };
}

function requireRow(map, id, description) {
    const row = map.get(Number(id));
    if (!row) throw new Error(`Missing ${description} ${id}.`);
    return row;
}

function originalState(item) {
    const state = typeof item.original_state === 'string'
        ? JSON.parse(item.original_state) : item.original_state;
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
        throw new Error(`Invalid original state for ${item.entity_type} ${item.object_id}.`);
    }
    return state;
}

async function rowsByIDs(connection, table, columns, ids) {
    const rows = [];
    for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const [found] = await connection.query(
            `SELECT ${columns} FROM ${table} WHERE ID IN (${chunk.map(() => '?').join(',')}) FOR UPDATE`,
            chunk);
        rows.push(...found);
    }
    return new Map(rows.map(row => [Number(row.ID), row]));
}

async function loadPlan(connection) {
    const [runs] = await connection.execute(
        'SELECT * FROM aa_data_archive_runs WHERE batch_id = ? FOR UPDATE', [BATCH_ID]);
    if (runs.length !== 1) throw new Error('AA archive batch is missing or duplicated.');
    const run = runs[0];
    if (Number(run.benchmark_count) !== EXPECTED_COUNTS.benchmark
        || Number(run.condition_count) !== EXPECTED_COUNTS.condition
        || Number(run.result_count) !== EXPECTED_COUNTS.result) {
        throw new Error('AA archive batch counts differ from the audited batch.');
    }

    const [items] = await connection.execute(
        'SELECT * FROM aa_data_archive_items WHERE batch_id = ? ORDER BY entity_type, object_id FOR UPDATE',
        [BATCH_ID]);
    const groups = Object.fromEntries(Object.keys(EXPECTED_COUNTS).map(type => [type, []]));
    const seen = new Set();
    for (const item of items) {
        const group = groups[item.entity_type];
        const key = `${item.entity_type}:${item.object_id}`;
        if (!group || seen.has(key) || Number(item.related_id) !== 0
            || Number(item.extra_id) !== 0) {
            throw new Error(`Unexpected or duplicate archive item ${key}.`);
        }
        originalState(item);
        group.push(item);
        seen.add(key);
    }
    for (const [type, expected] of Object.entries(EXPECTED_COUNTS)) {
        if (groups[type].length !== expected) {
            throw new Error(`Expected ${expected} ${type} archive items; found ${groups[type].length}.`);
        }
    }

    const results = await rowsByIDs(connection, 'benchmark_results',
        'ID, model_ID, benchmark_ID, benchmark_condition_ID, status',
        groups.result.map(item => Number(item.object_id)));
    const benchmarkIDs = new Set(groups.benchmark.map(item => Number(item.object_id)));
    const conditionIDs = new Set(groups.condition.map(item => Number(item.object_id)));
    const modelIDs = new Set();
    for (const result of results.values()) {
        benchmarkIDs.add(Number(result.benchmark_ID));
        conditionIDs.add(Number(result.benchmark_condition_ID));
        modelIDs.add(Number(result.model_ID));
    }
    const benchmarks = await rowsByIDs(connection, 'benchmarks', 'ID, name, is_active',
        [...benchmarkIDs]);
    const conditions = await rowsByIDs(connection, 'benchmark_conditions',
        'ID, benchmark_ID, name, deleted_at', [...conditionIDs]);
    const models = await rowsByIDs(connection, 'models', 'ID, is_active', [...modelIDs]);
    const pending = Object.fromEntries(Object.keys(groups).map(type => [type, []]));
    const archivedBenchmarkIDs = new Set(groups.benchmark.map(item => Number(item.object_id)));
    const referencedConditionIDs = new Set([...results.values()]
        .map(row => Number(row.benchmark_condition_ID)));

    for (const [id, expected] of DEPENDENCY_CONDITIONS) {
        const condition = requireRow(conditions, id, 'AA score dependency condition');
        if (!referencedConditionIDs.has(id) || Number(condition.benchmark_ID) !== expected.benchmarkID
            || condition.name !== expected.name || condition.deleted_at !== null) {
            throw new Error(`AA score dependency condition ${id} differs from the audited state.`);
        }
    }

    for (const item of groups.benchmark) {
        const row = requireRow(benchmarks, item.object_id, 'benchmark');
        const original = originalState(item);
        if (Number(original.isActive) !== 1 || row.name !== original.name) {
            throw new Error(`Benchmark ${row.ID} differs from the archive.`);
        }
        const expectedActive = item.restored_at === null ? 0 : 1;
        if (Number(row.is_active) !== expectedActive) {
            throw new Error(`Benchmark ${row.ID} has a conflicting active state.`);
        }
        if (item.restored_at === null) pending.benchmark.push(Number(row.ID));
    }
    for (const item of groups.condition) {
        const row = requireRow(conditions, item.object_id, 'condition');
        const original = originalState(item);
        if (Number(row.benchmark_ID) !== Number(original.benchmarkID)
            || row.deleted_at !== null) {
            throw new Error(`Condition ${row.ID} differs from the archive.`);
        }
        if (item.restored_at === null) pending.condition.push(Number(row.ID));
    }
    for (const item of groups.result) {
        const row = requireRow(results, item.object_id, 'result');
        const original = originalState(item);
        if (original.status !== 'accepted'
            || Number(row.benchmark_ID) !== Number(original.benchmarkID)) {
            throw new Error(`Result ${row.ID} differs from the archive.`);
        }
        const expectedStatus = item.restored_at === null ? 'archived' : 'accepted';
        if (row.status !== expectedStatus) {
            throw new Error(`Result ${row.ID} has a conflicting status.`);
        }
        const condition = requireRow(conditions, row.benchmark_condition_ID, 'result condition');
        const benchmark = requireRow(benchmarks, row.benchmark_ID, 'result benchmark');
        const model = requireRow(models, row.model_ID, 'result model');
        if (Number(condition.benchmark_ID) !== Number(benchmark.ID)
            || Number(model.is_active) !== 1
            || (Number(benchmark.is_active) !== 1 && !archivedBenchmarkIDs.has(Number(benchmark.ID)))
            || condition.deleted_at !== null) {
            throw new Error(`Result ${row.ID} has an invalid or inactive dependency.`);
        }
        if (item.restored_at === null) pending.result.push(Number(row.ID));
    }

    return { run, pending, counts: EXPECTED_COUNTS };
}

async function updateInChunks(connection, table, sql, ids) {
    let changed = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const [result] = await connection.query(
            sql.replace(':ids', chunk.map(() => '?').join(',')), chunk);
        changed += result.affectedRows;
    }
    if (changed !== ids.length) {
        throw new Error(`${table}: updated ${changed} rows; expected ${ids.length}.`);
    }
}

async function markRestored(connection, type, ids) {
    let changed = 0;
    for (let offset = 0; offset < ids.length; offset += 500) {
        const chunk = ids.slice(offset, offset + 500);
        const [result] = await connection.query(
            `UPDATE aa_data_archive_items SET restored_at = UTC_TIMESTAMP()
             WHERE batch_id = ? AND entity_type = ? AND restored_at IS NULL
             AND object_id IN (${chunk.map(() => '?').join(',')})`,
            [BATCH_ID, type, ...chunk]);
        changed += result.affectedRows;
    }
    if (changed !== ids.length) {
        throw new Error(`Archive audit ${type}: updated ${changed} rows; expected ${ids.length}.`);
    }
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [BATCH_ID]);
    if (Number(lock.acquired) !== 1) throw new Error('Could not acquire AA archive lock.');
    try {
        await connection.beginTransaction();
        try {
            const plan = await loadPlan(connection);
            const report = {
                batchID: BATCH_ID,
                dryRun: !APPLY,
                archiveBackup: plan.run.backup_path,
                archivedCounts: plan.counts,
                restoreNow: Object.fromEntries(Object.entries(plan.pending)
                    .map(([type, ids]) => [type, ids.length]))
            };
            if (APPLY) {
                for (const [type, table, sql] of [
                    ['benchmark', 'benchmarks',
                        'UPDATE benchmarks SET is_active = 1 WHERE is_active = 0 AND ID IN (:ids)'],
                    ['result', 'benchmark_results',
                        "UPDATE benchmark_results SET status = 'accepted' WHERE status = 'archived' AND ID IN (:ids)"]
                ]) {
                    const ids = plan.pending[type];
                    await updateInChunks(connection, table, sql, ids);
                    await markRestored(connection, type, ids);
                }
                await markRestored(connection, 'condition', plan.pending.condition);
                await connection.commit();
                report.restored = true;
            } else {
                await connection.rollback();
            }
            console.log(JSON.stringify(report, null, 2));
        } catch (error) {
            await connection.rollback();
            throw error;
        }
    } finally {
        await connection.query('SELECT RELEASE_LOCK(?)', [BATCH_ID]);
    }
} finally {
    await connection.end();
}
