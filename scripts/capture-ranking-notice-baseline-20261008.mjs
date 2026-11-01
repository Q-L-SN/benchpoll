import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const baseline = 'D:/BenchPoll-artifacts/review-20261008/paging-notice-production-before';
const output = 'artifacts/review-20261008/paging-progress-deployment';
const path = 'public/js/workspace/ranking-notice.js';
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const source = `import {readFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const path=${JSON.stringify(path)},data=await readFile('/home/ubuntu/benchpoll/'+path);
console.log(JSON.stringify({path,hash:createHash('sha256').update(data).digest('hex'),data:data.toString('base64')}));`;
const file = JSON.parse(execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', ['-i', key,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'], { input: source, encoding: 'utf8', timeout: 90000, windowsHide: true }));
assert.equal(file.path, path);
const sha = data => createHash('sha256').update(data).digest('hex');
assert.equal(sha(await readFile(path)), file.hash, 'Local notice must match production before repair');
const destination = join(baseline, path);
await mkdir(dirname(destination), { recursive: true });
await writeFile(destination, Buffer.from(file.data, 'base64'), { flag: 'wx' });
assert.equal(sha(await readFile(destination)), file.hash);
await writeFile(join(output, 'production-notice-before.json'), JSON.stringify({ baseline,
    capturedAt: new Date().toISOString(), hashes: [{ path, hash: file.hash }],
    databaseAccess: false, databaseChanged: false }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ baseline, captured: true, databaseAccess: false }));
