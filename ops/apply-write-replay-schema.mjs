import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = '/home/ubuntu/benchpoll';
const stage = process.argv.find(value => value.startsWith('--stage='))?.slice(8);
assert.match(stage ?? '', /^\/tmp\/benchpoll-write-review-[0-9]+$/);
const migrationPath = 'scripts/migrate-write-requests.mjs';
const manifest = JSON.parse(await readFile(`${stage}/manifest.json`, 'utf8'));
const expected = manifest.files.find(file => file.path === migrationPath)?.after;
assert.ok(expected, 'Migration is required in the verified release manifest.');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
assert.equal(await hash(`${stage}/${migrationPath}`), expected);
const { config } = await import(pathToFileURL(`${root}/node_modules/dotenv/lib/main.js`).href);
config({ path: `${root}/.env`, quiet: true });
const { default: mysql } = await import(pathToFileURL(`${root}/node_modules/mysql2/index.js`).href);
const { ensureWriteRequestSchema, migrationID } = await import(pathToFileURL(`${stage}/${migrationPath}`).href);
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
assert.equal(database, 'benchmarks', 'This rollout is scoped to the inspected production database.');
const connection = mysql.createConnection({ socketPath: process.env.BENCHPOLL_DB_SOCKET || undefined,
    host: process.env.BENCHPOLL_DB_HOST || 'localhost', port: Number(process.env.BENCHPOLL_DB_PORT || 3306),
    user: process.env.BENCHPOLL_DB_USER || 'root', password: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD,
    database, charset: 'utf8mb4' }).promise();
let locked = false;
try {
    const [[users]] = await connection.execute(`SELECT COLUMN_TYPE AS type FROM information_schema.COLUMNS
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users' AND COLUMN_NAME = 'ID'`);
    assert.equal(users?.type, 'bigint unsigned', 'Actor foreign key must match the installed users schema.');
    const [[table]] = await connection.execute(`SELECT COUNT(*) AS total FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'write_requests'`);
    if (!process.argv.includes('--apply')) {
        console.log(JSON.stringify({ database, migration: migrationID, dryRun: true,
            actorType: users.type, tableExists: Number(table.total) === 1, businessRowsWritten: false }));
    } else {
        const backup = process.argv.find(value => value.startsWith('--backup='))?.slice(9);
        assert.match(backup ?? '', /^\/var\/backups\/benchpoll\/benchmarks-[0-9TZN]+\.sql\.gz$/);
        execFileSync('sudo', ['gzip', '-t', backup]);
        const checksum = execFileSync('sudo', ['cat', `${backup}.sha256`], { encoding: 'utf8' }).trim();
        const actualChecksum = execFileSync('sudo', ['sha256sum', backup], { encoding: 'utf8' }).trim();
        assert.match(checksum, /^[0-9a-f]{64}  benchmarks-[0-9TZN]+\.sql\.gz$/);
        assert.equal(checksum.split('  ')[1], backup.split('/').at(-1));
        assert.equal(actualChecksum.split(/\s+/)[0], checksum.split('  ')[0]);
        const [[lock]] = await connection.query('SELECT GET_LOCK(?, 20) AS acquired', ['benchpoll_write_requests_migration']);
        assert.equal(Number(lock.acquired), 1);
        locked = true;
        await ensureWriteRequestSchema(connection);
        await connection.execute('INSERT IGNORE INTO schema_migrations (migration_id) VALUES (?)', [migrationID]);
        console.log(JSON.stringify({ database, migration: migrationID, verified: true, backup,
            schemaChanged: Number(table.total) === 0, creates: ['write_requests'], destructiveChanges: false,
            businessRowsRead: false, businessRowsWritten: false }));
    }
} finally {
    if (locked) await connection.query('SELECT RELEASE_LOCK(?)', ['benchpoll_write_requests_migration']);
    await connection.end();
}
