import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const output = resolve('artifacts/review-20261008/guest-restoration-deployment');
const target = 'public/js/home-workspace.js';
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const options = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const hash = data => createHash('sha256').update(data).digest('hex');
const sha = async path => hash(await readFile(path));
const arg = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const ssh = (source, timeout = 90000) => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host, 'node --input-type=module'],
    { input: source, encoding: 'utf8', timeout, windowsHide: true });
await mkdir(output, { recursive: true });
async function testInputs(directory = 'test') {
    const paths = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) paths.push(...await testInputs(path));
        else if (/\.test\.m?js$/.test(entry.name)) paths.push(path);
    }
    return paths.sort();
}
async function fingerprint() {
    const baseline = await json(join(output, 'production-before.json'));
    const paths = new Set([...baseline.hashes.map(file => file.path), ...await testInputs(), 'package.json',
        'scripts/deploy-guest-restoration-review-20261008.mjs', 'scripts/frontend/server.mjs', 'scripts/frontend/fixtures.mjs',
        'scripts/frontend/verify.mjs', 'scripts/frontend/review-guest-restoration-ui-20261008.mjs',
        'ops/launch-release.mjs', 'ops/review-installed-startup-20261008.mjs']);
    return Object.fromEntries(await Promise.all([...paths].sort().map(async path => [path, await sha(path)])));
}
async function run(label, args, path) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 1200000, maxBuffer: 64 * 1024 * 1024 });
    await writeFile(path, (result.stdout ?? '') + (result.stderr ?? ''), { flag: 'wx' });
    assert.equal(result.error, undefined, label);
    assert.equal(result.status, 0, `${label}: inspect ${path}`);
    return result.stdout ?? '';
}
async function gates() {
    const verification = await json(arg('verification'));
    assert.equal(verification.passed, true);
    assert.deepEqual(await fingerprint(), verification.hashes, 'Verification source drift');
    assert.equal(await sha(verification.unitReport), verification.unitReportHash);
    assert.equal(await sha(verification.frontendReport), verification.frontendReportHash);
    assert.equal(await sha(verification.lintReport), verification.lintReportHash);
    const browserPath = arg('browser-report');
    const browser = await json(browserPath);
    assert.equal(browser.completeMatrix, true);
    assert.equal(browser.results.length, 24);
    assert.ok(browser.results.every(result => result.passed));
    assert.equal(browser.homeSourceHash, await sha(target));
    assert.equal(browser.runnerSourceHash, await sha('scripts/frontend/review-guest-restoration-ui-20261008.mjs'));
    return { ...verification, browserReport: browserPath, browserReportHash: await sha(browserPath) };
}

