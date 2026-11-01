#!/usr/bin/env node

import 'dotenv/config';
import mysql from 'mysql2/promise';
import { aaBenchmarkReason, aaResultReason } from '../aa-archive-policy.js';

const BATCH_ID = 'aa-archive-2026-09-26';
const APPLY = process.argv.includes('--apply');
const backupPath = process.argv.find(arg => arg.startsWith('--backup-path='))?.slice(14);
const expectedResults = Number(process.argv.find(arg => arg.startsWith('--expect-results='))?.slice(17));
const expectedBenchmarks = Number(process.argv.find(arg => arg.startsWith('--expect-benchmarks='))?.slice(20));

if (APPLY && (!backupPath || !Number.isSafeInteger(expectedResults)
    || !Number.isSafeInteger(expectedBenchmarks))) {
    throw new Error('Apply requires --backup-path, --expect-results and --expect-benchmarks.');
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

async function selectByIDs(connection, sql, ids) {
    if (ids.length === 0) return [];
    const [rows] = await connection.query(sql.replace(':ids', ids.map(() => '?').join(',')), ids);
    return rows;
}

async function loadPlan(connection) {
    const [allBenchmarks] = await connection.query('SELECT ID, name, is_active FROM benchmarks');
    const benchmarks = allBenchmarks
        .map(row => ({ ...row, reason: aaBenchmarkReason(row.name) }))
        .filter(row => row.reason && Number(row.is_active) === 1);
    const benchmarkIDs = benchmarks.map(row => Number(row.ID));
    const benchmarkIDSet = new Set(benchmarkIDs);
    const conditions = await selectByIDs(connection,
        'SELECT ID, benchmark_ID FROM benchmark_conditions WHERE benchmark_ID IN (:ids)',
        benchmarkIDs);
    const conditionIDs = conditions.map(row => Number(row.ID));
    const conditionIDSet = new Set(conditionIDs);

    const benchmarkPredicate = benchmarkIDs.length > 0
        ? `benchmark_ID IN (${benchmarkIDs.map(() => '?').join(',')})`
        : 'FALSE';
    const [candidateRows] = await connection.query(`
        SELECT ID, benchmark_ID, status, source_url, source_title, notes
        FROM benchmark_results
        WHERE status = 'accepted' AND (
            ${benchmarkPredicate}
            OR LOWER(source_url) LIKE '%artificialanalysis%'
            OR LOWER(COALESCE(source_title, '')) LIKE '%artificial analysis%'
            OR LOWER(COALESCE(notes, '')) LIKE '%artificial analysis%'
        )`, benchmarkIDs);
    const results = candidateRows
        .map(row => ({ ID: row.ID, benchmark_ID: row.benchmark_ID,
            reason: aaResultReason(row, benchmarkIDSet) }))
        .filter(row => row.reason);

    const affectedWeights = await selectByIDs(connection,
        'SELECT * FROM personal_pie_weights WHERE benchmark_condition_ID IN (:ids)', conditionIDs);
    const pieIDs = [...new Set(affectedWeights.map(row => Number(row.pie_ID)))];
    const pies = await selectByIDs(connection,
        'SELECT ID, revision FROM personal_pies WHERE ID IN (:ids)', pieIDs);
    const weights = await selectByIDs(connection,
        'SELECT * FROM personal_pie_weights WHERE pie_ID IN (:ids)', pieIDs);
    if (weights.some(row => !conditionIDSet.has(Number(row.benchmark_condition_ID)))) {
        throw new Error('An affected pie also has non-AA weights; manual rebalancing is required.');
    }
    const rules = await selectByIDs(connection,
        'SELECT * FROM personal_pie_score_rules WHERE pie_ID IN (:ids)', pieIDs);
    const components = await selectByIDs(connection,
        'SELECT * FROM personal_pie_score_rule_components WHERE pie_ID IN (:ids)', pieIDs);
    const externalComponents = await selectByIDs(connection, `
        SELECT pie_ID, primary_benchmark_condition_ID, fallback_benchmark_condition_ID
        FROM personal_pie_score_rule_components
        WHERE fallback_benchmark_condition_ID IN (:ids)`, conditionIDs);
    if (externalComponents.some(row => !pieIDs.includes(Number(row.pie_ID)))) {
        throw new Error('A non-AA pie fallback references an AA condition; manual handling is required.');
    }

    return { benchmarks, conditions, results, pies, weights, rules, components };
}

function summary(plan) {
    const reasons = {};
    for (const row of plan.results) reasons[row.reason] = (reasons[row.reason] ?? 0) + 1;
    return {
        batchID: BATCH_ID,
        benchmarks: plan.benchmarks.map(row => ({ ID: row.ID, name: row.name })),
        benchmarkCount: plan.benchmarks.length,
        conditionCount: plan.conditions.length,
        resultCount: plan.results.length,
        scoreReasons: reasons,
        affectedPies: plan.pies.map(row => ({ ID: row.ID, revision: row.revision })),
        fallbackRules: plan.rules.length,
        fallbackComponents: plan.components.length
    };
}

async function ensureArchiveSchema(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS aa_data_archive_runs (
        batch_id VARCHAR(64) NOT NULL PRIMARY KEY,
        backup_path VARCHAR(512) NOT NULL,
        benchmark_count INT UNSIGNED NOT NULL,
        condition_count INT UNSIGNED NOT NULL,
        result_count INT UNSIGNED NOT NULL,
        archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS aa_data_archive_items (
        batch_id VARCHAR(64) NOT NULL,
        entity_type VARCHAR(32) NOT NULL,
        object_id BIGINT UNSIGNED NOT NULL,
        related_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        extra_id BIGINT UNSIGNED NOT NULL DEFAULT 0,
        original_state JSON NOT NULL,
        reason VARCHAR(64) NOT NULL,
        PRIMARY KEY (batch_id, entity_type, object_id, related_id, extra_id),
        CONSTRAINT fk_aa_archive_batch FOREIGN KEY (batch_id)
            REFERENCES aa_data_archive_runs (batch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);

    const [columns] = await connection.query("SHOW COLUMNS FROM benchmark_results LIKE 'status'");
    if (columns.length !== 1) throw new Error('Missing benchmark_results.status.');
    if (!columns[0].Type.includes("'archived'")) {
        await connection.query(`ALTER TABLE benchmark_results
            MODIFY COLUMN status ENUM('accepted','superseded','archived') NOT NULL DEFAULT 'accepted'`);
    }
}

function archiveItems(plan) {
    const items = [];
    const add = (kind, objectID, relatedID, extraID, state, reason) => {
        items.push([BATCH_ID, kind, objectID, relatedID, extraID, JSON.stringify(state), reason]);
    };
    for (const row of plan.benchmarks) add('benchmark', row.ID, 0, 0,
        { isActive: row.is_active, name: row.name }, row.reason);
    for (const row of plan.conditions) add('condition', row.ID, 0, 0,
        { benchmarkID: row.benchmark_ID }, 'aa_specific_benchmark');
    for (const row of plan.results) add('result', row.ID, 0, 0,
        { status: 'accepted', benchmarkID: row.benchmark_ID }, row.reason);
    for (const row of plan.pies) add('pie', row.ID, 0, 0,
        { revision: row.revision }, 'aa_weight_removed');
    for (const row of plan.weights) add('pie_weight', row.pie_ID, row.benchmark_condition_ID,
        0, row, 'aa_weight_removed');
    for (const row of plan.rules) add('pie_rule', row.pie_ID,
        row.primary_benchmark_condition_ID, 0, row, 'aa_weight_removed');
    for (const row of plan.components) add('pie_component', row.pie_ID,
        row.primary_benchmark_condition_ID, row.fallback_benchmark_condition_ID,
        row, 'aa_weight_removed');
    return items;
}

async function executeInChunks(connection, sql, ids, expected) {
    let changed = 0;
    for (let index = 0; index < ids.length; index += 500) {
        const chunk = ids.slice(index, index + 500);
        const [result] = await connection.query(
            sql.replace(':ids', chunk.map(() => '?').join(',')), chunk);
        changed += result.affectedRows;
    }
    if (changed !== expected) throw new Error(`Changed ${changed} rows; expected ${expected}.`);
}

async function applyArchive(connection, plan) {
    const [existing] = await connection.execute(
        'SELECT batch_id FROM aa_data_archive_runs WHERE batch_id = ?', [BATCH_ID]);
    if (existing.length) throw new Error(`${BATCH_ID} already exists; refusing to archive twice.`);
    await connection.beginTransaction();
    try {
        await connection.execute(`INSERT INTO aa_data_archive_runs
            (batch_id, backup_path, benchmark_count, condition_count, result_count)
            VALUES (?, ?, ?, ?, ?)`, [BATCH_ID, backupPath,
            plan.benchmarks.length, plan.conditions.length, plan.results.length]);
        const items = archiveItems(plan);
        for (let index = 0; index < items.length; index += 500) {
            await connection.query(`INSERT INTO aa_data_archive_items
                (batch_id, entity_type, object_id, related_id, extra_id, original_state, reason)
                VALUES ?`, [items.slice(index, index + 500)]);
        }

        await executeInChunks(connection,
            "UPDATE benchmark_results SET status = 'archived' WHERE status = 'accepted' AND ID IN (:ids)",
            plan.results.map(row => Number(row.ID)), plan.results.length);
        await executeInChunks(connection,
            'UPDATE benchmarks SET is_active = 0 WHERE is_active = 1 AND ID IN (:ids)',
            plan.benchmarks.map(row => Number(row.ID)), plan.benchmarks.length);
        for (const weight of plan.weights) {
            const [deleted] = await connection.execute(`DELETE FROM personal_pie_weights
                WHERE pie_ID = ? AND benchmark_condition_ID = ?`,
            [weight.pie_ID, weight.benchmark_condition_ID]);
            if (deleted.affectedRows !== 1) throw new Error('Personal pie weight changed during archive.');
        }
        for (const pie of plan.pies) {
            const [updated] = await connection.execute(`UPDATE personal_pies
                SET revision = revision + 1 WHERE ID = ? AND revision = ?`,
            [pie.ID, pie.revision]);
            if (updated.affectedRows !== 1) throw new Error('Personal pie revision changed during archive.');
        }
        await connection.commit();
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

const connection = await mysql.createConnection(databaseConfig());
try {
    const plan = await loadPlan(connection);
    const report = summary(plan);
    if (!APPLY) {
        console.log(JSON.stringify({ dryRun: true, ...report }, null, 2));
    } else {
        if (expectedResults !== plan.results.length || expectedBenchmarks !== plan.benchmarks.length) {
            throw new Error(`Archive candidates changed: ${JSON.stringify(report)}`);
        }
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [BATCH_ID]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire AA archive lock.');
        try {
            await ensureArchiveSchema(connection);
            const currentPlan = await loadPlan(connection);
            if (currentPlan.results.length !== expectedResults
                || currentPlan.benchmarks.length !== expectedBenchmarks
                || JSON.stringify(currentPlan.pies) !== JSON.stringify(plan.pies)) {
                throw new Error('Archive candidates changed during preparation.');
            }
            await applyArchive(connection, currentPlan);
            console.log(JSON.stringify({ archived: true, ...summary(currentPlan) }, null, 2));
        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [BATCH_ID]);
        }
    }
} finally {
    await connection.end();
}
