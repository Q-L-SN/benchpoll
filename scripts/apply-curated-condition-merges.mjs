#!/usr/bin/env node

import 'dotenv/config';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { initPool, pool } from '../db.js';
import { buildCuratedConditionMergePlan } from '../curated-condition-merges.js';
import { loadScoreFieldCatalog } from '../score-field-service.js';
import { normalizeScoreFields } from '../public/js/shared/score-fields.js';
import { scoreEvidenceDigest, fullScoreEvidenceDigest } from '../condition-overlap-merge-plan.js';
import { reviewedFieldAdditions, reviewedResultFieldAdditions, combinedReviewedFieldAdditions,
    extendReviewedScoreFields } from './reviewed-score-field-additions.mjs';

const apply = process.argv.includes('--apply');
const rehearse = process.argv.includes('--rehearse');
const execute = apply || rehearse;
const specPath = process.argv.find(arg => arg.startsWith('--spec='))?.slice(7);
const expectedPlan = process.argv.find(arg => arg.startsWith('--expect-plan='))?.slice(14);
const reportPath = process.argv.find(arg => arg.startsWith('--report='))?.slice(9);
if (!specPath || apply && rehearse || execute && !expectedPlan || process.argv.slice(2).some(arg =>
    !['--apply', '--rehearse'].includes(arg) && !arg.startsWith('--spec=')
    && !arg.startsWith('--expect-plan=') && !arg.startsWith('--report='))) {
    throw new Error('Usage: node scripts/apply-curated-condition-merges.mjs --spec=<file> [--rehearse|--apply --expect-plan=<digest>] [--report=<file>]');
}

const spec = JSON.parse(await readFile(specPath, 'utf8'));
const chunks = (items, size) => Array.from({ length: Math.ceil(items.length / size) },
    (_, index) => items.slice(index * size, (index + 1) * size));
const digest = plan => createHash('sha256').update(JSON.stringify(plan)).digest('hex');

async function checkReferences(connection) {
    const [rows] = await connection.query(`SELECT TABLE_NAME, COLUMN_NAME
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE REFERENCED_TABLE_SCHEMA = DATABASE() AND REFERENCED_TABLE_NAME = 'benchmark_conditions'`);
    const actual = rows.map(row => `${row.TABLE_NAME}.${row.COLUMN_NAME}`).sort();
    const expected = ['benchmark_results.benchmark_condition_ID', 'discussion_mentions.condition_ID',
        'personal_pie_score_rule_components.fallback_benchmark_condition_ID',
        'personal_pie_weights.benchmark_condition_ID'].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw new Error(`Unknown condition references: ${JSON.stringify(actual)}`);
    }
}

