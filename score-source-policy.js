export function assertManualScoreAllowed(condition, { syncedCorrection = false } = {}) {
    if (!Object.hasOwn(condition, 'score_source')
        || (condition.score_source !== null && (typeof condition.score_source !== 'string' || !condition.score_source))) {
        throw new Error('The benchmark condition has no valid score source policy');
    }
    if (condition.score_source !== null && !syncedCorrection) {
        throw { status: 409, body: { error: 'dynamic_scores_are_synced', benchmarkConditionID: Number(condition.ID) } };
    }
}

export async function assertScoreSourcePolicy(connection, condition, { editingResultID = null } = {}) {
    let syncedCorrection = false;
    if (editingResultID !== null) {
        const [tracked] = await connection.execute(`SELECT a.result_ID,r.benchmark_condition_ID
            FROM arena_import_rows a JOIN benchmark_results r ON r.ID=a.result_ID
            WHERE a.result_ID=? FOR UPDATE`, [editingResultID]);
        if (tracked.length > 0) {
            if (Number(tracked[0].benchmark_condition_ID) !== Number(condition.ID)) {
                throw { status: 409, body: { error: 'dynamic_score_condition_immutable' } };
            }
            syncedCorrection = condition.score_source === 'arena_official';
        }
    }
    assertManualScoreAllowed(condition, { syncedCorrection });
    return syncedCorrection;
}

export async function recordSyncedScoreEdit(connection, oldResultID, newResultID, { required = false } = {}) {
    const [updated] = await connection.execute(`UPDATE arena_import_rows SET result_ID=?,manual_override='edit'
        WHERE result_ID=?`, [newResultID, oldResultID]);
    if (required && Number(updated.affectedRows) !== 1) throw new Error('The synced score correction lost its source tracking');
}

export async function recordSyncedScoreDeletion(connection, resultID, { required = false } = {}) {
    const [updated] = await connection.execute("UPDATE arena_import_rows SET manual_override='delete' WHERE result_ID=?", [resultID]);
    if (required && Number(updated.affectedRows) !== 1) throw new Error('The synced score deletion lost its source tracking');
}
