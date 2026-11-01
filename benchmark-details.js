import { isAACondition, AA_DISPLAY_RESTRICTION } from './public/js/shared/aa-ranking-policy.js';

function invalidCondition() {
    throw { status: 400, body: { error: 'benchmark_condition_required' } };
}

export async function getBenchmarkInformation(db, body) {
    if (!body || Object.keys(body).some(key => key !== 'conditionID')) invalidCondition();
    const conditionID = Number(body.conditionID);
    if (!Number.isSafeInteger(conditionID) || conditionID <= 0) invalidCondition();
    const [rows] = await db.execute(`SELECT b.ID AS benchmarkID, c.ID AS conditionID,
        b.name, c.name AS conditionName, c.condition_key AS conditionKey, b.description, b.introduction_url AS introductionURL,
        COALESCE(c.difference_explanation, '') AS differenceExplanation, c.is_primary AS isPrimaryCondition,
        b.request_official_sync AS requestOfficialSync, c.score_source AS scoreSource,
        DATE_FORMAT(b.scores_updated_at, '%Y-%m-%dT%H:%i:%sZ') AS scoresUpdatedAt
        FROM benchmark_conditions c JOIN benchmarks b ON b.ID=c.benchmark_ID
        WHERE c.ID=? AND c.deleted_at IS NULL AND b.is_active=1 LIMIT 1`, [conditionID]);
    if (!rows.length) throw { status: 404, body: { error: 'benchmark_condition_unavailable' } };
    const { conditionKey, ...row } = rows[0];
    const restricted = isAACondition({ ...row, conditionKey });
    return { ...row, benchmarkID: Number(row.benchmarkID), conditionID: Number(row.conditionID),
        description: row.description ?? '', introductionURL: row.introductionURL ?? '',
        requestOfficialSync: Boolean(row.requestOfficialSync), isPrimaryCondition: Boolean(row.isPrimaryCondition),
        displayRestriction: restricted ? AA_DISPLAY_RESTRICTION : null,
        ...(restricted ? { description: '', differenceExplanation: '', scoreSource: null,
            scoresUpdatedAt: null, requestOfficialSync: false } : {}) };
}

export async function markBenchmarkScoresUpdated(connection, benchmarkIDs) {
    const IDs = [...new Set(benchmarkIDs.map(Number))];
    if (!IDs.length) return;
    if (IDs.some(ID => !Number.isSafeInteger(ID) || ID <= 0)) throw new Error('Invalid score-update benchmark IDs');
    await connection.query('UPDATE benchmarks SET scores_updated_at=UTC_TIMESTAMP(3) WHERE ID IN (?)', [IDs]);
}

