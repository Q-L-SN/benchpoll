import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_PROPOSALS_MIGRATION = 'topic_proposals_20261027';
const tableNames = ['topic_proposals', 'topic_proposal_votes'];
const cleanType = value => String(value).toLowerCase().replace(/\(\d+\)/g, '');

async function referenceTypes(connection) {
    const types = {};
    for (const table of ['users', 'categories', 'moderation_logs']) {
        const [rows] = await connection.execute(`SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
            WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? AND COLUMN_NAME = 'ID'`, [table]);
        const type = cleanType(rows[0]?.type);
        if (!/^(int|bigint) unsigned$/.test(type)) throw new Error(`Unsupported ${table}.ID type for proposal foreign keys`);
        types[table] = type.toUpperCase();
    }
    return types;
}

export function topicProposalDDL(types = { users: 'BIGINT UNSIGNED', categories: 'INT UNSIGNED', moderation_logs: 'INT UNSIGNED' }) {
    for (const table of ['users', 'categories', 'moderation_logs']) {
        if (!/^(INT|BIGINT) UNSIGNED$/.test(types[table])) throw new Error('Invalid proposal reference type');
    }
    return [
        `CREATE TABLE IF NOT EXISTS topic_proposals (
            ID INT UNSIGNED NOT NULL AUTO_INCREMENT,
            user_ID ${types.users} NOT NULL,
            name VARCHAR(128) NOT NULL,
            slug VARCHAR(80) NOT NULL,
            description VARCHAR(180) NOT NULL,
            status ENUM('open','pending','approved','rejected') NOT NULL DEFAULT 'open',
            moderation_log_ID ${types.moderation_logs} NULL,
            topic_ID ${types.categories} NULL,
            promoted_at DATETIME(3) NULL,
            decided_at DATETIME(3) NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
            PRIMARY KEY (ID),
            UNIQUE KEY uq_topic_proposal_slug (slug),
            UNIQUE KEY uq_topic_proposal_moderation (moderation_log_ID),
            UNIQUE KEY uq_topic_proposal_topic (topic_ID),
            KEY idx_topic_proposal_user (user_ID, created_at),
            CONSTRAINT fk_topic_proposal_user FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE RESTRICT,
            CONSTRAINT fk_topic_proposal_moderation FOREIGN KEY (moderation_log_ID) REFERENCES moderation_logs (ID) ON DELETE RESTRICT,
            CONSTRAINT fk_topic_proposal_topic FOREIGN KEY (topic_ID) REFERENCES categories (ID) ON DELETE RESTRICT,
            CONSTRAINT ck_topic_proposal_state CHECK (
                (status = 'open' AND moderation_log_ID IS NULL AND topic_ID IS NULL AND promoted_at IS NULL AND decided_at IS NULL)
                OR (status = 'pending' AND moderation_log_ID IS NOT NULL AND topic_ID IS NULL AND promoted_at IS NOT NULL AND decided_at IS NULL)
                OR (status = 'approved' AND moderation_log_ID IS NOT NULL AND topic_ID IS NOT NULL AND promoted_at IS NOT NULL AND decided_at IS NOT NULL)
                OR (status = 'rejected' AND moderation_log_ID IS NOT NULL AND topic_ID IS NULL AND promoted_at IS NOT NULL AND decided_at IS NOT NULL))
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`,
        `CREATE TABLE IF NOT EXISTS topic_proposal_votes (
            proposal_ID INT UNSIGNED NOT NULL,
            user_ID ${types.users} NOT NULL,
            created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
            PRIMARY KEY (proposal_ID, user_ID),
            KEY idx_topic_proposal_vote_user (user_ID, proposal_ID),
            CONSTRAINT fk_topic_proposal_vote_proposal FOREIGN KEY (proposal_ID) REFERENCES topic_proposals (ID) ON DELETE CASCADE,
            CONSTRAINT fk_topic_proposal_vote_user FOREIGN KEY (user_ID) REFERENCES users (ID) ON DELETE RESTRICT
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_0900_ai_ci`
    ];
}

