#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { initPool, pool } from '../db.js';
import { buildMtebConsolidationPlan } from '../mteb-condition-consolidation.js';

const apply = process.argv.includes('--apply');
const rehearse = process.argv.includes('--rehearse');
const execute = apply || rehearse;
const expectedPlan = process.argv.find(arg => arg.startsWith('--expect-plan='))?.slice('--expect-plan='.length);
const reportPath = process.argv.find(arg => arg.startsWith('--report='))?.slice('--report='.length);
if ((apply && rehearse) || process.argv.slice(2).some(arg => !['--apply', '--rehearse'].includes(arg)
    && !arg.startsWith('--expect-plan=') && !arg.startsWith('--report='))) {
    throw new Error('Usage: node scripts/consolidate-mteb-conditions.mjs [--rehearse|--apply --expect-plan=<digest>] [--report=<path>]');
}
if (execute && !expectedPlan) throw new Error('Execution requires the digest from a fresh dry run.');

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function checkReferences(connection) {
    const [rows] = await connection.query(`
        SELECT TABLE_NAME, COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE()
          AND REFERENCED_TABLE_NAME = 'benchmark_conditions'`);
    const actual = rows.map(row => `${row.TABLE_NAME}.${row.COLUMN_NAME}`).sort();
    const expected = [
        'benchmark_results.benchmark_condition_ID',
        'discussion_mentions.condition_ID',
        'personal_pie_score_rule_components.fallback_benchmark_condition_ID',
        'personal_pie_weights.benchmark_condition_ID'
    ].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Unknown benchmark-condition references: ${JSON.stringify(actual)}`);
    }
}

async function originalNamesForHashedConditions(connection, conditions) {
    const names = new Map();
    const IDs = conditions.filter(item => /\s+\[[0-9a-f]{12}\]$/i.test(item.name)).map(item => Number(item.ID));
    for (const chunk of chunks(IDs, 250)) {
        const [rows] = await connection.query(`
            SELECT benchmark_condition_ID, notes
            FROM benchmark_results
            WHERE benchmark_condition_ID IN (${chunk.map(() => '?').join(', ')})`, chunk);
        for (const row of rows) {
            let note;
            try { note = JSON.parse(row.notes); } catch { note = null; }
            const ID = Number(row.benchmark_condition_ID);
            if (!names.has(ID)) names.set(ID, []);
            names.get(ID).push(typeof note?.original_benchmark_condition === 'string'
                ? note.original_benchmark_condition : null);
        }
    }
    return names;
}

async function readPlan(connection) {
    await checkReferences(connection);
    const [conditions] = await connection.query(`
        SELECT c.ID, c.benchmark_ID, b.name AS benchmark_name, c.name,
               c.score_direction, c.target_value, c.uses_percentage_scale,
               c.score_min, c.score_max, c.deleted_at,
               (SELECT COUNT(*) FROM benchmark_results r WHERE r.benchmark_condition_ID = c.ID) AS resultCount
        FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID AND b.is_active = 1
        WHERE c.deleted_at IS NULL
          AND (b.name LIKE '%MTEB%' OR c.name LIKE '%MTEB%')
        ORDER BY c.ID`);
    const [protectedRows] = await connection.query(`
        SELECT benchmark_condition_ID AS ID FROM personal_pie_weights
        UNION SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components
        UNION SELECT condition_ID AS ID FROM discussion_mentions`);
    const [[{ pendingRequests }]] = await connection.query(`
        SELECT COUNT(*) AS pendingRequests FROM moderation_logs WHERE status = 'pending'`);
    const plan = buildMtebConsolidationPlan(conditions,
        await originalNamesForHashedConditions(connection, conditions),
        new Set(protectedRows.map(row => Number(row.ID))));
    return { plan, digest: signature(plan.merges), pendingRequests: Number(pendingRequests),
        protectedConditions: protectedRows.length, examinedConditions: conditions.length };
}

async function rowCounts(connection) {
    const [[counts]] = await connection.query(`SELECT
        (SELECT COUNT(*) FROM benchmark_conditions WHERE deleted_at IS NULL) AS conditions,
        (SELECT COUNT(*) FROM benchmark_results) AS results,
        (SELECT COUNT(*) FROM personal_pie_weights) AS pieWeights,
        (SELECT COUNT(*) FROM personal_pie_score_rule_components) AS fallbackComponents,
        (SELECT COUNT(*) FROM discussion_mentions) AS discussionMentions`);
    return Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, Number(value)]));
}

async function moveResults(connection, mappings) {
    let moved = 0;
    for (const chunk of chunks(mappings, 150)) {
        const derived = chunk.map((_, index) => index === 0
            ? 'SELECT ? AS sourceID, ? AS targetID' : 'UNION ALL SELECT ?, ?').join(' ');
        const params = chunk.flatMap(item => [item.sourceID, item.targetID]);
        const [result] = await connection.query(`
            UPDATE benchmark_results r
            JOIN (${derived}) m ON m.sourceID = r.benchmark_condition_ID
            SET r.benchmark_condition_ID = m.targetID,
                r.benchmark_condition_snapshot = JSON_SET(r.benchmark_condition_snapshot, '$.conditionID', m.targetID),
                r.updated_at = r.updated_at`, params);
        const expected = chunk.reduce((sum, item) => sum + item.resultCount, 0);
        if (result.affectedRows !== expected) {
            throw new Error(`Result count changed during migration: ${result.affectedRows} != ${expected}`);
        }
        moved += result.affectedRows;
    }
    return moved;
}

async function deleteMergedConditions(connection, mappings) {
    for (const chunk of chunks(mappings, 300)) {
        const [result] = await connection.query(`
            DELETE FROM benchmark_conditions
            WHERE ID IN (${chunk.map(() => '?').join(', ')})`, chunk.map(item => item.sourceID));
        if (result.affectedRows !== chunk.length) {
            throw new Error('A merged benchmark condition could not be deleted.');
        }
    }
}

async function verifyPostconditions(connection, before, plan) {
    const after = await rowCounts(connection);
    if (after.conditions !== before.conditions - plan.merges.length
        || after.results !== before.results
        || after.pieWeights !== before.pieWeights
        || after.fallbackComponents !== before.fallbackComponents
        || after.discussionMentions !== before.discussionMentions) {
        throw new Error(`Consolidation changed protected row counts: ${JSON.stringify({ before, after })}`);
    }
    const [[{ mismatches }]] = await connection.query(`
        SELECT COUNT(*) AS mismatches FROM benchmark_results r
        WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(r.benchmark_condition_snapshot, '$.conditionID')) AS UNSIGNED)
            <> r.benchmark_condition_ID`);
    if (Number(mismatches) !== 0) throw new Error(`${mismatches} result snapshots reference a different condition`);
    return after;
}

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
let locked = false;
try {
    if (execute) {
        const [[row]] = await connection.query("SELECT GET_LOCK('benchpoll_mteb_condition_consolidation', 10) AS locked");
        if (row.locked !== 1) throw new Error('Could not acquire the consolidation lock.');
        locked = true;
    }
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query(execute ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT'
        : 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const report = await readPlan(connection);
    const summary = {
        planDigest: report.digest,
        examinedConditions: report.examinedConditions,
        protectedConditions: report.protectedConditions,
        pendingRequests: report.pendingRequests,
        eligibleGroups: report.plan.eligibleGroups,
        protectedGroups: report.plan.protectedGroups,
        mergedConditions: report.plan.merges.length,
        movedResults: report.plan.merges.reduce((sum, item) => sum + item.resultCount, 0)
    };
    if (reportPath) await writeFile(reportPath, JSON.stringify({ summary, plan: report.plan }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (execute) {
        if (report.digest !== expectedPlan) throw new Error('The consolidation plan changed since the dry run.');
        if (report.pendingRequests !== 0) throw new Error('Pending moderation requests must be resolved first.');
        const before = await rowCounts(connection);
        const moved = await moveResults(connection, report.plan.merges);
        await deleteMergedConditions(connection, report.plan.merges);
        const after = await verifyPostconditions(connection, before, report.plan);
        if (apply) await connection.commit();
        else await connection.rollback();
        console.log(JSON.stringify({ applied: apply, rehearsed: rehearse, moved, after }));
    } else await connection.rollback();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('benchpoll_mteb_condition_consolidation')");
    connection.release();
    await pool.end();
}
