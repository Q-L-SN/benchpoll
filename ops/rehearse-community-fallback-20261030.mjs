import assert from 'node:assert/strict';
import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { migrateCommunityFallback, inspectCommunityFallback } from '../scripts/migrate-community-fallback-20261030.mjs';

const source = 'benchmarks';
const rehearsal = 'benchpoll_fallback_rehearsal_' + Date.now();
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root',
    database: source, supportBigNumbers: true, bigNumberStrings: true });
const copied = new Set(['schema_migrations', 'benchmark_conditions', 'benchmark_families', 'benchmark_family_members',
    'personal_pies', 'personal_pie_weights', 'personal_pie_score_rules']);
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const evidence = async database => {
    assert.ok(database === source || database === rehearsal);
    const [weights] = await db.query(`SELECT * FROM \`${database}\`.personal_pie_weights ORDER BY pie_ID, benchmark_condition_ID`);
    const [pies] = await db.query(`SELECT ID,user_ID,context_ID,created_at,updated_at FROM \`${database}\`.personal_pies ORDER BY ID`);
    return hash([pies, weights]);
};
let created = false;
try {
    const original = await evidence(source);
    await db.query('CREATE DATABASE `' + rehearsal + '`'); created = true;
    await db.query('USE `' + rehearsal + '`');
    await db.query('SET FOREIGN_KEY_CHECKS=0');
    const [tables] = await db.query("SELECT TABLE_NAME FROM information_schema.TABLES WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'", [source]);
    for (const { TABLE_NAME: table } of tables) {
        if (!/^[a-zA-Z0-9_]+$/.test(table)) throw new Error('Unsafe table name');
        // SHOW CREATE preserves real foreign keys; CREATE LIKE would omit them.
        const [[definition]] = await db.query(`SHOW CREATE TABLE \`${source}\`.\`${table}\``);
        await db.query(definition['Create Table']);
        if (!copied.has(table)) continue;
        const [columns] = await db.query(`SELECT COLUMN_NAME FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA=? AND TABLE_NAME=? AND GENERATION_EXPRESSION='' ORDER BY ORDINAL_POSITION`, [source, table]);
        const names = columns.map(column => '`' + column.COLUMN_NAME + '`').join(',');
        await db.query(`INSERT INTO \`${rehearsal}\`.\`${table}\` (${names}) SELECT ${names} FROM \`${source}\`.\`${table}\``);
    }
    await db.query('SET FOREIGN_KEY_CHECKS=1');
    const before = await evidence(rehearsal);
    const [[old]] = await db.query('SELECT COUNT(*) AS count FROM personal_pie_score_rules');
    const migrated = await migrateCommunityFallback(db);
    assert.equal(migrated.ready, true);
    assert.equal(await evidence(rehearsal), before);
    assert.equal((await inspectCommunityFallback(db)).concreteVersionsOnly, true);
    for (const table of ['personal_pie_score_rules', 'benchmark_families', 'benchmark_family_members']) {
        const [[row]] = await db.query(`SELECT COUNT(*) AS count FROM ${table}`);
        assert.equal(Number(row.count), 0, table + ' must be reset');
    }
    const [[entry]] = await db.query('SELECT pie_ID, benchmark_condition_ID FROM personal_pie_weights LIMIT 1');
    assert.ok(entry, 'Rehearsal requires an existing sector');
    await db.execute('INSERT INTO personal_pie_score_rules (pie_ID,primary_benchmark_condition_ID,family_ID) VALUES (?,?,NULL)',
        [entry.pie_ID, entry.benchmark_condition_ID]);
    assert.equal((await migrateCommunityFallback(db)).applied, false);
    const [[remaining]] = await db.query('SELECT COUNT(*) AS count FROM personal_pie_score_rules');
    assert.equal(Number(remaining.count), 1, 'Retry must preserve a new explicit no-fallback choice');
    assert.equal(await evidence(source), original, 'Source database must remain unchanged');
    console.log(JSON.stringify({ rehearsal, ready: true, originalChoices: Number(old.count),
        sourceUnchanged: true, weightsAndActivityUnchanged: true, concreteVersionsOnly: true,
        explicitNoneAccepted: true, retryPreservesNewChoices: true, migration: migrated }));
} finally {
    await db.query('USE `' + source + '`');
    if (created && /^benchpoll_fallback_rehearsal_\d+$/.test(rehearsal)) await db.query('DROP DATABASE `' + rehearsal + '`');
    await db.end();
}
