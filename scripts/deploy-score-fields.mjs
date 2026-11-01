import 'dotenv/config';
import { readFile, mkdir, chmod, stat, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { request } from 'node:https';
import mysql from 'mysql2/promise';
import { validateWorkspacePayload } from '../public/js/workspace/contracts.js';

const production = '/home/ubuntu/benchpoll';
const staging = fileURLToPath(new URL('../', import.meta.url));
if (path.resolve(staging) === production) throw Error('Run deployment from the staged release, not production');
const manifest = JSON.parse(await readFile(path.join(staging, 'deployment-manifest.json'), 'utf8'));
const hash = data => createHash('sha256').update(data).digest('hex');
function blobHash(data) {
    const text = data.toString('utf8').replace(/\r\n/g, '\n');
    return createHash('sha1').update(`blob ${Buffer.byteLength(text)}\0`).update(text).digest('hex');
}
const existing = [];
for (const item of manifest) {
    if (!/^[\w./-]+$/.test(item.path) || item.path.split('/').includes('..') || item.path.startsWith('/')) throw Error('Unsafe deployment path');
    const source = await readFile(path.join(staging, item.path));
    if (hash(source) !== item.sha256) throw Error(`Staged hash mismatch: ${item.path}`);
    try {
        const target = await readFile(path.join(production, item.path));
        if (!item.priorComposition && blobHash(target) !== item.baseBlob && hash(target) !== item.sha256) throw Error(`Unreviewed remote changes: ${item.path}`);
        existing.push(item.path);
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
}
console.log(JSON.stringify({ preflight: 'passed', files: manifest.length }));
if (!process.argv.includes('--apply')) process.exit(0);
const database = process.env.BENCHPOLL_DB_NAME || 'benchmarks';
if (!/^[a-zA-Z0-9_]+$/.test(database) || database.endsWith('_score_fields_rehearsal')) throw Error('Unexpected deployment database');
const socket = '/var/run/mysqld/mysqld.sock';
const db = await mysql.createConnection({ socketPath: socket, user: 'root', database });
const env = { ...process.env, BENCHPOLL_DB_NAME: database, BENCHPOLL_DB_USER: 'root', BENCHPOLL_DB_PASSWORD: '', BENCHPOLL_DB_SOCKET: socket };
const backupDir = `/home/ubuntu/backups/score-fields-deploy-${Date.now()}`;
await mkdir(backupDir, { recursive: true, mode: 0o700 });
const dump = `${backupDir}/database.sql`, code = `${backupDir}/code.tar`;
function run(command, args, options = {}) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { cwd: staging, env, stdio: ['pipe', 'pipe', 'pipe'] });
        let stdout = '', stderr = '';
        child.stdout.on('data', chunk => { stdout += chunk; }); child.stderr.on('data', chunk => { stderr += chunk; });
        child.on('error', reject); child.on('exit', status => status === 0 ? resolve(stdout) : reject(Error(`${command} failed: ${stderr || stdout}`)));
        if (options.input) createReadStream(options.input).pipe(child.stdin); else child.stdin.end();
    });
}
const evidence = async () => {
    const [rows] = await db.execute('SELECT ID, model_ID, benchmark_ID, benchmark_condition_ID, raw_score, source_url, source_type, source_title, notes, status, benchmark_condition_snapshot, submitted_by, moderation_log_ID FROM benchmark_results ORDER BY ID');
    return { count: rows.length, hash: hash(JSON.stringify(rows)) };
};
function health() {
    return new Promise((resolve, reject) => {
        const req = request('https://127.0.0.1:1337/api/get_weighted_workspace', { method: 'POST', rejectUnauthorized: false,
            headers: { 'Content-Type': 'application/json' }, timeout: 10000 }, res => {
            let body = ''; res.on('data', chunk => { body += chunk; }); res.on('end', () => {
                try { if (res.statusCode !== 200) throw Error(`Ranking health status ${res.statusCode}`); resolve(validateWorkspacePayload(JSON.parse(body))); }
                catch (error) { reject(error); }
            });
        });
        req.on('error', reject); req.on('timeout', () => req.destroy(Error('Health timeout'))); req.end('{}');
    });
}
let stopped = false, backupReady = false, changed = false;
try {
    await run('tar', ['-cf', code, '-C', production, '--', ...existing]);
    await run('systemctl', ['stop', 'benchpoll.service']); stopped = true;
    await run('mysqldump', ['--socket', socket, '-u', 'root', '--single-transaction', '--routines', '--triggers', '--events', '--set-gtid-purged=OFF', `--result-file=${dump}`, database]);
    await chmod(dump, 0o600); backupReady = true;
    const before = await evidence();
    changed = true;
    await run(process.execPath, ['scripts/migrate-score-fields.mjs', '--apply']);
    if ((await evidence()).hash !== before.hash) throw Error('Production evidence checksum changed');
    await run('tar', ['-xf', path.join(staging, 'patch.tar'), '-C', production, '--no-same-owner', '--', ...manifest.map(item => item.path)]);
    const integrity = JSON.parse(await run(process.execPath, ['scripts/check-ranking-integrity.mjs']));
    if (integrity.status !== 'passed') throw Error('Production ranking integrity failed');
    await run('systemctl', ['start', 'benchpoll.service']); stopped = false;
    let workspace;
    for (let attempt = 0; ; attempt++) {
        try { workspace = await health(); break; }
        catch (error) { if (attempt >= 30) throw error; await new Promise(resolve => setTimeout(resolve, 200)); }
    }
    console.log(JSON.stringify({ deployed: true, backupDir, scoresPreserved: before.count,
        integrityChecks: integrity.checks.length, models: workspace.modelLeaderboards.public.length }));
} catch (error) {
    if (changed && backupReady) {
        await run('systemctl', ['stop', 'benchpoll.service']); stopped = true;
        await db.query('SET FOREIGN_KEY_CHECKS = 0');
        await db.query('DROP TABLE IF EXISTS score_field_options, score_fields, score_field_migration_archive');
        await db.query('SET FOREIGN_KEY_CHECKS = 1');
        await run('mysql', ['--socket', socket, '-u', 'root', database], { input: dump });
        await run('tar', ['-xf', code, '-C', production, '--no-same-owner']);
        for (const item of manifest.filter(item => !existing.includes(item.path))) {
            try { await stat(path.join(production, item.path)); await unlink(path.join(production, item.path)); }
            catch (cause) { if (cause.code !== 'ENOENT') throw cause; }
        }
        console.error(`Deployment rolled back; backup retained at ${backupDir}`);
    }
    throw error;
} finally {
    if (stopped) await run('systemctl', ['start', 'benchpoll.service']);
    await db.end();
}