export async function verifyTopicProposalSchema(connection) {
    const types = await referenceTypes(connection);
    const [tables] = await connection.execute(`SELECT TABLE_NAME AS name, ENGINE AS engine FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('topic_proposals','topic_proposal_votes')`);
    if (tables.length !== 2 || tables.some(table => table.engine !== 'InnoDB')) throw new Error('Topic proposal tables are missing or not InnoDB');
    const [columns] = await connection.execute(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name, COLUMN_TYPE AS type,
        IS_NULLABLE AS nullable FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('topic_proposals','topic_proposal_votes')`);
    const expected = {
        topic_proposals: { ID: 'int unsigned', user_ID: types.users.toLowerCase(), name: 'varchar(128)', slug: 'varchar(80)',
            description: 'varchar(180)', status: "enum('open','pending','approved','rejected')",
            moderation_log_ID: types.moderation_logs.toLowerCase(), topic_ID: types.categories.toLowerCase(),
            promoted_at: 'datetime(3)', decided_at: 'datetime(3)', created_at: 'datetime(3)', updated_at: 'datetime(3)' },
        topic_proposal_votes: { proposal_ID: 'int unsigned', user_ID: types.users.toLowerCase(), created_at: 'datetime(3)' }
    };
    for (const [table, fields] of Object.entries(expected)) for (const [name, type] of Object.entries(fields)) {
        const column = columns.find(row => row.tableName === table && row.name === name);
        const actual = column && /^(int|bigint)/i.test(column.type) ? cleanType(column.type) : column?.type.toLowerCase();
        const nullable = ['moderation_log_ID', 'topic_ID', 'promoted_at', 'decided_at'].includes(name) ? 'YES' : 'NO';
        if (actual !== type || column.nullable !== nullable) throw new Error(`Invalid proposal schema column: ${table}.${name}`);
    }
    const [indexes] = await connection.execute(`SELECT TABLE_NAME AS tableName, INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columnsList FROM information_schema.STATISTICS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('topic_proposals','topic_proposal_votes')
        GROUP BY TABLE_NAME, INDEX_NAME, NON_UNIQUE`);
    for (const [table, name, fields] of [['topic_proposals', 'PRIMARY', 'ID'],
        ['topic_proposals', 'uq_topic_proposal_moderation', 'moderation_log_ID'], ['topic_proposals', 'uq_topic_proposal_topic', 'topic_ID'],
        ['topic_proposal_votes', 'PRIMARY', 'proposal_ID,user_ID']]) {
        if (!indexes.some(row => row.tableName === table && row.name === name && Number(row.nonUnique) === 0 && row.columnsList === fields)) {
            throw new Error(`Missing proposal unique index: ${table}.${name}`);
        }
    }
    const hasUnique = (name, column) => indexes.some(row => row.tableName === 'topic_proposals' && row.name === name
        && Number(row.nonUnique) === 0 && row.columnsList === column);
    const legacy = hasUnique('uq_topic_proposal_slug', 'slug');
    const reservations = hasUnique('uq_topic_proposal_reservation_slug', 'reservation_slug')
        && hasUnique('uq_topic_proposal_reservation_name', 'reservation_name');
    if (!legacy && !reservations) throw new Error('Missing proposal name uniqueness');
    const [keys] = await connection.execute(`SELECT TABLE_NAME AS tableName, COLUMN_NAME AS name,
        REFERENCED_TABLE_NAME AS target, REFERENCED_COLUMN_NAME AS targetColumn FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME IN ('topic_proposals','topic_proposal_votes') AND REFERENCED_TABLE_NAME IS NOT NULL`);
    for (const [table, name, target] of [['topic_proposals', 'user_ID', 'users'], ['topic_proposals', 'moderation_log_ID', 'moderation_logs'],
        ['topic_proposals', 'topic_ID', 'categories'], ['topic_proposal_votes', 'proposal_ID', 'topic_proposals'], ['topic_proposal_votes', 'user_ID', 'users']]) {
        if (!keys.some(row => row.tableName === table && row.name === name && row.target === target && row.targetColumn === 'ID')) {
            throw new Error(`Missing proposal foreign key: ${table}.${name}`);
        }
    }
    const [checks] = await connection.execute(`SELECT CONSTRAINT_NAME AS name FROM information_schema.TABLE_CONSTRAINTS
        WHERE CONSTRAINT_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals' AND CONSTRAINT_TYPE = 'CHECK'`);
    if (!checks.some(row => row.name === 'ck_topic_proposal_state')) throw new Error('Missing proposal lifecycle constraint');
    return { verified: true, tables: tableNames };
}

// Only release preparation, migration CLI and isolated rehearsals call this hook.
export async function ensureTopicProposalSchema(connection) {
    const types = await referenceTypes(connection);
    for (const statement of topicProposalDDL(types)) await connection.query(statement);
    return { migration: TOPIC_PROPOSALS_MIGRATION, ...await verifyTopicProposalSchema(connection) };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const apply = process.argv.includes('--apply'), check = process.argv.includes('--check'), rehearse = process.argv.includes('--rehearse');
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    if (!apply && !check && !rehearse) {
        console.log(JSON.stringify({ migration: TOPIC_PROPOSALS_MIGRATION, dryRun: true, creates: tableNames,
            alters: [], backupRequired: true, rehearsalDatabasePattern: 'benchpoll_proposals_rehearsal_<suffix>' }, null, 2));
    } else {
        if (check && (apply || rehearse)) throw new Error('Use --check separately from schema application');
        if (rehearse && !/^benchpoll_proposals_rehearsal_[a-z0-9_]+$/.test(database)) throw new Error('Rehearsal requires an isolated proposal database');
        if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
            user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
            database, supportBigNumbers: true, bigNumberStrings: true });
        try {
            const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [TOPIC_PROPOSALS_MIGRATION]);
            if (Number(lock.acquired) !== 1) throw new Error('Proposal migration is already running');
            try {
                const result = check ? await verifyTopicProposalSchema(connection) : await ensureTopicProposalSchema(connection);
                console.log(JSON.stringify({ migration: TOPIC_PROPOSALS_MIGRATION, database, rehearsal: rehearse, ...result }, null, 2));
            } finally { await connection.query('SELECT RELEASE_LOCK(?)', [TOPIC_PROPOSALS_MIGRATION]); }
        } finally { await connection.end(); }
    }
}
