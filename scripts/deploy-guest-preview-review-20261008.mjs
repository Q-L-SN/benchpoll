import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';

const output = resolve('artifacts/review-20261008/guest-preview-lifecycle-20261008/deployment');
const targets = ['public/js/home-workspace.js', 'public/js/workspace/model-list.js'];
const stage = join(output, 'stage'), before = join(output, 'before');
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async path => sha(await readFile(path));
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const ssh = (code, timeout = 90000) => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host, 'node --input-type=module'],
    { input: code, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 48 * 1024 * 1024 });
const normal = text => text.replaceAll('\r\n', '\n');
function range(source, path) {
    const start = path === targets[0] ? 'async function previewGuestPersonalPie()' : '    function renderModels()';
    const end = path === targets[0] ? 'async function persistPersonalPie(' : '\n    return { renderModels, clearRankingStatus:';
    const left = source.indexOf(start), right = source.indexOf(end, left + start.length);
    assert.ok(left >= 0 && right > left, 'Owned function boundaries: ' + path);
    return { left, right, text: source.slice(left, right) };
}
async function guard(expected) {
    return JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
for(const file of ${JSON.stringify(expected)}){const actual=createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+file.path)).digest('hex');if(actual!==file.hash)throw Error('Production drift: '+file.path);}
execFileSync('systemctl',['is-active','--quiet','benchpoll.service']);execFileSync('systemctl',['is-active','--quiet','nginx']);console.log(JSON.stringify({matched:true,files:${expected.length}}));`));
}
async function proof() {
    const path = arg('verification'); assert.ok(path, 'A fresh full gate is required.');
    const verified = await json(path);
    assert.equal(verified.passed, true); assert.deepEqual(verified.sourceDrift, []);
    for (const [file, expected] of Object.entries(verified.after)) assert.equal(await hash(file), expected, 'Local drift: ' + file);
    for (const check of verified.checks) {
        assert.equal(check.passed, true); assert.equal(await hash(check.report), check.sha256);
    }
    const browserReports = [];
    for (const name of ['timeout-report', 'interrupted-report']) {
        const path = arg(name); assert.ok(path);
        const data = await json(path);
        assert.equal(data.phase, 'after'); assert.equal(resolve(data.sourceRoot), stage);
        assert.deepEqual(data.sourceDrift, []); assert.equal(data.results.length, 8);
        assert.ok(data.results.every(result => result.passed && result.ruleSatisfied));
        for (const target of targets) assert.equal(await hash(join(stage, target)), data.hashes[target]);
        browserReports.push({ path, sha256: await hash(path) });
    }
    return { path, sha256: await hash(path), browserReports };
}

if (process.argv.includes('--capture')) {
    await mkdir(output, { recursive: true });
    assert.equal((await readdir(output)).length, 0, 'An existing capture must not be replaced.');
    const previous = await json('artifacts/review-20261008/static-session-20261008-b06a71d9/deployment/installed-guards.json');
    const packed = ssh(`import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';import{gzipSync}from'node:zlib';
