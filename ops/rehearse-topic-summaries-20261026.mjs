import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';

export const SUMMARY_METADATA_TABLES = Object.freeze(['categories', 'schema_migrations', 'topic_migration_archive']);
const source = 'benchmarks';
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const identifier = value => '`' + value.replaceAll('`', '``') + '`';
const migrationStatements = new Set([
    'SELECT migration_id FROM schema_migrations WHERE migration_id = ? FOR UPDATE',
    'SELECT ID, name, description, is_active, owner_user_ID, created_by_user_ID FROM categories ORDER BY ID FOR UPDATE',
    'SELECT ID, name, description, is_active, owner_user_ID, created_by_user_ID FROM categories ORDER BY ID',
    'UPDATE categories SET description = ?, updated_at = updated_at WHERE ID = ? AND name = ? AND description <=> ?',
    'INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)',
    'INSERT INTO schema_migrations (migration_id) VALUES (?)'
]);

export function summaryRehearsalConfiguration(stage, env = process.env) {
    const match = typeof stage === 'string' && stage.match(/^\/home\/ubuntu\/benchpoll\/scripts\/topics-identity-ui-20261026\/topics-identity-ui-20261026-(\d+)$/);
    if (!match || match[0] !== stage) throw new Error('Unsafe topic summary rehearsal stage');
    if (env.BENCHPOLL_DB_USER !== 'root') throw new Error('Use the root socket account for metadata rehearsal');
    const target = 'benchpoll_summary_rehearsal_' + match[1];
    if (target.length > 64) throw new Error('Unsafe summary rehearsal database name');
    const socketPath = env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock';
    if (!socketPath.startsWith('/') || /[\0\r\n]/.test(socketPath)) throw new Error('Use an absolute Unix database socket');
    return { stage, target, settings: { user: 'root', socketPath, password: env.DB_PASSWORD,
        supportBigNumbers: true, bigNumberStrings: true, dateStrings: true, jsonStrings: true } };
}

export async function readSummaryMetadata(db, schema) {
    if (schema !== source && !/^benchpoll_summary_rehearsal_\d+$/.test(schema)) throw new Error('Unsafe metadata schema');
    const result = {};
    for (const table of SUMMARY_METADATA_TABLES) {
        const key = table === 'categories' ? 'ID' : 'migration_id';
        [result[table]] = await db.query(`SELECT * FROM ${identifier(schema)}.${identifier(table)} ORDER BY ${identifier(key)}`);
    }
    return result;
}

export function summaryMigrationProbe(db, failAt = '') {
    const stats = { writes: 0, updates: 0, commits: 0, rollbacks: 0 };
    const statement = method => async (sql, args) => {
        const normalized = sql.replace(/\s+/g, ' ').trim();
        if (!migrationStatements.has(normalized)) throw new Error('Unreviewed summary migration SQL');
        if (/^(UPDATE|INSERT) /.test(normalized)) stats.writes++;
        if (normalized.startsWith('UPDATE categories')) stats.updates++;
        if ((failAt === 'second update' && stats.updates === 2 && normalized.startsWith('UPDATE categories'))
            || (failAt === 'archive' && normalized.startsWith('INSERT INTO topic_migration_archive'))
            || (failAt === 'marker' && normalized.startsWith('INSERT INTO schema_migrations'))) {
            throw Object.assign(new Error('Injected summary transaction failure: ' + failAt), { code: 'ER_LOCK_DEADLOCK' });
        }
        return db[method](sql, args);
    };
    return { stats, connection: {
        query: statement('query'), execute: statement('execute'), beginTransaction: () => db.beginTransaction(),
        async commit() { await db.commit(); stats.commits++; },
        async rollback() { await db.rollback(); stats.rollbacks++; }
    } };
}

