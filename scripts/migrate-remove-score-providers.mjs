import 'dotenv/config';
import mysql from 'mysql2/promise';
import { pathToFileURL } from 'node:url';

export function upgradeScoreContent(input) {
    const content = structuredClone(input);
    if (content.type === 'new_provider') throw new Error('Provider application requires explicit archival before migration');
    if (content.type !== 'benchmark_result' && !(content.type === 'entity_change' && content.targetKind === 'result')) return null;
    if (content.schemaVersion === 8) return null;
    if (content.schemaVersion !== 7) throw new Error('Unexpected score submission schema');
    const strip = result => {
        if (!result?.source || !result.source.url) throw new Error('Missing score source URL');
        delete result.source.providerID;
        delete result.source.providerRef;
    };
    if (content.type === 'benchmark_result') content.results.forEach(strip);
    else {
        strip(content.before.result);
        if (content.operation === 'update') strip(content.after.result);
        if (content.operation === 'merge') strip(content.after.destinationBefore.result);
        content.changes = content.changes.filter(change => !/\.source\.provider(?:ID|Ref)(?:\.|$)/.test(change.path));
        if (!content.changes.length) throw new Error('Provider-only change requires explicit archival before migration');
    }
    content.schemaVersion = 8;
    return content;
}

async function main() {
    const apply = process.argv.includes('--apply');
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    if (password === undefined) throw new Error('Database credentials are required.');
    const connection = await mysql.createConnection({ host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306), user: process.env.BENCHPOLL_DB_USER || 'root',
        password, database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4' });
    const hasColumn = async (table, column) => {
        const [rows] = await connection.execute(`SELECT 1 FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = ?`, [table, column]);
        return rows.length > 0;
    };
    try {
        const [locks] = await connection.execute("SELECT GET_LOCK('benchpoll_remove_score_providers', 10) AS acquired");
        if (Number(locks[0].acquired) !== 1) throw new Error('Migration is already running.');
        const [logs] = await connection.execute('SELECT ID, content FROM moderation_logs');
        const upgraded = logs.map(row => ({ ...row, next: upgradeScoreContent(typeof row.content === 'string' ? JSON.parse(row.content) : row.content) })).filter(row => row.next);
        const [counts] = await connection.execute('SELECT COUNT(*) AS scores FROM benchmark_results');
        const scoreColumn = await hasColumn('benchmark_results', 'provider_organization_ID');
        const roleColumn = await hasColumn('organizations', 'is_score_provider');
        if (!apply) {
            console.log(JSON.stringify({ dryRun: true, ...counts[0], upgradedLogs: upgraded.length, scoreColumn, roleColumn }));
            return;
        }
        // Archive removed attribution and original requests; audit/history tables are never rewritten.
        await connection.query(`CREATE TABLE IF NOT EXISTS score_provider_retirement_archive (
            entity_type VARCHAR(32) NOT NULL, entity_id BIGINT UNSIGNED NOT NULL,
            snapshot JSON NOT NULL, archived_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (entity_type, entity_id))`);
        await connection.beginTransaction();
        for (const row of upgraded) {
            const original = typeof row.content === 'string' ? row.content : JSON.stringify(row.content);
            await connection.execute(`INSERT INTO score_provider_retirement_archive (entity_type, entity_id, snapshot)
                VALUES ('moderation_log', ?, ?) ON DUPLICATE KEY UPDATE entity_id = entity_id`, [row.ID, original]);
            await connection.execute('UPDATE moderation_logs SET content = ? WHERE ID = ?', [JSON.stringify(row.next), row.ID]);
        }
        if (scoreColumn) await connection.execute(`INSERT INTO score_provider_retirement_archive (entity_type, entity_id, snapshot)
            SELECT 'score', ID, JSON_OBJECT('providerID', provider_organization_ID) FROM benchmark_results
            WHERE provider_organization_ID IS NOT NULL ON DUPLICATE KEY UPDATE entity_id = entity_id`);
        if (roleColumn) await connection.execute(`INSERT INTO score_provider_retirement_archive (entity_type, entity_id, snapshot)
            SELECT 'organization', ID, JSON_OBJECT('isScoreProvider', is_score_provider) FROM organizations
            ON DUPLICATE KEY UPDATE entity_id = entity_id`);
        await connection.commit();
        if (scoreColumn) {
            const [keys] = await connection.execute(`SELECT CONSTRAINT_NAME FROM information_schema.KEY_COLUMN_USAGE
                WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'benchmark_results'
                AND COLUMN_NAME = 'provider_organization_ID' AND REFERENCED_TABLE_NAME IS NOT NULL`);
            for (const key of keys) await connection.query(`ALTER TABLE benchmark_results DROP FOREIGN KEY ${mysql.escapeId(key.CONSTRAINT_NAME)}`);
            await connection.query('ALTER TABLE benchmark_results DROP COLUMN provider_organization_ID');
        }
        if (roleColumn) await connection.query('ALTER TABLE organizations DROP COLUMN is_score_provider');
        await connection.execute(`INSERT INTO schema_migrations (migration_id) SELECT '025_remove_score_providers'
            WHERE NOT EXISTS (SELECT 1 FROM schema_migrations WHERE migration_id = '025_remove_score_providers')`);
        const [after] = await connection.execute('SELECT COUNT(*) AS scores FROM benchmark_results');
        if (Number(after[0].scores) !== Number(counts[0].scores)) throw new Error('Unexpected score count change');
        console.log(JSON.stringify({ applied: true, upgradedLogs: upgraded.length, ...after[0], originalMetadataArchived: true }));
    } catch (error) {
        await connection.rollback();
        console.error(JSON.stringify({ error: error.code || error.message }));
        process.exitCode = 1;
    } finally {
        await connection.execute("SELECT RELEASE_LOCK('benchpoll_remove_score_providers')");
        await connection.end();
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
