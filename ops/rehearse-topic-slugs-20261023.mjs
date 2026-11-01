import { config } from 'dotenv';
import mysql from 'mysql2/promise';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';

const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/(?:topics-polish-20261023\/topics-polish-20261023|topics-policy-20261026\/topics-policy-20261026)-\d+$/.test(stage)) throw new Error('Unsafe rehearsal stage');
const nameURLs = stage.includes('/topics-policy-20261026/');
config({ path: '/home/ubuntu/benchpoll/.env', quiet: true });
const settings = { socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', user: process.env.BENCHPOLL_DB_USER || 'root',
    password: process.env.DB_PASSWORD, supportBigNumbers: true, bigNumberStrings: true };
if (settings.user !== 'root') throw new Error('Rehearsal needs the operational database account');
const source = 'benchmarks', target = 'benchpoll_slug_rehearsal_' + stage.split('-').at(-1);
if (!/^benchpoll_slug_rehearsal_\d+$/.test(target)) throw new Error('Unsafe metadata database name');
const db = await mysql.createConnection(settings);
let created = false, copy;
try {
    const [[exists]] = await db.execute('SELECT COUNT(*) AS count FROM information_schema.schemata WHERE schema_name = ?', [target]);
    if (Number(exists.count)) throw new Error('Never replace a pre-existing rehearsal database');
    const [original] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM benchmarks.categories ORDER BY ID');
    const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
    const beforeDigest = digest(original);
    await db.query(`CREATE DATABASE \`${target}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`); created = true;
    for (const table of ['categories', 'schema_migrations', 'topic_migration_archive', ...(nameURLs ? ['topic_legacy_routes'] : [])]) {
        await db.query(`CREATE TABLE \`${target}\`.\`${table}\` LIKE \`${source}\`.\`${table}\``);
        const [columns] = await db.execute(`SELECT column_name AS name FROM information_schema.columns
            WHERE table_schema = ? AND table_name = ? AND EXTRA NOT LIKE '%VIRTUAL GENERATED%'
            AND EXTRA NOT LIKE '%STORED GENERATED%' ORDER BY ordinal_position`, [source, table]);
        const names = columns.map(row => '`' + row.name.replaceAll('`', '``') + '`').join(', ');
        await db.query(`INSERT INTO \`${target}\`.\`${table}\` (${names}) SELECT ${names} FROM \`${source}\`.\`${table}\``);
    }
    copy = await mysql.createConnection({ ...settings, database: target });
    const migration = await import(join(stage, 'candidate/scripts/' + (nameURLs ? 'migrate-topic-name-urls-20261026.mjs' : 'migrate-topic-slugs-20261023.mjs')));
    const apply = nameURLs ? migration.applyTopicNameURLs : migration.applyShortTopicSlugs;
    const result = await apply(copy);
    const second = await apply(copy);
    assert.equal(second.applied, false);
    const [rows] = await copy.query('SELECT ID, name, owner_user_ID, is_active FROM categories ORDER BY ID');
    assert.deepEqual(rows, original.map(({ slug: _slug, ...row }) => row));
    if (nameURLs) for (const changed of result.changedSlugs) {
        const key = changed.before.replace(/[-_\s]+/g, ' ');
        const [aliases] = await copy.execute('SELECT category_ID FROM topic_legacy_routes WHERE route_key = ?', [key]);
        assert.equal(Number(aliases[0]?.category_ID), changed.ID, 'Retain each old URL for the same topic');
    }
    await assert.rejects(copy.execute(`INSERT INTO categories (name, slug) VALUES (?, ?)`, ['Duplicate address test', 'intelligence']),
        error => error.code === 'ER_DUP_ENTRY');
    await copy.execute('INSERT INTO categories (name, slug) VALUES (?, ?)', ['New topic test', 'new-topic-test']);
    const [[topic]] = await copy.query("SELECT COUNT(*) AS count FROM categories WHERE slug = 'new-topic-test'");
    assert.equal(Number(topic.count), 1);
    const [after] = await db.query('SELECT ID, name, slug, owner_user_ID, is_active FROM benchmarks.categories ORDER BY ID');
    assert.equal(digest(after), beforeDigest, 'Production metadata changed during isolated rehearsal');
    const report = { verified: true, metadataOnly: true, sourceTopics: original.length, ...result,
        idempotent: true, databaseUniquenessEnforced: true, existingTopicIdentityPreserved: true,
        productionMetadataUnchanged: true, temporaryDatabaseRemoved: true };
    await writeFile(join(stage, 'slug-rehearsal.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify(report));
} finally {
    if (copy) await copy.end();
    if (created) await db.query(`DROP DATABASE \`${target}\``);
    await db.end();
}
