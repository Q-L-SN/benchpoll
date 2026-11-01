import 'dotenv/config';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const COMMUNITY_FALLBACK_MIGRATION = 'community_fallback_20261030';

export async function inspectCommunityFallback(connection) {
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS tableName, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE()
        AND ((TABLE_NAME = 'personal_pie_score_rules' AND COLUMN_NAME = 'family_ID')
        OR (TABLE_NAME = 'benchmark_family_members' AND COLUMN_NAME = 'benchmark_condition_ID'))`);
    const rule = columns.find(column => column.tableName === 'personal_pie_score_rules');
    const member = columns.find(column => column.tableName === 'benchmark_family_members');
    if (![rule, member].every(column => column?.type.toLowerCase() === 'bigint unsigned')) throw new Error('Ordered fallback schema is required');
    const [marks] = await connection.execute('SELECT migration_id FROM schema_migrations WHERE migration_id = ?', [COMMUNITY_FALLBACK_MIGRATION]);
    return { ready: rule.nullable === 'YES' && member.nullable === 'NO' && marks.length === 1,
        explicitNoneReady: rule.nullable === 'YES', concreteVersionsOnly: member.nullable === 'NO', resetApplied: marks.length === 1 };
}

async function protectedState(connection) {
    const [weights] = await connection.query(`SELECT pie_ID, benchmark_condition_ID, weight_basis_points
        FROM personal_pie_weights ORDER BY pie_ID, benchmark_condition_ID`);
    const [pies] = await connection.query(`SELECT ID, user_ID, context_ID, created_at, updated_at FROM personal_pies ORDER BY ID`);
    return { weightCount: weights.length, pieCount: pies.length,
        hash: createHash('sha256').update(JSON.stringify([pies, weights])).digest('hex') };
}

export async function migrateCommunityFallback(connection) {
    const state = await inspectCommunityFallback(connection);
    if (state.ready) return { applied: false, protectedDataUnchanged: true, ...state };
    const before = await protectedState(connection);
    if (!state.explicitNoneReady) await connection.query('ALTER TABLE personal_pie_score_rules MODIFY COLUMN family_ID BIGINT UNSIGNED NULL');
    let clearedRules = 0, clearedFamilies = 0;
    if (!state.resetApplied) {
        await connection.beginTransaction();
        try {
            await connection.query(`UPDATE personal_pies p JOIN (SELECT DISTINCT pie_ID FROM personal_pie_score_rules) r
                ON r.pie_ID = p.ID SET p.revision = p.revision + 1, p.updated_at = p.updated_at`);
            const [rules] = await connection.query('DELETE FROM personal_pie_score_rules');
            const [families] = await connection.query('DELETE FROM benchmark_families');
            clearedRules = Number(rules.affectedRows); clearedFamilies = Number(families.affectedRows);
            const after = await protectedState(connection);
            if (after.hash !== before.hash) throw new Error('Fallback reset changed protected pie data');
            // The reset and marker commit together; retry must never erase subsequent choices.
            await connection.execute('INSERT INTO schema_migrations (migration_id) VALUES (?)', [COMMUNITY_FALLBACK_MIGRATION]);
            await connection.commit();
        } catch (error) { await connection.rollback(); throw error; }
    }
    if (!state.concreteVersionsOnly) await connection.query('ALTER TABLE benchmark_family_members MODIFY COLUMN benchmark_condition_ID BIGINT UNSIGNED NOT NULL');
    const result = await inspectCommunityFallback(connection);
    const after = await protectedState(connection);
    if (!result.ready || before.hash !== after.hash) throw new Error('Community fallback migration verification failed');
    return { applied: true, ...result, clearedRules, clearedFamilies, protectedDataUnchanged: true, protectedState: after };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2), apply = args.includes('--apply'), check = args.includes('--check');
    if (args.some(arg => !['--apply', '--check', '--writes-stopped'].includes(arg) && !arg.startsWith('--backup-manifest='))) throw new Error('Unknown migration argument');
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    if (!apply && !check) {
        console.log(JSON.stringify({ migration: COMMUNITY_FALLBACK_MIGRATION, dryRun: true,
            resets: ['all legacy fallback choices', 'all saved fallback chains'],
            preserves: ['pie entries', 'pie weights', 'activity timestamps'], onceOnly: true, backupRequired: true, writesMustBeStopped: true }));
    } else {
        if (apply && check) throw new Error('Use --apply or --check, not both');
        if (apply && !args.includes('--writes-stopped')) throw new Error('Stop application writes and pass --writes-stopped before resetting legacy fallback choices');
        if (apply) await verifySlugBackup(args.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
            user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
            database, supportBigNumbers: true, bigNumberStrings: true });
        try {
            const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 30) AS acquired', [COMMUNITY_FALLBACK_MIGRATION]);
            if (Number(lock.acquired) !== 1) throw new Error('Community fallback migration is busy');
            try {
                const result = check ? await inspectCommunityFallback(connection) : await migrateCommunityFallback(connection);
                if (!result.ready) throw new Error('Community fallback migration is required');
                console.log(JSON.stringify({ migration: COMMUNITY_FALLBACK_MIGRATION, ...result }));
            } finally { await connection.execute('SELECT RELEASE_LOCK(?)', [COMMUNITY_FALLBACK_MIGRATION]); }
        } finally { await connection.end(); }
    }
}
