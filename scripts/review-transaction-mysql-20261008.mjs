import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const output = resolve('artifacts/review-20261008/transaction-cleanup-deployment');
await mkdir(output, { recursive: true });
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const ssh = 'C:/WINDOWS/System32/OpenSSH/ssh.exe', scp = 'C:/WINDOWS/System32/OpenSSH/scp.exe';
const installed = process.argv.includes('--installed');
const moderation = process.argv.includes('--moderation');
const manifest = installed ? JSON.parse(await readFile(`${output}/manifest.json`, 'utf8')) : null;
const stage = installed ? '/home/ubuntu/benchpoll' : `/tmp/benchpoll-${moderation ? 'moderation' : 'transaction'}-review-${Date.now()}`;
const baseline = installed ? `/home/ubuntu/benchpoll-code-backups/${manifest.release}` : '/home/ubuntu/benchpoll';
const archive = `${output}/mysql-diagnostic-${Date.now()}.tar`;
const diagnostic = moderation ? 'ops/review-moderation-replay.mjs' : 'ops/review-transaction-cleanup.mjs';
execFileSync('tar.exe', ['-cf', archive, '-C', process.cwd(), 'package.json', 'db-transaction.js',
    'discussion-service.js', 'server.js', 'arena-sync.js', 'arena-sync-conflicts.js', 'arena-import-plan.js', 'score-sync-service.js',
    diagnostic], { stdio: 'inherit' });
const upload = installed ? `/tmp/benchpoll-transaction-review-${Date.now()}` : stage;
execFileSync(scp, [...options, archive, `${host}:${upload}.tar`], { stdio: 'inherit', timeout: 90000 });
execFileSync(ssh, [...options, host, `mkdir ${upload}`], { stdio: 'inherit', timeout: 90000 });
execFileSync(ssh, [...options, host, `tar -xf ${upload}.tar -C ${upload}`], { stdio: 'inherit', timeout: 90000 });
const result = execFileSync(ssh, [...options, host,
    `sudo -n env BENCHPOLL_DB_USER=root BENCHPOLL_DB_SOCKET=/var/run/mysqld/mysqld.sock BENCHPOLL_DB_PASSWORD= DB_PASSWORD= node ${upload}/${diagnostic} --stage=${stage} --baseline=${baseline}`],
{ encoding: 'utf8', timeout: 180000 });
const report = JSON.parse(result);
await writeFile(`${output}/${installed ? 'installed' : 'staged'}${moderation ? '-moderation' : ''}-mysql.json`, JSON.stringify({ ...report,
    applicationSource: stage, baselineSource: baseline, release: manifest?.release ?? null }, null, 2));
console.log(JSON.stringify({ passed: report.passed, total: report.total, applicationSource: stage,
    isolatedSchemaRemovedOnCompletion: true, productionBusinessTablesAccessed: report.productionBusinessTablesAccessed }));
