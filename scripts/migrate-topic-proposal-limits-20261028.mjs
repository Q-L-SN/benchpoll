import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_PROPOSAL_LIMITS_MIGRATION = 'topic_proposal_limits_20261028';
export async function verifyTopicProposalLimitsSchema(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type,
        IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals'
        AND COLUMN_NAME IN ('revision', 'withdrawn_at')`);
    const revision = columns.find(column => column.name === 'revision');
    const withdrawn = columns.find(column => column.name === 'withdrawn_at');
    if (!revision || !/^int(?:\(\d+\))? unsigned$/i.test(revision.type) || revision.nullable !== 'NO'
        || String(revision.defaultValue) !== '1' || !withdrawn || withdrawn.type.toLowerCase() !== 'datetime(3)'
        || withdrawn.nullable !== 'YES') throw new Error('Topic proposal limits schema is missing or incompatible');
    const [[invalid]] = await connection.execute(`SELECT COUNT(*) AS count FROM topic_proposals
        WHERE revision < 1 OR (withdrawn_at IS NOT NULL AND status <> 'open')`);
    if (Number(invalid.count)) throw new Error('Invalid proposal revision or withdrawal state');
    return { verified: true, columns: ['revision', 'withdrawn_at'] };
}

export async function ensureTopicProposalLimitsSchema(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals'`);
    if (!columns.length) throw new Error('Base topic proposal schema must be prepared first');
    const names = new Set(columns.map(column => column.name)), addedColumns = [];
    for (const [name, definition] of [['revision', 'INT UNSIGNED NOT NULL DEFAULT 1'], ['withdrawn_at', 'DATETIME(3) NULL']]) {
        if (names.has(name)) continue;
        await connection.query(`ALTER TABLE topic_proposals ADD COLUMN ${name} ${definition}`);
        addedColumns.push(name);
    }
    return { migration: TOPIC_PROPOSAL_LIMITS_MIGRATION, addedColumns, ...await verifyTopicProposalLimitsSchema(connection) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2), apply = args.includes('--apply'), check = args.includes('--check');
    if (args.some(arg => !['--apply', '--check'].includes(arg) && !arg.startsWith('--backup-manifest=')) || apply && check) {
        throw new Error('Choose --check or --apply --backup-manifest=...');
    }
    if (!apply && !check) console.log(JSON.stringify({ migration: TOPIC_PROPOSAL_LIMITS_MIGRATION,
        dryRun: true, alters: ['topic_proposals.revision', 'topic_proposals.withdrawn_at'], dataRewritten: false }));
    else {
        const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
        if (apply) await verifySlugBackup(args.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', user: process.env.BENCHPOLL_DB_USER || 'root',
            password: process.env.DB_PASSWORD, database, supportBigNumbers: true, bigNumberStrings: true });
        try {
            const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_PROPOSAL_LIMITS_MIGRATION]);
            if (Number(lock.acquired) !== 1) throw new Error('Proposal limits migration is already running');
            try { console.log(JSON.stringify(await (apply ? ensureTopicProposalLimitsSchema(connection) : verifyTopicProposalLimitsSchema(connection)))); }
            finally { await connection.query('SELECT RELEASE_LOCK(?)', [TOPIC_PROPOSAL_LIMITS_MIGRATION]); }
        } finally { await connection.end(); }
    }
}