export function assertSummaryPreservation(before, after, plan, migrationID) {
    const otherColumns = rows => rows.map(({ description: _description, ...row }) => row);
    assert.equal(sha(otherColumns(after.categories)), sha(otherColumns(before.categories)), 'A non-summary category column changed');
    assert.equal(sha(after.categories.map(row => [Number(row.ID), row.description])),
        sha(plan.map(row => [row.ID, row.description])), 'Summaries differ from the complete backfill plan');
    for (const table of ['schema_migrations', 'topic_migration_archive']) {
        assert.equal(sha(after[table].filter(row => row.migration_id !== migrationID)), sha(before[table]), 'Existing migration metadata changed');
        assert.equal(after[table].filter(row => row.migration_id === migrationID).length, 1, 'Missing or duplicate summary migration record');
    }
    const archived = after.topic_migration_archive.find(row => row.migration_id === migrationID).payload;
    const changes = plan.filter(row => row.before !== row.description);
    assert.equal(sha(typeof archived === 'string' ? JSON.parse(archived) : archived), sha({ changes }), 'Incorrect summary migration archive');
}

export async function exerciseTopicSummaryMigration({ db, target, migration, reset }) {
    const { applyTopicSummaries, topicSummaryPlan, TOPIC_SUMMARY_MIGRATION: migrationID } = migration;
    const scenarios = [];
    const read = () => readSummaryMetadata(db, target);
    async function applyChecked(before) {
        const plan = topicSummaryPlan(before.categories);
        const probe = summaryMigrationProbe(db);
        const result = await applyTopicSummaries(probe.connection);
        assert.equal(result.applied, true); assert.equal(result.verified, true);
        assert.equal(result.topics, before.categories.length);
        assert.equal(result.activeTopics, before.categories.filter(row => Number(row.is_active) === 1).length);
        assert.equal(result.changedSummaries, plan.filter(row => row.before !== row.description).length);
        assert.equal(probe.stats.commits, 1); assert.equal(probe.stats.rollbacks, 0);
        const after = await read();
        assertSummaryPreservation(before, after, plan, migrationID);
        return { result, after };
    }
    await reset();
    const initial = await read();
    assert.equal(initial.categories.length, 75, 'Review the changed source topic count');
    assert.equal(initial.categories.filter(row => Number(row.is_active) === 1).length, 30, 'Review the changed active topic count');
    for (const table of ['schema_migrations', 'topic_migration_archive']) {
        assert.equal(initial[table].some(row => row.migration_id === migrationID), false, 'Summary migration is already marked or archived');
    }
    const actual = await applyChecked(initial);
    scenarios.push('all 75 actual summaries, 30 active topics, every other category column and existing migration record preserved');
    const rerun = summaryMigrationProbe(db);
    assert.equal((await applyTopicSummaries(rerun.connection)).applied, false);
    assert.equal(rerun.stats.writes, 0); assert.equal(rerun.stats.commits, 1);
    assert.equal(sha(await read()), sha(actual.after), 'Marked rerun was not idempotent');
    scenarios.push('marked second apply validates without writes or duplicate archives');

    const lastID = Number(initial.categories.at(-1).ID);
    for (const bad of [null, 'x'.repeat(181), 'Invalid\nsummary']) {
        await db.execute('UPDATE categories SET description = ? WHERE ID = ?', [bad, lastID]);
        const before = await read(), probe = summaryMigrationProbe(db);
        await assert.rejects(applyTopicSummaries(probe.connection));
        assert.equal(probe.stats.writes, 0); assert.equal(probe.stats.rollbacks, 1);
        assert.equal(sha(await read()), sha(before), 'Marked validation failure changed metadata');
    }
    scenarios.push('marked validation rejects missing, oversized and multiline summaries and rolls back without writes');

    await reset();
    const authoredID = Number(initial.categories.find(row => Number(row.ID) === 54)?.ID);
    assert.equal(authoredID, 54, 'Expected official topic 54');
    await db.execute('UPDATE categories SET description = ? WHERE ID = ?', ['  Existing authored scope.  ', authoredID]);
    for (const [ID, name, slug, owner, text] of [
        [lastID + 1000, 'Custom public scope', 'summary-rehearsal-custom', null, '  A custom public scope.  '],
        [lastID + 1001, 'Private scope', 'summary-rehearsal-private', '42', '  A private scope.  ']
    ]) await db.execute(`INSERT INTO categories (ID, name, slug, is_active, owner_user_ID, created_by_user_ID, description)
        VALUES (?, ?, ?, 1, ?, ?, ?)`, [ID, name, slug, owner, '42', text]);
    await applyChecked(await read());
    scenarios.push('existing authored, custom public and private nonempty text preserved byte-for-byte');

    for (const bad of ['x'.repeat(181), 'Invalid\nsummary', 'Invalid\u200bsummary']) {
        await reset();
        await db.execute('UPDATE categories SET description = ? WHERE ID = ?', [bad, lastID]);
        const before = await read(), probe = summaryMigrationProbe(db);
        await assert.rejects(applyTopicSummaries(probe.connection), /Review the existing summary/);
        assert.equal(probe.stats.writes, 0, 'Validation must finish before the first migration write');
        assert.equal(probe.stats.rollbacks, 1);
        assert.equal(sha(await read()), sha(before), 'Invalid preexisting summary was partially migrated');
    }
    scenarios.push('invalid preexisting descriptions are rejected before any migration write and fully rolled back');

    for (const failAt of ['second update', 'archive', 'marker']) {
        await reset();
        // Ensure a second update is reached even when the source already has authored text.
        for (const row of initial.categories.slice(0, 2)) await db.execute('UPDATE categories SET description = ? WHERE ID = ?', [null, row.ID]);
        const before = await read(), probe = summaryMigrationProbe(db, failAt);
        await assert.rejects(applyTopicSummaries(probe.connection), /Injected summary transaction failure/);
        assert.equal(probe.stats.rollbacks, 1); assert.equal(probe.stats.commits, 0);
        assert.equal(sha(await read()), sha(before), 'Transaction failure retained partial summaries, archive or marker');
        const retry = await applyChecked(before);
        assert.equal((await applyTopicSummaries(summaryMigrationProbe(db).connection)).applied, false);
        assert.equal(sha(await read()), sha(retry.after), 'Retry was not idempotent');
        scenarios.push(`${failAt} transaction error fully rolls back; same-connection retry and marked rerun are safe`);
    }
    return { result: actual.result, scenarios };
}

