import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { assertHomeSaveRepair, assertPieSaveStyles } from './personal-pie-release-guard-20261008.mjs';

const output = resolve('artifacts/review-20261008/personal-pie-commit-20261008/deployment');
const stage = join(output, 'stage'), before = join(output, 'before');
const targets = ['server.js', 'ranking-service.js', 'public/js/home-workspace.js', 'public/js/shared/write-intent.js',
    'public/js/workspace/state.js', 'public/js/workspace/model-list.js', 'public/js/workspace/pie-save.js', 'public/css/ui/workspace.css'];
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
async function guard(expected) {
    return JSON.parse(ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';import{execFileSync}from'node:child_process';
for(const file of ${JSON.stringify(expected)}){let actual=null;try{actual=createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+file.path)).digest('hex');}catch(e){if(e.code!=='ENOENT')throw e;}if(actual!==file.hash)throw Error('Production drift: '+file.path);}
for(const service of ['benchpoll.service','nginx'])execFileSync('systemctl',['is-active','--quiet',service]);console.log(JSON.stringify({matched:true,files:${expected.length},servicesActive:true}));`));
}
async function proofs() {
    const verification = arg('verification'); assert.ok(verification);
    const proof = await json(verification); assert.equal(proof.passed, true); assert.deepEqual(proof.sourceDrift, []);
    const stagedVerification = arg('staged-verification'); assert.ok(stagedVerification);
    const stagedProof = await json(stagedVerification); assert.equal(stagedProof.passed, true);
    assert.equal(resolve(stagedProof.verification), resolve(verification));
    const sourceRoot = resolve(stagedProof.sourceRoot);
    assert.ok(sourceRoot.startsWith(resolve('artifacts/review-20261008/personal-pie-commit-20261008/immutable-')));
    assert.deepEqual(stagedProof.sourceDrift, []); assert.deepEqual(stagedProof.runtimeDrift, []);
    const capture = await json(stagedProof.capture); assert.equal(resolve(capture.sourceRoot), sourceRoot);
    assert.equal(capture.runtimeMode, 'local_integration');
    const baseline = await json(join(output, 'baseline.json'));
    for (const [path, expected] of Object.entries(proof.after)) assert.equal(await hash(join(sourceRoot, path)), expected, 'Verified snapshot drift: ' + path);
    for (const [path, expected] of Object.entries(capture.runtime)) assert.equal(await hash(join(sourceRoot, path)), expected, 'Integration snapshot drift: ' + path);
    assertHomeSaveRepair(await readFile(join(sourceRoot, 'public/js/home-workspace.js'), 'utf8'), await readFile(join(stage, 'public/js/home-workspace.js'), 'utf8'));
    assertPieSaveStyles(await readFile(join(sourceRoot, 'public/css/ui/workspace.css'), 'utf8'), await readFile(join(stage, 'public/css/ui/workspace.css'), 'utf8'));
    for (const path of targets.filter(path => !['public/js/home-workspace.js', 'public/css/ui/workspace.css'].includes(path))) {
        assert.equal(normal(await readFile(join(sourceRoot, path), 'utf8')), normal(await readFile(join(stage, path), 'utf8')), 'Integration target differs from installed repair: ' + path);
    }
    const focusedPath = arg('focused-verification'); assert.ok(focusedPath);
    const focused = await json(focusedPath), focusedCapture = await json(focused.capture);
    assert.equal(focused.passed, true); assert.deepEqual(focused.runtimeDrift, []); assert.deepEqual(focused.sourceDrift, []);
    assert.equal(focusedCapture.runtimeMode, 'installed_stage'); assert.equal(resolve(focusedCapture.runtimeRoot), stage);
    for (const [path, expected] of Object.entries(focusedCapture.runtime)) {
        assert.equal(await hash(join(stage, path)), expected, 'Staged runtime drift: ' + path);
        assert.equal(await hash(join(focused.sourceRoot, path)), expected, 'Focused snapshot drift: ' + path);
    }
    for (const file of baseline.hashes.filter(file => file.hash !== null && !targets.includes(file.path))) {
        assert.equal(focusedCapture.runtime[file.path], file.hash, 'Protected installed runtime changed: ' + file.path);
    }
    for (const path of targets) assert.equal(focusedCapture.runtime[path], await hash(join(stage, path)), 'Missing verified release target: ' + path);
    const focusedUnit = await json(focused.verification);
    assert.equal(focusedUnit.passed, true); assert.equal(focusedUnit.unitInputs.length, 7);
    assert.ok(focusedUnit.unitInputs.includes('test/personal-pie-save.test.mjs') && focusedUnit.unitInputs.includes('test/personal-pie-release-guard.test.mjs'));
    for (const check of focusedUnit.checks) {
        assert.equal(check.passed, true); assert.ok(check.summary.pass >= 89); assert.equal(check.summary.fail, 0);
        assert.equal(await hash(check.report), check.sha256);
    }
    await guardLocalRepair(baseline);
    for (const check of proof.checks) { assert.equal(check.passed, true); assert.equal(await hash(check.report), check.sha256); }
    const browser = arg('browser-report'); assert.ok(browser);
    const report = await json(browser); assert.equal(resolve(report.sourceRoot), stage);
    assert.equal(report.results.length, 12); assert.ok(report.results.every(result => result.passed)); assert.deepEqual(report.sourceDrift, []);
    for (const [path, expected] of Object.entries(report.hashes)) assert.equal(await hash(join(stage, path)), expected, 'Staged browser drift: ' + path);
    const nativePath = join(output, 'mysql.json'), native = await json(nativePath);
    assert.equal(native.passed, 14); assert.equal(native.total, 14);
    assert.equal(native.productionBusinessDataWritten, false); assert.equal(native.productionSchemaVerifiedReadOnly, true);
    for (const [path, expected] of Object.entries(native.hashes)) assert.equal(await hash(join(stage, path)), expected, 'Native SQL source drift: ' + path);
    return { verification, verificationHash: await hash(verification), stagedVerification, stagedVerificationHash: await hash(stagedVerification),
        capture: stagedProof.capture, captureHash: await hash(stagedProof.capture),
        focusedVerification: focusedPath, focusedVerificationHash: await hash(focusedPath),
        focusedCaptureHash: await hash(focused.capture), focusedUnitHash: await hash(focused.verification),
        releaseGuardHash: await hash('scripts/personal-pie-release-guard-20261008.mjs'),
        browser, browserHash: await hash(browser), nativePath, nativeHash: await hash(nativePath) };
}
async function guardLocalRepair(baseline) {
    for (const path of targets.filter(path => !['public/js/home-workspace.js', 'public/css/ui/workspace.css'].includes(path))) {
        assert.equal(await hash(path), baseline.localHashes[path], 'Captured owned source changed: ' + path);
    }
    assertPieSaveStyles(await readFile('public/css/ui/workspace.css', 'utf8'), await readFile(join(stage, 'public/css/ui/workspace.css'), 'utf8'));
    return assertHomeSaveRepair(await readFile('public/js/home-workspace.js', 'utf8'), await readFile(join(stage, 'public/js/home-workspace.js'), 'utf8'));
}
if (process.argv.includes('--capture')) {
    await mkdir(output, { recursive: true }); assert.equal((await readdir(output)).length, 0, 'Never replace an existing capture.');
    const previous = await json('artifacts/review-20261008/guest-preview-lifecycle-20261008/deployment/installed-guards.json');
    const packed = ssh(`import{readFile,readdir}from'node:fs/promises';import{createHash}from'node:crypto';import{gzipSync}from'node:zlib';
