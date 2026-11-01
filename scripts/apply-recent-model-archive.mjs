#!/usr/bin/env node

import 'dotenv/config';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import mysql from 'mysql2/promise';

const args = new Map(process.argv.slice(2).map(arg => {
    const split = arg.indexOf('=');
    return split < 0 ? [arg, true] : [arg.slice(0, split), arg.slice(split + 1)];
}));
const apply = args.has('--apply');
const planPath = args.get('--plan');
const backupPath = args.get('--backup');
const expectedPlanHash = args.get('--plan-sha256');
const expectedBackupHash = args.get('--backup-sha256');
if (!planPath || !backupPath || !/^[a-f0-9]{64}$/.test(expectedPlanHash ?? '')
    || !/^[a-f0-9]{64}$/.test(expectedBackupHash ?? '')) {
    throw new Error('Provide --plan, --backup, --plan-sha256 and --backup-sha256.');
}

function hashContent(value) {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function digestRows(rows, serialize) {
    return hashContent(rows.map(row => `${serialize(row)}\n`).join(''));
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

function chunks(rows, size = 500) {
    const result = [];
    for (let index = 0; index < rows.length; index += size) result.push(rows.slice(index, index + size));
    return result;
}

async function selectInChunks(connection, sql, ids) {
    const rows = [];
    for (const idsChunk of chunks(ids)) {
        const [selected] = await connection.query(sql.replace(':ids', idsChunk.map(() => '?').join(',')), idsChunk);
        rows.push(...selected);
    }
    return rows;
}

async function updateInChunks(connection, sql, ids) {
    let changed = 0;
    for (const idsChunk of chunks(ids)) {
        const [result] = await connection.query(sql.replace(':ids', idsChunk.map(() => '?').join(',')), idsChunk);
        changed += result.affectedRows;
    }
    if (changed !== ids.length) throw new Error(`Expected ${ids.length} updated rows, found ${changed}.`);
}

async function validateBackup() {
    const planBytes = await fs.readFile(planPath);
    if (hashContent(planBytes) !== expectedPlanHash) throw new Error('Archive plan SHA-256 changed.');
    const backupStat = await fs.stat(backupPath);
    if (backupStat.size < 1_000_000) throw new Error('Database backup is unexpectedly small.');
    const backupBytes = await fs.readFile(backupPath);
    if (hashContent(backupBytes) !== expectedBackupHash) throw new Error('Database backup SHA-256 changed.');
    return JSON.parse(planBytes.toString('utf8'));
}

function validatePlan(plan) {
    if (plan.batchID !== 'recent-model-archive-2026-09-27' || plan.cutoff !== '2026-08-01'
        || !Array.isArray(plan.candidates) || !Array.isArray(plan.benchmarkIDs)
        || !Array.isArray(plan.modelEvidence) || plan.candidates.length < 1) {
        throw new Error('Unsupported or empty archive plan.');
    }
    const conditionIDs = plan.candidates.map(row => row.ID);
    const uniqueIDs = new Set(conditionIDs);
    if (uniqueIDs.size !== conditionIDs.length || conditionIDs.some(id => !Number.isSafeInteger(id))
        || plan.candidates.some(row => !Number.isSafeInteger(row.benchmarkID)
            || !Number.isSafeInteger(row.scoredModels) || row.scoredModels < 1)
        || plan.modelEvidence.some(row => !Number.isSafeInteger(row.ID)
            || row.date >= plan.cutoff || !row.source)) {
        throw new Error('Archive plan contains invalid condition or model evidence.');
    }
}

async function verifyDatabase(connection, plan, lockRows) {
    const conditionIDs = plan.candidates.map(row => row.ID);
    if (lockRows && plan.benchmarkIDs.length) {
        const lockedBenchmarks = await selectInChunks(connection,
            'SELECT ID, is_active FROM benchmarks WHERE ID IN (:ids) FOR UPDATE', plan.benchmarkIDs);
        if (lockedBenchmarks.length !== plan.benchmarkIDs.length
            || lockedBenchmarks.some(row => Number(row.is_active) !== 1)) {
            throw new Error('A benchmark changed while preparing the archive.');
        }
    }
    const [conditions] = await connection.query(`SELECT c.ID, c.benchmark_ID
        FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID
        WHERE c.deleted_at IS NULL AND b.is_active = 1`);
    const conditionDigest = digestRows(conditions
        .map(row => ({ ID: Number(row.ID), benchmarkID: Number(row.benchmark_ID) }))
        .sort((a, b) => a.ID - b.ID), row => `${row.ID}:${row.benchmarkID}`);
    if (conditions.length !== plan.conditionCount
        || conditionDigest !== plan.conditionDigest) {
        throw new Error('Benchmark conditions changed after plan generation.');
    }
    const candidateConditions = await selectInChunks(connection,
        `SELECT ID, benchmark_ID, name, deleted_at FROM benchmark_conditions
        WHERE ID IN (:ids) ${lockRows ? 'FOR UPDATE' : ''}`, conditionIDs);
    const candidateByID = new Map(plan.candidates.map(row => [row.ID, row]));
    if (candidateConditions.length !== conditionIDs.length
        || candidateConditions.some(row => row.deleted_at !== null
            || Number(row.benchmark_ID) !== candidateByID.get(Number(row.ID))?.benchmarkID)) {
        throw new Error('Candidate conditions changed after plan generation.');
    }
    const protectedRows = await selectInChunks(connection, `SELECT ID FROM (
        SELECT benchmark_condition_ID AS ID FROM personal_pie_weights
        UNION SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components
        UNION SELECT condition_ID AS ID FROM discussion_mentions WHERE condition_ID IS NOT NULL
    ) AS protected_conditions WHERE ID IN (:ids)`, conditionIDs);
    if (protectedRows.length) throw new Error('A candidate condition gained a pie or discussion reference.');
    const results = await selectInChunks(connection, `SELECT ID, benchmark_condition_ID, model_ID
        FROM benchmark_results WHERE status = 'accepted' AND benchmark_condition_ID IN (:ids)
        ${lockRows ? 'FOR UPDATE' : ''}`, conditionIDs);
    results.sort((a, b) => Number(a.ID) - Number(b.ID));
    const resultDigest = digestRows(results,
        row => `${row.ID}:${row.benchmark_condition_ID}:${row.model_ID}`);
    if (results.length !== plan.resultCount || resultDigest !== plan.resultDigest) {
        throw new Error('Accepted scores changed after plan generation.');
    }
    const conditionCounts = new Map();
    for (const row of results) {
        const id = Number(row.benchmark_condition_ID);
        conditionCounts.set(id, (conditionCounts.get(id) ?? 0) + 1);
    }
    if (conditionIDs.some(id => !conditionCounts.has(id))) {
        throw new Error('A candidate condition no longer has an accepted score.');
    }
    const conditionsByBenchmark = new Map();
    for (const row of conditions) {
        const id = Number(row.benchmark_ID);
        if (!conditionsByBenchmark.has(id)) conditionsByBenchmark.set(id, []);
        conditionsByBenchmark.get(id).push(Number(row.ID));
    }
    const selected = new Set(conditionIDs);
    const benchmarkIDs = [...conditionsByBenchmark]
        .filter(([, ids]) => ids.every(id => selected.has(id)))
        .map(([id]) => id).sort((a, b) => a - b);
    if (JSON.stringify(benchmarkIDs) !== JSON.stringify(plan.benchmarkIDs)) {
        throw new Error('Benchmark archive set changed after plan generation.');
    }
    return { candidateConditions, results, conditionIDs, benchmarkIDs };
}

async function ensureArchiveSchema(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS recent_model_archive_runs (
        batch_id VARCHAR(64) NOT NULL PRIMARY KEY,
        cutoff_date DATE NOT NULL,
        plan_sha256 CHAR(64) NOT NULL,
        backup_path VARCHAR(512) NOT NULL,
        backup_sha256 CHAR(64) NOT NULL,
        condition_count INT UNSIGNED NOT NULL,
        benchmark_count INT UNSIGNED NOT NULL,
        result_count INT UNSIGNED NOT NULL,
        archived_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
    await connection.query(`CREATE TABLE IF NOT EXISTS recent_model_archive_items (
        batch_id VARCHAR(64) NOT NULL,
        entity_type VARCHAR(32) NOT NULL,
        object_id BIGINT UNSIGNED NOT NULL,
        original_state JSON NOT NULL,
        reason VARCHAR(64) NOT NULL,
        PRIMARY KEY (batch_id, entity_type, object_id),
        CONSTRAINT fk_recent_model_archive_batch FOREIGN KEY (batch_id)
            REFERENCES recent_model_archive_runs (batch_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`);
}

async function storeItems(connection, plan, state, benchmarks) {
    const items = [];
    for (const row of benchmarks) items.push([plan.batchID, 'benchmark', row.ID,
        JSON.stringify({ isActive: row.is_active, name: row.name }), 'no_post_july_model']);
    for (const row of state.candidateConditions) items.push([plan.batchID, 'condition', row.ID,
        JSON.stringify({ benchmarkID: row.benchmark_ID, name: row.name }),
        'no_post_july_model']);
    for (const row of state.results) items.push([plan.batchID, 'result', row.ID,
        JSON.stringify({ status: 'accepted', conditionID: row.benchmark_condition_ID,
            modelID: row.model_ID }), 'no_post_july_model']);
    for (const itemChunk of chunks(items)) {
        await connection.query(`INSERT INTO recent_model_archive_items
            (batch_id, entity_type, object_id, original_state, reason) VALUES ?`, [itemChunk]);
    }
}

async function applyArchive(connection, plan) {
    const [existing] = await connection.execute(
        'SELECT batch_id FROM recent_model_archive_runs WHERE batch_id = ?', [plan.batchID]);
    if (existing.length) throw new Error('This archive batch was already applied.');
    await connection.beginTransaction();
    try {
        const state = await verifyDatabase(connection, plan, true);
        const benchmarks = await selectInChunks(connection,
            'SELECT ID, name, is_active FROM benchmarks WHERE ID IN (:ids)', state.benchmarkIDs);
        await connection.execute(`INSERT INTO recent_model_archive_runs
            (batch_id, cutoff_date, plan_sha256, backup_path, backup_sha256,
                condition_count, benchmark_count, result_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [plan.batchID, plan.cutoff, expectedPlanHash, backupPath, expectedBackupHash,
            state.conditionIDs.length, state.benchmarkIDs.length, state.results.length]);
        await storeItems(connection, plan, state, benchmarks);
        await updateInChunks(connection,
            "UPDATE benchmark_results SET status = 'archived' WHERE status = 'accepted' AND ID IN (:ids)",
            state.results.map(row => Number(row.ID)));
        await updateInChunks(connection,
            'UPDATE benchmarks SET is_active = 0 WHERE is_active = 1 AND ID IN (:ids)',
            state.benchmarkIDs);
        const [[inactiveResults]] = await connection.query(`SELECT COUNT(*) AS total
            FROM benchmark_results r JOIN benchmark_conditions c ON c.ID = r.benchmark_condition_ID
            JOIN benchmarks b ON b.ID = c.benchmark_ID
            WHERE r.status = 'accepted' AND (c.deleted_at IS NOT NULL OR b.is_active = 0)`);
        const [[emptyBenchmarks]] = await connection.query(`SELECT COUNT(*) AS total FROM benchmarks b
            WHERE b.is_active = 1 AND NOT EXISTS (
                SELECT 1 FROM benchmark_conditions c WHERE c.benchmark_ID = b.ID AND c.deleted_at IS NULL)`);
        if (Number(inactiveResults.total) || Number(emptyBenchmarks.total)) {
            throw new Error('Ranking integrity check failed inside archive transaction.');
        }
        await connection.commit();
        return { archived: true, batchID: plan.batchID,
            conditions: state.conditionIDs.length, benchmarks: state.benchmarkIDs.length,
            results: state.results.length };
    } catch (error) {
        await connection.rollback();
        throw error;
    }
}

const plan = await validateBackup();
validatePlan(plan);
const connection = await mysql.createConnection(databaseConfig());
try {
    if (!apply) {
        const state = await verifyDatabase(connection, plan, false);
        console.log(JSON.stringify({ dryRun: true, batchID: plan.batchID,
            conditions: state.conditionIDs.length, benchmarks: state.benchmarkIDs.length,
            results: state.results.length }, null, 2));
    } else {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [plan.batchID]);
        if (Number(lock.acquired) !== 1) throw new Error('Could not acquire archive lock.');
        try {
            await ensureArchiveSchema(connection);
            console.log(JSON.stringify(await applyArchive(connection, plan), null, 2));
        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [plan.batchID]);
        }
    }
} finally {
    await connection.end();
}