async function sourceSnapshot(connect, settings) {
    const db = await connect({ ...settings, database: source });
    try {
        await db.query('SET SESSION TRANSACTION READ ONLY');
        await db.query('START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY');
        const [tables] = await db.execute(`SELECT table_name AS name, engine AS storageEngine FROM information_schema.tables
            WHERE table_schema = ? AND table_name IN (?, ?, ?) ORDER BY table_name`, [source, ...SUMMARY_METADATA_TABLES]);
        assert.deepEqual(tables.map(row => row.name).sort(), [...SUMMARY_METADATA_TABLES].sort(), 'Required metadata tables are missing');
        assert.ok(tables.every(row => row.storageEngine === 'InnoDB'), 'Rehearsal requires transactional metadata tables');
        const [columns] = await db.execute(`SELECT table_name AS tableName, column_name AS name, column_type AS columnType,
            is_nullable AS nullable, column_default AS defaultValue, extra AS columnExtra, generation_expression AS generationExpression
            FROM information_schema.columns WHERE table_schema = ? AND table_name IN (?, ?, ?)
            ORDER BY table_name, ordinal_position`, [source, ...SUMMARY_METADATA_TABLES]);
        const metadata = await readSummaryMetadata(db, source);
        await db.commit();
        return { tables, columns, metadata };
    } finally { await db.end(); }
}