async function readPlan(connection) {
    await checkReferences(connection);
    const IDs = [...new Set(spec.groups.flatMap(group => [group.targetID, ...group.sourceIDs]))];
    if (IDs.length > 1000) throw new Error('Split the curated plan into batches of at most 1000 conditions.');
    const conditions = [];
    for (const chunk of chunks(IDs, 300)) {
        const [rows] = await connection.query(`SELECT c.ID, c.benchmark_ID, b.name AS benchmark_name,
            c.name, c.is_default, c.deleted_at, c.score_direction, c.target_value,
            c.uses_percentage_scale, c.score_min, c.score_max,
            (SELECT COUNT(*) FROM benchmark_results r WHERE r.benchmark_condition_ID = c.ID) AS resultCount
            FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID
            WHERE c.ID IN (${chunk.map(() => '?').join(', ')})`, chunk);
        conditions.push(...rows);
    }
    const [references] = await connection.query(`SELECT benchmark_condition_ID AS ID FROM personal_pie_weights
        UNION SELECT fallback_benchmark_condition_ID AS ID FROM personal_pie_score_rule_components
        UNION SELECT condition_ID AS ID FROM discussion_mentions`);
    const protectedIDs = new Set(references.map(row => Number(row.ID)));
    const plan = buildCuratedConditionMergePlan(spec, conditions, protectedIDs);
    if (spec.reviewedConditionNames) {
        const live = new Map(conditions.map(row => [Number(row.ID), row.name]));
        if (Object.keys(spec.reviewedConditionNames).length !== IDs.length) {
            throw new Error('Reviewed condition names do not cover the full merge plan.');
        }
        for (const id of IDs) {
            if (live.get(id) !== spec.reviewedConditionNames[id]) {
                throw new Error(`Condition ${id} changed since the manual review.`);
            }
        }
    }
    for (const group of plan.groups.filter(item => item.newName !== item.targetName)) {
        const [collisions] = await connection.query(`SELECT ID FROM benchmark_conditions
            WHERE benchmark_ID = ? AND name = ? AND deleted_at IS NULL
            AND ID NOT IN (${[group.targetID, ...group.sourceIDs].map(() => '?').join(', ')})`,
        [group.benchmarkID, group.newName, group.targetID, ...group.sourceIDs]);
        if (collisions.length) throw new Error(`The target name ${group.newName} already belongs to another condition.`);
    }
    const fieldUpdates = await readFieldUpdates(connection, plan);
    if (spec.scoreEvidence) {
        const fullHistory = spec.scoreEvidenceScope === 'all';
        if (spec.scoreEvidenceScope && !fullHistory) throw new Error('Unknown score evidence scope.');
        const evidence = [];
        for (const chunk of chunks(IDs, 300)) {
            const [rows] = await connection.query(`SELECT r.ID, r.benchmark_condition_ID AS conditionID,
                r.model_ID AS modelID, CAST(r.raw_score AS CHAR) AS rawScore,
                r.score_fields AS fields, r.source_url AS sourceURL, r.status AS scoreStatus
                FROM benchmark_results r JOIN models m ON m.ID = r.model_ID
                WHERE ${fullHistory ? '1 = 1' : "r.status = 'accepted' AND m.is_active = 1"}
                  AND r.benchmark_condition_ID IN (${chunk.map(() => '?').join(', ')})`, chunk);
            evidence.push(...rows);
        }
        const actualDigest = fullHistory ? fullScoreEvidenceDigest(evidence) : scoreEvidenceDigest(evidence);
        if (actualDigest !== spec.scoreEvidence) {
            throw new Error('Score evidence changed since the overlap scan; export and recompute the plan.');
        }
    }
    const [[{ pendingRequests }]] = await connection.query(
        "SELECT COUNT(*) AS pendingRequests FROM moderation_logs WHERE status = 'pending'");
    return { plan, fieldUpdates, planDigest: digest({ plan, fieldUpdates }),
        pendingRequests: Number(pendingRequests) };
}

async function readFieldUpdates(connection, plan) {
    const catalog = await loadScoreFieldCatalog(connection);
    const additionsBySource = reviewedFieldAdditions(spec, plan, catalog);
    const additionsByResult = reviewedResultFieldAdditions(spec, plan, catalog);
    const sourceIDs = [...new Set([...additionsBySource.keys(),
        ...[...additionsByResult.values()].map(item => item.conditionID)])];
    if (!sourceIDs.length) return [];
    const updates = [];
    let examined = 0;
    const seenResults = new Set();
    for (const chunk of chunks(sourceIDs, 300)) {
        const [rows] = await connection.query(`SELECT ID, benchmark_condition_ID, score_fields
            FROM benchmark_results WHERE benchmark_condition_ID IN (${chunk.map(() => '?').join(', ')})`, chunk);
        examined += rows.length;
        for (const row of rows) {
            const sourceID = Number(row.benchmark_condition_ID);
            const assignments = typeof row.score_fields === 'string'
                ? JSON.parse(row.score_fields) : row.score_fields;
            if (!Array.isArray(assignments)) throw new Error(`Invalid score fields on result ${row.ID}.`);
            const specific = additionsByResult.get(Number(row.ID));
            if (specific && specific.conditionID !== sourceID) {
                throw new Error(`Reviewed result ${row.ID} no longer belongs to condition ${specific.conditionID}.`);
            }
            if (specific) seenResults.add(Number(row.ID));
            const additions = combinedReviewedFieldAdditions(additionsBySource.get(sourceID), specific?.entries, catalog);
            const extended = extendReviewedScoreFields(assignments, additions, catalog, row.ID);
            if (extended) updates.push({ resultID: Number(row.ID), sourceID, assignments: extended });
        }
    }
    if (seenResults.size !== additionsByResult.size) throw new Error('A specifically reviewed result disappeared.');
    const resultsByID = new Map(plan.groups.flatMap(group => [
        [group.targetID, group.targetResultCount], ...group.sources.map(source => [source.ID, source.resultCount])
    ]));
    const expected = sourceIDs.reduce((sum, id) => sum + resultsByID.get(id), 0);
    if (examined !== expected) throw new Error(`Score-field preflight read ${examined} results, expected ${expected}.`);
    updates.sort((a, b) => a.resultID - b.resultID);
    return updates;
}

