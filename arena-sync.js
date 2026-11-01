import { createHash } from 'node:crypto';
import { buildArenaPlan, arenaRowHash } from './arena-import-plan.js';
import { ArenaSyncConflictError, arenaSourceChangeApproved, initializeArenaConflictSchema,
    persistArenaSyncConflicts, rollbackArenaTransaction } from './arena-sync-conflicts.js';
import { commitTransactionConnection, destroyTransactionConnection, isTransactionConnectionDiscarded,
    startTransactionConnection } from './db-transaction.js';

export const ARENA_DATASET_URL = 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset';
export const ARENA_SNAPSHOT_VERSION = 2;

function timestamp(value, label) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value)
        || !Number.isFinite(Date.parse(value))) throw new Error(`Invalid ${label}`);
    return new Date(value).toISOString();
}

function publicationDate(value) {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)
        || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
        throw new Error('Invalid Arena leaderboard publication date');
    }
    return value;
}

export function arenaSnapshotContentHash(snapshot) {
    const content = snapshot.configs.map(config => [config.config,
        config.checksums.map(file => ({ filename: file.filename, sha256: file.sha256, rows: file.rows }))
            .sort((a, b) => a.filename.localeCompare(b.filename)), config.rows.map(arenaRowHash).sort()]);
    return createHash('sha256').update(JSON.stringify([
        snapshot.revision, content.sort((a, b) => a[0].localeCompare(b[0]))
    ])).digest('hex');
}

export function selectArenaSnapshotConfig(snapshot, configName) {
    if (!Array.isArray(snapshot?.expectedConfigs) || !Array.isArray(snapshot.configs)
        || new Set(snapshot.expectedConfigs).size !== snapshot.expectedConfigs.length
        || snapshot.configs.length !== snapshot.expectedConfigs.length
        || new Set(snapshot.configs.map(item => item.config)).size !== snapshot.configs.length
        || !snapshot.configs.every(item => snapshot.expectedConfigs.includes(item.config))) {
        throw new Error('Arena snapshot manifest is incomplete');
    }
    const config = snapshot.configs.find(item => item.config === configName);
    if (!config) throw new Error(`Arena snapshot is missing the requested config: ${configName}`);
    if (Object.hasOwn(config, 'fetchError')) throw new Error(`Arena download failed for ${configName}: ${config.fetchError}`);
    return { ...snapshot, expectedConfigs: [configName], configs: [config] };
}

export function validateArenaSnapshot(snapshot) {
    if (snapshot?.schemaVersion !== ARENA_SNAPSHOT_VERSION || snapshot.source !== ARENA_DATASET_URL
        || snapshot.license !== 'CC-BY-4.0' || !/^[a-f0-9]{40}$/.test(snapshot.revision)) {
        throw new Error('A complete version-2 official Arena snapshot is required; fetch a fresh snapshot');
    }
    const fetchedAt = timestamp(snapshot.fetchedAt, 'Arena fetch time');
    const sourceModifiedAt = timestamp(snapshot.sourceModifiedAt, 'Arena source revision time');
    if (sourceModifiedAt > fetchedAt) throw new Error('Arena source revision is newer than its fetch time');
    if (!Array.isArray(snapshot.expectedConfigs) || snapshot.expectedConfigs.length === 0
        || !snapshot.expectedConfigs.every(name => typeof name === 'string' && /^[a-z0-9_]+$/.test(name))
        || new Set(snapshot.expectedConfigs).size !== snapshot.expectedConfigs.length
        || !Array.isArray(snapshot.configs) || snapshot.configs.length !== snapshot.expectedConfigs.length) {
        throw new Error('Arena snapshot manifest is incomplete');
    }
    const expectedConfigs = new Set(snapshot.expectedConfigs);
    const configs = new Set();
    const feedDates = new Map();
    for (const config of snapshot.configs) {
        if (Object.hasOwn(config, 'fetchError')) throw new Error(`Arena download failed for ${config.config}: ${config.fetchError}`);
        if (!expectedConfigs.has(config.config) || configs.has(config.config)
            || !Array.isArray(config.rows) || config.rows.length === 0
            || !Array.isArray(config.checksums) || config.checksums.length === 0) {
            throw new Error(`Incomplete or duplicated Arena config: ${config.config}`);
        }
        configs.add(config.config);
        const filenames = new Set();
        let rowCount = 0;
        for (const file of config.checksums) {
            if (typeof file.filename !== 'string' || !file.filename || filenames.has(file.filename)
                || !/^[a-f0-9]{64}$/.test(file.sha256)
                || !Number.isSafeInteger(file.rows) || file.rows < 0
                || !Number.isSafeInteger(file.size) || file.size < 1) {
                throw new Error(`Invalid Arena file manifest: ${config.config}`);
            }
            filenames.add(file.filename);
            rowCount += file.rows;
        }
        if (rowCount !== config.rows.length) throw new Error(`Truncated Arena config: ${config.config}`);
        for (const row of config.rows) {
            if (typeof row.model_name !== 'string' || !row.model_name.trim()
                || typeof row.organization !== 'string'
                || typeof row.category !== 'string' || !row.category.trim()) {
                throw new Error(`Incomplete Arena model identity in ${config.config}`);
            }
            const date = publicationDate(row.leaderboard_publish_date);
            if (date > fetchedAt.slice(0, 10)) throw new Error('Arena publication date is in the future');
            const feed = `${config.config}/${row.category}`;
            if (feedDates.has(feed) && feedDates.get(feed) !== date) {
                throw new Error(`Mixed historical and current Arena dates in ${feed}`);
            }
            feedDates.set(feed, date);
        }
    }
    const plan = buildArenaPlan(snapshot);
    if (plan.conflicts.length > 0) {
        throw new Error(`Conflicting Arena source rows; the previous batch remains current: ${JSON.stringify(plan.conflicts)}`);
    }
    if (plan.entries.length === 0) throw new Error('Arena snapshot has no publishable scores');
    const contentHash = arenaSnapshotContentHash(snapshot);
    return { snapshot, plan, fetchedAt, sourceModifiedAt, feedDates, contentHash };
}

