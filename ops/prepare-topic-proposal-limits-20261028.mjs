import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { rehearseProposalLimits } from './rehearse-topic-proposal-limits-20261028.mjs';

const root = '/home/ubuntu/benchpoll';
const stage = resolve(process.argv[2] || '.');
const release = stage.split('/').at(-1), mode = process.argv[3];
if (!/^topics-account-20261027-\d+$/.test(release)
    || stage !== `${root}/scripts/topics-account-20261027/${release}`) throw new Error('Unsafe proposal limits stage');
if (!['inspect', 'rehearse', 'apply'].includes(mode)) throw new Error('Choose inspect, rehearse or apply');
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Invalid database name');
const settings = { socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD,
    database, supportBigNumbers: true, bigNumberStrings: true };
const source = await mysql.createConnection(settings);
const proposals = await import(join(stage, 'candidate/topic-proposal-service.js'));
const proposalFields = 'ID, user_ID, name, slug, description, status, moderation_log_ID, topic_ID, promoted_at, decided_at, created_at, updated_at';
const tables = ['users', 'categories', 'ranking_contexts', 'user_public_profiles', 'moderation_logs',
    'topic_legacy_routes', 'topic_proposals', 'topic_proposal_votes', 'write_requests'];
async function preserved(db) {
    const result = {};
    for (const [table, order] of [['users', 'ID'], ['categories', 'ID'], ['ranking_contexts', 'ID'],
        ['user_public_profiles', 'user_ID'], ['moderation_logs', 'ID'], ['topic_legacy_routes', 'route_hash'],
        ['topic_proposals', 'ID'], ['topic_proposal_votes', 'proposal_ID, user_ID']]) {
        const [rows] = await db.query(`SELECT ${table === 'topic_proposals' ? proposalFields : '*'} FROM \`${table}\` ORDER BY ${order}`);
        result[table] = { count: rows.length, sha256: createHash('sha256').update(JSON.stringify(rows)).digest('hex') };
    }
    return result;
}
async function inspect(db) {
    const names = async table => {
        const [columns] = await db.execute('SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ?', [table]);
        return columns.map(column => column.name);
    };
    return { profileColumns: await names('user_public_profiles'), proposalColumns: await names('topic_proposals'),
        proposalTables: ['topic_proposals', 'topic_proposal_votes'] };
}
async function fileHash(path) {
    const hash = createHash('sha256'); for await (const bytes of createReadStream(path)) hash.update(bytes); return hash.digest('hex');
}
try {
    if (mode === 'inspect') console.log(JSON.stringify(await inspect(source)));
    else if (mode === 'rehearse') {
        const clone = `benchpoll_accounts_rehearsal_${release.split('-').at(-1)}`;
        if (!/^benchpoll_accounts_rehearsal_\d+$/.test(clone) || clone === database) throw new Error('Unsafe rehearsal name');
        const original = await preserved(source);
        let created = false, isolated;
        try {
            await source.query(`CREATE DATABASE \`${clone}\` CHARACTER SET utf8mb4`); created = true;
            isolated = await mysql.createConnection({ ...settings, database: clone });
            for (const table of tables) {
                if (['topic_proposals', 'topic_proposal_votes'].includes(table)) {
                    const [[ddl]] = await source.query(`SHOW CREATE TABLE \`${database}\`.\`${table}\``);
                    if (!ddl['Create Table'].startsWith(`CREATE TABLE \`${table}\` (`)) throw new Error('Unexpected rehearsal DDL');
                    await isolated.query(ddl['Create Table']);
                } else await source.query(`CREATE TABLE \`${clone}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
                if (table === 'write_requests') continue;
                const [columns] = await source.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COALESCE(GENERATION_EXPRESSION, '') = '' ORDER BY ORDINAL_POSITION`, [database, table]);
                if (!columns.length || columns.some(column => !/^[a-zA-Z0-9_]+$/.test(column.name))) throw new Error('Unsafe rehearsal columns');
                const fields = columns.map(column => `\`${column.name}\``).join(', ');
                await source.query(`INSERT INTO \`${clone}\`.\`${table}\` (${fields}) SELECT ${fields} FROM \`${database}\`.\`${table}\``);
            }
            const before = await preserved(isolated);
            const first = await proposals.ensureTopicProposalLimitsSchema(isolated), second = await proposals.ensureTopicProposalLimitsSchema(isolated);
            if (JSON.stringify(await preserved(isolated)) !== JSON.stringify(before)) throw new Error('Schema rehearsal changed existing records');
            const businessRules = await rehearseProposalLimits(isolated, settings, proposals.createTopicProposalService);
            if (JSON.stringify(await preserved(source)) !== JSON.stringify(original)) throw new Error('Production changed during rehearsal');
            const report = { rehearsed: true, release, first, second, businessRules, existingRecordsPreserved: true, sourceUnchanged: true };
            await writeFile(join(stage, 'schema-rehearsal.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
            console.log(JSON.stringify(report));
        } finally { await isolated?.end(); if (created) await source.query(`DROP DATABASE \`${clone}\``); }
    } else {
        const rehearsal = JSON.parse(await readFile(join(stage, 'schema-rehearsal.json'), 'utf8'));
        if (rehearsal.release !== release || rehearsal.rehearsed !== true || rehearsal.sourceUnchanged !== true
            || rehearsal.businessRules?.passed !== true) throw new Error('A successful isolated business/schema rehearsal is required');
        const backup = JSON.parse(await readFile(join(stage, 'database-backup.json'), 'utf8'));
        const age = Date.now() - Date.parse(backup.createdAt);
        if (backup.database !== database || !Number.isFinite(age) || age < 0 || age > 2 * 3600000
            || typeof backup.path !== 'string' || !backup.path.startsWith(stage + '/database-')
            || !/^[a-f0-9]{64}$/.test(backup.sha256) || await fileHash(backup.path) !== backup.sha256) throw new Error('A fresh verified database backup is required');
        const before = await preserved(source);
        for (const table of ['users', 'topic_proposals', 'topic_proposal_votes']) {
            if (before[table].sha256 !== backup.configurationDigests?.[table]) throw new Error('Protected data changed after backup: ' + table);
        }
        const result = await proposals.ensureTopicProposalLimitsSchema(source);
        if (JSON.stringify(await preserved(source)) !== JSON.stringify(before)) throw new Error('Production data changed during schema preparation');
        const report = { applied: true, release, protectedDataUnchanged: true, result, schema: await inspect(source), completedAt: new Date().toISOString() };
        await writeFile(join(stage, 'schema-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log(JSON.stringify(report));
    }
} finally { await source.end(); }
