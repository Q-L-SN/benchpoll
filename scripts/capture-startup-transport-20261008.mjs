import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const output = resolve('artifacts/review-20261008/startup-transport-' + Date.now());
const root = join(output, 'installed'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
const host = 'ubuntu@18.226.222.18';
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
await mkdir(output, { recursive: true });
const started = performance.now();
let result;
try {
    result = execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host, 'node --input-type=module'], {
    input: `import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{gzipSync}from'node:zlib';
const root='/home/ubuntu/benchpoll',files=[];const sha=b=>createHash('sha256').update(b).digest('hex');
async function add(path){const bytes=await readFile(root+'/'+path);files.push({path,hash:sha(bytes),data:bytes.toString('base64')});}
async function collect(dir){for(const e of await readdir(root+'/'+dir,{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory())await collect(path);else if(/\\.(js|css|woff2?|ttf|svg|png|webp|ico)$/.test(path))await add(path);}}
for(const dir of ['public/js','public/css','public/assets/fonts','public/assets/vendors','public/vendor/fontawesome/css','public/vendor/fontawesome/webfonts'])await collect(dir);
for(const e of await readdir(root+'/public/assets',{withFileTypes:true}))if(e.isFile())await add('public/assets/'+e.name);
for(const path of ['private/home.html','public/favicon.ico','server.js','ranking-service.js','ranking-pagination.js'])await add(path);
for(const f of files)if(sha(await readFile(root+'/'+f.path))!==f.hash)throw Error('Changed during capture: '+f.path);
process.stdout.write(gzipSync(JSON.stringify({capturedAt:new Date().toISOString(),files})));`,
        windowsHide: true, timeout: 420000, maxBuffer: 40 * 1024 * 1024
    });
} catch (error) {
    const failure = { passed: false, operation: 'read-only-installed-static-capture', code: error.code,
        status: error.status, signal: error.signal, elapsedMs: Math.round(performance.now() - started),
        receivedBytes: error.stdout?.length ?? 0, stderr: String(error.stderr ?? '').slice(0, 2000),
        applicationChanges: false, productionBusinessDataWritten: false };
    await writeFile(join(output, 'capture-failure.json'), JSON.stringify(failure, null, 2), { flag: 'wx' });
    throw new Error('Installed capture failed: ' + JSON.stringify(failure));
}
const captureMs = Math.round(performance.now() - started);
const capture = JSON.parse(gunzipSync(result).toString('utf8'));
await mkdir(root, { recursive: true });
for (const file of capture.files) {
    assert.ok(/^[a-zA-Z0-9_./-]+$/.test(file.path) && !file.path.split('/').includes('..'));
    const bytes = Buffer.from(file.data, 'base64'); assert.equal(sha(bytes), file.hash);
    const destination = join(root, file.path); await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
}
const publicProbes = [];
for (const path of ['/js/shared/motion.js', '/js/workspace/draft-records.js', '/css/ui/workspace.css', '/assets/fonts/manrope-400.woff2']) {
    const started = performance.now(), response = await fetch('https://benchpoll.com' + path, { signal: AbortSignal.timeout(30000), credentials: 'omit' });
    const headersMs = Math.round(performance.now() - started), bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(response.status, 200); assert.equal(sha(bytes), sha(await readFile(join(root, 'public' + path))));
    publicProbes.push({ path, status: response.status, headersMs, totalMs: Math.round(performance.now() - started), bytes: bytes.length,
        headers: Object.fromEntries(['cache-control', 'content-type', 'content-encoding', 'etag', 'cf-cache-status', 'age']
            .map(name => [name, response.headers.get(name)])) });
}
await writeFile(join(output, 'baseline.json'), JSON.stringify({ capturedAt: capture.capturedAt, root, captureMs, compressedBytes: result.length,
    files: capture.files.map(({ path, hash }) => ({ path, hash })), publicProbes,
    applicationChanges: false, productionBusinessDataRead: false, productionBusinessDataWritten: false }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, root, files: capture.files.length, publicProbes: publicProbes.length, applicationChanges: false }));
