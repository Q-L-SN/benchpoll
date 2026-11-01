#!/usr/bin/env node
import 'dotenv/config';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';
import { currentScoreSQL } from '../score-aggregation.js';
import { chooseInitialPrimaryCondition } from '../benchmark-primary-condition.js';

const placeholders = IDs => IDs.map(() => '?').join(', ');
const chunks = values => Array.from({ length: Math.ceil(values.length / 300) }, (_, i) => values.slice(i * 300, i * 300 + 300));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const referenceTables = [
    ['personalWeightReferences', 'personal_pie_weights', 'benchmark_condition_ID'],
    ['familyEntranceReferences', 'benchmark_families', 'primary_benchmark_condition_ID'],
    ['familyMemberReferences', 'benchmark_family_members', 'benchmark_condition_ID'],
    ['discussionConditionReferences', 'discussion_mentions', 'condition_ID']
];

export function createZeroScoreCleanupPlan(benchmarks, conditions) {
    const groups = new Map(benchmarks.map(benchmark => [Number(benchmark.ID), []]));
    if (groups.size !== benchmarks.length || benchmarks.some(row => Number(row.is_active) !== 1)) {
        throw new Error('Cleanup expects unique open benchmarks.');
    }
    const seen = new Set();
    for (const condition of conditions) {
        if (seen.has(Number(condition.ID)) || !groups.has(Number(condition.benchmark_ID)) || condition.deleted_at !== null
            || !Number.isSafeInteger(condition.scoreCount) || condition.scoreCount < 0
            || !Number.isSafeInteger(condition.scoredModelCount) || condition.scoredModelCount < 0
            || condition.scoredModelCount > condition.scoreCount
            || Boolean(condition.scoreCount) !== Boolean(condition.scoredModelCount)) {
            throw new Error('Invalid current-score condition snapshot.');
        }
        seen.add(Number(condition.ID)); groups.get(Number(condition.benchmark_ID)).push(condition);
    }
    const targets = conditions.filter(row => row.scoreCount === 0);
    const primaryReplacements = [];
    const benchmarkIDs = [];
    for (const [benchmarkID, rows] of groups) {
        if (rows.length && rows.filter(row => Number(row.is_primary) === 1).length !== 1) {
            throw new Error(`Benchmark ${benchmarkID} does not have exactly one primary condition before cleanup.`);
        }
        const retained = rows.filter(row => row.scoreCount > 0);
        if (!retained.length) { benchmarkIDs.push(benchmarkID); continue; }
        if (!retained.some(row => Number(row.is_primary) === 1)) {
            const replacement = chooseInitialPrimaryCondition(retained);
            primaryReplacements.push({ benchmarkID, previousID: Number(rows.find(row => Number(row.is_primary) === 1).ID),
                conditionID: Number(replacement.ID), name: replacement.name });
        }
    }
    const conditionIDs = targets.map(row => Number(row.ID)).sort((a, b) => a - b);
    benchmarkIDs.sort((a, b) => a - b);
    const affectedBenchmarkIDs = [...new Set([...targets.map(row => Number(row.benchmark_ID)), ...benchmarkIDs])].sort((a, b) => a - b);
    return { scope: 'open-benchmarks-without-current-accepted-active-model-scores', conditionIDs, benchmarkIDs,
        affectedBenchmarkIDs, primaryReplacements,
        synchronizedConditions: targets.filter(row => row.score_source !== null).map(row => Number(row.ID)) };
}

export function assertCleanupReferencesClear(references) {
    for (const [name, count] of Object.entries(references)) {
        assert.equal(Number(count), 0, `Cleanup has ${name}; repair these references explicitly before applying.`);
    }
}

