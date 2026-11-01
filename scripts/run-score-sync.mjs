import mysql from 'mysql2/promise';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scoreSyncOutcome, TRUSTED_SCORE_SOURCES } from '../score-sync-service.js';
import { destroyTransactionConnection, isTransactionConnectionDiscarded, runDatabaseOperation } from '../db-transaction.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dataDirectory = resolve(process.env.BENCHPOLL_SCORE_SYNC_DATA || '/var/lib/benchpoll-score-sync');
const force = process.argv.includes('--run-now');
if (process.argv.slice(2).some(argument => argument !== '--run-now')) throw new Error('Unknown score-sync argument');
if (!process.env.BENCHPOLL_DB_USER || !process.env.BENCHPOLL_DB_PASSWORD) {
    throw new Error('Dedicated score-sync database credentials are required');
}
async function connectWorker() {
    let cancelled = false, timer;
    const pending = Promise.resolve().then(() => mysql.createConnection({
        socketPath: process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock',
        user: process.env.BENCHPOLL_DB_USER, password: process.env.BENCHPOLL_DB_PASSWORD,
        database: process.env.BENCHPOLL_DB_NAME || 'benchmarks', charset: 'utf8mb4',
        dateStrings: true, timezone: 'Z', connectTimeout: 5000
    })).then(connection => {
        if (cancelled) {
            destroyTransactionConnection(connection, 'Score sync late connection');
            return;
        }
        return connection;
    });
    try {
        return await Promise.race([pending, new Promise((_, reject) => {
            timer = setTimeout(() => {
                cancelled = true;
                reject(Object.assign(new Error('Score sync connection timed out'), {
                    code: 'SCORE_SYNC_CONNECTION_TIMEOUT'
                }));
            }, 5000);
        })]);
    } finally { cancelled = true; clearTimeout(timer); }
}

const connection = await connectWorker();
const query = (...args) => runDatabaseOperation(connection, 'Score sync query', () => connection.query(...args));
const execute = (...args) => runDatabaseOperation(connection, 'Score sync execute', () => connection.execute(...args));

async function cleanupWorker(operation, label) {
    if (isTransactionConnectionDiscarded(connection)) return;
    try { await runDatabaseOperation(connection, `Score sync ${label}`, operation, 5000); }
    catch (error) {
        try { console.error(`[Score sync worker] ${label} failed`, error?.code ?? 'UNKNOWN'); }
        catch { /* Diagnostics cannot replace the publication result or its original failure. */ }
        destroyTransactionConnection(connection, `Score sync ${label}`);
        process.exitCode = 1;
    }
}

function command(script, args, timeout) {
    const result = spawnSync(process.execPath, [resolve(root, 'scripts', script), ...args], {
        cwd: root, env: { ...process.env, DOTENV_CONFIG_QUIET: 'true', DOTENV_CONFIG_DEBUG: 'false' },
        encoding: 'utf8', timeout, maxBuffer: 16 * 1024 * 1024
    });
    const stdout = (result.stdout || '').trim(), stderr = (result.stderr || '').trim();
    if (result.error || result.status !== 0) {
        throw new Error(`${script} failed (${result.error?.message || result.signal || result.status}): ${`${stdout}\n${stderr}`.trim().slice(-24000)}`);
    }
    return { stdout, stderr };
}

