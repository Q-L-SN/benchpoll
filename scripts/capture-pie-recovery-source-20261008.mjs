import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const root = resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008');
const output = join(root, 'installed-before');
await mkdir(output, { recursive: false });
const program = `import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{gzipSync}from'node:zlib';
const root='/home/ubuntu/benchpoll',files=[];
async function collect(dir,pattern){for(const entry of await readdir(root+'/'+dir,{withFileTypes:true})){const path=dir+'/'+entry.name;if(entry.isDirectory())await collect(path,pattern);else if(pattern.test(path))await add(path);}}
async function add(path){const bytes=await readFile(root+'/'+path);files.push({path,hash:createHash('sha256').update(bytes).digest('hex'),data:bytes.toString('base64')});}
for(const dir of ['public/js','public/css','private'])await collect(dir,/\\.(?:js|css|html)$/);
await add('package.json');
for(const file of files){const hash=createHash('sha256').update(await readFile(root+'/'+file.path)).digest('hex');if(hash!==file.hash)throw Error('Capture changed: '+file.path);}
console.log(gzipSync(JSON.stringify({capturedAt:new Date().toISOString(),files})).toString('base64'));`;
const packed = execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [
    '-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20',
    'ubuntu@18.226.222.18', 'node --input-type=module'
], { input: program, encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 24 * 1024 * 1024 });
const capture = JSON.parse(gunzipSync(Buffer.from(packed.trim(), 'base64')).toString('utf8'));
for (const file of capture.files) {
    assert.match(file.path, /^(?:public\/(?:js|css)\/|private\/|package\.json$)/);
    assert.equal(file.path.split('/').includes('..'), false);
    const bytes = Buffer.from(file.data, 'base64');
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.hash);
    const path = join(output, file.path); await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: 'wx' });
}
await writeFile(join(root, 'installed-baseline.json'), JSON.stringify({ capturedAt: capture.capturedAt,
    sourceRoot: output, files: capture.files.map(({ path, hash }) => ({ path, hash })),
    productionBusinessDataRead: false, productionBusinessDataWritten: false,
    scope: 'Read-only capture of current installed client sources and public/private HTML, after the concurrent UI release. No environment, session or business table is read.' }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ captured: true, files: capture.files.length, output, applicationChanged: false }));
