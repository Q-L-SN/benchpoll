import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';

const baseline = 'D:/BenchPoll-artifacts/review-20261008/paging-progress-production-before';
const output = 'artifacts/review-20261008/paging-progress-deployment';
const paths = ['ranking-pagination.js', 'server.js', 'public/js/home-workspace.js',
    'public/js/workspace/contracts.js', 'public/js/workspace/benchmark-fallback-catalogue.js',
    'public/js/contribution/score-fields.js', 'public/js/shared/ranking-resume.js'];
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const source = `import {readFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const files=[]; for(const path of ${JSON.stringify(paths)}) {
try {const data=await readFile('/home/ubuntu/benchpoll/'+path);
files.push({path,hash:createHash('sha256').update(data).digest('hex'),data:data.toString('base64')});}
catch(error) {if(error.code!=='ENOENT')throw error; files.push({path,hash:null});}}
console.log(JSON.stringify(files));`;
const files = JSON.parse(execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', ['-i', key,
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'], { input: source, encoding: 'utf8', timeout: 90000, windowsHide: true }));
assert.deepEqual(files.map(file => file.path), paths);
await mkdir(output);
for (const file of files) {
    if (file.hash === null) {
        assert.equal(file.path, 'public/js/shared/ranking-resume.js');
        continue;
    }
    const destination = join(baseline, file.path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(file.data, 'base64'), { flag: 'wx' });
    assert.equal(createHash('sha256').update(await readFile(destination)).digest('hex'), file.hash);
    if (file.path !== 'public/js/contribution/score-fields.js') {
        assert.equal(createHash('sha256').update(await readFile(file.path)).digest('hex'), file.hash,
            'Paging application sources must still match installed source before repair');
    }
}
await writeFile(join(output, 'production-before.json'), JSON.stringify({ baseline,
    capturedAt: new Date().toISOString(), hashes: files.map(({ path, hash }) => ({ path, hash })),
    databaseAccess: false, databaseChanged: false }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ files: files.length, baseline, captured: true, databaseAccess: false }));