async function counts(connection) {
    const [[row]] = await connection.query(`SELECT
        (SELECT COUNT(*) FROM benchmark_conditions WHERE deleted_at IS NULL) AS conditions,
        (SELECT COUNT(*) FROM benchmark_results) AS results,
        (SELECT COUNT(*) FROM personal_pie_weights) AS pieWeights,
        (SELECT COUNT(*) FROM personal_pie_score_rule_components) AS fallbackComponents,
        (SELECT COUNT(*) FROM discussion_mentions) AS discussionMentions`);
    return Object.fromEntries(Object.entries(row).map(([key, value]) => [key, Number(value)]));
}

async function preservedResultsDigest(connection, plan, allowFieldAdditions = false) {
    const ids = [...new Set(plan.groups.flatMap(group => [group.targetID, ...group.sourceIDs]))];
    const entries = [];
    for (const chunk of chunks(ids, 300)) {
        const [rows] = await connection.query(`SELECT ID, model_ID, benchmark_ID,
            raw_score, source_url, source_type, source_title, submitted_by, moderation_log_ID,
            status, accepted_at, created_at, updated_at, notes, score_fields
            FROM benchmark_results WHERE benchmark_condition_ID IN (${chunk.map(() => '?').join(', ')})`, chunk);
        entries.push(...rows.map(row => {
            if (!allowFieldAdditions) return row;
            const preserved = { ...row };
            delete preserved.score_fields;
            return preserved;
        }));
    }
    entries.sort((a, b) => Number(a.ID) - Number(b.ID));
    return digest(entries);
}

async function moveResults(connection, merges) {
    let moved = 0;
    for (const chunk of chunks(merges, 150)) {
        const derived = chunk.map((_, index) => index === 0
            ? 'SELECT ? AS sourceID, ? AS targetID' : 'UNION ALL SELECT ?, ?').join(' ');
        const [result] = await connection.query(`UPDATE benchmark_results r
            JOIN (${derived}) m ON m.sourceID = r.benchmark_condition_ID
            SET r.benchmark_condition_ID = m.targetID,
                r.benchmark_condition_snapshot = JSON_SET(r.benchmark_condition_snapshot, '$.conditionID', m.targetID),
                r.updated_at = r.updated_at`, chunk.flatMap(item => [item.sourceID, item.targetID]));
        const expected = chunk.reduce((sum, item) => sum + item.resultCount, 0);
        if (result.affectedRows !== expected) {
            throw new Error(`Result count changed while merging: ${result.affectedRows} != ${expected}`);
        }
        moved += result.affectedRows;
    }
    return moved;
}

async function updateScoreFields(connection, updates) {
    for (const item of updates) {
        const [result] = await connection.query(`UPDATE benchmark_results
            SET score_fields = ?, updated_at = updated_at
            WHERE ID = ? AND benchmark_condition_ID = ?`,
        [JSON.stringify(item.assignments), item.resultID, item.sourceID]);
        if (result.affectedRows !== 1) throw new Error(`Result ${item.resultID} changed during score-field migration.`);
    }
}

