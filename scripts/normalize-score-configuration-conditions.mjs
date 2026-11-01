#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { initPool, pool } from '../db.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { fieldNameKey, normalizeScoreFields } from '../public/js/shared/score-fields.js';
import { buildScoreConfigurationPlan, extractScoreConfiguration,
    REQUIRED_SCORE_FIELDS } from '../score-condition-normalization.js';

const apply = process.argv.includes('--apply');
const rehearse = process.argv.includes('--rehearse');
const execute = apply || rehearse;
const expectedPlan = process.argv.find(arg => arg.startsWith('--expect-plan='))?.slice('--expect-plan='.length);
const reportPath = process.argv.find(arg => arg.startsWith('--report='))?.slice('--report='.length);
if ((apply && rehearse) || process.argv.slice(2).some(arg => !['--apply', '--rehearse'].includes(arg)
    && !arg.startsWith('--expect-plan=') && !arg.startsWith('--report='))) {
    throw new Error('Usage: node scripts/normalize-score-configuration-conditions.mjs [--rehearse|--apply --expect-plan=<digest>] [--report=<path>]');
}
if (execute && !expectedPlan) throw new Error('Execution requires a fresh dry-run plan digest.');

const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
const signature = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const parse = value => typeof value === 'string' ? JSON.parse(value) : value;

async function checkReferences(connection) {
    const [rows] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'benchmark_conditions'`);
    const actual = rows.map(row => `${row.TABLE_NAME}.${row.COLUMN_NAME}`).sort();
    const expected = ['benchmark_results.benchmark_condition_ID', 'discussion_mentions.condition_ID',
        'personal_pie_score_rule_components.fallback_benchmark_condition_ID',
        'personal_pie_weights.benchmark_condition_ID'].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Unknown condition references: ${JSON.stringify(actual)}`);
}

async function readPlan(connection) {
    await checkReferences(connection);
    const [conditions] = await connection.query(`
        SELECT c.ID, c.benchmark_ID, b.name AS benchmark_name, c.name, c.is_default, c.deleted_at,
               c.score_direction, c.target_value, c.uses_percentage_scale,
               c.score_min, c.score_max,
               (SELECT COUNT(*) FROM benchmark_results r WHERE r.benchmark_condition_ID = c.ID) AS resultCount
        FROM benchmark_conditions c
        JOIN benchmarks b ON b.ID = c.benchmark_ID AND b.is_active = 1
        WHERE c.deleted_at IS NULL ORDER BY c.ID`);
    const [references] = await connection.query(`
        SELECT benchmark_condition_ID AS ID FROM personal_pie_weights
        UNION SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components
        UNION SELECT condition_ID AS ID FROM discussion_mentions`);
    const protectedIDs = new Set(references.map(row => Number(row.ID)));
    for (const condition of conditions) condition.protected = protectedIDs.has(Number(condition.ID));
    const fields = await loadScoreFieldCatalog(connection);
    const virtualFields = REQUIRED_SCORE_FIELDS.filter(([name]) => !fields.some(field => fieldNameKey(field.name) === fieldNameKey(name)))
        .map(([name, type]) => ({ ID: null, name, type, options: [] }));
    const allFields = [...fields, ...virtualFields];
    const fieldMap = new Map(allFields.map(field => [field.name.toLowerCase(), field]));
    const candidateIDs = conditions.filter(condition => extractScoreConfiguration(condition, fieldMap))
        .map(condition => Number(condition.ID));
    const results = [];
    for (const chunk of chunks(candidateIDs, 300)) {
        const [rows] = await connection.query(`
            SELECT ID AS resultID, benchmark_condition_ID AS conditionID, score_fields AS scoreFields
            FROM benchmark_results WHERE benchmark_condition_ID IN (${chunk.map(() => '?').join(', ')})`, chunk);
        results.push(...rows);
    }
    const plan = buildScoreConfigurationPlan(conditions, results, allFields);
    const needed = new Set(plan.fieldUpdates.flatMap(item => item.additions.map(entry => entry.fieldName)));
    const newFields = virtualFields.filter(field => needed.has(field.name));
    const [[{ pendingRequests }]] = await connection.query("SELECT COUNT(*) AS pendingRequests FROM moderation_logs WHERE status = 'pending'");
    return { plan, results, newFields, digest: signature(plan), pendingRequests: Number(pendingRequests),
        examinedConditions: conditions.length, candidateConditions: candidateIDs.length,
        protectedConditions: protectedIDs.size };
}

