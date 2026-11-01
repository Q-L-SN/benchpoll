import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';

const output = resolve('artifacts/review-20261008/db-deadlines-deployment');
await mkdir(output, { recursive: true });
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const ssh = 'C:/WINDOWS/System32/OpenSSH/ssh.exe', scp = 'C:/WINDOWS/System32/OpenSSH/scp.exe';
const installed = process.argv.includes('--installed');
const manifest = installed ? JSON.parse(await readFile(`${output}/manifest.json`, 'utf8')) : null;
const upload = `/tmp/benchpoll-db-deadline-review-${Date.now()}`;
const stage = installed ? '/home/ubuntu/benchpoll' : upload;
const archive = `${output}/mysql-diagnostic-${Date.now()}.tar`;
execFileSync('tar.exe', ['-cf', archive, '-C', process.cwd(), 'package.json', 'db.js', 'db-transaction.js', 'db-deadlines.js',
    'ops/review-db-deadlines.mjs'], { stdio: 'inherit' });
execFileSync(scp, [...options, archive, `${host}:${upload}.tar`], { stdio: 'inherit', timeout: 90000 });
execFileSync(ssh, [...options, host, `mkdir ${upload} && tar -xf ${upload}.tar -C ${upload} && ln -s /home/ubuntu/benchpoll/node_modules ${upload}/node_modules`],
    { stdio: 'inherit', timeout: 90000 });
const result = execFileSync(ssh, [...options, host,
    `sudo -n env BENCHPOLL_DB_USER=root BENCHPOLL_DB_SOCKET=/var/run/mysqld/mysqld.sock BENCHPOLL_DB_PASSWORD= DB_PASSWORD= node ${upload}/ops/review-db-deadlines.mjs --stage=${stage}`],
{ encoding: 'utf8', timeout: 180000 });
const report = JSON.parse(result);
await writeFile(`${output}/${installed ? 'installed' : 'staged'}-mysql.json`, JSON.stringify({ ...report, release: manifest?.release ?? null }, null, 2));
console.log(JSON.stringify({ passed: report.passed, total: report.total, applicationSource: stage,
    productionBusinessTablesAccessed: false }));
