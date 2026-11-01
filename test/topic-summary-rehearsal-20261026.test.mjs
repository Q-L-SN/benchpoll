import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as migration from '../scripts/migrate-topic-summaries-20261026.mjs';
import { SUMMARY_METADATA_TABLES, summaryRehearsalConfiguration, rehearseTopicSummaries,
    summaryMigrationProbe, assertSummaryPreservation } from '../ops/rehearse-topic-summaries-20261026.mjs';

const stage = '/home/ubuntu/benchpoll/scripts/topics-identity-ui-20261026/topics-identity-ui-20261026-123456';
const env = { BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_SOCKET: '/var/run/mysqld/mysqld.sock' };
const target = 'benchpoll_summary_rehearsal_123456';
const now = '2026-10-26 12:00:00';
const clone = value => structuredClone(value);
const fixture = () => ({
    categories: [...Object.keys(migration.OFFICIAL_TOPIC_SUMMARIES).map(Number), ...Array.from({ length: 45 }, (_, i) => 300 + i)]
        .sort((a, b) => a - b).map((ID, i) => ({ ID, name: `Topic ${ID}`, slug: `topic-${ID}`, parent_ID: null,
            position: i * 10, is_active: i < 30 ? 1 : 0, owner_user_ID: null, created_by_user_ID: null,
            description: ID === 54 ? 'Existing source scope.' : [null, '', '   '][i % 3],
            created_at: '2025-01-01 00:00:00', updated_at: '2025-01-01 00:00:00', unrelated_column: `keep-${ID}` })),
    schema_migrations: [{ migration_id: 'previous_metadata', applied_at: '2025-01-01 00:00:00' }],
    topic_migration_archive: [{ migration_id: 'previous_metadata', payload: '{"retained":true}', created_at: '2025-01-01 00:00:00' }]
});

class MetadataServer {
    constructor(options = {}) {
        this.options = { autoUpdatedAt: true, ...options };
        this.schemas = new Map([['benchmarks', fixture()]]);
        this.connections = []; this.sql = []; this.reports = [];
        this.columns = SUMMARY_METADATA_TABLES.flatMap(tableName => Object.keys(this.schemas.get('benchmarks')[tableName][0])
            .map(name => ({ tableName, name, columnType: 'text', nullable: 'YES', defaultValue: null, columnExtra: '', generationExpression: '' })));
    }
    connect = async settings => {
        const db = new MetadataConnection(this, settings.database);
        this.connections.push(db);
        return db;
    };
    async run() {
        return rehearseTopicSummaries(stage, { env, connect: this.connect,
            loadMigration: async url => { assert.ok(url.endsWith('/candidate/scripts/migrate-topic-summaries-20261026.mjs')); return migration; },
            saveReport: async (path, body, options) => {
                assert.equal(path, join(stage, 'summary-rehearsal.json')); assert.equal(options.mode, 0o600);
                this.reports.push(JSON.parse(body));
            } });
    }
}

