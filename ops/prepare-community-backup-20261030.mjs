import { copyFile, chmod, lstat, readFile, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const [stage, source] = process.argv.slice(2);
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/community-fallback-20261030\/community-fallback-20261030-\d+$/.test(stage)
    || !/^\/var\/backups\/benchpoll\/benchmarks-\d{8}T\d+Z\.sql\.gz$/.test(source)) throw new Error('Unexpected backup path');
const sourceInfo = await lstat(source), stageInfo = await lstat(stage);
if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink() || sourceInfo.mode & 0o077
    || !stageInfo.isDirectory() || stageInfo.isSymbolicLink() || stageInfo.mode & 0o077) throw new Error('Unsafe backup permissions');
const age = Date.now() - sourceInfo.mtimeMs;
if (age < 0 || age > 7200000 || sourceInfo.size < 1000) throw new Error('Fresh complete backup required');
execFileSync('gzip', ['-t', source], { stdio: 'pipe' });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const checksum = sha(await readFile(source));
if ((await readFile(source + '.sha256', 'utf8')).split(/\s/)[0] !== checksum) throw new Error('Backup checksum mismatch');
const path = `${stage}/database-${Date.now()}.sql.gz`;
await copyFile(source, path, constants.COPYFILE_EXCL);
await chmod(path, 0o600);
if (sha(await readFile(path)) !== checksum) throw new Error('Backup copy mismatch');
const manifest = { database: 'benchmarks', path, sha256: checksum, bytes: sourceInfo.size, createdAt: sourceInfo.mtime.toISOString() };
const bytes = JSON.stringify(manifest, null, 2);
await writeFile(stage + '/database-backup.json', bytes, { flag: 'wx', mode: 0o600 });
console.log(JSON.stringify({ ...manifest, manifestSha256: sha(bytes) }));
