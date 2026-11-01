import mysql from 'mysql2/promise';
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile, writeFile, chmod, cp } from 'node:fs/promises';

if (process.getuid?.() !== 0) throw new Error('Score-sync installation requires a local root operator');
const root = '/home/ubuntu/benchpoll';
const user = 'benchpoll-sync';
const credentialFile = '/etc/benchpoll-score-sync.env';
const command = (name, args) => execFileSync(name, args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
command('setfacl', ['--version']);
let account;
try { account = command('getent', ['passwd', user]); }
catch (error) { if (error.status !== 2) throw error; }
if (!account) command('useradd', ['--system', '--user-group', '--home-dir', '/var/lib/benchpoll-score-sync', '--shell', '/usr/sbin/nologin', user]);
let password;
try {
    const contents = await readFile(credentialFile, 'utf8');
    const match = contents.match(/^BENCHPOLL_DB_PASSWORD=([A-Za-z0-9_-]+)$/m);
    if (!match || !contents.includes('BENCHPOLL_DB_USER=benchpoll_sync')) throw new Error('Unexpected existing score-sync credentials');
    password = match[1];
} catch (error) { if (error.code !== 'ENOENT') throw error; password = randomBytes(36).toString('base64url'); }
const db = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'root', database: 'benchmarks' });
try {
    await db.query("CREATE USER IF NOT EXISTS 'benchpoll_sync'@'localhost' IDENTIFIED BY ?", [password]);
    await db.query("REVOKE ALL PRIVILEGES, GRANT OPTION FROM 'benchpoll_sync'@'localhost'");
    for (const table of ['organizations', 'models', 'benchmarks', 'benchmark_conditions', 'benchmark_tag_links',
        'benchmark_results', 'arena_sync_batches', 'arena_sync_feed_state', 'arena_sync_state']) {
        await db.query(`GRANT SELECT, INSERT, UPDATE ON benchmarks.${table} TO 'benchpoll_sync'@'localhost'`);
    }
    await db.query("GRANT SELECT,INSERT,UPDATE,DELETE ON benchmarks.arena_import_rows TO 'benchpoll_sync'@'localhost'");
    await db.query("GRANT SELECT,INSERT,UPDATE,DELETE ON benchmarks.arena_sync_conflicts TO 'benchpoll_sync'@'localhost'");
    for (const table of ['benchmark_tags', 'personal_pie_weights', 'personal_pie_score_rule_components', 'score_fields', 'score_field_options']) {
        await db.query(`GRANT SELECT ON benchmarks.${table} TO 'benchpoll_sync'@'localhost'`);
    }
    await db.query("GRANT SELECT,INSERT,UPDATE ON benchmarks.score_sync_runs TO 'benchpoll_sync'@'localhost'");
    await db.query("GRANT SELECT,UPDATE (next_run_at,last_status) ON benchmarks.score_sync_jobs TO 'benchpoll_sync'@'localhost'");
} finally { await db.end(); }
await writeFile(credentialFile, `BENCHPOLL_DB_USER=benchpoll_sync\nBENCHPOLL_DB_PASSWORD=${password}\nBENCHPOLL_DB_NAME=benchmarks\nBENCHPOLL_DB_SOCKET=/var/run/mysqld/mysqld.sock\nBENCHPOLL_SCORE_SYNC_DATA=/var/lib/benchpoll-score-sync\n`, { mode: 0o600 });
await chmod(credentialFile, 0o600);
command('setfacl', ['-m', `u:${user}:--x`, '/home/ubuntu']);
command('setfacl', ['-m', `u:${user}:r-x`, root]);
command('setfacl', ['-R', '-m', `u:${user}:r-X`, `${root}/node_modules`, `${root}/scripts`, `${root}/public/js`]);
const { readdir } = await import('node:fs/promises');
for (const entry of await readdir(root)) {
    if (entry.endsWith('.js') || entry === 'package.json') command('setfacl', ['-m', `u:${user}:r--`, `${root}/${entry}`]);
    if (entry === '.env' || entry.startsWith('.env.')) command('setfacl', ['-m', `u:${user}:---`, `${root}/${entry}`]);
}
await cp(`${root}/ops/systemd/benchpoll-score-sync.service`, '/etc/systemd/system/benchpoll-score-sync.service');
await cp(`${root}/ops/systemd/benchpoll-score-sync.timer`, '/etc/systemd/system/benchpoll-score-sync.timer');
command('systemd-analyze', ['verify', '/etc/systemd/system/benchpoll-score-sync.service', '/etc/systemd/system/benchpoll-score-sync.timer']);
const worker = await mysql.createConnection({ socketPath: '/var/run/mysqld/mysqld.sock', user: 'benchpoll_sync', password, database: 'benchmarks' });
try {
    for (const sql of ['SELECT ID FROM users LIMIT 0', 'UPDATE score_sync_jobs SET enabled=enabled WHERE ID=-1',
        'DELETE FROM benchmark_results WHERE ID=-1', 'CREATE TABLE score_sync_permission_probe (ID INT)']) {
        let denied = false;
        try { await worker.query(sql); } catch (error) {
            if (!['ER_TABLEACCESS_DENIED_ERROR', 'ER_COLUMNACCESS_DENIED_ERROR', 'ER_DBACCESS_DENIED_ERROR'].includes(error.code)) throw error;
            denied = true;
        }
        if (!denied) throw new Error(`Score-sync account unexpectedly allowed: ${sql}`);
    }
} finally { await worker.end(); }
const envCheck = command('runuser', ['-u', user, '--', '/usr/bin/node', '-e',
    `try {require('node:fs').readFileSync('${root}/.env'); process.exit(2)} catch(e) {if(e.code!=='EACCES')throw e}`]);
if (envCheck) throw new Error('Unexpected credential permission probe output');
command('systemctl', ['daemon-reload']);
console.log(JSON.stringify({ installed: true, dedicatedUser: user, registryWriteDenied: true,
    usersAndSessionsInaccessible: true, applicationSecretsInaccessible: true, timerEnabled: false }));