async function arenaRun(runID) {
    await mkdir(dataDirectory, { recursive: true });
    const path = resolve(dataDirectory, `arena-${runID}.json`);
    const fetched = command('fetch-arena-latest.mjs', [path, '--candidate'], 300000);
    const fetchLog = `${fetched.stdout}\n${fetched.stderr}`.trim().slice(-24000);
    const snapshot = JSON.parse(await readFile(path, 'utf8'));
    if (!Array.isArray(snapshot.expectedConfigs) || !snapshot.expectedConfigs.length
        || new Set(snapshot.expectedConfigs).size !== snapshot.expectedConfigs.length) throw new Error('Invalid Arena feed manifest');
    const feeds = [];
    for (const config of snapshot.expectedConfigs) {
        try {
            const log = command('import-arena-latest.mjs', [path, '--apply', '--schema-ready', '--config', config,
                '--sync-run', String(runID)], 300000);
            const publication = JSON.parse(log.stdout);
            if (publication?.applied !== true || publication.revision !== snapshot.revision) {
                throw new Error('Arena importer did not acknowledge the requested publication');
            }
            feeds.push({ config, status: 'succeeded', publication,
                ...(log.stderr ? { stderr: log.stderr.slice(-24000) } : {}) });
        } catch (error) {
            feeds.push({ config, status: 'failed', error: error.message });
            console.error(`${config}: ${error.message}`);
        }
    }
    // Raw candidates are retained for diagnosis; durable run summaries stay in MySQL.
    const snapshots = (await readdir(dataDirectory)).filter(name => /^arena-\d+\.json$/.test(name))
        .sort((left, right) => Number(right.match(/\d+/)[0]) - Number(left.match(/\d+/)[0]));
    for (const name of snapshots.slice(28)) {
        await unlink(resolve(dataDirectory, name));
        const validation = `${name}.validation.json`;
        if ((await readdir(dataDirectory)).includes(validation)) await unlink(resolve(dataDirectory, validation));
    }
    return { revision: snapshot.revision, fetchLog, feeds, status: scoreSyncOutcome(feeds) };
}

try {
    const [jobs] = await query(`SELECT * FROM score_sync_jobs WHERE enabled=1
        ${force ? '' : 'AND next_run_at<=UTC_TIMESTAMP(3)'} ORDER BY ID`);
    for (const candidate of jobs) {
        if (isTransactionConnectionDiscarded(connection)) break;
        if (!Object.hasOwn(TRUSTED_SCORE_SOURCES, candidate.source_key)) throw new Error(`Untrusted registered adapter: ${candidate.source_key}`);
        const lock = `score-sync:${candidate.source_key}`;
        const [[{ acquired }]] = await execute('SELECT GET_LOCK(?,0) AS acquired', [lock]);
        if (Number(acquired) !== 1) { console.log(`${candidate.source_key}: already running`); continue; }
        try {
            const [current] = await execute(`SELECT * FROM score_sync_jobs WHERE ID=? AND enabled=1
                ${force ? '' : 'AND next_run_at<=UTC_TIMESTAMP(3)'}`, [candidate.ID]);
            if (!current.length) continue;
            await execute(`UPDATE score_sync_runs SET status='failed',completed_at=UTC_TIMESTAMP(3),
                error_message='Worker interrupted before completion; the next run acquired its released lock'
                WHERE job_ID=? AND status='running'`, [candidate.ID]);
            const [created] = await execute('INSERT INTO score_sync_runs (job_ID) VALUES (?)', [candidate.ID]);
            const runID = Number(created.insertId);
            await execute(`UPDATE score_sync_jobs SET last_status='running',
                next_run_at=DATE_ADD(UTC_TIMESTAMP(3),INTERVAL interval_seconds SECOND) WHERE ID=?`, [candidate.ID]);
            let outcome;
            try { outcome = await arenaRun(runID); }
            catch (error) { outcome = { status: 'failed', error: error.message }; }
            await execute(`UPDATE score_sync_runs SET status=?,source_revision=?,summary=?,error_message=?,
                completed_at=UTC_TIMESTAMP(3) WHERE ID=? AND status='running'`,
            [outcome.status, outcome.revision || null, JSON.stringify(outcome), outcome.error ||
                (outcome.status === 'partial' ? 'Some feeds failed; previous successful data retained for those feeds' : null), runID]);
            await execute('UPDATE score_sync_jobs SET last_status=? WHERE ID=?', [outcome.status, candidate.ID]);
            console.log(JSON.stringify({ source: candidate.source_key, runID, status: outcome.status,
                feeds: outcome.feeds?.map(feed => ({ config: feed.config, status: feed.status })) }));
            if (outcome.status !== 'succeeded') process.exitCode = 1;
        } finally {
            await cleanupWorker(async () => {
                const [[{ released }]] = await connection.execute('SELECT RELEASE_LOCK(?) AS released', [lock]);
                if (Number(released) !== 1) throw Object.assign(new Error('Score sync advisory lock ownership was lost'), {
                    code: 'SCORE_SYNC_LOCK_LOST'
                });
            }, 'lock release');
        }
    }
} finally { await cleanupWorker(() => connection.end(), 'end'); }
