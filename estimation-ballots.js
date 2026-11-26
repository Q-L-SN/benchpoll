import { catalogueCandidateSQL, MIN_COMPARABLE_MODELS, selectableBenchmarkConditionSQL } from './benchmark-condition-visibility.js';
import { currentScoreSQL } from './score-aggregation.js';
import { estimationPair } from './public/js/shared/estimation-votes.js';
import { excludedFromRanking } from './public/js/shared/aa-ranking-policy.js';
import { canonicalAccountID } from './public/js/shared/account-identity.js';
import { claimWriteIntent, completeWriteIntent } from './write-idempotency.js';
import { startTransactionConnection, commitTransactionConnection, rollbackTransactionConnection, releaseTransactionConnection } from './db-transaction.js';

const fail = (status, error) => { throw { status, body: { error } }; };

export const PUBLIC_PIE_SAMPLE_HOURS = 72;
export const PUBLIC_PIE_MIN_SAMPLES = 10;

// Limit the window to this pair for single-pair writes. Workspace reads aggregate all pairs once.
function tallyQuery(singlePair = false) {
    return `WITH ranked_votes AS (
        SELECT v.*, ROW_NUMBER() OVER (PARTITION BY first_ID, second_ID ORDER BY updated_at DESC, v.user_ID) AS position_in_pair
        FROM estimation_pair_votes v JOIN users u ON u.ID=v.user_ID WHERE u.deleted_at IS NULL
            AND (u.banned_at IS NULL OR u.banned_until<=NOW())
            ${singlePair ? 'AND v.first_ID=? AND v.second_ID=?' : ''}
    ), sampled AS (SELECT *, (position_in_pair<=? OR updated_at>=NOW()-INTERVAL ? HOUR) AS included FROM ranked_votes)
    SELECT first_ID, second_ID, SUM(included AND vote='support') AS supportCount, SUM(included AND vote='oppose') AS opposeCount,
        MAX(CASE WHEN user_ID=? THEN CAST(vote AS CHAR) END) AS personalVote FROM sampled
    GROUP BY first_ID, second_ID ORDER BY first_ID, second_ID`;
}

export async function loadEstimationBallots(db, userID, catalogue, hours = PUBLIC_PIE_SAMPLE_HOURS, minimum = PUBLIC_PIE_MIN_SAMPLES) {
    const eligible = id => catalogue.has(id) && !excludedFromRanking(catalogue.get(id));
    const [rows] = await db.execute(tallyQuery(), [minimum, hours, userID]);
    const community = [], personal = [], externalPairs = [];
    for (const row of rows) {
        const a = Number(row.first_ID), b = Number(row.second_ID);
        if (!eligible(a) || !eligible(b)) continue;
        const pair = estimationPair(a, b);
        const supportCount = Number(row.supportCount), opposeCount = Number(row.opposeCount);
        if (catalogue.get(a).benchmarkID !== catalogue.get(b).benchmarkID) {
            if (!supportCount) continue;
            externalPairs.push(pair);
        }
        community.push({ ...pair, supportCount, opposeCount });
        if (row.personalVote) personal.push({ ...pair, vote: row.personalVote });
    }
    return { externalPairs, personal, community };
}

export async function writePairVote(connection, userID, { targetConditionID: a, sourceConditionID: b, vote }, nominate = false) {
    const [versions] = await connection.execute(`SELECT c.ID, c.benchmark_ID AS benchmarkID, c.condition_key AS conditionKey,
        c.name AS conditionName, c.score_source AS scoreSource, benchmarks.name FROM benchmark_conditions c
        JOIN benchmarks ON benchmarks.ID=c.benchmark_ID AND benchmarks.is_active=1
        WHERE c.ID IN (?,?) AND c.deleted_at IS NULL ORDER BY c.ID FOR SHARE`, [a,b]);
    if (versions.length !== 2 || versions.some(excludedFromRanking)) fail(400, 'estimation_vote_condition_unavailable');
    const external = versions[0].benchmarkID !== versions[1].benchmarkID;
    if (nominate && !external) fail(400, 'estimation_pair_already_available');
    if (nominate) {
        const scoreCount = `(SELECT COUNT(DISTINCT r.model_ID) FROM benchmark_results r
            JOIN models ON models.ID=r.model_ID AND models.is_active=1
            WHERE r.benchmark_condition_ID=candidate_conditions.ID AND ${currentScoreSQL('r')})`;
        const [available] = await connection.execute(`SELECT DISTINCT candidate_conditions.benchmark_ID FROM benchmark_conditions candidate_conditions
            WHERE candidate_conditions.benchmark_ID IN (?,?) AND ${selectableBenchmarkConditionSQL('candidate_conditions')}
            AND ${catalogueCandidateSQL(scoreCount)}`, [...versions.map(row => row.benchmarkID), MIN_COMPARABLE_MODELS]);
        if (available.length !== 2) fail(400, 'estimation_vote_condition_unavailable');
    }
    if (external && !nominate && vote !== null) {
        const [[counts]] = await connection.execute(tallyQuery(true), [a, b, PUBLIC_PIE_MIN_SAMPLES, PUBLIC_PIE_SAMPLE_HOURS, userID]);
        if (!Number(counts?.supportCount)) fail(400, 'estimation_vote_condition_unavailable');
    }
    if (vote === null) {
        await connection.execute('DELETE FROM estimation_pair_votes WHERE user_ID=? AND first_ID=? AND second_ID=?', [userID,a,b]);
    } else {
        await connection.execute(`INSERT INTO estimation_pair_votes (user_ID, first_ID, second_ID, vote) VALUES (?,?,?,?) AS incoming
            ON DUPLICATE KEY UPDATE updated_at=IF(? OR estimation_pair_votes.vote<>incoming.vote,CURRENT_TIMESTAMP(6),estimation_pair_votes.updated_at),
            vote=incoming.vote`, [userID,a,b,vote,nominate]);
    }
}

export async function saveEstimationVote(db, userID, key, body) {
    const actor = canonicalAccountID(userID);
    if (!actor) fail(401, 'unauthorized');
    let pair;
    try { pair = estimationPair(body.targetConditionID, body.sourceConditionID); } catch { fail(400, 'invalid_estimation_vote'); }
    const { vote, nominate = false } = body;
    if (![null,'support','oppose'].includes(vote) || typeof nominate !== 'boolean' || nominate && vote !== 'support') fail(400, 'invalid_estimation_vote');
    const ballot = { ...pair, vote }, transaction = 'SAVE ESTIMATION VOTE';
    const connection = await db.getConnection();
    try {
        await startTransactionConnection(connection, transaction);
        const [users] = await connection.execute(`SELECT ID FROM users WHERE ID=? AND deleted_at IS NULL
            AND (banned_at IS NULL OR banned_until<=NOW()) FOR UPDATE`, [actor]);
        if (!users.length) fail(403, 'account_unavailable');
        const intent = await claimWriteIntent(connection, { userID: actor, key, action: 'save_estimation_vote', payload: { ...ballot, nominate } });
        let receipt = intent.response?.body;
        if (!receipt) {
            await writePairVote(connection, actor, ballot, nominate);
            receipt = { saved: true, userID: actor, requestKey: intent.key, ...ballot, nominate };
            await completeWriteIntent(connection, intent, { status: 200, body: receipt });
        }
        await commitTransactionConnection(connection, transaction);
        return receipt;
    } catch (error) { await rollbackTransactionConnection(connection, transaction, error); throw error; }
    finally { releaseTransactionConnection(connection, transaction); }
}
