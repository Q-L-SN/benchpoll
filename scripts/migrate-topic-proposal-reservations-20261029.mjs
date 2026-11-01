import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const PROPOSAL_RESERVATIONS_MIGRATION = 'topic_proposal_reservations_20261029';
const expectedIndexes = new Map([
    ['uq_topic_proposal_reservation_slug', 'reservation_slug'],
    ['uq_topic_proposal_reservation_name', 'reservation_name']
]);

async function inspect(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable
        FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals'`);
    const [indexes] = await connection.execute(`SELECT INDEX_NAME AS name, NON_UNIQUE AS nonUnique,
        GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX SEPARATOR ',') AS columnsList
        FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposals'
        GROUP BY INDEX_NAME, NON_UNIQUE`);
    return { columns: new Map(columns.map(row => [row.name, row])), indexes: new Map(indexes.map(row => [row.name, row])) };
}

export async function verifyProposalReservations(connection) {
    const state = await inspect(connection);
    for (const [name, type] of [['reservation_slug', 'varchar(80)'], ['reservation_name', 'varchar(128)']]) {
        const column = state.columns.get(name);
        if (!column || String(column.type).toLowerCase() !== type || column.nullable !== 'YES') {
            throw new Error(`Invalid proposal reservation column: ${name}`);
        }
    }
    for (const [name, column] of expectedIndexes) {
        const index = state.indexes.get(name);
        if (!index || Number(index.nonUnique) !== 0 || index.columnsList !== column) {
            throw new Error(`Invalid proposal reservation index: ${name}`);
        }
    }
    if (state.indexes.has('uq_topic_proposal_slug')) throw new Error('Legacy proposal slug uniqueness still blocks expired names');
    const [[invalid]] = await connection.execute(`SELECT COUNT(*) AS count FROM topic_proposals
        WHERE (reservation_slug IS NULL) <> (reservation_name IS NULL)
           OR (reservation_slug IS NOT NULL AND (reservation_slug <> slug OR reservation_name <> name))
           OR (reservation_slug IS NULL AND withdrawn_at IS NULL AND status <> 'rejected'
               AND NOT (status = 'open' AND created_at <= CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY))`);
    if (Number(invalid.count) !== 0) throw new Error('Invalid proposal reservation data');
    return { verified: true };
}

export async function migrateProposalReservations(connection) {
    let state = await inspect(connection);
    if (!state.columns.has('ID') || !state.columns.has('withdrawn_at')) throw new Error('Current proposal schema is required');
    if (!state.indexes.has('uq_topic_proposal_slug')) return verifyProposalReservations(connection);
    if ([...expectedIndexes.keys()].some(name => state.indexes.has(name))) throw new Error('Partial reservation indexes require inspection');
    for (const [name, type] of [['reservation_slug', 'VARCHAR(80)'], ['reservation_name', 'VARCHAR(128)']]) {
        if (!state.columns.has(name)) await connection.query(`ALTER TABLE topic_proposals ADD COLUMN ${name} ${type} NULL`);
    }
    state = await inspect(connection);
    for (const [name, type] of [['reservation_slug', 'varchar(80)'], ['reservation_name', 'varchar(128)']]) {
        const column = state.columns.get(name);
        if (!column || String(column.type).toLowerCase() !== type || column.nullable !== 'YES') {
            throw new Error(`Invalid proposal reservation column: ${name}`);
        }
    }
    await connection.execute(`UPDATE topic_proposals SET
        reservation_slug = CASE WHEN withdrawn_at IS NOT NULL OR status = 'rejected' OR (status = 'open'
            AND created_at <= CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY) THEN NULL ELSE slug END,
        reservation_name = CASE WHEN withdrawn_at IS NOT NULL OR status = 'rejected' OR (status = 'open'
            AND created_at <= CURRENT_TIMESTAMP(3) - INTERVAL 14 DAY) THEN NULL ELSE name END,
        updated_at = updated_at`);
    for (const column of ['reservation_slug', 'reservation_name']) {
        const [duplicates] = await connection.execute(`SELECT ${column}, COUNT(*) AS count FROM topic_proposals
            WHERE ${column} IS NOT NULL GROUP BY ${column} HAVING COUNT(*) > 1 LIMIT 1`);
        if (duplicates.length) throw new Error(`Duplicate active proposal ${column}; resolve before migration`);
    }
    await connection.query(`ALTER TABLE topic_proposals
        ADD UNIQUE KEY uq_topic_proposal_reservation_slug (reservation_slug),
        ADD UNIQUE KEY uq_topic_proposal_reservation_name (reservation_name),
        DROP INDEX uq_topic_proposal_slug`);
    return verifyProposalReservations(connection);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const apply = process.argv.includes('--apply'), check = process.argv.includes('--check'), rehearse = process.argv.includes('--rehearse');
    const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
    if (!apply && !check && !rehearse) {
        console.log(JSON.stringify({ migration: PROPOSAL_RESERVATIONS_MIGRATION, dryRun: true,
            preserves: ['proposal names', 'slugs', 'votes', 'timestamps'], backupRequired: true }));
    } else {
        if (check && (apply || rehearse)) throw new Error('Use --check separately');
        if (rehearse && !/^benchpoll_proposal_reservations_rehearsal_[a-z0-9_]+$/.test(database)) {
            throw new Error('Rehearsal requires an isolated proposal reservations database');
        }
        if (apply && !rehearse) await verifySlugBackup(process.argv.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
            user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
            database, supportBigNumbers: true, bigNumberStrings: true });
        try {
            const [[lock]] = await connection.query('SELECT GET_LOCK(?, 30) AS acquired', [PROPOSAL_RESERVATIONS_MIGRATION]);
            if (Number(lock.acquired) !== 1) throw new Error('Proposal reservations migration is already running');
            try {
                const result = check ? await verifyProposalReservations(connection) : await migrateProposalReservations(connection);
                console.log(JSON.stringify({ migration: PROPOSAL_RESERVATIONS_MIGRATION, database, rehearsal: rehearse, ...result }));
            } finally { await connection.query('SELECT RELEASE_LOCK(?)', [PROPOSAL_RESERVATIONS_MIGRATION]); }
        } finally { await connection.end(); }
    }
}