class MetadataConnection {
    constructor(server, database) { this.server = server; this.database = database; this.closed = false; this.snapshot = null; this.readOnly = false; }
    get data() { return this.server.schemas.get(this.database); }
    async beginTransaction() { assert.equal(this.snapshot, null); this.snapshot = clone(this.data); }
    async commit() {
        this.snapshot = null;
        if (this.database === target && this.server.options.sourceDrift && !this.server.drifted) {
            this.server.schemas.get('benchmarks').categories[0].position++;
            this.server.drifted = true;
        }
    }
    async rollback() { if (this.snapshot) this.server.schemas.set(this.database, this.snapshot); this.snapshot = null; }
    async end() { this.closed = true; }
    async query(sql, args = []) { return this.execute(sql, args); }
    async execute(sql, args = []) {
        assert.equal(this.closed, false);
        sql = sql.replace(/\s+/g, ' ').trim();
        this.server.sql.push({ database: this.database, sql });
        assert.doesNotMatch(sql, /\b(?:users|scores|ranking_contexts|personal_pies)\b/i, 'Only the three metadata tables may be accessed');
        if (sql === 'SET SESSION TRANSACTION READ ONLY') { this.readOnly = true; return [[]]; }
        if (sql === 'START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY') {
            assert.equal(this.readOnly, true); await this.beginTransaction(); return [[]];
        }
        if (sql === 'SET SESSION sql_log_bin = 0') return [[]];
        if (sql === 'SELECT DATABASE() AS name') return [[{ name: this.database }]];
        if (sql.includes('FROM information_schema.schemata')) return [[{ count: this.server.schemas.has(args[0]) ? 1 : 0 }]];
        if (sql.includes('FROM information_schema.tables')) {
            const tables = Object.keys(this.server.schemas.get(args[0]) ?? {}).map(name => ({ name, storageEngine: 'InnoDB' }));
            return [tables.sort((a, b) => a.name.localeCompare(b.name))];
        }
        if (sql.includes('FROM information_schema.columns')) return [clone(this.server.columns)];
        let match = sql.match(/^CREATE DATABASE `([^`]+)` /);
        if (match) {
            assert.equal(match[1], target); assert.equal(this.server.schemas.has(target), false);
            this.server.schemas.set(target, {}); return [[]];
        }
        match = sql.match(/^CREATE TABLE `([^`]+)`\.`([^`]+)` LIKE `benchmarks`\.`([^`]+)`$/);
        if (match) {
            assert.equal(match[1], target); assert.equal(match[2], match[3]);
            assert.ok(SUMMARY_METADATA_TABLES.includes(match[2]));
            if (this.server.options.createFailure) throw new Error('Injected table creation failure');
            this.server.schemas.get(target)[match[2]] = []; return [[]];
        }
        match = sql.match(/^DROP DATABASE `([^`]+)`$/);
        if (match) {
            assert.equal(match[1], target);
            if (this.server.options.dropFailure) throw new Error('Injected database cleanup failure');
            if (this.server.options.dropNoop) return [[]];
            this.server.schemas.delete(target); return [[]];
        }
        match = sql.match(/^SELECT \* FROM `([^`]+)`\.`([^`]+)` ORDER BY `([^`]+)`$/);
        if (match) {
            assert.ok(SUMMARY_METADATA_TABLES.includes(match[2]));
            if (match[1] === 'benchmarks') { assert.equal(this.readOnly, true); assert.ok(this.snapshot); }
            const data = match[1] === 'benchmarks' ? this.snapshot : this.server.schemas.get(match[1]);
            const rows = clone(data[match[2]]);
            return [rows.sort((a, b) => match[3] === 'ID' ? Number(a.ID) - Number(b.ID) : a[match[3]].localeCompare(b[match[3]]))];
        }
        assert.equal(this.database, target, 'All unqualified migration reads and writes must use the isolated database');
        assert.equal(this.readOnly, false);
        match = sql.match(/^DELETE FROM `(categories|schema_migrations|topic_migration_archive)`$/);
        if (match) { this.data[match[1]] = []; return [[]]; }
        match = sql.match(/^INSERT INTO `(categories|schema_migrations|topic_migration_archive)` \(([^)]+)\) VALUES \([?, ]+\)$/);
        if (match) {
            const fields = match[2].split(', ').map(value => value.slice(1, -1));
            this.data[match[1]].push(Object.fromEntries(fields.map((field, i) => [field, args[i]]))); return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('SELECT migration_id FROM schema_migrations')) return [this.data.schema_migrations.filter(row => row.migration_id === args[0])];
        if (sql.startsWith('SELECT ID, name, description, is_active, owner_user_ID, created_by_user_ID FROM categories ORDER BY ID')) {
            return [clone(this.data.categories).sort((a, b) => a.ID - b.ID).map(row => Object.fromEntries(
                ['ID', 'name', 'description', 'is_active', 'owner_user_ID', 'created_by_user_ID'].map(key => [key, row[key]])))];
        }
        match = sql.match(/^UPDATE categories SET description = \?(, updated_at = updated_at)? WHERE ID = \?(?: AND name = \? AND description <=> \?)?$/);
        if (match) {
            const row = this.data.categories.find(row => Number(row.ID) === Number(args[1]));
            if (!row || (args.length === 4 && (row.name !== args[2] || row.description !== args[3]))) return [{ affectedRows: 0 }];
            const changed = row.description !== args[0];
            row.description = args[0];
            if (this.server.options.autoUpdatedAt && changed && !match[1]) row.updated_at = now;
            return [{ affectedRows: 1 }];
        }
        if (sql.startsWith('INSERT INTO categories (ID, name, slug, is_active, owner_user_ID, created_by_user_ID, description)')) {
            this.data.categories.push({ ID: args[0], name: args[1], slug: args[2], parent_ID: null, position: 0, is_active: 1,
                owner_user_ID: args[3], created_by_user_ID: args[4], description: args[5], created_at: now, updated_at: now, unrelated_column: 'default' });
            return [{ affectedRows: 1 }];
        }
        if (sql === 'INSERT INTO topic_migration_archive (migration_id, payload) VALUES (?, ?)') {
            assert.equal(this.data.topic_migration_archive.some(row => row.migration_id === args[0]), false);
            this.data.topic_migration_archive.push({ migration_id: args[0], payload: args[1], created_at: now });
            return [{ affectedRows: 1 }];
        }
        if (sql === 'INSERT INTO schema_migrations (migration_id) VALUES (?)') {
            assert.equal(this.data.schema_migrations.some(row => row.migration_id === args[0]), false);
            this.data.schema_migrations.push({ migration_id: args[0], applied_at: now }); return [{ affectedRows: 1 }];
        }
        throw new Error('Unexpected metadata test SQL: ' + sql);
    }
}

