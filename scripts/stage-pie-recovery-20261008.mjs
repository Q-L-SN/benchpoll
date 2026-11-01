import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { transplantPieRecovery } from './pie-recovery-release-guard-20261008.mjs';

const root = resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008');
const output = join(root, 'deployment-' + Date.now()), before = join(output, 'before'), stage = join(output, 'stage');
const targets = ['public/js/workspace/draft-records.js', 'public/js/workspace/pie-recovery.js', 'public/js/shared/write-intent.js',
    'public/js/workspace/state.js', 'public/js/workspace/guest-drafts.js', 'public/js/home-workspace.js'];
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const packed = execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', ['-i',
    'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem', '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20', 'ubuntu@18.226.222.18', 'node --input-type=module'],
{ input: `import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{gzipSync}from'node:zlib';
const root='/home/ubuntu/benchpoll',files=[];
async function add(path){let bytes;try{bytes=await readFile(root+'/'+path);}catch(e){if(e.code!=='ENOENT')throw e;}
files.push({path,hash:bytes===undefined?null:createHash('sha256').update(bytes).digest('hex'),...(bytes===undefined?{}:{data:bytes.toString('base64')})});}
async function collect(dir){for(const e of await readdir(root+'/'+dir,{withFileTypes:true})){const p=dir+'/'+e.name;if(e.isDirectory())await collect(p);else if(/\\.(js|css|html)$/.test(p))await add(p);}}
for(const dir of ['public/js','public/css','private'])await collect(dir);
for(const p of await readdir(root))if(/\\.js$/.test(p))await add(p);await add('package.json');
for(const p of ${JSON.stringify(targets)})if(!files.some(f=>f.path===p))await add(p);
for(const f of files){let hash=null;try{hash=createHash('sha256').update(await readFile(root+'/'+f.path)).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;}if(hash!==f.hash)throw Error('Changed during capture: '+f.path);}
console.log(gzipSync(JSON.stringify({capturedAt:new Date().toISOString(),files})).toString('base64'));`,
encoding: 'utf8', windowsHide: true, timeout: 90000, maxBuffer: 48 * 1024 * 1024 });
const capture = JSON.parse(gunzipSync(Buffer.from(packed.trim(), 'base64')).toString('utf8'));
await mkdir(stage, { recursive: true });
for (const file of capture.files) {
    assert.equal(file.path.split('/').includes('..'), false);
    if (file.hash === null) continue;
    const bytes = Buffer.from(file.data, 'base64'); assert.equal(sha(bytes), file.hash);
    for (const dir of [before, stage]) { const path = join(dir, file.path); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes, { flag: 'wx' }); }
}
const localHashes = {}, files = [];
for (const path of targets) {
    const bytes = await readFile(path), installed = capture.files.find(file => file.path === path);
    localHashes[path] = sha(bytes);
    let next = bytes;
    if (installed.hash !== null) {
        const original = await readFile(join(root, 'before', path), 'utf8');
        if (path.endsWith('/home-workspace.js')) next = Buffer.from(transplantPieRecovery(original, bytes.toString('utf8'), Buffer.from(installed.data, 'base64').toString('utf8')));
        else assert.equal(original.replaceAll('\r\n', '\n'), Buffer.from(installed.data, 'base64').toString('utf8').replaceAll('\r\n', '\n'),
            'Another deployment changed this owned module: ' + path);
    } else assert.ok(['public/js/workspace/draft-records.js', 'public/js/workspace/pie-recovery.js'].includes(path));
    await writeFile(join(stage, path), next, installed.hash === null ? { flag: 'wx' } : {});
    execFileSync(process.execPath, ['--check', join(stage, path)], { windowsHide: true });
    files.push({ path, before: installed.hash, after: sha(next) });
}
await writeFile(join(output, 'baseline.json'), JSON.stringify({ capturedAt: capture.capturedAt, files, localHashes,
    protectedFiles: capture.files.filter(file => !targets.includes(file.path)).map(({ path, hash }) => ({ path, hash })),
    applicationFilesReverted: false, productionBusinessDataRead: false, productionBusinessDataWritten: false }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, stage, files: files.length, protectedFiles: capture.files.length - targets.length, applicationChanges: false }));
