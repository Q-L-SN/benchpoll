import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import mysql from 'mysql2/promise';

const stage = resolve(process.argv[2] || '.');
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/fallback-choice-20261031\/fallback-choice-20261031-\d+$/.test(stage)) throw new Error('Unsafe schema stage');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const bytes = await readFile(join(stage, 'manifest.json')), manifest = JSON.parse(bytes);
if (sha(bytes) !== process.argv[3] || manifest.release !== stage.split('/').at(-1)
    || manifest.candidate !== join(stage, 'candidate') || manifest.migration !== 'migrate-fallback-choice-source-20261031.mjs') throw new Error('Unverified manifest');
const migration = 'scripts/' + manifest.migration, file = manifest.files.find(file => file.path === migration);
if (!file || sha(await readFile(join(manifest.candidate, migration))) !== file.after) throw new Error('Unverified migration');
const connection = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks',
    supportBigNumbers: true, bigNumberStrings: true, dateStrings: true });
try {
    const tables = ['personal_pie_score_rules', 'personal_pies', 'personal_pie_weights', 'personal_pie_topic_weights'];
    const columns = new Map();
    for (const table of tables) {
        const [rows] = await connection.query('SHOW COLUMNS FROM `' + table + '`');
        columns.set(table, rows.map(row => row.Field).filter(name => name !== 'selection_source'));
    }
    async function fingerprints() {
        const result = {};
        for (const [table, names] of columns) {
            if (names.some(name => !/^[a-zA-Z0-9_]+$/.test(name))) throw new Error('Unexpected column');
            const selected = names.map(name => '`' + name + '`').join(',');
            const [rows] = await connection.query(`SELECT ${selected} FROM \`${table}\` ORDER BY ${selected}`);
            result[table] = { count: rows.length, sha256: sha(JSON.stringify(rows)) };
        }
        return result;
    }
    const before = await fingerprints();
    const backup = execFileSync('mysqldump', ['--socket=/var/run/mysqld/mysqld.sock', '--single-transaction', '--no-tablespaces',
        'benchmarks', ...tables], { maxBuffer: 64 * 1024 * 1024 });
    const backupPath = join(stage, 'fallback-choice-before.sql');
    await writeFile(backupPath, backup, { flag: 'wx', mode: 0o600 });
    const { migrateFallbackChoiceSource } = await import(pathToFileURL(join(manifest.candidate, migration)));
    const result = await migrateFallbackChoiceSource(connection, { apply: true });
    const after = await fingerprints();
    if (JSON.stringify(before) !== JSON.stringify(after)) throw new Error('Protected personal data changed during schema preparation');
    const receipt = { release: manifest.release, manifestHash: sha(bytes), ...result, protectedDataUnchanged: true,
        before, after, backupPath, backupHash: sha(backup), appliedAt: new Date().toISOString() };
    await writeFile(join(stage, 'schema-result.json'), JSON.stringify(receipt, null, 2), { flag: 'wx', mode: 0o644 });
    console.log(JSON.stringify(receipt));
} finally { await connection.end(); }
