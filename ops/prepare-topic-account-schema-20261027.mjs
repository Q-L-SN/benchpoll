import mysql from 'mysql2/promise';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = '/home/ubuntu/benchpoll';
const stage = resolve(process.argv[2] || '.');
const release = stage.split('/').at(-1);
if (!/^topics-account-20261027-\d+$/.test(release)
    || stage !== `${root}/scripts/topics-account-20261027/${release}`) throw new Error('Unsafe account schema stage');
const mode = process.argv[3];
if (!['rehearse', 'apply', 'inspect'].includes(mode)) throw new Error('Choose rehearse, apply or inspect');
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(database)) throw new Error('Invalid database name');
const settings = { socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD,
    database, supportBigNumbers: true, bigNumberStrings: true };
const connection = await mysql.createConnection(settings);
const profile = await import(join(stage, 'candidate/user-profile-service.js'));
const proposals = await import(join(stage, 'candidate/topic-proposal-service.js'));
const tables = ['users', 'categories', 'ranking_contexts', 'user_public_profiles', 'moderation_logs', 'topic_legacy_routes'];
const hash = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fileHash = async path => {
    const digest = createHash('sha256');
    for await (const bytes of createReadStream(path)) digest.update(bytes);
    return digest.digest('hex');
};
async function preserved(db) {
    const result = {};
    for (const [table, order] of [['users', 'ID'], ['categories', 'ID'], ['ranking_contexts', 'ID'],
        ['user_public_profiles', 'user_ID'], ['moderation_logs', 'ID'], ['topic_legacy_routes', 'route_hash']]) {
        const fields = table === 'user_public_profiles' ? 'user_ID, display_name, avatar_data_url, updated_at' : '*';
        const [rows] = await db.query(`SELECT ${fields} FROM \`${table}\` ORDER BY ${order}`);
        result[table] = { count: rows.length, sha256: hash(rows) };
    }
    return result;
}
async function schema(db) {
    const profileResult = await profile.ensurePublicGitHubProfileSchema(db);
    const proposalResult = await proposals.ensureTopicProposalSchema(db);
    return { profile: profileResult, proposals: proposalResult };
}
async function inspect(db) {
    const [columns] = await db.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='user_public_profiles'`);
    const [existing] = await db.execute(`SELECT TABLE_NAME AS name FROM information_schema.TABLES
        WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME IN ('topic_proposals','topic_proposal_votes')`);
    return { profileColumns: columns.map(row => row.name), proposalTables: existing.map(row => row.name) };
}
try {
    if (mode === 'inspect') console.log(JSON.stringify(await inspect(connection)));
    else if (mode === 'rehearse') {
        const clone = `benchpoll_accounts_rehearsal_${release.split('-').at(-1)}`;
        if (!/^benchpoll_accounts_rehearsal_\d+$/.test(clone) || clone === database) throw new Error('Unsafe rehearsal name');
        let created = false, isolated;
        const before = await preserved(connection);
        try {
            await connection.query(`CREATE DATABASE \`${clone}\` CHARACTER SET utf8mb4`); created = true;
            for (const table of tables) {
                await connection.query(`CREATE TABLE \`${clone}\`.\`${table}\` LIKE \`${database}\`.\`${table}\``);
                const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
                    WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COALESCE(GENERATION_EXPRESSION, '') = ''
                    ORDER BY ORDINAL_POSITION`, [database, table]);
                if (!columns.length || columns.some(column => !/^[a-zA-Z0-9_]+$/.test(column.name))) throw new Error('Unsafe rehearsal columns');
                const fields = columns.map(column => `\`${column.name}\``).join(', ');
                await connection.query(`INSERT INTO \`${clone}\`.\`${table}\` (${fields}) SELECT ${fields} FROM \`${database}\`.\`${table}\``);
            }
            isolated = await mysql.createConnection({ ...settings, database: clone });
            const original = await preserved(isolated);
            const first = await schema(isolated), second = await schema(isolated);
            if (JSON.stringify(await preserved(isolated)) !== JSON.stringify(original)) throw new Error('Rehearsal changed existing records');
            const [[flags]] = await isolated.query('SELECT COUNT(*) AS count FROM user_public_profiles WHERE show_github_profile <> 0 OR github_username IS NOT NULL');
            if (Number(flags.count) !== 0) throw new Error('Existing profiles were opted in');
            const state = await inspect(isolated);
            if (state.proposalTables.length !== 2) throw new Error('Proposal tables are missing');
            const report = { rehearsed: true, release, first, second, existingRecordsPreserved: true,
                defaultOff: true, sourceUnchanged: JSON.stringify(await preserved(connection)) === JSON.stringify(before) };
            if (!report.sourceUnchanged) throw new Error('Source changed during rehearsal; inspect before proceeding');
            await writeFile(join(stage, 'schema-rehearsal.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
            console.log(JSON.stringify(report));
        } finally {
            await isolated?.end();
            if (created) await connection.query(`DROP DATABASE \`${clone}\``);
        }
    } else {
        const rehearsal = JSON.parse(await readFile(join(stage, 'schema-rehearsal.json'), 'utf8'));
        if (rehearsal.release !== release || rehearsal.rehearsed !== true || rehearsal.sourceUnchanged !== true) throw new Error('Missing isolated schema rehearsal');
        const backup = JSON.parse(await readFile(join(stage, 'database-backup.json'), 'utf8'));
        const age = Date.now() - Date.parse(backup.createdAt);
        if (backup.database !== database || !Number.isFinite(age) || age < 0 || age > 6 * 60 * 60 * 1000
            || typeof backup.path !== 'string' || !backup.path.startsWith(stage + '/database-')
            || !/^[a-f0-9]{64}$/.test(backup.sha256) || await fileHash(backup.path) !== backup.sha256) throw new Error('Missing fresh verified database backup');
        const before = await preserved(connection);
        for (const table of ['users', 'user_public_profiles']) {
            if (before[table].sha256 !== backup.configurationDigests?.[table]) throw new Error('Protected records changed after backup: ' + table);
        }
        const result = await schema(connection);
        if (JSON.stringify(await preserved(connection)) !== JSON.stringify(before)) throw new Error('Existing records changed during schema preparation');
        const report = { applied: true, release, protectedDataUnchanged: true, result, schema: await inspect(connection),
            backupManifest: join(stage, 'database-backup.json'), completedAt: new Date().toISOString() };
        await writeFile(join(stage, 'schema-result.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
        console.log(JSON.stringify(report));
    }
} finally { await connection.end(); }
