import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const baseline = 'D:/BenchPoll-artifacts/review-20261008/profile-read-production-before';
const output = 'artifacts/review-20261008/profile-read-deployment';
const paths = ['public/js/navigation/sidebar.js', 'public/js/workspace/comparison-profile-menu.js'];
const record = join(output, 'coordination-production-before.json');
try { await stat(record); throw new Error('Original coordination baseline already captured'); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const source = `import {readFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const files=[]; for(const path of ${JSON.stringify(paths)}) { const data=await readFile('/home/ubuntu/benchpoll/'+path);
files.push({path,hash:createHash('sha256').update(data).digest('hex'),data:data.toString('base64')}); }
console.log(JSON.stringify(files));`;
const files = JSON.parse(execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', ['-i', key,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'], { input: source, encoding: 'utf8', timeout: 90000 }));
assert.deepEqual(files.map(file => file.path), paths);
for (const file of files) {
    const destination = join(baseline, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.data, 'base64'), { flag: 'wx' });
    assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'), file.hash);
    assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.hash,
        'These additional application sources must still be original before their repair');
}
await mkdir(output, { recursive: true });
await writeFile(record, JSON.stringify({ baseline,
    hashes: files.map(({ path, hash }) => ({ path, hash })), databaseChanged: false }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ captured: true, files: files.length, baseline, productionDataRead: false }));