const root='/home/ubuntu/benchpoll',paths=new Set(${JSON.stringify(previous.hashes.map(file => file.path))});
for(const path of await readdir(root)){if(/\\.js$/.test(path))paths.add(path);}
async function collect(dir){for(const e of await readdir(root+'/'+dir,{withFileTypes:true})){const path=dir+'/'+e.name;if(e.isDirectory())await collect(path);else if(/\\.(js|css|html)$/.test(path))paths.add(path);}}
for(const dir of ['public/js','public/css','private'])await collect(dir);
for(const path of ['package.json','scripts/migrate-write-requests.mjs',...${JSON.stringify(targets)}])paths.add(path);
const files=[];for(const path of [...paths].sort()){let bytes;try{bytes=await readFile(root+'/'+path);}catch(e){if(e.code!=='ENOENT')throw e;}
files.push({path,hash:bytes?createHash('sha256').update(bytes).digest('hex'):null,...(bytes?{data:bytes.toString('base64')}:{})});}
const source=await readFile(root+'/server.js','utf8'),registrations=[...source.matchAll(/API\\.post\\('(\\/[^']+)',[^\\n]*\\brequireAccountWriteOwner\\b/g)].map(match=>match[1]);console.log(gzipSync(JSON.stringify({files,registrations})).toString('base64'));`);
    const captured = JSON.parse(gunzipSync(Buffer.from(packed.trim(), 'base64')).toString('utf8'));
    assert.equal(captured.registrations.length, 26);
    for (const file of captured.files.filter(file => file.data)) for (const directory of [before, stage]) {
        const path = join(directory, file.path); await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.from(file.data, 'base64'), { flag: 'wx' });
    }
    const localHashes = {};
    for (const path of targets) {
        const current = await readFile(path, 'utf8'); localHashes[path] = sha(current);
        const original = captured.files.find(file => file.path === path);
        if (path === 'public/js/workspace/pie-save.js') {
            assert.equal(original.hash, null, 'An independently added module must not be replaced.');
            await writeFile(join(stage, path), current, { flag: 'wx' }); continue;
        }
        if (path.endsWith('.css')) {
            const installed = await readFile(join(before, path), 'utf8');
            const start = current.indexOf('.bp-error-state.bp-pie-save-error {'), end = current.indexOf('.bp-error-state button', start);
            assert.ok(start >= 0 && end > start); const block = normal(current.slice(start, end));
            assert.equal(installed.includes('.bp-pie-save-error'), false);
            assert.equal(installed.split('.bp-error-state button').length, 2);
            const insertion = installed.includes('\r\n') ? block.replaceAll('\n', '\r\n') : block;
            await writeFile(join(stage, path), installed.replace('.bp-error-state button', insertion + '.bp-error-state button')); continue;
        }
        const old = resolve('artifacts/review-20261008/personal-pie-commit-20261008/before', path);
        let diff;
        try { diff = execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--', old, resolve(path)], { encoding: 'utf8', windowsHide: true }); }
        catch (error) { if (error.status !== 1) throw error; diff = String(error.stdout); }
        const hunks = diff.slice(diff.indexOf('@@ ')); assert.ok(hunks.startsWith('@@ '));
        const patch = `diff --git a/${path} b/${path}\n--- a/${path}\n+++ b/${path}\n${hunks}`;
        await writeFile(join(output, path.replaceAll('/', '-') + '.patch'), patch, { flag: 'wx' });
        const relativeStage = stage.slice(process.cwd().length + 1).replaceAll('\\', '/');
        assert.ok(relativeStage.startsWith('artifacts/review-20261008/'));
        const settings = { input: patch, cwd: process.cwd(), encoding: 'utf8', windowsHide: true };
        execFileSync('git', ['apply', '--directory=' + relativeStage, '--check', '--ignore-space-change', '--whitespace=nowarn', '-'], settings);
        execFileSync('git', ['apply', '--directory=' + relativeStage, '--ignore-space-change', '--whitespace=nowarn', '-'], settings);
        assert.notEqual(await hash(join(stage, path)), original.hash, 'The staged patch must actually change its target.');
    }
    for (const path of ['ops/review-personal-pie-save.mjs', 'scripts/personal-pie-save-fixture.mjs']) {
        await mkdir(dirname(join(stage, path)), { recursive: true });
        await writeFile(join(stage, path), await readFile(path), { flag: 'wx' });
    }
    await writeFile(join(output, 'baseline.json'), JSON.stringify({ capturedAt: new Date().toISOString(),
        hashes: captured.files.map(({ path, hash }) => ({ path, hash })), registrations: captured.registrations, localHashes }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ captured: true, targets, stage, protectedFiles: captured.files.length - targets.length }));
} else if (process.argv.includes('--restage')) {
    const baseline = await json(join(output, 'baseline.json'));
    for (const path of targets.filter(path => path.endsWith('.js') && path !== 'public/js/workspace/pie-save.js')) {
        assert.equal(await hash(path), baseline.localHashes[path]);
        assert.equal(await hash(join(stage, path)), baseline.hashes.find(file => file.path === path).hash);
        const patch = await readFile(join(output, path.replaceAll('/', '-') + '.patch'), 'utf8');
        const relativeStage = stage.slice(process.cwd().length + 1).replaceAll('\\', '/');
        assert.ok(relativeStage.startsWith('artifacts/review-20261008/'));
        const settings = { input: patch, cwd: process.cwd(), encoding: 'utf8', windowsHide: true };
        execFileSync('git', ['apply', '--directory=' + relativeStage, '--check', '--ignore-space-change', '--whitespace=nowarn', '-'], settings);
        execFileSync('git', ['apply', '--directory=' + relativeStage, '--ignore-space-change', '--whitespace=nowarn', '-'], settings);
        assert.notEqual(await hash(join(stage, path)), baseline.hashes.find(file => file.path === path).hash);
    }
    console.log(JSON.stringify({ stagedPatchApplied: true, applicationChanges: false }));
} else if (process.argv.includes('--update-ranking-capture')) {
    const baseline = await json(join(output, 'baseline.json'));
    for (const path of targets.filter(path => path !== 'ranking-service.js')) assert.equal(await hash(path), baseline.localHashes[path]);
    assert.equal(normal(await readFile(join(stage, 'ranking-service.js'), 'utf8')), normal(await readFile('ranking-service.js', 'utf8')));
    baseline.localHashes['ranking-service.js'] = await hash('ranking-service.js');
    await writeFile(join(output, 'baseline.json'), JSON.stringify(baseline, null, 2));
    console.log(JSON.stringify({ capturedOwnedRankingRepair: true, applicationChanges: false }));
} else if (process.argv.includes('--mysql')) {
    const remote = `/tmp/benchpoll-pie-review-${Date.now()}`, archive = join(output, 'mysql-stage.tar');
    execFileSync('tar.exe', ['-cf', archive, '-C', stage, '.']);
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, archive, `${host}:${remote}.tar`], { windowsHide: true });
    let receipt;
    try { receipt = JSON.parse(ssh(`import{mkdir,symlink}from'node:fs/promises';import{execFileSync}from'node:child_process';
await mkdir('${remote}');execFileSync('tar',['-xf','${remote}.tar','-C','${remote}']);await symlink('/home/ubuntu/benchpoll/node_modules','${remote}/node_modules');
execFileSync('sudo',['-n','env','BENCHPOLL_DB_USER=root','BENCHPOLL_DB_SOCKET=/var/run/mysqld/mysqld.sock','BENCHPOLL_DB_PASSWORD=','DB_PASSWORD=','node','${remote}/ops/review-personal-pie-save.mjs','--stage=${remote}'],{stdio:'inherit'});`, 180000)); }
    catch (error) {
        await writeFile(join(output, `mysql-failure-${Date.now()}.txt`), String(error.stderr ?? error.message), { flag: 'wx' });
        throw error;
    }
    await writeFile(join(output, 'mysql.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ passed: receipt.passed, total: receipt.total, databaseRemoved: receipt.disposableSchemaCreatedAndRemoved }));
} else if (process.argv.includes('--prepare')) {
    const proof = await proofs(), baseline = await json(join(output, 'baseline.json'));
    const files = [];
    await guardLocalRepair(baseline);
    for (const path of targets) {
        if (path.endsWith('.js')) execFileSync(process.execPath, ['--check', join(stage, path)]);
        files.push({ path, before: baseline.hashes.find(file => file.path === path).hash, after: await hash(join(stage, path)) });
    }
    const manifest = { release: `launch-20261008-${Date.now()}`, files,
        protectedFiles: baseline.hashes.filter(file => !targets.includes(file.path)), protectedRegistrations: baseline.registrations };
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ proof, schemaMigration: false, productionBusinessDataWritten: false,
        scope: 'Reviewed save-protocol hunks transplanted onto the current installed files, preserving unrelated logic and UI.' }, null, 2), { flag: 'wx' });
    execFileSync('tar.exe', ['-cf', join(output, manifest.release + '.tar'), '-C', stage, ...targets,
        '-C', process.cwd(), 'ops/launch-release.mjs', '-C', output, 'manifest.json']);
    console.log(JSON.stringify({ prepared: true, release: manifest.release, files: files.length }));
} else if (process.argv.includes('--apply')) {
    const proof = await proofs(), preflight = await json(join(output, 'preflight.json'));
    assert.deepEqual(proof, preflight.proof);
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
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';const stage='/tmp/${manifest.release}';
await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000));
    assert.equal(receipt.healthy, true); assert.equal(receipt.files, targets.length);
    await writeFile(join(output, 'receipt.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    await guard([...manifest.files.map(file => ({ path: file.path, hash: file.after })), ...manifest.protectedFiles]);
    const installed = { hashes: [...manifest.files.map(file => ({ path: file.path, hash: file.after })), ...manifest.protectedFiles],
        protectedRegistrations: manifest.protectedRegistrations, servicesActive: true, receipt };
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify(installed, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else throw Error('Use --capture, --mysql, --prepare or --apply. An uncertain apply must be inspected, never repeated.');
