#!/usr/bin/env node

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import mysql from 'mysql2/promise';

const APPLY = process.argv.includes('--apply');
const MIGRATION_ID = '021_context_free_results';
const PREVIOUS_MIGRATION_ID = '020_result_medians';
const LOCK_NAME = 'benchpoll_context_free_results_migration';
const OBSOLETE_COLUMN = 'ranking_context_ID';

function readLocalCredentials() {
    const credentialPath = path.resolve('db-credentials.local.md');
    if (!fs.existsSync(credentialPath)) return null;
    const content = fs.readFileSync(credentialPath, 'utf8');
    const readValue = key => content
        .match(new RegExp(`^${key}\\s*[:=]\\s*[\\x60"]?(.+?)[\\x60"]?\\s*$`, 'mi'))?.[1]
        ?.trim();
    return {
        host: readValue('host') || 'localhost',
        port: Number(readValue('port') || 3306),
        user: readValue('user'),
        password: readValue('password'),
        database: readValue('database') || 'benchmarks'
    };
}

function databaseConfig() {
    const password = process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD;
    const local = password === undefined ? readLocalCredentials() : null;
    const config = local ?? {
        host: process.env.BENCHPOLL_DB_HOST || 'localhost',
        port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
        user: process.env.BENCHPOLL_DB_USER || 'root',
        password,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks'
    };
    if (!config?.user || config.password === undefined || !Number.isInteger(config.port)) {
        throw new Error('Database credentials are unavailable or incomplete.');
    }
    return { ...config, charset: 'utf8mb4' };
}

function quoteIdentifier(value) {
    const identifier = String(value);
    if (!/^[A-Za-z0-9_$]+$/.test(identifier)) {
        throw new Error(`Unsafe database identifier: ${identifier}`);
    }
    return `\`${identifier}\``;
}

async function columnExists(connection) {
    const [rows] = await connection.execute(`
        SELECT 1
        FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'benchmark_results'
          AND COLUMN_NAME = ?
        LIMIT 1`, [OBSOLETE_COLUMN]);
    return rows.length === 1;
}

async function foreignKeysForColumn(connection) {
    const [rows] = await connection.execute(`
        SELECT DISTINCT CONSTRAINT_NAME AS name
        FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'benchmark_results'
          AND COLUMN_NAME = ?
          AND REFERENCED_TABLE_NAME IS NOT NULL
        ORDER BY CONSTRAINT_NAME`, [OBSOLETE_COLUMN]);
    return rows.map(row => String(row.name));
}

async function indexesForColumn(connection) {
    const [rows] = await connection.execute(`
        SELECT DISTINCT INDEX_NAME AS name
        FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE()
          AND TABLE_NAME = 'benchmark_results'
          AND COLUMN_NAME = ?
          AND INDEX_NAME <> 'PRIMARY'
        ORDER BY INDEX_NAME`, [OBSOLETE_COLUMN]);
    return rows.map(row => String(row.name));
}

function parseModerationContent(value, ID) {
    if (value && typeof value === 'object' && !Buffer.isBuffer(value)) return value;
    try {
        return JSON.parse(Buffer.isBuffer(value) ? value.toString('utf8') : String(value));
    } catch {
        throw new Error(`Moderation log ${ID} contains invalid JSON.`);
    }
}

function stripObjectContext(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
    const contextFreeValue = { ...value };
    delete contextFreeValue.context;
    return contextFreeValue;
}

function contextFreeModerationContent(content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return content;
    if (content.type === 'benchmark_result') {
        const contextFreeContent = { ...content };
        delete contextFreeContent.context;
        return {
            ...contextFreeContent,
            schemaVersion: Math.max(6, Number(content.schemaVersion) || 0)
        };
    }
    if (content.type === 'entity_change' && content.targetKind === 'result') {
        return {
            ...content,
            schemaVersion: Math.max(6, Number(content.schemaVersion) || 0),
            before: stripObjectContext(content.before),
            after: stripObjectContext(content.after),
            ...(Object.hasOwn(content, 'proposed')
                ? { proposed: stripObjectContext(content.proposed) }
                : {}),
            changes: Array.isArray(content.changes)
                ? content.changes.filter(change => !String(change?.field ?? '').startsWith('context'))
                : []
        };
    }
    return content;
}

