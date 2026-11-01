import { arenaRowHash } from './arena-import-plan.js';
import { commitTransactionConnection, destroyTransactionConnection, isTransactionConnectionDiscarded,
    rollbackTransactionConnection, startTransactionConnection } from './db-transaction.js';

export async function initializeArenaConflictSchema(connection) {
    // Preserve the exact source serialization used by its existing hash contract.
    await connection.query(`CREATE TABLE IF NOT EXISTS arena_sync_conflicts (
        row_key char(64) NOT NULL PRIMARY KEY,
        result_ID bigint unsigned NOT NULL,
        incoming_hash char(64) NULL,
        incoming_row longtext NULL,
        source_revision char(40) NOT NULL,
        config varchar(64) NOT NULL,
        category varchar(96) NOT NULL,
        status enum('pending','accept_source') NOT NULL DEFAULT 'pending',
        reviewed_by_user_ID bigint unsigned NULL,
        reviewed_at datetime(3) NULL,
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_arena_conflict_result FOREIGN KEY (result_ID) REFERENCES benchmark_results (ID) ON DELETE CASCADE,
        CONSTRAINT chk_arena_conflict_json CHECK (incoming_row IS NULL OR JSON_VALID(incoming_row))
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

export class ArenaSyncConflictError extends Error {
    constructor(conflicts) {
        super(`${conflicts.length} Arena source changes need review before publication`);
        this.conflicts = conflicts;
    }
}

export function arenaSourceChangeApproved(previous, resolution, incomingHash) {
    return resolution?.status === 'accept_source'
        && Number(resolution.result_ID) === Number(previous.result_ID)
        && resolution.incoming_hash === incomingHash;
}

export function findArenaSyncConflicts(entries, tracked, resolutions = []) {
    const entriesByKey = new Map(entries.map(entry => [entry.key, entry]));
    const resolutionsByKey = new Map(resolutions.map(row => [row.row_key, row]));
    return tracked.flatMap(previous => {
        if (previous.manual_override === 'none') return [];
        const entry = entriesByKey.get(previous.row_key);
        const incomingHash = entry ? arenaRowHash(entry.row) : null;
        if (incomingHash === previous.source_hash || arenaSourceChangeApproved(previous, resolutionsByKey.get(previous.row_key), incomingHash)) return [];
        return [{ rowKey: previous.row_key, resultID: Number(previous.result_ID), incomingHash,
            incomingRow: entry?.row ?? null, config: previous.config, category: previous.category }];
    });
}

export async function rollbackArenaTransaction(connection, label, originalError) {
    let rollbackError;
    // Retain the rollback cause while the shared helper owns its timeout and discards the actual lease.
    const rolledBack = await rollbackTransactionConnection({
        async rollback() {
            try { await connection.rollback(); }
            catch (error) { rollbackError = error; throw error; }
        },
        destroy() { destroyTransactionConnection(connection, label); }
    }, label, originalError);
    if (rolledBack) return null;
    destroyTransactionConnection(connection, label);
    return rollbackError ?? new Error(`${label} rollback could not be confirmed`);
}

export async function persistArenaSyncConflicts(connection, conflicts, revision) {
    let transactionStarted = false;
    try {
        await startTransactionConnection(connection, 'Arena conflict persistence');
        transactionStarted = true;
        for (const conflict of conflicts) {
            await connection.execute(`INSERT INTO arena_sync_conflicts
                (row_key,result_ID,incoming_hash,incoming_row,source_revision,config,category)
                VALUES (?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE
                result_ID=VALUES(result_ID),incoming_hash=VALUES(incoming_hash),incoming_row=VALUES(incoming_row),
                source_revision=VALUES(source_revision),status='pending',reviewed_by_user_ID=NULL,reviewed_at=NULL,updated_at=NOW(3)`,
            [conflict.rowKey, conflict.resultID, conflict.incomingHash,
                conflict.incomingRow === null ? null : JSON.stringify(conflict.incomingRow), revision, conflict.config, conflict.category]);
        }
        await commitTransactionConnection(connection, 'Arena conflict persistence');
    } catch (error) {
        if (transactionStarted && !isTransactionConnectionDiscarded(connection)) {
            const rollbackError = await rollbackArenaTransaction(connection, 'Arena conflict persistence', error);
            if (rollbackError) throw new AggregateError([error, rollbackError],
                'Arena conflict persistence and rollback failed', { cause: error });
        }
        throw error;
    }
}

export async function resolveArenaSyncConflict(connection, input, reviewerUserID) {
    if (!input || Object.keys(input).some(key => !['rowKey', 'resultID', 'incomingHash', 'choice'].includes(key))
        || !/^[a-f0-9]{64}$/.test(input.rowKey) || !Number.isSafeInteger(input.resultID) || input.resultID < 1
        || !Object.hasOwn(input, 'incomingHash')
        || (input.incomingHash !== null && !/^[a-f0-9]{64}$/.test(input.incomingHash))
        || !['source', 'correction'].includes(input.choice)) {
        throw { status: 400, body: { error: 'invalid_sync_conflict_resolution' } };
    }
    const [rows] = await connection.execute(`SELECT c.*,a.result_ID AS tracked_result_ID,a.source_hash AS previous_hash,
        a.manual_override,r.status AS result_status FROM arena_sync_conflicts c JOIN arena_import_rows a ON a.row_key=c.row_key
        JOIN benchmark_results r ON r.ID=a.result_ID
        WHERE c.row_key=? FOR UPDATE`, [input.rowKey]);
    const before = rows[0];
    if (!before || before.status !== 'pending' || Number(before.result_ID) !== input.resultID
        || Number(before.tracked_result_ID) !== input.resultID || before.incoming_hash !== input.incomingHash
        || before.manual_override === 'none') throw { status: 409, body: { error: 'sync_conflict_changed' } };
    if (input.choice === 'correction') {
        if (before.incoming_hash === null) throw { status: 400, body: { error: 'removed_source_requires_acceptance' } };
        if (!(before.manual_override === 'edit' && before.result_status === 'accepted')
            && !(before.manual_override === 'delete' && before.result_status === 'superseded')) {
            throw { status: 409, body: { error: 'sync_correction_changed' } };
        }
        const incoming = typeof before.incoming_row === 'string' ? JSON.parse(before.incoming_row) : before.incoming_row;
        if (arenaRowHash(incoming) !== before.incoming_hash) throw new Error('The stored Arena review candidate is invalid');
        const [updated] = await connection.execute(`UPDATE arena_import_rows SET source_hash=?,source_revision=?,source_date=?
            WHERE row_key=? AND result_ID=?`, [before.incoming_hash, before.source_revision,
            incoming.leaderboard_publish_date, input.rowKey, input.resultID]);
        if (Number(updated.affectedRows) !== 1) throw new Error('Arena review lost its source tracking');
        await connection.execute('DELETE FROM arena_sync_conflicts WHERE row_key=?', [input.rowKey]);
    } else {
        const [updated] = await connection.execute(`UPDATE arena_sync_conflicts SET status='accept_source',
            reviewed_by_user_ID=?,reviewed_at=NOW(3),updated_at=NOW(3) WHERE row_key=? AND status='pending'`,
        [reviewerUserID, input.rowKey]);
        if (Number(updated.affectedRows) !== 1) throw new Error('Arena source acceptance was not recorded');
    }
    return { before, after: { ...input, status: input.choice === 'source' ? 'accept_source' : 'kept_correction' } };
}