export async function rehearseTopicSummaries(stage, { env = process.env, connect = settings => mysql.createConnection(settings),
    loadMigration = url => import(url), saveReport = writeFile } = {}) {
    const { target, settings } = summaryRehearsalConfiguration(stage, env);
    const report = { verified: false, metadataOnly: true, sourceDatabase: source, targetDatabase: target,
        tables: SUMMARY_METADATA_TABLES, sourceMetadataUnchanged: false, temporaryDatabaseRemoved: false, scenarios: [] };
    let admin, copy, original, created = false;
    const errors = [];
    try {
        const migration = await loadMigration(pathToFileURL(join(stage, 'candidate/scripts/migrate-topic-summaries-20261026.mjs')).href);
        admin = await connect(settings);
        const [[exists]] = await admin.execute('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?', [target]);
        if (Number(exists.count)) throw new Error('Never overwrite an existing summary rehearsal database');
        original = await sourceSnapshot(connect, settings);
        report.sourceMetadataDigest = sha(original);
        report.sourceTopics = original.metadata.categories.length;
        report.sourceActiveTopics = original.metadata.categories.filter(row => Number(row.is_active) === 1).length;
        await admin.query('SET SESSION sql_log_bin = 0');
        await admin.query(`CREATE DATABASE ${identifier(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
        created = true;
        // CREATE LIKE omits user foreign keys; no account or score data is copied.
        for (const table of SUMMARY_METADATA_TABLES) await admin.query(`CREATE TABLE ${identifier(target)}.${identifier(table)} LIKE ${identifier(source)}.${identifier(table)}`);
        const [cloned] = await admin.execute('SELECT table_name AS name FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name', [target]);
        assert.deepEqual(cloned.map(row => row.name).sort(), [...SUMMARY_METADATA_TABLES].sort(), 'Clone contains unexpected tables');
        report.scoreTablesNotCloned = true;
        copy = await connect({ ...settings, database: target });
        await copy.query('SET SESSION sql_log_bin = 0');
        const [[selected]] = await copy.query('SELECT DATABASE() AS name');
        assert.equal(selected.name, target, 'Migration connection must select the isolated database');
        async function reset() {
            await copy.beginTransaction();
            try {
                for (const table of SUMMARY_METADATA_TABLES) {
                    await copy.query(`DELETE FROM ${identifier(table)}`);
                    const columns = original.columns.filter(row => row.tableName === table && !/(?:VIRTUAL|STORED) GENERATED/i.test(row.columnExtra));
                    assert.ok(columns.length, 'Missing writable metadata columns');
                    const fields = columns.map(row => identifier(row.name)).join(', '), placeholders = columns.map(() => '?').join(', ');
                    for (const row of original.metadata[table]) await copy.execute(`INSERT INTO ${identifier(table)} (${fields}) VALUES (${placeholders})`, columns.map(column => row[column.name]));
                }
                await copy.commit();
            } catch (error) { await copy.rollback(); throw error; }
            assert.equal(sha(await readSummaryMetadata(copy, target)), sha(original.metadata), 'Metadata clone differs from the read-only source snapshot');
        }
        Object.assign(report, await exerciseTopicSummaryMigration({ db: copy, target, migration, reset }));
    } catch (error) { errors.push(error); }
    finally {
        const cleanup = async action => { try { await action(); } catch (error) { errors.push(error); } };
        if (copy) await cleanup(() => copy.end());
        if (created) await cleanup(async () => {
            await admin.query(`DROP DATABASE ${identifier(target)}`);
            const [[exists]] = await admin.execute('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?', [target]);
            assert.equal(Number(exists.count), 0, 'Isolated summary rehearsal database was not removed');
            report.temporaryDatabaseRemoved = true;
        });
        if (original) await cleanup(async () => {
            assert.equal(sha(await sourceSnapshot(connect, settings)), sha(original), 'Source metadata changed during isolated rehearsal');
            report.sourceMetadataUnchanged = true;
        });
        if (admin) await cleanup(() => admin.end());
        report.verified = errors.length === 0 && report.temporaryDatabaseRemoved && report.sourceMetadataUnchanged;
        if (errors.length) report.failure = errors.map(error => error.stack ?? String(error)).join('\n');
        await saveReport(join(stage, 'summary-rehearsal.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    }
    if (errors.length) throw new AggregateError(errors, 'Topic summary rehearsal failed: ' + errors.map(error => error.message).join('; '));
    return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    console.log(JSON.stringify(await rehearseTopicSummaries(process.argv[2])));
}