test('stage, account, socket and derived schema guards fail closed without connecting', async () => {
    const config = summaryRehearsalConfiguration(stage, { ...env, BENCHPOLL_DB_HOST: 'ignored', BENCHPOLL_DB_NAME: 'production_override' });
    assert.equal(config.target, target); assert.equal(config.settings.socketPath, env.BENCHPOLL_DB_SOCKET);
    assert.equal(config.settings.host, undefined); assert.equal(config.settings.database, undefined);
    for (const bad of [undefined, '.', stage + '/', stage + '\n', stage + '/child', stage + '/..', stage.replace('-123456', '-abc'),
        stage.replace('/topics-identity-ui-20261026/', '/topics-taxonomy-20261026/'), stage.replace('-123456', '-' + '1'.repeat(70))]) {
        await assert.rejects(rehearseTopicSummaries(bad, { env, connect() { assert.fail('Unsafe stage opened a database'); } }), /Unsafe/);
    }
    for (const settings of [{}, { BENCHPOLL_DB_USER: 'app' }, { ...env, BENCHPOLL_DB_SOCKET: 'localhost:3306' }]) {
        assert.throws(() => summaryRehearsalConfiguration(stage, settings), /root socket|absolute Unix/);
    }
});

test('complete metadata-only rehearsal covers real migration behavior and verified cleanup without source writes', async () => {
    const server = new MetadataServer(), before = clone(server.schemas.get('benchmarks'));
    const result = await server.run();
    assert.equal(result.verified, true); assert.equal(result.metadataOnly, true);
    assert.equal(result.result.topics, 75); assert.equal(result.result.activeTopics, 30);
    assert.equal(result.temporaryDatabaseRemoved, true); assert.equal(result.sourceMetadataUnchanged, true);
    assert.equal(result.scoreTablesNotCloned, true); assert.equal(result.sourceMetadataDigest.length, 64);
    assert.equal(result.scenarios.length, 8);
    assert.deepEqual(server.schemas.get('benchmarks'), before);
    assert.deepEqual([...server.schemas.keys()], ['benchmarks']);
    assert.ok(server.connections.every(db => db.closed));
    assert.equal(server.reports.length, 1); assert.equal(server.reports[0].verified, true);
    assert.deepEqual(server.sql.filter(row => row.sql.startsWith('CREATE TABLE')).map(row => row.sql.match(/\.`([^`]+)` LIKE/)[1]), SUMMARY_METADATA_TABLES);
    assert.ok(server.sql.filter(row => row.database === 'benchmarks').every(row => /^(SELECT|SET SESSION TRANSACTION|START TRANSACTION)\b/.test(row.sql)));
    assert.doesNotMatch(JSON.stringify(result), /Existing source scope|A private scope/);
});

test('unreviewed or source-qualified migration SQL cannot reach the root connection', async () => {
    let calls = 0;
    const probe = summaryMigrationProbe({ async execute() { calls++; }, async query() { calls++; } });
    for (const sql of ['UPDATE benchmarks.categories SET description = ?', 'UPDATE `benchmarks`.`categories` SET description = ?',
        'UPDATE categories SET description = ? WHERE ID = ? AND name = ? AND description <=> ?',
        'DELETE FROM categories', 'SELECT * FROM users', 'USE benchmarks', 'DROP DATABASE benchmarks']) {
        await assert.rejects(probe.connection.execute(sql), /Unreviewed summary migration SQL/);
    }
    assert.equal(calls, 0); assert.equal(probe.stats.writes, 0);
});

test('explicit timestamp self-assignment preserves every updated_at through migration and marked rerun', async () => {
    const server = new MetadataServer(); server.schemas.set(target, fixture());
    const db = await server.connect({ database: target });
    try {
        const control = server.schemas.get(target).categories[0], originalTimestamp = control.updated_at;
        await db.execute('UPDATE categories SET description = ? WHERE ID = ?', [control.description, control.ID]);
        assert.equal(control.updated_at, originalTimestamp, 'An implicit no-op must not advance the timestamp');
        await db.execute('UPDATE categories SET description = ? WHERE ID = ?', ['Changed control scope.', control.ID]);
        assert.equal(control.updated_at, now, 'The fixture must model automatic timestamp updates for actual changes');

        server.schemas.set(target, fixture());
        const before = clone(server.schemas.get(target));
        const result = await migration.applyTopicSummaries(summaryMigrationProbe(db).connection);
        assert.equal(result.applied, true); assert.ok(result.changedSummaries > 0);
        const after = clone(server.schemas.get(target));
        assert.deepEqual(after.categories.map(row => [row.ID, row.updated_at]), before.categories.map(row => [row.ID, row.updated_at]));
        assertSummaryPreservation(before, after, migration.topicSummaryPlan(before.categories), migration.TOPIC_SUMMARY_MIGRATION);
        assert.equal((await migration.applyTopicSummaries(summaryMigrationProbe(db).connection)).applied, false);
        assert.deepEqual(server.schemas.get(target), after);
    } finally { await db.end(); }
});

for (const [label, description] of [['oversized', 'x'.repeat(181)], ['multiline', 'Invalid\nsummary'],
    ['format control', 'Invalid\u200bsummary'], ['non-string', 42]]) {
    test('real migration rejects invalid late-row description before its first write: ' + label, async () => {
        const server = new MetadataServer(); server.schemas.set(target, fixture());
        server.schemas.get(target).categories.at(-1).description = description;
        const before = clone(server.schemas.get(target)), db = await server.connect({ database: target });
        const probe = summaryMigrationProbe(db);
        await assert.rejects(migration.applyTopicSummaries(probe.connection), /Review the existing summary|Invalid summary/);
        assert.equal(probe.stats.writes, 0); assert.equal(probe.stats.rollbacks, 1);
        assert.deepEqual(server.schemas.get(target), before); await db.end();
    });
}

test('a marker failure rolls back the archive and every update, then retries once and validates idempotently', async () => {
    const server = new MetadataServer(); server.schemas.set(target, fixture());
    const before = clone(server.schemas.get(target)), db = await server.connect({ database: target });
    const probe = summaryMigrationProbe(db, 'marker');
    await assert.rejects(migration.applyTopicSummaries(probe.connection), error => error.code === 'ER_LOCK_DEADLOCK');
    assert.ok(probe.stats.updates > 1); assert.equal(probe.stats.commits, 0); assert.equal(probe.stats.rollbacks, 1);
    assert.deepEqual(server.schemas.get(target), before);
    const result = await migration.applyTopicSummaries(summaryMigrationProbe(db).connection);
    assert.equal(result.applied, true);
    const after = clone(server.schemas.get(target));
    assertSummaryPreservation(before, after, migration.topicSummaryPlan(before.categories), migration.TOPIC_SUMMARY_MIGRATION);
    assert.equal((await migration.applyTopicSummaries(summaryMigrationProbe(db).connection)).applied, false);
    assert.deepEqual(server.schemas.get(target), after); await db.end();
});

test('marked validation failure rolls back without writes instead of treating the marker as sufficient', async () => {
    const server = new MetadataServer(); server.schemas.set(target, fixture());
    const db = await server.connect({ database: target });
    await migration.applyTopicSummaries(summaryMigrationProbe(db).connection);
    server.schemas.get(target).categories.at(-1).description = null;
    const before = clone(server.schemas.get(target)), probe = summaryMigrationProbe(db);
    await assert.rejects(migration.applyTopicSummaries(probe.connection), /missing summaries/);
    assert.equal(probe.stats.writes, 0); assert.equal(probe.stats.rollbacks, 1);
    assert.deepEqual(server.schemas.get(target), before); await db.end();
});

test('an existing isolated database is never reused, cleared or dropped', async () => {
    const server = new MetadataServer(); server.schemas.set(target, { protected: ['keep'] });
    await assert.rejects(server.run(), /Never overwrite/);
    assert.deepEqual(server.schemas.get(target), { protected: ['keep'] });
    assert.equal(server.sql.some(row => /^(CREATE|DELETE|INSERT|DROP) /.test(row.sql)), false);
    assert.equal(server.reports[0].verified, false); assert.ok(server.connections.every(db => db.closed));
});

for (const [options, message, removed, unchanged] of [
    [{ createFailure: true }, /table creation failure/, true, true],
    [{ sourceDrift: true }, /Source metadata changed/, true, false],
    [{ dropFailure: true }, /database cleanup failure/, false, true],
    [{ dropNoop: true }, /database was not removed/, false, true]
]) test('failure report verifies source and cleanup independently: ' + Object.keys(options)[0], async () => {
    const server = new MetadataServer(options);
    await assert.rejects(server.run(), message);
    const report = server.reports[0];
    assert.equal(report.verified, false); assert.equal(report.temporaryDatabaseRemoved, removed);
    assert.equal(report.sourceMetadataUnchanged, unchanged); assert.ok(report.failure);
    assert.equal(server.schemas.has(target), !removed); assert.ok(server.connections.every(db => db.closed));
});