export function assertFreshArenaBatch(batch, { currentBatch = null, trackedRows = [], checkContentHash = true } = {}) {
    if (currentBatch) {
        const storedTime = currentBatch.source_modified_at;
        const previousModifiedAt = storedTime instanceof Date ? storedTime.toISOString()
            : new Date(/^\d{4}-\d{2}-\d{2} /.test(storedTime) ? storedTime.replace(' ', 'T') + 'Z' : storedTime).toISOString();
        if (batch.sourceModifiedAt < previousModifiedAt
            || (batch.sourceModifiedAt === previousModifiedAt && batch.snapshot.revision !== currentBatch.source_revision)) {
            throw new Error('Older or unordered Arena source revision cannot replace the current batch');
        }
        if (checkContentHash && batch.snapshot.revision === currentBatch.source_revision && batch.contentHash !== currentBatch.snapshot_hash) {
            throw new Error('Arena snapshot contents changed within the same source revision');
        }
    }
    for (const row of trackedRows) {
        const feed = `${row.config}/${row.category}`;
        const nextDate = batch.feedDates.get(feed);
        if (!nextDate) throw new Error(`Arena batch omits a currently published leaderboard: ${feed}`);
        if (nextDate < publicationDate(row.source_date)) {
            throw new Error(`Older Arena leaderboard cannot replace current scores: ${feed}`);
        }
    }
}

export function arenaTrackedAction(entry, previous, resolution = null) {
    if (!previous) return 'insert';
    const sourceHash = arenaRowHash(entry.row);
    if (previous.manual_override !== 'none') {
        if (previous.source_hash !== sourceHash) {
            if (arenaSourceChangeApproved(previous, resolution, sourceHash)) return 'replace';
            throw new Error(`Arena source changed under a manual correction; review required for result ${previous.result_ID}`);
        }
        if (previous.manual_override === 'delete' && previous.result_status === 'superseded') return 'suppressed';
        if (previous.manual_override === 'edit' && previous.result_status === 'accepted') return 'corrected';
        throw new Error(`Invalid Arena manual correction state: ${previous.result_ID}`);
    }
    if (previous.result_status !== 'accepted') {
        throw new Error(`Arena current result was changed outside the source importer: ${previous.result_ID}`);
    }
    return previous.source_hash === sourceHash ? 'unchanged' : 'replace';
}