const root='/home/ubuntu/benchpoll',paths=new Set(${JSON.stringify(previous.hashes.map(file => file.path))});
async function collect(dir){for(const e of await readdir(root+'/'+dir,{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory())await collect(path);else if(/\\.(js|css|html)$/.test(path))paths.add(path);}}
for(const dir of ['public/js','public/css','private'])await collect(dir);
const files=[];for(const path of [...paths].sort()){const bytes=await readFile(root+'/'+path);files.push({path,hash:createHash('sha256').update(bytes).digest('hex'),...(/^(public|private)\\//.test(path)?{data:bytes.toString('base64')}:{})});}
const source=await readFile(root+'/server.js','utf8'),registrations=[...source.matchAll(/API\\.post\\('(\\/[^']+)',[^\\n]*\\brequireAccountWriteOwner\\b/g)].map(match=>match[1]);
const status=execFileSync('systemctl',['show','benchpoll.service','-p','MainPID','-p','ActiveEnterTimestamp'],{encoding:'utf8'});
console.log(gzipSync(JSON.stringify({files,registrations,status})).toString('base64'));`);
    const captured = JSON.parse(gunzipSync(Buffer.from(packed.trim(), 'base64')).toString('utf8'));
    assert.equal(captured.registrations.length, 26);
    for (const file of captured.files.filter(file => file.data)) {
        for (const dir of [before, stage]) {
            const destination = join(dir, file.path); await mkdir(dirname(destination), { recursive: true });
            await writeFile(destination, Buffer.from(file.data, 'base64'), { flag: 'wx' });
        }
    }
    const localHashes = {};
    for (const path of targets) {
        const original = await readFile(join(before, path), 'utf8');
        const oldLocal = await readFile(resolve('artifacts/review-20261008/guest-preview-lifecycle-20261008/before', path), 'utf8');
        const current = await readFile(path, 'utf8'); localHashes[path] = sha(current);
        const installed = range(original, path), expected = range(oldLocal, path), repaired = range(current, path);
        assert.equal(normal(installed.text), normal(expected.text), 'Concurrent function changes must not be overwritten: ' + path);
        const replacement = installed.text.includes('\r\n') ? normal(repaired.text).replaceAll('\n', '\r\n') : normal(repaired.text);
        const result = original.slice(0, installed.left) + replacement + original.slice(installed.right);
        // Mechanically transplant only the already-reviewed function into the fresh installed file.
        await writeFile(join(stage, path), result);
        assert.equal(result.slice(0, installed.left), original.slice(0, installed.left));
        assert.equal(result.slice(installed.left + replacement.length), original.slice(installed.right));
    }
    await writeFile(join(output, 'baseline.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
        hashes: captured.files.map(({ path, hash }) => ({ path, hash })), registrations: captured.registrations,
        status: captured.status, localHashes, databaseAccess: false, databaseChanged: false }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ captured: true, targets, protected: captured.files.length - targets.length, stage }));
} else if (process.argv.includes('--prepare')) {
    const proofs = await proof(), baseline = await json(join(output, 'baseline.json'));
    for (const path of targets) assert.equal(await hash(path), baseline.localHashes[path]);
    const tests = spawnSync(process.execPath, ['--test', 'test/guest-preview-lifecycle.test.mjs'], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, GUEST_PREVIEW_REVIEW_SOURCE_DIR: stage } });
    await writeFile(join(output, 'staged-unit.tap'), (tests.stdout ?? '') + (tests.stderr ?? ''), { flag: 'wx' });
    assert.equal(tests.status, 0);
    const files = [];
    for (const path of targets) {
        execFileSync(process.execPath, ['--check', join(stage, path)]);
        let diff;
        try { diff = execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', join(before, path), join(stage, path)], { encoding: 'utf8', windowsHide: true }); }
        catch (error) { if (error.status !== 1) throw error; diff = String(error.stdout); }
        await writeFile(join(output, path.replaceAll('/', '-') + '.diff'), diff, { flag: 'wx' });
        files.push({ path, before: baseline.hashes.find(file => file.path === path).hash, after: await hash(join(stage, path)) });
    }
    const manifest = { release: `launch-20261008-${Date.now()}`, files,
        protectedFiles: baseline.hashes.filter(file => !targets.includes(file.path)), protectedRegistrations: baseline.registrations };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ proofs, applicationRestarted: false,
        databaseChanged: false, scope: 'Two owned frontend functions transplanted into fresh installed files. All other frontend bytes and backend registrations are preserved.' }, null, 2), { flag: 'wx' });
    execFileSync('tar.exe', ['-cf', join(output, manifest.release + '.tar'), '-C', stage, ...targets,
        '-C', process.cwd(), 'ops/launch-release.mjs', '-C', output, 'manifest.json']);
    console.log(JSON.stringify({ prepared: true, release: manifest.release, files: files.length }));
} else if (process.argv.includes('--apply')) {
    const proofs = await proof(), preflight = await json(join(output, 'preflight.json'));
    assert.deepEqual(proofs, preflight.proofs);
    const baseline = await json(join(output, 'baseline.json')), manifest = await json(join(output, 'manifest.json'));
    assert.deepEqual(manifest.files.map(file => file.path), targets);
    assert.deepEqual(manifest.protectedFiles, baseline.hashes.filter(file => !targets.includes(file.path)));
    assert.deepEqual(manifest.protectedRegistrations, baseline.registrations);
    for (const file of manifest.files) {
        assert.equal(file.before, baseline.hashes.find(candidate => candidate.path === file.path).hash);
        assert.equal(await hash(join(stage, file.path)), file.after);
    }
    await guard([...manifest.files.map(file => ({ path: file.path, hash: file.before })), ...manifest.protectedFiles]);
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, join(output, manifest.release + '.tar'), `${host}:/tmp/${manifest.release}.tar`], { windowsHide: true });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';const stage='/tmp/${manifest.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000));
    assert.equal(receipt.healthy, true); assert.equal(receipt.files, 2);
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const checked = await guard([...manifest.files.map(file => ({ path: file.path, hash: file.after })), ...manifest.protectedFiles]);
    const status = ssh(`import{execFileSync}from'node:child_process';console.log(execFileSync('systemctl',['show','benchpoll.service','-p','MainPID','-p','ActiveEnterTimestamp'],{encoding:'utf8'}));`);
    assert.equal(status.trim(), baseline.status.trim(), 'Frontend-only release must not restart the application.');
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify({ ...checked, release: manifest.release,
        hashes: [...manifest.files.map(file => ({ path: file.path, hash: file.after, changed: true })), ...manifest.protectedFiles],
        status: status.trim(), protectedRegistrations: manifest.protectedRegistrations.length, applicationRestarted: false,
        databaseChanged: false }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --capture, --prepare or --apply. Do not repeat an uncertain apply; inspect the current hashes and receipt.');
