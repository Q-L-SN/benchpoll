import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const root = 'artifacts/review-20261008';
const output = resolve(`${root}/profile-read-deployment`);
const testRun = process.argv.find(value => value.startsWith('--test-run='))?.slice(11);
if (testRun !== undefined) assert.match(testRun, /^[a-z0-9-]+$/);
const testOutput = testRun ? join(output, `verification-${testRun}`) : output;
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const options = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const registrationPattern = /API\.post\('(\/[^']+)',[^\n]*\brequireAccountWriteOwner\b/;
const ssh = (source, timeout = 90000) => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host,
    'node --input-type=module'], { input: source, encoding: 'utf8', timeout });
const names = ['public/js/shared/http.js', 'public/js/workspace/comparison-profiles.js',
    'public/js/home-workspace.js', 'ranking-pagination.js', 'public/js/navigation/sidebar.js',
    'public/js/workspace/comparison-profile-menu.js'];
const protectedPaths = ['server.js', 'db.js', 'db-deadlines.js', 'db-transaction.js', 'ranking-service.js',
    'model-comparison.js', 'navigation-service.js', 'benchmark-family-service.js', 'score-field-service.js',
    'score-sync-service.js', 'arena-sync.js', 'moderation-admin.js', 'moderation-email.js', 'write-idempotency.js',
    'private/home.html', 'private/how-it-works.html', 'public/js/home.js', 'public/js/discussion.js',
    'public/js/shared/workspace-channel.js', 'public/js/shared/account-identity.js', 'public/js/shared/write-intent.js'];
const proofSources = ['test/profile-read-deadline.test.mjs', 'scripts/frontend/review-profile-read-20261008.mjs',
    'scripts/review-coordination-20261008.mjs', 'test/review-coordination-20261008.test.mjs',
    'scripts/review-snapshot-capacity-20261008.mjs', 'test/review-snapshot-capacity-20261008.test.mjs',
    'scripts/frontend/navigation.mjs'];
const fingerprint = async () => Object.fromEntries(await Promise.all([...names, ...proofSources]
    .map(async path => [path, await sha(path)])));

async function runCheck(label, args, reportPath) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
    await writeFile(reportPath, (result.stdout ?? '') + (result.stderr ?? ''), { flag: 'wx' });
    assert.equal(result.error, undefined, label);
    assert.equal(result.status, 0, `${label} failed; inspect ${reportPath}`);
}