export async function initializeArenaSyncSchema(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS arena_import_rows (
        row_key char(64) NOT NULL PRIMARY KEY,
        result_ID bigint unsigned NOT NULL,
        source_hash char(64) NOT NULL,
        source_revision char(40) NOT NULL,
        config varchar(64) NOT NULL,
        category varchar(96) NOT NULL,
        model_key varchar(192) NOT NULL,
        source_date date NOT NULL,
        manual_override enum('none','edit','delete') NOT NULL DEFAULT 'none',
        ingested_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uq_arena_import_result (result_ID),
        CONSTRAINT fk_arena_import_result FOREIGN KEY (result_ID) REFERENCES benchmark_results (ID) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE IF NOT EXISTS arena_sync_batches (
        ID bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_revision char(40) NOT NULL,
        source_modified_at datetime(3) NOT NULL,
        snapshot_hash char(64) NOT NULL,
        status enum('running','succeeded','failed') NOT NULL DEFAULT 'running',
        summary json NOT NULL,
        error_message text NULL,
        started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        completed_at datetime(3) NULL,
        KEY idx_arena_sync_revision (source_revision, status)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE IF NOT EXISTS arena_sync_state (
        ID tinyint unsigned NOT NULL PRIMARY KEY,
        current_batch_ID bigint unsigned NOT NULL,
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_arena_sync_singleton CHECK (ID = 1),
        CONSTRAINT fk_arena_sync_batch FOREIGN KEY (current_batch_ID) REFERENCES arena_sync_batches (ID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE IF NOT EXISTS arena_sync_feed_state (
        config varchar(64) NOT NULL PRIMARY KEY,
        current_batch_ID bigint unsigned NOT NULL,
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_arena_sync_feed_batch FOREIGN KEY (current_batch_ID) REFERENCES arena_sync_batches (ID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await initializeArenaConflictSchema(connection);
    await connection.query(`INSERT IGNORE INTO arena_sync_feed_state (config,current_batch_ID,updated_at)
        SELECT DISTINCT a.config,s.current_batch_ID,s.updated_at
        FROM arena_import_rows a CROSS JOIN arena_sync_state s WHERE s.ID=1`);
}

const connectionCleanupTimeoutMs = 5000;

async function recoverArenaPublication(connection, factory, work) {
    destroyTransactionConnection(connection, 'Arena publication recovery');
    if (typeof factory !== 'function') throw new Error('Arena publication recovery requires a clean connection factory');
    let recoveryConnection, cancelled = false, timer;
    const recovery = (async () => {
        recoveryConnection = await factory();
        if (cancelled) {
            if (recoveryConnection) destroyTransactionConnection(recoveryConnection, 'Arena publication late recovery');
            return;
        }
        if (!recoveryConnection || recoveryConnection === connection || isTransactionConnectionDiscarded(recoveryConnection)) {
            throw new Error('Arena publication recovery did not receive a clean connection');
        }
        await work(recoveryConnection, () => cancelled);
    })();
    try {
        await Promise.race([recovery, new Promise((_, reject) => {
            timer = setTimeout(() => {
                cancelled = true;
                if (recoveryConnection) destroyTransactionConnection(recoveryConnection, 'Arena publication recovery timeout');
                reject(new Error('Arena publication recovery timed out'));
            }, connectionCleanupTimeoutMs);
        })]);
    } finally {
        cancelled = true;
        clearTimeout(timer);
        if (recoveryConnection) destroyTransactionConnection(recoveryConnection, 'Arena publication recovery cleanup');
    }
}

export async function cleanupArenaImportConnection(connection, { lockName = null, originalError = null } = {}) {
    if (isTransactionConnectionDiscarded(connection)) return;
    const errors = [];
    let timer;
    const cleanup = (async () => {
        if (lockName) {
            try { await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
            catch (error) { errors.push(error); }
        }
        if (isTransactionConnectionDiscarded(connection)) return;
        try { await connection.end(); }
        catch (error) {
            errors.push(error);
            destroyTransactionConnection(connection, 'Arena import end failure');
        }
    })();
    try {
        await Promise.race([cleanup, new Promise((_, reject) => {
            timer = setTimeout(() => {
                destroyTransactionConnection(connection, 'Arena import cleanup timeout');
                reject(new Error('Arena import connection cleanup timed out'));
            }, connectionCleanupTimeoutMs);
        })]);
    } catch (error) { errors.push(error); }
    finally { clearTimeout(timer); }
    if (errors.length) {
        if (originalError) throw new AggregateError([originalError, ...errors],
            'Arena import failed; connection cleanup also failed', { cause: originalError });
        if (errors.length === 1) throw errors[0];
        throw new AggregateError(errors, 'Arena import connection cleanup failed');
    }
}

// The caller holds the Arena advisory lock. Publication and its success marker commit together.
export async function publishArenaBatch(connection, batch, work,
    { trackedRows = [], scoped = false, recoveryConnectionFactory = null } = {}) {
    const summary = { revision: batch.snapshot.revision, rows: batch.plan.entries.length,
        configs: batch.snapshot.expectedConfigs, feedDates: Object.fromEntries(batch.feedDates) };
    const [created] = await connection.execute(`INSERT INTO arena_sync_batches
        (source_revision,source_modified_at,snapshot_hash,summary) VALUES (?,?,?,?)`,
    [batch.snapshot.revision, batch.sourceModifiedAt.slice(0, 23).replace('T', ' '),
        batch.contentHash, JSON.stringify(summary)]);
    const batchID = Number(created.insertId);
    let transactionStarted = false, commitAttempted = false;
    try {
        await startTransactionConnection(connection, 'Arena publication');
        transactionStarted = true;
        const [feeds] = await connection.query(`SELECT batches.* FROM arena_sync_feed_state state
            JOIN arena_sync_batches batches ON batches.ID=state.current_batch_ID
            WHERE state.config IN (?) FOR UPDATE`, [batch.snapshot.expectedConfigs]);
        for (const current of feeds) {
            if (current.status !== 'succeeded') throw new Error('The current Arena feed batch is not successful');
            const previousSummary = typeof current.summary === 'string' ? JSON.parse(current.summary) : current.summary;
            const sameScope = JSON.stringify([...(previousSummary.configs || [])].sort())
                === JSON.stringify([...batch.snapshot.expectedConfigs].sort());
            assertFreshArenaBatch(batch, { currentBatch: current, checkContentHash: sameScope });
        }
        if (!scoped) {
            const [current] = await connection.query(`SELECT batches.* FROM arena_sync_state state
                JOIN arena_sync_batches batches ON batches.ID=state.current_batch_ID WHERE state.ID=1 FOR UPDATE`);
            if (current[0] && current[0].status !== 'succeeded') throw new Error('The current Arena batch is not successful');
            assertFreshArenaBatch(batch, { currentBatch: current[0] ?? null });
        }
        assertFreshArenaBatch(batch, { trackedRows });
        const stats = await work();
        const [published] = await connection.execute(`UPDATE arena_sync_batches SET status='succeeded',summary=?,completed_at=NOW(3)
            WHERE ID=? AND status='running'`, [JSON.stringify({ ...summary, ...stats }), batchID]);
        if (Number(published.affectedRows) !== 1) throw new Error('Arena batch success marker was not written');
        for (const config of batch.snapshot.expectedConfigs) {
            await connection.execute(`INSERT INTO arena_sync_feed_state (config,current_batch_ID) VALUES (?,?)
                ON DUPLICATE KEY UPDATE current_batch_ID=VALUES(current_batch_ID),updated_at=NOW(3)`, [config, batchID]);
        }
        if (!scoped) await connection.execute(`INSERT INTO arena_sync_state (ID,current_batch_ID) VALUES (1,?)
            ON DUPLICATE KEY UPDATE current_batch_ID=VALUES(current_batch_ID),updated_at=NOW(3)`, [batchID]);
        commitAttempted = true;
        await commitTransactionConnection(connection, 'Arena publication');
        return { batchID, ...stats };
    } catch (error) {
        const errors = [error];
        if (transactionStarted && !isTransactionConnectionDiscarded(connection)) {
            const rollbackError = await rollbackArenaTransaction(connection, 'Arena publication', error);
            if (rollbackError) errors.push(rollbackError);
        }
        const recordFailure = async (cleanConnection, cancelled = () => false, recordConflicts = true) => {
            const message = typeof error?.message === 'string' ? error.message : 'Arena publication failed';
            const [logged] = await cleanConnection.execute(`UPDATE arena_sync_batches SET status='failed',error_message=?,completed_at=NOW(3)
                WHERE ID=? AND status='running'`, [message.slice(0, 16000), batchID]);
            if (cancelled()) return;
            if (Number(logged.affectedRows) !== 1) {
                const [[current]] = await cleanConnection.execute('SELECT status FROM arena_sync_batches WHERE ID=?', [batchID]);
                if (!['succeeded', 'failed'].includes(current?.status)) throw new Error('Arena batch failure marker was not written');
                return;
            }
            // A recovery lease no longer owns the publication advisory lock; only log its batch failure.
            if (recordConflicts && !commitAttempted && error instanceof ArenaSyncConflictError) {
                await persistArenaSyncConflicts(cleanConnection, error.conflicts, batch.snapshot.revision);
            }
        };
        try {
            if (isTransactionConnectionDiscarded(connection)) {
                await recoverArenaPublication(connection, recoveryConnectionFactory,
                    (recoveryConnection, cancelled) => recordFailure(recoveryConnection, cancelled, false));
            } else {
                await recordFailure(connection);
            }
        } catch (recoveryError) {
            errors.push(recoveryError);
        }
        if (errors.length > 1) throw new AggregateError(errors,
            'Arena publication failed; rollback/logging also failed', { cause: error });
        throw error;
    }
}
