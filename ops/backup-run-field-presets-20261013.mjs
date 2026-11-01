import 'dotenv/config';
import { spawn } from 'node:child_process';
import { createWriteStream, createReadStream } from 'node:fs';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { createGzip, createGunzip } from 'node:zlib';
import { createHash } from 'node:crypto';
import { pipeline } from 'node:stream/promises';

if (process.platform !== 'linux' || process.cwd() !== '/home/ubuntu/benchpoll') throw new Error('Run from the production application directory');
const directory = '/home/ubuntu/benchpoll-db-backups';
await mkdir(directory, { recursive: true, mode: 0o700 });
const path = `${directory}/pre-run-field-presets-${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz`;
const dump = spawn('mysqldump', ['--single-transaction', '--routines', '--triggers', '--events', '--hex-blob',
    '--set-gtid-purged=OFF', '--no-tablespaces', `--socket=${process.env.BENCHPOLL_DB_SOCKET || '/var/run/mysqld/mysqld.sock'}`,
    `--user=${process.env.BENCHPOLL_DB_USER || 'root'}`, process.env.BENCHPOLL_DB_NAME || 'benchmarks'],
{ env: { ...process.env, MYSQL_PWD: process.env.BENCHPOLL_DB_PASSWORD ?? process.env.DB_PASSWORD ?? '' } });
let stderr = '';
dump.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
const finished = new Promise((resolve, reject) => {
    dump.once('error', reject);
    dump.once('exit', code => code === 0 ? resolve() : reject(new Error(`Database backup failed (${code}): ${stderr}`)));
});
await Promise.all([finished, pipeline(dump.stdout, createGzip({ level: 1 }), createWriteStream(path, { flags: 'wx', mode: 0o600 }))]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(path)) hash.update(chunk);
let sqlBytes = 0, tail = '', tableDefinitions = 0;
for await (const chunk of createReadStream(path).pipe(createGunzip())) {
    sqlBytes += chunk.length;
    const text = tail + chunk.toString('utf8');
    tableDefinitions += (text.slice(0, -160).match(/CREATE TABLE `/g) ?? []).length;
    tail = text.slice(-160);
}
tableDefinitions += (tail.match(/CREATE TABLE `/g) ?? []).length;
if (sqlBytes < 100000 || tableDefinitions < 6 || !/Dump completed on/.test(tail)) throw new Error('Backup verification failed');
const receipt = { path, compressedBytes: (await stat(path)).size, sqlBytes, tableDefinitions,
    sha256: hash.digest('hex'), gzipVerified: true, dumpCompleted: true };
await writeFile(`${path}.json`, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify(receipt));
