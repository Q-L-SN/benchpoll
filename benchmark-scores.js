import { currentScoreSQL } from './score-aggregation.js';
import { selectableBenchmarkConditionSQL } from './benchmark-condition-visibility.js';
import { isAACondition, AA_DISPLAY_RESTRICTION } from './public/js/shared/aa-ranking-policy.js';
import { aaResultReason } from './aa-archive-policy.js';
import { loadScoreFieldCatalog } from './score-field-service.js';
import { fieldDisplayValue, normalizeScoreFields } from './public/js/shared/score-fields.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection,
    releaseTransactionConnection } from './db-transaction.js';

const pageSize = 50;
const positiveID = value => Number.isSafeInteger(value) && value > 0;
const fail = (error, status = 400) => { throw { status, body: { error } }; };

export async function getBenchmarkScores(db, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)
        || Object.keys(body).some(key => !['benchmarkID', 'conditionID', 'beforeID'].includes(key))
        || !positiveID(body.benchmarkID) || !positiveID(body.conditionID)
        || (Object.hasOwn(body, 'beforeID') && !positiveID(body.beforeID))) fail('invalid_benchmark_scores_request');
    const connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, 'BENCHMARK SCORES', { readOnlySnapshot: true });
        const [conditions] = await connection.execute(`SELECT c.ID, c.name, c.condition_key AS conditionKey,
            b.name AS benchmarkName, c.score_source AS scoreSource, c.is_primary AS isPrimary,
            c.uses_percentage_scale AS usesPercentageScale,
            (SELECT COUNT(*) FROM benchmark_results r JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
             WHERE r.benchmark_condition_ID = c.ID AND r.benchmark_ID = c.benchmark_ID AND ${currentScoreSQL('r')}) AS scoreCount
            FROM benchmark_conditions c JOIN benchmarks b ON b.ID = c.benchmark_ID
            WHERE b.ID = ? AND b.is_active = 1 AND ${selectableBenchmarkConditionSQL('c')}
            ORDER BY c.is_primary DESC, c.name, c.ID`, [body.benchmarkID]);
        const selected = conditions.find(condition => Number(condition.ID) === body.conditionID);
        if (!selected) fail('benchmark_condition_unavailable', 404);
        const visibleConditions = conditions.map(condition => {
            const restricted = isAACondition({ ...condition, benchmarkID: body.benchmarkID, conditionName: condition.name });
            return { ID: Number(condition.ID), name: condition.name,
                isPrimary: Boolean(condition.isPrimary), usesPercentageScale: Boolean(condition.usesPercentageScale),
                scoreCount: restricted ? null : Number(condition.scoreCount),
                displayRestriction: restricted ? AA_DISPLAY_RESTRICTION : null };
        });
        const displayRestriction = visibleConditions.find(condition => condition.ID === body.conditionID).displayRestriction;
        if (displayRestriction) {
            await commitTransactionConnection(connection, 'BENCHMARK SCORES');
            return { benchmarkID: body.benchmarkID, conditionID: body.conditionID,
                conditions: visibleConditions, displayRestriction, scores: [], nextBeforeID: null };
        }
        const definitions = await loadScoreFieldCatalog(connection);
        const allowedConditions = visibleConditions.filter(condition => !condition.displayRestriction).map(condition => condition.ID);
        const [provenance] = await connection.execute(`SELECT r.ID, r.benchmark_ID, r.benchmark_condition_ID AS conditionID,
            r.score_fields, r.source_url, r.source_title, r.notes
            FROM benchmark_results r JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
            WHERE r.benchmark_ID = ? AND r.benchmark_condition_ID IN (${allowedConditions.map(() => '?').join(',')})
              AND ${currentScoreSQL('r')}`, [body.benchmarkID, ...allowedConditions]);
        const restrictedIDs = [], omittedCounts = new Map();
        for (const row of provenance) {
            if (!aaResultReason(row, undefined, definitions)) continue;
            const conditionID = Number(row.conditionID);
            omittedCounts.set(conditionID, (omittedCounts.get(conditionID) ?? 0) + 1);
            if (conditionID === body.conditionID) restrictedIDs.push(Number(row.ID));
        }
        for (const condition of visibleConditions) {
            if (!condition.displayRestriction) condition.scoreCount = Math.max(0, condition.scoreCount - (omittedCounts.get(condition.ID) ?? 0));
        }
        const values = [body.benchmarkID, body.conditionID];
        if (body.beforeID) {
            const [anchor] = await connection.execute(`SELECT raw_score AS rawScore FROM benchmark_results
                WHERE ID = ? AND benchmark_ID = ? AND benchmark_condition_ID = ?`,
            [body.beforeID, body.benchmarkID, body.conditionID]);
            if (!anchor.length) fail('invalid_benchmark_scores_cursor');
            if (!Number.isFinite(Number(anchor[0].rawScore))) fail('accepted_result_score_invalid', 409);
            // Keep the database decimal intact at page boundaries, including tied scores.
            values.push(anchor[0].rawScore, anchor[0].rawScore, body.beforeID);
        }
        values.push(...restrictedIDs);
        const [rows] = await connection.execute(`SELECT r.ID, r.raw_score AS rawScore,
            r.source_url AS sourceURL, r.source_title AS sourceTitle, r.score_fields AS scoreFields,
            DATE_FORMAT(r.created_at, '%Y-%m-%dT%H:%i:%sZ') AS createdAt,
            m.ID AS modelID, m.name AS modelName, v.name AS vendorName, v.slug AS vendorSlug, v.logo_key AS logoKey
            FROM benchmark_results r JOIN models m ON m.ID = r.model_ID AND m.is_active = 1
            JOIN organizations v ON v.ID = m.vendor_ID
            WHERE r.benchmark_ID = ? AND r.benchmark_condition_ID = ? AND ${currentScoreSQL('r')}
            ${body.beforeID ? 'AND (r.raw_score < CAST(? AS DECIMAL(18,6)) OR (r.raw_score = CAST(? AS DECIMAL(18,6)) AND r.ID < ?))' : ''}
            ${restrictedIDs.length ? `AND r.ID NOT IN (${restrictedIDs.map(() => '?').join(',')})` : ''}
            ORDER BY r.raw_score DESC, r.ID DESC LIMIT ${pageSize + 1}`, values);
        const scores = rows.slice(0, pageSize).map(row => {
            const rawScore = Number(row.rawScore);
            if (!Number.isFinite(rawScore)) fail('accepted_result_score_invalid', 409);
            const assignments = normalizeScoreFields(typeof row.scoreFields === 'string'
                ? JSON.parse(row.scoreFields) : row.scoreFields, definitions);
            return { ID: Number(row.ID), rawScore, createdAt: row.createdAt,
                modelID: Number(row.modelID), modelName: row.modelName, vendorName: row.vendorName,
                vendorSlug: row.vendorSlug, logoKey: row.logoKey, sourceURL: row.sourceURL, sourceTitle: row.sourceTitle,
                fields: assignments.map(item => {
                    const field = definitions.find(field => field.ID === item.fieldID);
                    return { name: field.name, value: fieldDisplayValue(field, item.value) };
                }) };
        });
        await commitTransactionConnection(connection, 'BENCHMARK SCORES');
        return { benchmarkID: body.benchmarkID, conditionID: body.conditionID,
            conditions: visibleConditions, displayRestriction: null,
            omittedScores: restrictedIDs.length > 0, scores, nextBeforeID: rows.length > pageSize ? scores.at(-1).ID : null };
    } catch (error) {
        await rollbackTransactionConnection(connection, 'BENCHMARK SCORES', error);
        throw error;
    } finally { releaseTransactionConnection(connection, 'BENCHMARK SCORES'); }
}
