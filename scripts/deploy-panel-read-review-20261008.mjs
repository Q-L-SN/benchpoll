import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const output = resolve('artifacts/review-20261008/panel-read-deployment');
const targets = ['server.js', 'public/js/discussion.js', 'public/js/workspace/benchmark-scores.js'];
const stage = join(output, 'stage');
const before = join(output, 'before');
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const sha = value => createHash('sha256').update(value).digest('hex');
const hash = async path => sha(await readFile(path));
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const ssh = (source, timeout = 90000) => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host, 'node --input-type=module'],
    { input: source, encoding: 'utf8', windowsHide: true, timeout, maxBuffer: 8 * 1024 * 1024 });
await mkdir(output, { recursive: true });
const baselineFile = join(output, 'production-before.json');
async function guards(expected) {
    return JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
for(const file of ${JSON.stringify(expected)}){const hash=createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+file.path)).digest('hex');if(hash!==file.hash)throw Error('Production drift: '+file.path);}
for(const service of ['benchpoll.service','nginx'])execFileSync('systemctl',['is-active','--quiet',service]);console.log(JSON.stringify({matched:true,files:${expected.length},servicesActive:true}));`));
}
async function assertProof() {
    const proofPath = arg('verification');
    assert.ok(proofPath, 'A fresh stable full-source verification is required');
    const proof = await json(proofPath);
    assert.equal(proof.passed, true);
    assert.deepEqual(proof.sourceDrift, []);
    for (const [path, expected] of Object.entries(proof.after)) assert.equal(await hash(path), expected, `Local source drift: ${path}`);
    for (const check of proof.checks) {
        assert.equal(check.passed, true);
        assert.equal(await hash(check.report), check.sha256);
    }
    const browserPath = arg('browser-report');
    const browser = await json(browserPath);
    assert.equal(browser.phase, 'after');
    assert.equal(resolve(browser.panelSource), stage);
    assert.deepEqual(browser.sourceDrift, []);
    assert.equal(browser.results.length, 32);
    assert.ok(browser.results.every(result => result.passed && result.ruleSatisfied));
    for (const path of targets.filter(path => path.startsWith('public/'))) assert.equal(await hash(join(stage, path)), browser.hashes[path]);
    return { proofPath, proofHash: await hash(proofPath), browserPath, browserHash: await hash(browserPath) };
}

if (process.argv.includes('--capture')) {
    const previous = await json('artifacts/review-20261008/guest-restoration-deployment/installed-guards.json');
    const paths = [...new Set([...previous.hashes.map(file => file.path), ...targets])];
    const capture = JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';const files=[];
for(const path of ${JSON.stringify(paths)}){const data=await readFile('/home/ubuntu/benchpoll/'+path);files.push({path,hash:createHash('sha256').update(data).digest('hex'),...(${JSON.stringify(targets)}.includes(path)?{data:data.toString('base64')}:{})});}
const server=await readFile('/home/ubuntu/benchpoll/server.js','utf8');const registrations=[...server.matchAll(/API\\.post\\('([^']+)',[^\\n]*\\brequireAccountWriteOwner\\b/g)].map(match=>match[1]);console.log(JSON.stringify({files,registrations}));`));
    assert.equal(capture.registrations.length, 26);
    for (const file of capture.files.filter(file => targets.includes(file.path))) {
        for (const directory of [before, stage]) {
            const path = join(directory, file.path);
            await mkdir(dirname(path), { recursive: true });
            await writeFile(path, Buffer.from(file.data, 'base64'), { flag: 'wx' });
        }
    }
    await writeFile(baselineFile, JSON.stringify({ capturedAt: new Date().toISOString(),
        hashes: capture.files.map(({ path, hash }) => ({ path, hash })), registrations: capture.registrations,
        databaseAccess: false, databaseChanged: false }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ capture: true, files: capture.files.length, targets, stage }));
} else if (process.argv.includes('--prepare')) {
    const proofs = await assertProof();
    const baseline = await json(baselineFile);
    const verificationDirectory = join(output, `staged-verification-${Date.now()}`);
    await mkdir(verificationDirectory);
    const tests = spawnSync(process.execPath, ['--test', 'test/panel-read-lifecycle.test.mjs', 'test/ranking-disconnect.test.mjs'], {
        encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env,
            PANEL_READ_BASELINE: stage, RANKING_DISCONNECT_BASELINE: stage } });
    await writeFile(join(verificationDirectory, 'unit.tap'), (tests.stdout ?? '') + (tests.stderr ?? ''), { flag: 'wx' });
    assert.equal(tests.status, 0, 'Actual staged panel/route loader tests must pass');
    const files = [];
    for (const path of targets) {
        execFileSync(process.execPath, ['--check', join(stage, path)]);
        const old = baseline.hashes.find(file => file.path === path).hash;
        assert.equal(await hash(join(before, path)), old);
        const after = await hash(join(stage, path));
        if (old === after) continue;
        let diff;
        try { diff = execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', join(before, path), join(stage, path)], { encoding: 'utf8', windowsHide: true }); }
        catch (error) { if (error.status !== 1) throw error; diff = String(error.stdout); }
        await writeFile(join(output, path.replaceAll('/', '-') + '.diff'), diff, { flag: 'wx' });
        files.push({ path, before: old, after });
    }
    assert.ok(files.length > 0, 'There are no missing repairs to deploy');
    const changedPaths = files.map(file => file.path);
    const release = `launch-20261008-${Date.now()}`;
    const manifest = { release, files, protectedFiles: baseline.hashes.filter(file => !changedPaths.includes(file.path)),
        protectedRegistrations: baseline.registrations };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ proofs, verificationDirectory,
        databaseChanged: false, scope: 'Only the reviewed lifecycle hunks on the current installed baseline. New local UI remains untouched and is not included.' }, null, 2), { flag: 'wx' });
    execFileSync('tar.exe', ['-cf', join(output, release + '.tar'), '-C', stage, ...changedPaths,
        '-C', process.cwd(), 'ops/launch-release.mjs', 'ops/review-installed-startup-20261008.mjs', '-C', output, 'manifest.json']);
    console.log(JSON.stringify({ prepared: true, release, files: files.length }));
} else if (process.argv.includes('--apply')) {
    const proofs = await assertProof();
    const preflight = await json(join(output, 'preflight.json'));
    assert.deepEqual(proofs, preflight.proofs);
    const manifest = await json(join(output, 'manifest.json'));
    const changedPaths = manifest.files.map(file => file.path);
    assert.ok(changedPaths.length > 0 && changedPaths.length <= targets.length);
    assert.equal(new Set(changedPaths).size, changedPaths.length);
    assert.ok(changedPaths.every(path => targets.includes(path)));
    const baseline = await json(baselineFile);
    assert.deepEqual(manifest.protectedFiles, baseline.hashes.filter(file => !changedPaths.includes(file.path)));
    assert.deepEqual(manifest.protectedRegistrations, baseline.registrations);
    for (const file of manifest.files) assert.equal(file.before, baseline.hashes.find(candidate => candidate.path === file.path).hash);
    for (const file of manifest.files) assert.equal(await hash(join(stage, file.path)), file.after);
    await guards([...manifest.files.map(file => ({ path: file.path, hash: file.before })), ...manifest.protectedFiles]);
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, join(output, manifest.release + '.tar'), `${host}:/tmp/${manifest.release}.tar`], { windowsHide: true });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';const stage='/tmp/${manifest.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000));
    assert.equal(receipt.healthy, true); assert.equal(receipt.files, manifest.files.length);
    await writeFile(join(output, 'deployment-result.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const checked = JSON.parse(ssh(`import{execFileSync}from'node:child_process';execFileSync('node',['/tmp/${manifest.release}/ops/review-installed-startup-20261008.mjs','--manifest=/tmp/${manifest.release}/manifest.json'],{stdio:'inherit'});`));
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify(checked, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --capture, --prepare or --apply. Never repeat an uncertain apply; inspect installed hashes and the release receipt first.');
