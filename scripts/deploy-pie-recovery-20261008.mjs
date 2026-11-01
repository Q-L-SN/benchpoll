import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { assertPieRecoveryRepair } from './pie-recovery-release-guard-20261008.mjs';

const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
assert.ok(arg('deployment'));
const output = resolve(arg('deployment')), stage = join(output, 'stage');
assert.ok(output.startsWith(resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008/deployment-')));
const targets = ['public/js/workspace/draft-records.js', 'public/js/workspace/pie-recovery.js', 'public/js/shared/write-intent.js',
    'public/js/workspace/state.js', 'public/js/workspace/guest-drafts.js', 'public/js/home-workspace.js'];
const options = ['-i', 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem',
    '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = async path => sha(await readFile(path));
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const normalize = value => value.replaceAll('\r\n', '\n');
const baseline = await json(join(output, 'baseline.json'));
assert.deepEqual(baseline.files.map(file => file.path), targets);
const ssh = code => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host, 'node --input-type=module'],
    { input: code, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 4 * 1024 * 1024 });

function remoteGuard(expected) {
    return `import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
for(const file of ${JSON.stringify(expected)}){let actual=null;try{actual=createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+file.path)).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==file.hash)throw Error('Production drift: '+file.path);}
for(const service of ['benchpoll.service','nginx'])execFileSync('systemctl',['is-active','--quiet',service]);`;
}
async function guardLocal() {
    for (const file of baseline.files) assert.equal(await hash(join(stage, file.path)), file.after);
    for (const file of baseline.protectedFiles) assert.equal(await hash(join(stage, file.path)), file.hash);
    for (const path of targets.filter(path => path !== 'public/js/home-workspace.js')) {
        assert.equal(await hash(path), baseline.localHashes[path], 'Owned module changed since capture: ' + path);
    }
    assertPieRecoveryRepair(await readFile('public/js/home-workspace.js', 'utf8'), await readFile(join(stage, 'public/js/home-workspace.js'), 'utf8'));
}
async function verification(name, full) {
    const path = arg(name); assert.ok(path, 'Missing --' + name);
    const report = await json(path), capture = await json(report.capture);
    assert.equal(report.passed, true); assert.equal(report.fullTestTree, full); assert.deepEqual(report.sourceDrift, []);
    assert.equal(resolve(report.sourceRoot), resolve(capture.sourceRoot));
    assert.ok(resolve(report.sourceRoot).startsWith(resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008/verification-')));
    for (const [file, expected] of Object.entries(capture.hashes)) {
        assert.equal(await hash(join(report.sourceRoot, file)), expected, 'Frozen verification drift: ' + file);
    }
    assert.ok(report.checks.some(check => check.name === 'lint'));
    const unit = report.checks.find(check => check.name === 'unit');
    assert.ok(unit.summary.pass >= (full ? 1608 : 201));
    assert.equal(unit.summary.fail, 0); assert.equal(unit.summary.cancelled, 0); assert.equal(unit.summary.skipped, 0);
    for (const check of report.checks) { assert.equal(check.passed, true); assert.equal(await hash(check.report), check.sha256); }
    if (full) {
        assertPieRecoveryRepair(await readFile(join(report.sourceRoot, 'public/js/home-workspace.js'), 'utf8'),
            await readFile(join(stage, 'public/js/home-workspace.js'), 'utf8'));
        for (const file of targets.filter(file => file !== 'public/js/home-workspace.js')) {
            assert.equal(normalize(await readFile(join(report.sourceRoot, file), 'utf8')), normalize(await readFile(join(stage, file), 'utf8')));
        }
    } else {
        assert.equal(resolve(capture.runtimeRoot), stage); assert.equal(resolve(report.runtimeRoot), stage);
        for (const file of capture.runtime) assert.equal(await hash(join(stage, file)), capture.hashes[file], 'Staged runtime drift: ' + file);
        for (const file of baseline.protectedFiles) assert.equal(capture.hashes[file.path], file.hash);
        for (const file of baseline.files) assert.equal(capture.hashes[file.path], file.after);
    }
    return { path: resolve(path), hash: await hash(path), captureHash: await hash(report.capture), testsPassed: unit.summary.pass };
}
async function proofs() {
    await guardLocal();
    const full = await verification('full-verification', true), focused = await verification('focused-verification', false);
    const path = arg('browser-report'); assert.ok(path);
    const browser = await json(path); assert.equal(resolve(browser.sourceRoot), stage); assert.deepEqual(browser.sourceDrift, []);
    assert.equal(browser.results.length, 20); assert.ok(browser.results.every(result => result.passed));
    for (const [file, expected] of Object.entries(browser.hashes)) assert.equal(await hash(join(stage, file)), expected, 'Browser runtime drift: ' + file);
    return { full, focused, browser: { path: resolve(path), hash: await hash(path), checksPassed: browser.results.length },
        releaseGuardHash: await hash('scripts/pie-recovery-release-guard-20261008.mjs'), launcherHash: await hash('ops/launch-release.mjs') };
}

if (process.argv.includes('--prepare')) {
    const proof = await proofs();
    const manifest = { release: 'launch-20261008-' + Date.now(), files: baseline.files, protectedFiles: baseline.protectedFiles };
    for (const file of manifest.files) { assert.notEqual(file.before, file.after); execFileSync(process.execPath, ['--check', join(stage, file.path)], { windowsHide: true }); }
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ proof, schemaMigration: false, applicationRestarted: false,
        productionBusinessDataWritten: false, scope: 'Six frontend recovery modules/hunks only; fresh installed UI and all protected files preserved.' }, null, 2), { flag: 'wx' });
    execFileSync('tar.exe', ['-cf', join(output, manifest.release + '.tar'), '-C', stage, ...targets,
        '-C', process.cwd(), 'ops/launch-release.mjs', '-C', output, 'manifest.json'], { windowsHide: true });
    console.log(JSON.stringify({ prepared: true, release: manifest.release, files: targets.length }));
} else if (process.argv.includes('--apply')) {
    const proof = await proofs(), preflight = await json(join(output, 'preflight.json'));
    assert.deepEqual(proof, preflight.proof);
    const manifest = await json(join(output, 'manifest.json'));
    assert.match(manifest.release, /^launch-20261008-[0-9]+$/); assert.deepEqual(manifest.files, baseline.files);
    assert.deepEqual(manifest.protectedFiles, baseline.protectedFiles);
    const before = [...manifest.files.map(file => ({ path: file.path, hash: file.before })), ...manifest.protectedFiles];
    ssh(remoteGuard(before));
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, join(output, manifest.release + '.tar'), `${host}:/tmp/${manifest.release}.tar`],
        { windowsHide: true, timeout: 120000 });
    // An uncertain publication must be inspected against hashes, never blindly retried.
    await writeFile(join(output, 'attempt.json'), JSON.stringify({ release: manifest.release, startedAt: new Date().toISOString() }), { flag: 'wx' });
    let receipt;
    try {
        receipt = JSON.parse(ssh(remoteGuard(before) + `
const stage='/tmp/${manifest.release}',{mkdir}=await import('node:fs/promises');await mkdir(stage);
execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`));
    } catch (error) {
        await writeFile(join(output, 'apply-error.txt'), String(error.stderr ?? error.message), { flag: 'wx' }); throw error;
    }
    assert.equal(receipt.healthy, true); assert.equal(receipt.files, targets.length); assert.equal(receipt.databaseChanged, false);
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const after = [...manifest.files.map(file => ({ path: file.path, hash: file.after })), ...manifest.protectedFiles];
    ssh(remoteGuard(after));
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify({ receipt, hashes: after, servicesActive: true,
        applicationRestarted: false, concurrentChangesReverted: false, protectedFiles: manifest.protectedFiles.length }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else throw Error('Use --prepare or --apply; uncertain publications require inspection before another release.');