async function checkSchemaReferences(connection) {
    const [rows] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME IN ('benchmark_conditions','benchmarks')`);
    const actual = rows.map(row => `${row.REFERENCED_TABLE_NAME}:${row.TABLE_NAME}.${row.COLUMN_NAME}`).sort();
    const expected = [
        'benchmark_conditions:benchmark_results.benchmark_condition_ID',
        'benchmark_conditions:discussion_mentions.condition_ID',
        'benchmark_conditions:personal_pie_weights.benchmark_condition_ID',
        'benchmark_conditions:benchmark_families.primary_benchmark_condition_ID',
        'benchmark_conditions:benchmark_family_members.benchmark_condition_ID',
        'benchmarks:benchmark_conditions.benchmark_ID', 'benchmarks:benchmark_results.benchmark_ID',
        'benchmarks:benchmark_tag_links.benchmark_ID', 'benchmarks:discussion_mentions.benchmark_ID'
    ].sort();
    assert.deepEqual(actual, expected, 'Unreviewed cleanup references or obsolete schema.');
}

async function snapshot(connection, lock = false) {
    const [benchmarks] = await connection.query(`SELECT * FROM benchmarks WHERE is_active = 1 ORDER BY ID${lock ? ' FOR UPDATE' : ''}`);
    const [rows] = await connection.query(`SELECT c.* FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID
        WHERE c.deleted_at IS NULL AND b.is_active = 1 ORDER BY c.ID${lock ? ' FOR UPDATE' : ''}`);
    const [coverage] = await connection.query(`SELECT r.benchmark_condition_ID, COUNT(*) AS scoreCount,
        COUNT(DISTINCT r.model_ID) AS scoredModelCount FROM benchmark_results r
        JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
        WHERE ${currentScoreSQL('r')} GROUP BY r.benchmark_condition_ID`);
    const scores = new Map(coverage.map(row => [Number(row.benchmark_condition_ID), row]));
    const conditions = rows.map(row => ({ ...row, scoreCount: Number(scores.get(Number(row.ID))?.scoreCount ?? 0),
        scoredModelCount: Number(scores.get(Number(row.ID))?.scoredModelCount ?? 0) }));
    return { benchmarks, conditions };
}

async function readReferences(connection, plan) {
    const references = {};
    for (const [name, table, column] of [...referenceTables,
        ['discussionBenchmarkReferences', 'discussion_mentions', 'benchmark_ID']]) {
        const IDs = column === 'benchmark_ID' ? plan.benchmarkIDs : plan.conditionIDs;
        let count = 0;
        for (const batch of chunks(IDs)) {
            const [[row]] = await connection.query(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} IN (${placeholders(batch)})`, batch);
            count += Number(row.count);
        }
        references[name] = count;
    }
    return references;
}

async function preservedState(connection) {
    const scores = createHash('sha256');
    let lastID = 0, scoreCount = 0;
    for (;;) {
        const [rows] = await connection.query('SELECT * FROM benchmark_results WHERE ID > ? ORDER BY ID LIMIT 2000', [lastID]);
        if (!rows.length) break;
        for (const row of rows) scores.update(JSON.stringify(row) + '\n');
        scoreCount += rows.length; lastID = Number(rows.at(-1).ID);
    }
    const references = {};
    for (const [table, order] of [
        ['personal_pies', 'ID'], ['personal_pie_weights', 'pie_ID,benchmark_condition_ID'],
        ['personal_pie_score_rules', 'pie_ID,primary_benchmark_condition_ID'],
        ['benchmark_families', 'ID'], ['benchmark_family_members', 'family_ID,position'], ['discussion_mentions', 'ID']
    ]) {
        const [rows] = await connection.query(`SELECT * FROM ${table} ORDER BY ${order}`);
        references[table] = { count: rows.length, digest: digest(rows) };
    }
    return { scoreCount, scoreDigest: scores.digest('hex'), references };
}