async function updateTargetScales(connection, plan) {
    for (const group of plan.groups.filter(item => item.targetScale)) {
        const scale = group.targetScale;
        const [condition] = await connection.query(`UPDATE benchmark_conditions
            SET uses_percentage_scale = 0, score_min = ?, score_max = ?, updated_at = updated_at
            WHERE ID = ? AND deleted_at IS NULL`, [scale.scoreMin, scale.scoreMax, group.targetID]);
        if (condition.affectedRows !== 1) throw new Error(`Could not correct score scale for ${group.targetID}.`);
        const [results] = await connection.query(`UPDATE benchmark_results
            SET benchmark_condition_snapshot = JSON_SET(benchmark_condition_snapshot,
                '$.usesPercentageScale', JSON_EXTRACT(?, '$'),
                '$.scoreMin', ?, '$.scoreMax', ?), updated_at = updated_at
            WHERE benchmark_condition_ID = ?`,
        ['false', scale.scoreMin, scale.scoreMax, group.targetID]);
        const expected = group.targetResultCount
            + group.sources.reduce((sum, source) => sum + source.resultCount, 0);
        if (results.affectedRows !== expected) {
            throw new Error(`Scale correction touched ${results.affectedRows} results, expected ${expected}.`);
        }
    }
}

async function verify(connection, before, plan, fieldUpdates) {
    const after = await counts(connection);
    if (after.conditions !== before.conditions - plan.merges.length
        || after.results !== before.results || after.pieWeights !== before.pieWeights
        || after.fallbackComponents !== before.fallbackComponents
        || after.discussionMentions !== before.discussionMentions) {
        throw new Error(`Unexpected row counts: ${JSON.stringify({ before, after })}`);
    }
    const [[{ mismatches }]] = await connection.query(`SELECT COUNT(*) AS mismatches FROM benchmark_results r
        WHERE CAST(JSON_UNQUOTE(JSON_EXTRACT(r.benchmark_condition_snapshot, '$.conditionID')) AS UNSIGNED)
            <> r.benchmark_condition_ID`);
    if (Number(mismatches)) throw new Error(`${mismatches} result snapshots have a stale condition ID.`);
    for (const rename of plan.renames) {
        const [[row]] = await connection.query('SELECT name FROM benchmark_conditions WHERE ID = ?', [rename.ID]);
        if (row?.name !== rename.name) throw new Error(`Target condition ${rename.ID} has an unexpected name.`);
    }
    for (const scale of plan.scaleUpdates) {
        const [[condition]] = await connection.query(`SELECT uses_percentage_scale, score_min, score_max
            FROM benchmark_conditions WHERE ID = ?`, [scale.ID]);
        if (Number(condition?.uses_percentage_scale) !== 0
            || Number(condition.score_min) !== scale.scoreMin
            || Number(condition.score_max) !== scale.scoreMax) {
            throw new Error(`Target condition ${scale.ID} has an unexpected score scale.`);
        }
        const [rows] = await connection.query(`SELECT benchmark_condition_snapshot AS snapshot
            FROM benchmark_results WHERE benchmark_condition_ID = ?`, [scale.ID]);
        for (const row of rows) {
            const snapshot = typeof row.snapshot === 'string' ? JSON.parse(row.snapshot) : row.snapshot;
            if (snapshot.usesPercentageScale !== false || Number(snapshot.scoreMin) !== scale.scoreMin
                || Number(snapshot.scoreMax) !== scale.scoreMax) {
                throw new Error(`Result snapshot for ${scale.ID} has an unexpected score scale.`);
            }
        }
    }
    if (fieldUpdates.length) {
        const catalog = await loadScoreFieldCatalog(connection);
        for (const chunk of chunks(fieldUpdates, 300)) {
            const [rows] = await connection.query(`SELECT ID, score_fields FROM benchmark_results
                WHERE ID IN (${chunk.map(() => '?').join(', ')})`, chunk.map(item => item.resultID));
            const byID = new Map(rows.map(row => [Number(row.ID), row.score_fields]));
            if (byID.size !== chunk.length) throw new Error('A score-field result disappeared.');
            for (const item of chunk) {
                const stored = byID.get(item.resultID);
                const normalized = normalizeScoreFields(typeof stored === 'string' ? JSON.parse(stored) : stored, catalog);
                if (JSON.stringify(normalized) !== JSON.stringify(item.assignments)) {
                    throw new Error(`Score-field migration mismatch on result ${item.resultID}.`);
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
        const [[row]] = await connection.query("SELECT GET_LOCK('benchpoll_curated_condition_merges', 10) AS locked");
        if (row.locked !== 1) throw new Error('Could not acquire the curated-merge lock.');
        locked = true;
    }
    await connection.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    await connection.query(execute ? 'START TRANSACTION WITH CONSISTENT SNAPSHOT'
        : 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
    const report = await readPlan(connection);
    const summary = { planDigest: report.planDigest, pendingRequests: report.pendingRequests,
        benchmarkGroups: report.plan.groups.length, mergedConditions: report.plan.merges.length,
        renamedConditions: report.plan.renames.length,
        correctedScoreScales: report.plan.scaleUpdates.length,
        movedResults: report.plan.merges.reduce((sum, item) => sum + item.resultCount, 0),
        updatedScoreFields: report.fieldUpdates.length };
    if (reportPath) await writeFile(reportPath,
        JSON.stringify({ summary, plan: report.plan, fieldUpdates: report.fieldUpdates }, null, 2));
    console.log(JSON.stringify(summary, null, 2));
    if (execute) {
        if (report.planDigest !== expectedPlan) throw new Error('The curated merge plan changed since the dry run.');
        if (report.pendingRequests) throw new Error('Resolve pending moderation requests before merging.');
        const before = await counts(connection);
        const preservedBefore = await preservedResultsDigest(connection, report.plan, !!report.fieldUpdates.length);
        await updateScoreFields(connection, report.fieldUpdates);
        const moved = await moveResults(connection, report.plan.merges);
        for (const chunk of chunks(report.plan.merges, 300)) {
            const [result] = await connection.query(`DELETE FROM benchmark_conditions
                WHERE ID IN (${chunk.map(() => '?').join(', ')})`, chunk.map(item => item.sourceID));
            if (result.affectedRows !== chunk.length) throw new Error('A merged condition could not be deleted.');
        }
        for (const rename of report.plan.renames) {
            const [result] = await connection.query(`UPDATE benchmark_conditions
                SET name = ?, updated_at = updated_at WHERE ID = ?`, [rename.name, rename.ID]);
            if (result.affectedRows !== 1) throw new Error(`Target condition ${rename.ID} could not be renamed.`);
        }
        await updateTargetScales(connection, report.plan);
        const after = await verify(connection, before, report.plan, report.fieldUpdates);
        if (preservedBefore !== await preservedResultsDigest(connection, report.plan, !!report.fieldUpdates.length)) {
            throw new Error('Original score values, sources, status, metadata or timestamps changed.');
        }
        if (apply) await connection.commit();
        else await connection.rollback();
        const execution = { applied: apply, rehearsed: rehearse, moved, before, after,
            preservedResultsSHA256: preservedBefore, completedAt: new Date().toISOString() };
        if (reportPath) await writeFile(reportPath, JSON.stringify({ summary, execution, plan: report.plan }, null, 2));
        console.log(JSON.stringify(execution));
    } else await connection.rollback();
} catch (error) {
    await connection.rollback();
    throw error;
} finally {
    if (locked) await connection.query("SELECT RELEASE_LOCK('benchpoll_curated_condition_merges')");
    connection.release();
    await pool.end();
}