if (process.argv.includes('--baseline')) {
    const previous = await json('artifacts/review-20261008/paging-progress-deployment/installed-resume-recheck.json');
    const paths = previous.hashes.map(file => file.path);
    const captured = JSON.parse(ssh(`import {readFile} from 'node:fs/promises';import {createHash} from 'node:crypto';
const files=[];for(const path of ${JSON.stringify(paths)}){const data=await readFile('/home/ubuntu/benchpoll/'+path);files.push({path,hash:createHash('sha256').update(data).digest('hex'),...(path===${JSON.stringify(target)}?{data:data.toString('base64')}:{})});}
const source=await readFile('/home/ubuntu/benchpoll/server.js','utf8');const registrations=[...source.matchAll(/API\\.post\\('([^']+)',[^\\n]*\\brequireAccountWriteOwner\\b/g)].map(match=>match[1]);console.log(JSON.stringify({files,registrations}));`));
    assert.equal(captured.files.length, previous.hashes.length);
    for (const file of captured.files) assert.equal(file.hash, previous.hashes.find(item => item.path === file.path).hash, `Production drift: ${file.path}`);
    const file = captured.files.find(file => file.path === target);
    assert.equal(await sha(target), file.hash, 'Capture before local repair');
    const baseline = join(output, 'before');
    await mkdir(dirname(join(baseline, target)), { recursive: true });
    await writeFile(join(baseline, target), Buffer.from(file.data, 'base64'), { flag: 'wx' });
    const registrations = [...(await readFile('server.js', 'utf8')).matchAll(/API\.post\('([^']+)',[^\n]*\brequireAccountWriteOwner\b/g)].map(match => match[1]);
    assert.equal(registrations.length, 26);
    assert.deepEqual(captured.registrations, registrations);
    await writeFile(join(output, 'production-before.json'), JSON.stringify({ previousRelease: previous.release,
        capturedAt: new Date().toISOString(), baseline, hashes: captured.files.map(({ path, hash }) => ({ path, hash })),
        protectedRegistrations: registrations, databaseAccess: false, databaseChanged: false }, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ captured: true, files: captured.files.length, baseline }));
} else if (process.argv.includes('--verify')) {
    const directory = join(output, `verification-${Date.now()}`);
    await mkdir(directory);
    const hashes = await fingerprint();
    const inputs = await testInputs();
    await writeFile(join(directory, 'unit-inputs.json'), JSON.stringify(inputs, null, 2), { flag: 'wx' });
    const unitReport = join(directory, 'unit.tap');
    const unit = await run('full current test tree', ['--test', ...inputs], unitReport);
    const count = Number(unit.match(/^# tests (\d+)$/m)?.[1]);
    assert.ok(count >= 1228);
    assert.match(unit, new RegExp(`^# pass ${count}$`, 'm'));
    for (const result of ['fail', 'cancelled', 'skipped']) assert.match(unit, new RegExp(`^# ${result} 0$`, 'm'));
    const frontendReport = join(directory, 'frontend.txt');
    await run('frontend suite', ['scripts/frontend/verify.mjs'], frontendReport);
    const lintReport = join(directory, 'lint.txt');
    await run('scoped lint', ['node_modules/eslint/bin/eslint.js', target, 'test/guest-workspace-restoration.test.mjs',
        'scripts/deploy-guest-restoration-review-20261008.mjs', 'scripts/frontend/review-guest-restoration-ui-20261008.mjs'], lintReport);
    assert.deepEqual(await fingerprint(), hashes);
    const report = { passed: true, hashes, unitTestsPassed: count, unitReport, unitReportHash: await sha(unitReport),
        frontendReport, frontendReportHash: await sha(frontendReport), lintReport, lintReportHash: await sha(lintReport),
        scope: 'Current test tree, frontend fixtures and narrow source; no production writes.' };
    await writeFile(join(directory, 'verification.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify({ verification: join(directory, 'verification.json'), unitTestsPassed: count }));
} else if (process.argv.includes('--prepare')) {
    const verification = await gates();
    const baseline = await json(join(output, 'production-before.json'));
    const before = baseline.hashes.find(file => file.path === target).hash;
    assert.equal(await sha(join(baseline.baseline, target)), before);
    const after = await sha(target);
    assert.notEqual(before, after);
    execFileSync(process.execPath, ['--check', target]);
    let diff;
    try { diff = execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--no-ext-diff', '--', join(baseline.baseline, target), resolve(target)], { encoding: 'utf8', windowsHide: true }); }
    catch (error) { if (error.status !== 1) throw error; diff = String(error.stdout); }
    const release = `launch-20261008-${Date.now()}`;
    const manifest = { release, files: [{ path: target, before, after }],
        protectedFiles: baseline.hashes.filter(file => file.path !== target), protectedRegistrations: baseline.protectedRegistrations };
    await writeFile(join(output, 'installed-baseline.diff'), diff, { flag: 'wx' });
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ release, verification, databaseChanged: false }, null, 2), { flag: 'wx' });
    execFileSync('tar.exe', ['-cf', join(output, `${release}.tar`), '-C', process.cwd(), target,
        'ops/launch-release.mjs', 'ops/review-installed-startup-20261008.mjs', '-C', output, 'manifest.json']);
    console.log(JSON.stringify({ release, prepared: true, files: 1 }));
} else if (process.argv.includes('--apply')) {
    const verification = await gates();
    const preflight = await json(join(output, 'preflight.json'));
    assert.deepEqual(verification, preflight.verification);
    const manifest = await json(join(output, 'manifest.json'));
    assert.deepEqual(manifest.files.map(file => file.path), [target]);
    assert.equal(await sha(target), manifest.files[0].after);
    const expected = [...manifest.files.map(file => ({ path: file.path, hash: file.before })), ...manifest.protectedFiles];
    ssh(`import{readFile}from'node:fs/promises';import{createHash}from'node:crypto';
for(const file of ${JSON.stringify(expected)}){const actual=createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+file.path)).digest('hex');if(actual!==file.hash)throw Error('Production drift: '+file.path);}`);
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, join(output, `${manifest.release}.tar`), `${host}:/tmp/${manifest.release}.tar`], { stdio: 'inherit', windowsHide: true });
    const receipt = JSON.parse(ssh(`import{mkdir}from'node:fs/promises';import{execFileSync}from'node:child_process';const stage='/tmp/${manifest.release}';await mkdir(stage);execFileSync('tar',['-xf',stage+'.tar','-C',stage]);process.chdir(stage);execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000));
    assert.equal(receipt.release, manifest.release);
    assert.equal(receipt.healthy, true);
    assert.equal(receipt.files, 1);
    await writeFile(join(output, 'deployment-result.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const guards = JSON.parse(ssh(`import{execFileSync}from'node:child_process';execFileSync('node',['/tmp/${manifest.release}/ops/review-installed-startup-20261008.mjs','--manifest=/tmp/${manifest.release}/manifest.json'],{stdio:'inherit'});`));
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify(guards, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else if (process.argv.includes('--assets')) {
    const manifest = await json(join(output, 'manifest.json'));
    const url = 'https://benchpoll.com/js/home-workspace.js?v=review-pagination-20261008';
    const bytes = execFileSync('curl.exe', ['--fail', '--silent', '--show-error', '--max-time', '45', url], { maxBuffer: 4 * 1024 * 1024, timeout: 50000, windowsHide: true });
    const actual = hash(bytes);
    const report = { release: manifest.release, url, hash: actual, matches: actual === manifest.files[0].after, databaseAccess: false };
    await writeFile(join(output, 'public-assets.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    assert.equal(report.matches, true);
    console.log(JSON.stringify(report));
} else throw new Error('Use --baseline, --verify, --prepare, --apply or --assets');
