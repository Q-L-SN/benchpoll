import 'dotenv/config';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import mysql from 'mysql2/promise';
import { verifySlugBackup } from './migrate-topic-slugs-20261023.mjs';

export const TOPIC_SNAPSHOT_MIGRATION = 'topic_snapshots_20261102';
export async function verifyTopicSnapshotSchema(connection) {
    const [columns] = await connection.execute(`SELECT COLUMN_NAME AS name, DATA_TYPE AS type, COLUMN_TYPE AS definition,
        IS_NULLABLE AS nullable, CHARACTER_MAXIMUM_LENGTH AS size, COLLATION_NAME AS collation,
        COLUMN_DEFAULT AS defaultValue, EXTRA AS extra FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposal_snapshots'`);
    for (const [name, type] of [['proposal_ID', 'int'], ['revision', 'int'], ['source_topic_ID', 'int'], ['content', 'json'], ['content_hash', 'char']]) {
        if (!columns.some(column => column.name === name && column.type === type && column.nullable === 'NO'
            && (type !== 'int' || column.definition === 'int unsigned')
            && (name !== 'content_hash' || Number(column.size) === 64 && column.collation === 'ascii_bin'))) throw new Error('Proposal snapshot schema is missing or incompatible');
    }
    const createdAt = columns.find(column => column.name === 'created_at');
    if (!createdAt || createdAt.type !== 'datetime' || createdAt.definition !== 'datetime(3)' || createdAt.nullable !== 'NO'
        || !/^CURRENT_TIMESTAMP\(3\)$/i.test(createdAt.defaultValue ?? '')
        || !['', 'default_generated'].includes(String(createdAt.extra).toLowerCase())) {
        throw new Error('Proposal snapshot creation timestamp is missing or incompatible');
    }
    const [keys] = await connection.execute(`SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'topic_proposal_snapshots' AND CONSTRAINT_NAME = 'PRIMARY' ORDER BY ORDINAL_POSITION`);
    if (keys.map(key => key.name).join(',') !== 'proposal_ID,revision') throw new Error('Proposal snapshot identity is incompatible');
    const [foreign] = await connection.execute(`SELECT k.COLUMN_NAME AS name, k.REFERENCED_TABLE_NAME AS target,
        k.REFERENCED_COLUMN_NAME AS targetColumn, r.DELETE_RULE AS deleteRule FROM information_schema.KEY_COLUMN_USAGE k
        JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
        WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'topic_proposal_snapshots'`);
    if (foreign.length !== 1 || foreign[0].name !== 'proposal_ID' || foreign[0].target !== 'topic_proposals'
        || foreign[0].targetColumn !== 'ID' || foreign[0].deleteRule !== 'CASCADE') throw new Error('Proposal snapshot ownership constraint is incompatible');
    return { migration: TOPIC_SNAPSHOT_MIGRATION, verified: true };
}
export async function ensureTopicSnapshotSchema(connection) {
    await connection.query(`CREATE TABLE IF NOT EXISTS topic_proposal_snapshots (
        proposal_ID INT UNSIGNED NOT NULL,
        revision INT UNSIGNED NOT NULL,
        source_topic_ID INT UNSIGNED NOT NULL,
        content JSON NOT NULL,
        content_hash CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
        PRIMARY KEY (proposal_ID, revision),
        CONSTRAINT fk_topic_snapshot_proposal FOREIGN KEY (proposal_ID) REFERENCES topic_proposals(ID) ON DELETE CASCADE,
        CONSTRAINT ck_topic_snapshot_revision CHECK (revision > 0)
    ) ENGINE=InnoDB`);
    return verifyTopicSnapshotSchema(connection);
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const args = process.argv.slice(2), apply = args.includes('--apply'), check = args.includes('--check');
    if (args.some(arg => !['--apply', '--check'].includes(arg) && !arg.startsWith('--backup-manifest=')) || apply && check) throw new Error('Choose --check or --apply --backup-manifest=...');
    if (!apply && !check) console.log(JSON.stringify({ migration: TOPIC_SNAPSHOT_MIGRATION, dryRun: true, creates: ['topic_proposal_snapshots'], dataRewritten: false }));
    else {
        const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
        if (apply) await verifySlugBackup(args.find(arg => arg.startsWith('--backup-manifest='))?.slice(18), database);
        const connection = await mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
            host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
            user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.DB_PASSWORD, database });
        let locked = false;
        try {
            if (apply) {
                const [[lock]] = await connection.execute('SELECT GET_LOCK(?, 0) AS acquired', [TOPIC_SNAPSHOT_MIGRATION]);
                if (Number(lock.acquired) !== 1) throw new Error('Another proposal snapshot migration is running');
                locked = true;
            }
            console.log(JSON.stringify(await (apply ? ensureTopicSnapshotSchema(connection) : verifyTopicSnapshotSchema(connection))));
        } finally {
            try { if (locked) await connection.execute('SELECT RELEASE_LOCK(?)', [TOPIC_SNAPSHOT_MIGRATION]); }
            finally { await connection.end(); }
        }
    }
}