async function rowCounts(connection) {
    const [[row]] = await connection.query(`SELECT
        (SELECT COUNT(*) FROM benchmark_conditions WHERE deleted_at IS NULL) AS conditions,
        (SELECT COUNT(*) FROM benchmark_results) AS results,
        (SELECT COUNT(*) FROM score_fields) AS scoreFields,
        (SELECT COUNT(*) FROM personal_pie_weights) AS pieWeights,
        (SELECT COUNT(*) FROM personal_pie_score_rule_components) AS fallbackComponents,
        (SELECT COUNT(*) FROM discussion_mentions) AS discussionMentions`);
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function insertFields(connection, fields) {
    for (const field of fields) {
        await connection.query('INSERT INTO score_fields (name, name_key, field_type) VALUES (?, ?, ?)',
            [field.name, fieldNameKey(field.name), field.type]);
    }
}

async function updateResultFields(connection, report) {
    const catalog = await loadScoreFieldCatalog(connection);
    const fieldIDs = new Map(catalog.map(field => [field.name, field.ID]));
    const existingByID = new Map(report.results.map(row => [Number(row.resultID), parse(row.scoreFields)]));
    for (const chunk of chunks(report.plan.fieldUpdates, 100)) {
        const values = chunk.map(item => {
            const existing = existingByID.get(item.resultID);
            if (!Array.isArray(existing)) throw new Error(`Missing original score fields on ${item.resultID}`);
            const added = item.additions.map(entry => {
                const fieldID = fieldIDs.get(entry.fieldName);
                if (!fieldID || existing.some(value => Number(value.fieldID) === fieldID)) {
                    throw new Error(`Score field conflict on result ${item.resultID}`);
                }
                return { fieldID, value: entry.value };
            });
            return JSON.stringify(normalizeScoreFields([...existing, ...added], catalog));
        });
        const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
        const params = [...chunk.flatMap((item, index) => [item.resultID, values[index]]), ...chunk.map(item => item.resultID)];
        const [result] = await connection.query(`UPDATE benchmark_results
            SET score_fields = CASE ID ${cases} END, updated_at = updated_at
            WHERE ID IN (${chunk.map(() => '?').join(', ')})`, params);
        if (result.affectedRows !== chunk.length) throw new Error('Score field migration changed an unexpected number of results.');
    }
}

async function moveResults(connection, mappings) {
    let moved = 0;
    for (const chunk of chunks(mappings, 150)) {
        const derived = chunk.map((_, index) => index === 0
            ? 'SELECT ? AS sourceID, ? AS targetID' : 'UNION ALL SELECT ?, ?').join(' ');
        const [result] = await connection.query(`UPDATE benchmark_results r
            JOIN (${derived}) m ON m.sourceID = r.benchmark_condition_ID
            SET r.benchmark_condition_ID = m.targetID,
                r.benchmark_condition_snapshot = JSON_SET(r.benchmark_condition_snapshot, '$.conditionID', m.targetID),
                r.updated_at = r.updated_at`, chunk.flatMap(item => [item.sourceID, item.targetID]));
        const expected = chunk.reduce((sum, item) => sum + item.resultCount, 0);
        if (result.affectedRows !== expected) throw new Error(`Result count changed during merge: ${result.affectedRows} != ${expected}`);
        moved += result.affectedRows;
    }
    return moved;
}

async function renameConditions(connection, renames) {
    for (const chunk of chunks(renames, 150)) {
        const cases = chunk.map(() => 'WHEN ? THEN ?').join(' ');
        const params = [...chunk.flatMap(item => [item.ID, item.name]), ...chunk.map(item => item.ID)];
        const [result] = await connection.query(`UPDATE benchmark_conditions
            SET name = CASE ID ${cases} END, updated_at = updated_at
            WHERE ID IN (${chunk.map(() => '?').join(', ')})`, params);
        if (result.affectedRows !== chunk.length) throw new Error('A condition rename was skipped.');
    }
}

async function deleteMergedConditions(connection, mappings) {
    for (const chunk of chunks(mappings, 300)) {
        const [result] = await connection.query(`DELETE FROM benchmark_conditions
            WHERE ID IN (${chunk.map(() => '?').join(', ')})`, chunk.map(item => item.sourceID));
        if (result.affectedRows !== chunk.length) throw new Error('A merged condition could not be deleted.');
    }
}

async function verifyPostconditions(connection, before, report) {
    const after = await rowCounts(connection);
    if (after.conditions !== before.conditions - report.plan.merges.length
        || after.results !== before.results
        || after.scoreFields !== before.scoreFields + report.newFields.length
        || after.pieWeights !== before.pieWeights
        || after.fallbackComponents !== before.fallbackComponents
        || after.discussionMentions !== before.discussionMentions) {
        throw new Error(`Unexpected row count after normalization: ${JSON.stringify({ before, after })}`);
    }
    const [[{ mismatches }]] = await connection.query(`SELECT COUNT(*) AS mismatches FROM benchmark_results r
        WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(r.benchmark_condition_snapshot, '$.conditionID')) AS UNSIGNED)
            <> r.benchmark_condition_ID`);
    if (Number(mismatches)) throw new Error(`${mismatches} result snapshots reference a different condition`);
    const catalog = await loadScoreFieldCatalog(connection);
    const fieldIDs = new Map(catalog.map(field => [field.name, field.ID]));
    for (const chunk of chunks(report.plan.fieldUpdates, 300)) {
        const [rows] = await connection.query(`SELECT ID, score_fields AS scoreFields FROM benchmark_results
            WHERE ID IN (${chunk.map(() => '?').join(', ')})`, chunk.map(item => item.resultID));
        const byID = new Map(rows.map(row => [Number(row.ID), parse(row.scoreFields)]));
        if (byID.size !== chunk.length) throw new Error('A migrated result disappeared.');
        for (const item of chunk) {
            const assignments = byID.get(item.resultID);
            normalizeScoreFields(assignments, catalog);
            for (const addition of item.additions) {
                const stored = assignments.find(entry => Number(entry.fieldID) === fieldIDs.get(addition.fieldName));
                if (!stored || stored.value !== addition.value) {
                    throw new Error(`Migrated score field differs on result ${item.resultID}`);
                }
            }
        }
    }
    return after;
}

initPool(process.env.DB_PASSWORD);
const connection = await pool.getConnection();
let locked = false;
try {
    if (execute) {
        const [[row]] = await connection.query("SELECT GET_LOCK('benchpoll_score_condition_normalization', 10) AS locked");
        if (row.locked !== 1) throw new Error('Could not acquire condition-normalization lock.');
        locked = true;
    }
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query(execute ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT'
        : 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const report = await readPlan(connection);
    const summary = { planDigest: report.digest, examinedConditions: report.examinedConditions,
        candidateConditions: report.candidateConditions, protectedConditions: report.protectedConditions,
        pendingRequests: report.pendingRequests, newFields: report.newFields.map(field => field.name),
        renamedConditions: report.plan.renames.length, mergedConditions: report.plan.merges.length,
        movedResults: report.plan.merges.reduce((sum, item) => sum + item.resultCount, 0),
        updatedScoreFields: report.plan.fieldUpdates.length, skipped: report.plan.skipped };
    if (reportPath) await writeFile(reportPath, JSON.stringify({ summary, plan: report.plan }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (execute) {
        if (report.digest !== expectedPlan) throw new Error('The normalization plan changed since the dry run.');
        if (report.pendingRequests !== 0) throw new Error('Pending moderation requests must be resolved first.');
        const before = await rowCounts(connection);
        await insertFields(connection, report.newFields);
        await updateResultFields(connection, report);
        const moved = await moveResults(connection, report.plan.merges);
        await deleteMergedConditions(connection, report.plan.merges);
        await renameConditions(connection, report.plan.renames);
        const after = await verifyPostconditions(connection, before, report);
        if (apply) await connection.commit();
        else await connection.rollback();
        console.log(JSON.stringify({ applied: apply, rehearsed: rehearse, moved, after }));
    } else await connection.rollback();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('benchpoll_score_condition_normalization')");
    connection.release();
    await pool.end();
}
