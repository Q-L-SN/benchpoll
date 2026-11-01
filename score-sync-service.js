import { commitTransactionConnection, rollbackTransactionConnection, startTransactionConnection } from './db-transaction.js';

export const TRUSTED_SCORE_SOURCES = Object.freeze({
    arena_official: Object.freeze({ name: 'Arena.ai official Hugging Face dataset', intervalSeconds: 21600 })
});

export function validateScoreSyncRegistration({ sourceKey, intervalSeconds, operator, enabled = true }) {
    if (!Object.hasOwn(TRUSTED_SCORE_SOURCES, sourceKey)) throw new Error('Unregistered score-source adapter');
    if (!Number.isSafeInteger(intervalSeconds) || intervalSeconds < 3600 || intervalSeconds > 604800) {
        throw new Error('The sync interval must be between one hour and seven days');
    }
    if (typeof operator !== 'string' || !operator.trim() || operator.length > 192 || typeof enabled !== 'boolean') {
        throw new Error('A named operator and a boolean enabled state are required');
    }
    return { sourceKey, intervalSeconds, operator: operator.trim(), enabled };
}

export function scoreSyncOutcome(feeds) {
    if (!Array.isArray(feeds) || !feeds.length || feeds.some(feed => !['succeeded', 'failed'].includes(feed.status))) {
        throw new Error('A sync run must report every attempted feed');
    }
    const succeeded = feeds.filter(feed => feed.status === 'succeeded').length;
    return succeeded === feeds.length ? 'succeeded' : succeeded === 0 ? 'failed' : 'partial';
}

export async function initializeScoreSyncSchema(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS score_sync_jobs (
        ID bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
        source_key varchar(64) NOT NULL UNIQUE,
        enabled boolean NOT NULL DEFAULT TRUE,
        interval_seconds int unsigned NOT NULL,
        next_run_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        last_status enum('never','running','succeeded','partial','failed') NOT NULL DEFAULT 'never',
        registered_by varchar(192) NOT NULL,
        updated_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
        CONSTRAINT chk_score_sync_interval CHECK (interval_seconds BETWEEN 3600 AND 604800)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE IF NOT EXISTS score_sync_runs (
        ID bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
        job_ID bigint unsigned NOT NULL,
        status enum('running','succeeded','partial','failed') NOT NULL DEFAULT 'running',
        source_revision varchar(40) NULL,
        summary json NULL,
        error_message text NULL,
        started_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        completed_at datetime(3) NULL,
        KEY idx_score_sync_runs_job (job_ID,started_at),
        CONSTRAINT fk_score_sync_run_job FOREIGN KEY (job_ID) REFERENCES score_sync_jobs (ID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    await connection.query(`CREATE TABLE IF NOT EXISTS score_sync_registry_events (
        ID bigint unsigned NOT NULL AUTO_INCREMENT PRIMARY KEY,
        job_ID bigint unsigned NOT NULL,
        operator varchar(192) NOT NULL,
        configuration json NOT NULL,
        created_at datetime(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        CONSTRAINT fk_score_sync_registry_job FOREIGN KEY (job_ID) REFERENCES score_sync_jobs (ID)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
}

export async function registerScoreSync(connection, input) {
    const configuration = validateScoreSyncRegistration(input);
    try {
        await startTransactionConnection(connection, 'Score sync registration');
        await connection.execute(`INSERT INTO score_sync_jobs (source_key,interval_seconds,registered_by,enabled)
            VALUES (?,?,?,?) ON DUPLICATE KEY UPDATE interval_seconds=VALUES(interval_seconds),
            registered_by=VALUES(registered_by),enabled=VALUES(enabled),next_run_at=UTC_TIMESTAMP(3)`,
        [configuration.sourceKey, configuration.intervalSeconds, configuration.operator, configuration.enabled]);
        const [[job]] = await connection.execute('SELECT ID FROM score_sync_jobs WHERE source_key=? FOR UPDATE', [configuration.sourceKey]);
        await connection.execute(`INSERT INTO score_sync_registry_events (job_ID,operator,configuration) VALUES (?,?,?)`,
            [job.ID, configuration.operator, JSON.stringify(configuration)]);
        await commitTransactionConnection(connection, 'Score sync registration');
        return { ID: Number(job.ID), ...configuration };
    } catch (error) {
        await rollbackTransactionConnection(connection, 'Score sync registration', error);
        throw error;
    }
}
