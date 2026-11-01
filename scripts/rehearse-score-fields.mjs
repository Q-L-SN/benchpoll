import 'dotenv/config';
import assert from 'node:assert/strict';
import { mkdir, chmod } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import mysql from 'mysql2/promise';

const source = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(source) || source.endsWith('_score_fields_rehearsal')) throw Error('Invalid source database');
const target = `${source}_score_fields_rehearsal`;
const socket = '/var/run/mysqld/mysqld.sock';
const db = await mysql.createConnection({ socketPath: socket, user: 'root' });
const root = fileURLToPath(new URL('../', import.meta.url));
function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: root, env: process.env, stdio: ['pipe', 'inherit', 'inherit'], ...options });
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(Error(`${command} exited ${code}`)));
        if (options.input) createReadStream(options.input).pipe(child.stdin); else child.stdin.end();
    });
}
const digest = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');
const commonScores = async name => {
    const [rows] = await db.query(`SELECT ID, model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, source_title, notes, status, benchmark_condition_snapshot, submitted_by, moderation_log_ID FROM ${mysql.escapeId(name)}.benchmark_results ORDER BY ID`);
    return digest(rows);
};
try {
    const [exists] = await db.execute('SELECT SCHEMA_NAME FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = ?', [target]);
    if (exists.length) throw Error('Rehearsal database already exists; inspect it before retrying');
    const backupDir = `/home/ubuntu/backups/score-fields-${Date.now()}`;
    await mkdir(backupDir, { recursive: true, mode: 0o700 });
    const backup = `${backupDir}/database.sql`;
    await run('mysqldump', ['--socket', socket, '-u', 'root', '--single-transaction', '--routines', '--triggers', '--events', '--set-gtid-purged=OFF', `--result-file=${backup}`, source]);
    await chmod(backup, 0o600);
    await db.query(`CREATE DATABASE ${mysql.escapeId(target)} CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`);
    await run('mysql', ['--socket', socket, '-u', 'root', target], { input: backup });
    const before = await commonScores(target);
    const env = { ...process.env, BENCHPOLL_DB_NAME: target, BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_PASSWORD: '', BENCHPOLL_DB_SOCKET: socket };
    await run(process.execPath, ['scripts/migrate-score-fields.mjs', '--apply'], { env });
    assert.equal(await commonScores(target), before);
    await run(process.execPath, ['scripts/verify-score-field-storage.mjs'], { env });
    await db.query(`DELETE FROM ${mysql.escapeId(target)}.schema_migrations WHERE migration_id = '029_score_fields'`);
    await run(process.execPath, ['scripts/migrate-score-fields.mjs', '--apply'], { env });
    await run(process.execPath, ['scripts/migrate-score-fields.mjs', '--apply'], { env });
    assert.equal(await commonScores(target), before);
    await run(process.execPath, ['scripts/check-ranking-integrity.mjs'], { env });
    console.log(JSON.stringify({ rehearsalPassed: true, scoreEvidenceUnchanged: true, restartVerified: true, backup, database: target }));
} finally { await db.end(); }
