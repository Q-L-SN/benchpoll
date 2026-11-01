import { spawn, execFileSync } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createWriteStream, createReadStream } from 'node:fs';
import { createGzip } from 'node:zlib';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';

const directory = '/var/backups/benchpoll';
await mkdir(directory, { recursive: true, mode: 0o700 });
const file = `${directory}/pre-arena-current-${new Date().toISOString().replace(/[:.]/g, '-')}.sql.gz`;
const dump = spawn('mysqldump', ['--single-transaction', '--routines', '--triggers', '--events', '--hex-blob', '--set-gtid-purged=OFF', '-uroot', 'benchmarks']);
let errorOutput = '';
dump.stderr.on('data', chunk => { errorOutput += chunk; });
const completion = new Promise((resolve, reject) => {
    dump.on('error', reject);
    dump.on('exit', code => code === 0 ? resolve() : reject(new Error(`mysqldump exit ${code}: ${errorOutput}`)));
});
await Promise.all([pipeline(dump.stdout, createGzip({ level: 1 }), createWriteStream(file, { mode: 0o600 })), completion]);
execFileSync('gzip', ['-t', file]);
const hash = createHash('sha256');
for await (const chunk of createReadStream(file)) hash.update(chunk);
const bytes = (await stat(file)).size;
if (bytes < 1000) throw new Error('Database backup is unexpectedly small');
console.log(JSON.stringify({ file, bytes, sha256: hash.digest('hex'), verified: true }));