function hasObsoleteResultContext(content) {
    if (!content || typeof content !== 'object' || Array.isArray(content)) return false;
    if (content.type === 'benchmark_result') return Object.hasOwn(content, 'context');
    if (content.type !== 'entity_change' || content.targetKind !== 'result') return false;
    return [content.before, content.after, content.proposed].some(value => (
        value && typeof value === 'object' && Object.hasOwn(value, 'context')
    )) || (content.changes ?? []).some(change => String(change?.field ?? '').startsWith('context'));
}

async function migrateModerationLogs(connection, { apply }) {
    const [rows] = await connection.execute('SELECT ID, content FROM moderation_logs ORDER BY ID');
    let affected = 0;
    for (const row of rows) {
        const parsed = parseModerationContent(row.content, row.ID);
        const migrated = contextFreeModerationContent(parsed);
        if (JSON.stringify(migrated) === JSON.stringify(parsed)) continue;
        affected += 1;
        if (apply) {
            await connection.execute(
                'UPDATE moderation_logs SET content = ?, updated_at = updated_at WHERE ID = ?',
                [JSON.stringify(migrated), row.ID]
            );
        }
    }
    return affected;
}

async function schemaState(connection) {
    return {
        obsoleteColumn: await columnExists(connection),
        foreignKeys: await foreignKeysForColumn(connection),
        indexes: await indexesForColumn(connection),
        moderationLogsToRewrite: await migrateModerationLogs(connection, { apply: false })
    };
}

async function verifyPostconditions(connection) {
    const state = await schemaState(connection);
    if (state.obsoleteColumn || state.foreignKeys.length > 0 || state.indexes.length > 0) {
        throw new Error(`Context-free result schema invariant failed: ${JSON.stringify(state)}`);
    }
    const [rows] = await connection.execute('SELECT ID, content FROM moderation_logs ORDER BY ID');
    const stale = rows.filter(row => hasObsoleteResultContext(
        parseModerationContent(row.content, row.ID)
    ));
    if (stale.length > 0) {
        throw new Error(`Result context remains in moderation logs: ${stale.map(row => row.ID).join(', ')}`);
    }
    return state;
}

async function applyMigration(connection) {
    await connection.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            migration_id VARCHAR(128) NOT NULL,
            applied_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (migration_id)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`);
    const [existing] = await connection.execute(
        'SELECT applied_at FROM schema_migrations WHERE migration_id = ?',
        [MIGRATION_ID]
    );
    if (existing.length > 0) {
        return {
            applied: false,
            alreadyAppliedAt: existing[0].applied_at,
            ...(await verifyPostconditions(connection))
        };
    }
    const [previous] = await connection.execute(
        'SELECT 1 FROM schema_migrations WHERE migration_id = ? LIMIT 1',
        [PREVIOUS_MIGRATION_ID]
    );
    if (previous.length !== 1) {
        throw new Error(`Apply ${PREVIOUS_MIGRATION_ID} before ${MIGRATION_ID}.`);
    }

    const before = await schemaState(connection);
    for (const foreignKey of before.foreignKeys) {
        await connection.query(`ALTER TABLE benchmark_results DROP FOREIGN KEY ${quoteIdentifier(foreignKey)}`);
    }
    for (const index of before.indexes) {
        await connection.query(`ALTER TABLE benchmark_results DROP INDEX ${quoteIdentifier(index)}`);
    }
    if (before.obsoleteColumn) {
        await connection.query(`ALTER TABLE benchmark_results DROP COLUMN ${quoteIdentifier(OBSOLETE_COLUMN)}`);
    }
    const rewrittenModerationLogs = await migrateModerationLogs(connection, { apply: true });
    const after = await verifyPostconditions(connection);
    await connection.execute(
        'INSERT INTO schema_migrations (migration_id) VALUES (?)',
        [MIGRATION_ID]
    );
    return { applied: true, before, rewrittenModerationLogs, after };
}

const connection = await mysql.createConnection(databaseConfig());
try {
    if (!APPLY) {
        console.log(JSON.stringify({
            migration: MIGRATION_ID,
            dryRun: true,
            ...(await schemaState(connection))
        }, null, 2));
    } else {
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [LOCK_NAME]);
        if (Number(lock.acquired) !== 1) {
            throw new Error('Could not acquire the database migration lock.');
        }
        try {
            console.log(JSON.stringify({
                migration: MIGRATION_ID,
                ...(await applyMigration(connection))
            }, null, 2));
        } finally {
            await connection.query('SELECT RELEASE_LOCK(?)', [LOCK_NAME]);
        }
    }
} finally {
    await connection.end();
}