async function gates() {
    const index = await json(join(output, 'verification-index.json'));
    assert.match(index.directory, /^verification-[a-z0-9-]+$/);
    const evidence = join(output, index.directory);
    const verification = await json(join(evidence, 'verification.json'));
    assert.deepEqual(verification.sourceHashes, await fingerprint(), 'Sources changed after the full regression run');
    const unit = await readFile(join(evidence, 'unit-final.tap'), 'utf8');
    const tests = Number(unit.match(/^# tests (\d+)$/m)?.[1]);
    assert.ok(tests >= 1395);
    assert.match(unit, new RegExp(`^# pass ${tests}$`, 'm'));
    for (const field of ['fail', 'skipped', 'cancelled']) assert.match(unit, new RegExp(`^# ${field} 0$`, 'm'));
    const frontend = await json(join(evidence, 'frontend-results.json'));
    assert.equal(frontend.length, 62); assert.ok(frontend.every(result => result.passed));
    const profile = await json(`${root}/profile-read-after-final/results.json`);
    assert.equal(profile.after, true); assert.equal(profile.results.length, 12);
    assert.ok(profile.results.every(result => result.passed && result.errors.length === 0));
    for (const source of profile.sources) assert.equal(source.sha256, await sha(source.path));
    const coordination = await json(join(output, 'coordination-proof.json'));
    assert.equal(coordination.reports.length, 2);
    for (const path of coordination.reports) {
        const report = await json(path);
        assert.equal(report.expectFixed, true);
        assert.equal(report.protectedEvidenceUnchanged, true);
        assert.deepEqual(report.changedSources, []);
        assert.equal(report.browserMatrix.length, 4);
        assert.ok(report.browserMatrix.every(result => result.status === 'passed'
            && result.remainingSameTarget.profileEditor.bug === false && result.remainingSameTarget.privateForm.bug === false));
        for (const name of names.filter(name => Object.hasOwn(report.after, name))) {
            assert.equal(report.after[name].sha256, await sha(name));
        }
    }
    const snapshots = await json(join(output, 'snapshot-proof.json'));
    assert.equal(snapshots.reports.length, 2);
    for (const path of snapshots.reports) {
        const report = await json(path);
        assert.equal(report.expectFixed, true); assert.equal(report.sourcesUnchanged, true);
        assert.equal(report.expectations.passed, true); assert.equal(report.preservation.preserved, true);
        assert.equal(report.tests.exitCode, 0); assert.equal(report.lint.exitCode, 0);
        const captures = await json(report.files.find(file => file.endsWith('-sources.json')));
        assert.equal(captures.files.find(file => file.file === 'ranking-pagination.js').sha256, await sha('ranking-pagination.js'));
    }
    return { unitTests: tests, frontendChecks: frontend.length, profileRecoveryCases: profile.results.length,
        coordinationMatrices: 2, coordinationCases: 8, snapshotRepetitions: 2, sourceHashesVerified: true };
}

await mkdir(output, { recursive: true });
if (process.argv.includes('--tests')) {
    if (testRun) await mkdir(testOutput);
    const before = await fingerprint();
    await runCheck('Full unit suite', ['--test'], join(testOutput, 'unit-final.tap'));
    await runCheck('Scoped lint', ['node_modules/eslint/bin/eslint.js', ...names, ...proofSources,
        'scripts/deploy-profile-review-20261008.mjs', 'scripts/capture-coordination-baseline-20261008.mjs'], join(testOutput, 'lint-final.txt'));
    await runCheck('Full frontend suite', ['scripts/frontend/verify.mjs'], join(testOutput, 'frontend-final.txt'));
    const frontend = await json('artifacts/frontend/results.json');
    assert.equal(frontend.length, 62); assert.ok(frontend.every(result => result.passed));
    await writeFile(join(testOutput, 'frontend-results.json'), JSON.stringify(frontend, null, 2), { flag: 'wx' });
    assert.deepEqual(await fingerprint(), before, 'Sources changed during regression; preserve this run and repeat separately');
    await writeFile(join(testOutput, 'verification.json'), JSON.stringify({ sourceHashes: before, completedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
    if (testRun) await writeFile(join(output, 'verification-index.json'), JSON.stringify({ directory: `verification-${testRun}` }, null, 2));
    console.log(JSON.stringify({ fullRegression: 'pass', frontendChecks: frontend.length, sourceHashesStable: true }));
} else if (process.argv.includes('--prepare')) {
    const verification = await gates();
    const baseline = await json(join(output, 'production-before.json'));
    const extra = await json(join(output, 'coordination-production-before.json'));
    assert.equal(baseline.baseline, extra.baseline);
    const records = [...baseline.hashes, ...extra.hashes];
    assert.deepEqual(records.map(file => file.path), names);
    const files = [], diffs = [];
    for (const file of records) {
        const old = join(baseline.baseline, file.path);
        assert.equal(await sha(old), file.hash);
        const after = await sha(file.path);
        assert.notEqual(after, file.hash);
        execFileSync(process.execPath, ['--check', file.path]);
        files.push({ path: file.path, before: file.hash, after });
        try { diffs.push(execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--no-ext-diff', '--', old, resolve(file.path)], { encoding: 'utf8' })); }
        catch (error) { if (error.status !== 1) throw error; diffs.push(String(error.stdout)); }
    }
    const protectedState = JSON.parse(ssh(`import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const paths=${JSON.stringify(protectedPaths)}; const files=[];
for(const path of paths) files.push({path,hash:createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+path)).digest('hex')});
const source=await readFile('/home/ubuntu/benchpoll/server.js','utf8');
const registrations=[...source.matchAll(new RegExp(${JSON.stringify(registrationPattern.source)},'g'))].map(match=>match[1]);
console.log(JSON.stringify({files,registrations}));`));
    assert.equal(protectedState.files.length, protectedPaths.length);
    const expected = [...(await readFile('server.js', 'utf8')).matchAll(new RegExp(registrationPattern.source, 'g'))].map(match => match[1]);
    assert.equal(expected.length, 26); assert.deepEqual(protectedState.registrations, expected);
    const release = `launch-20261008-${Date.now()}`;
    const manifest = { release, files, protectedFiles: protectedState.files, protectedRegistrations: protectedState.registrations };
    await writeFile(join(output, 'installed-baseline.diff'), diffs.join('\n'), { flag: 'wx' });
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ ...verification, release,
        protectedFiles: protectedState.files.length, protectedRegistrations: expected.length,
        originalBaselinePreserved: true, databaseChanged: false }, null, 2), { flag: 'wx' });
    const archive = join(output, `${release}.tar`);
    execFileSync('tar.exe', ['-cf', archive, '-C', process.cwd(), ...names, 'ops/launch-release.mjs',
        'ops/review-installed-startup-20261008.mjs', '-C', output, 'manifest.json']);
    console.log(JSON.stringify({ release, archive, prepared: true, files: files.length, verification }));
} else if (process.argv.includes('--apply')) {
    await gates();
    const manifest = await json(join(output, 'manifest.json'));
    assert.match(manifest.release, /^launch-20261008-\d+$/);
    assert.deepEqual(manifest.files.map(file => file.path), names);
    for (const file of manifest.files) assert.equal(await sha(file.path), file.after);
    const archive = join(output, `${manifest.release}.tar`);
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, archive, `${host}:/tmp/${manifest.release}.tar`], { stdio: 'inherit' });
    const receipt = JSON.parse(ssh(`import {mkdir} from 'node:fs/promises'; import {execFileSync} from 'node:child_process';
const stage='/tmp/${manifest.release}'; await mkdir(stage); execFileSync('tar',['-xf',stage+'.tar','-C',stage]);
process.chdir(stage); execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000));
    assert.equal(receipt.release, manifest.release); assert.equal(receipt.healthy, true); assert.equal(receipt.files, names.length);
    await writeFile(join(output, 'deployment-result.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const guards = JSON.parse(ssh(`import {execFileSync} from 'node:child_process';
execFileSync('node',['/tmp/${manifest.release}/ops/review-installed-startup-20261008.mjs','--manifest=/tmp/${manifest.release}/manifest.json'],{stdio:'inherit'});`));
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify(guards, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --tests, --prepare or --apply');