export async function deleteZeroScoreConditions(connection, { apply = false, backupDirectory, expectedPlanDigest } = {}) {
    if (apply && (!backupDirectory || !/^[a-f0-9]{64}$/.test(expectedPlanDigest ?? ''))) {
        throw new Error('A backup directory and a previously reviewed plan digest are required.');
    }
    const statements = [];
    let committed = false, executionPath;
    const execute = async (sql, params, expectedRows) => {
        const [result] = await connection.execute(sql, params);
        statements.push({ sql, params, affectedRows: result.affectedRows, warningStatus: result.warningStatus });
        assert.equal(result.affectedRows, expectedRows, 'Cleanup mutation count changed.');
        assert.equal(result.warningStatus, 0, 'Cleanup SQL returned warnings.');
    };
    if (apply) await connection.beginTransaction();
    else await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    try {
        await checkSchemaReferences(connection);
        const before = await snapshot(connection, apply);
        const plan = createZeroScoreCleanupPlan(before.benchmarks, before.conditions);
        const references = await readReferences(connection, plan);
        const planDigest = digest({ before, plan, references });
        const summary = { dryRun: !apply, ...plan, planDigest, references,
            conditionCount: plan.conditionIDs.length, benchmarkCount: plan.benchmarkIDs.length,
            primaryReplacementCount: plan.primaryReplacements.length };
        if (!apply) { await connection.rollback(); return summary; }
        assert.equal(planDigest, expectedPlanDigest, 'Cleanup plan changed; preview and review it again.');
        assertCleanupReferencesClear(references);
        assert.equal(plan.synchronizedConditions.length, 0, 'Targets have registered score sources; review their jobs before deleting.');
        const preservedBefore = await preservedState(connection);
        const backupPath = path.join(backupDirectory, `effective-zero-score-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
        executionPath = `${backupPath}.execution.json`;
        await fs.mkdir(backupDirectory, { recursive: true, mode: 0o700 });
        const affected = new Set(plan.affectedBenchmarkIDs);
        await fs.writeFile(backupPath, JSON.stringify({ createdAt: new Date().toISOString(), summary, preservedBefore,
            benchmarks: before.benchmarks.filter(row => affected.has(Number(row.ID))),
            conditions: before.conditions.filter(row => affected.has(Number(row.benchmark_ID))) }, null, 2),
        { encoding: 'utf8', flag: 'wx', mode: 0o600 });
        const verifiedBackup = JSON.parse(await fs.readFile(backupPath, 'utf8'));
        assert.equal(verifiedBackup.summary.planDigest, planDigest, 'Backup verification failed.');
        assert.deepEqual(verifiedBackup.preservedBefore, preservedBefore, 'Preserved-state backup verification failed.');
        const writeLog = value => fs.writeFile(executionPath, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
        await writeLog({ ...summary, state: 'prepared', backupPath, statements });
        for (const batch of chunks(plan.conditionIDs)) {
            await execute(`UPDATE benchmark_conditions
                SET condition_key = CONCAT('retired-', ID), is_default = 0, is_primary = 0,
                    deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                WHERE ID IN (${placeholders(batch)}) AND deleted_at IS NULL
                  AND NOT EXISTS (SELECT 1 FROM benchmark_results r
                    JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
                    WHERE r.benchmark_condition_ID = benchmark_conditions.ID AND ${currentScoreSQL('r')})`, batch, batch.length);
        }
        for (const replacement of plan.primaryReplacements) {
            await execute(`UPDATE benchmark_conditions SET is_primary = 1, updated_at = CURRENT_TIMESTAMP
                WHERE ID = ? AND benchmark_ID = ? AND deleted_at IS NULL AND is_primary = 0`,
            [replacement.conditionID, replacement.benchmarkID], 1);
        }
        for (const batch of chunks(plan.benchmarkIDs)) {
            await execute(`UPDATE benchmarks SET is_active = 0, updated_at = CURRENT_TIMESTAMP
                WHERE ID IN (${placeholders(batch)}) AND is_active = 1
                  AND NOT EXISTS (SELECT 1 FROM benchmark_conditions c WHERE c.benchmark_ID = benchmarks.ID AND c.deleted_at IS NULL)`, batch, batch.length);
        }
        for (const batch of chunks(plan.affectedBenchmarkIDs.filter(ID => !plan.benchmarkIDs.includes(ID)))) {
            await execute(`UPDATE benchmarks SET updated_at = CURRENT_TIMESTAMP WHERE ID IN (${placeholders(batch)})`, batch, batch.length);
        }
        const after = await snapshot(connection);
        const remaining = createZeroScoreCleanupPlan(after.benchmarks, after.conditions);
        assert.equal(remaining.conditionIDs.length, 0, 'Selectable conditions without current scores remain.');
        assert.equal(remaining.benchmarkIDs.length, 0, 'Open empty benchmarks remain.');
        assert.equal(after.conditions.length, before.conditions.length - plan.conditionIDs.length, 'Unexpected condition removal.');
        assert.equal(after.benchmarks.length, before.benchmarks.length - plan.benchmarkIDs.length, 'Unexpected benchmark removal.');
        const preservedAfter = await preservedState(connection);
        assert.deepEqual(preservedAfter, preservedBefore, 'Scores or personal/family/discussion data changed.');
        const result = { ...summary, backupPath, removedConditions: plan.conditionIDs.length,
            removedBenchmarks: plan.benchmarkIDs.length, preservedBefore, preservedAfter, statements };
        await writeLog({ ...result, state: 'prepared-and-verified' });
        await connection.commit(); committed = true;
        await writeLog({ ...result, state: 'committed' });
        return result;
    } catch (error) {
        if (committed) throw new Error('Cleanup committed, but its completion log could not be written. Verify database state before retrying.', { cause: error });
        await connection.rollback();
        if (executionPath) await fs.writeFile(executionPath, JSON.stringify({ state: 'rolled-back', error: error.message, statements }, null, 2), { mode: 0o600 });
        throw error;
    }
}

async function main() {
    const apply = process.argv.includes('--apply');
    const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
    if (apply && argument('confirm') !== 'delete-zero-score-conditions') throw new Error('Explicit cleanup confirmation is required.');
    const socketPath = argument('socket');
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (!socketPath && password === undefined) throw new Error('Writable database credentials or an explicit local socket are required.');
    const connection = await mysql.createConnection({
        ...(socketPath ? { socketPath } : { host: process.env.BENCHPOLL_DB_HOST ?? 'localhost', password }),
        user: argument('user') ?? process.env.BENCHPOLL_DB_USER ?? 'root',
        database: argument('database') ?? process.env.BENCHPOLL_DB_NAME ?? 'benchmarks', charset: 'utf8mb4', dateStrings: true
    });
    try {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', ['benchpoll_zero_score_cleanup']);
        assert.equal(Number(lock.acquired), 1, 'Could not obtain cleanup lock.');
        try {
            console.log(JSON.stringify(await deleteZeroScoreConditions(connection, {
                apply, backupDirectory: argument('backup-dir') && path.resolve(argument('backup-dir')),
                expectedPlanDigest: argument('expect-plan')
            }), null, 2));
        } finally { await connection.query('SELECT RELEASE_LOCK(?)', ['benchpoll_zero_score_cleanup']); }
    } finally { await connection.end(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
