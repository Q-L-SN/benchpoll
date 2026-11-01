import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const output = resolve('artifacts/review-20261008/paging-progress-deployment');
const names = ['ranking-pagination.js', 'server.js', 'public/js/home-workspace.js',
    'public/js/workspace/contracts.js', 'public/js/workspace/benchmark-fallback-catalogue.js',
    'public/js/contribution/score-fields.js', 'public/js/shared/ranking-resume.js',
    'public/js/workspace/ranking-notice.js'];
const proofSources = ['test/ranking-resume.test.mjs', 'test/review-snapshot-capacity-20261008.test.mjs',
    'scripts/review-snapshot-capacity-20261008.mjs', 'test/review-score-field-refresh-20261008.test.mjs',
    'scripts/frontend/review-score-field-refresh-20261008.mjs', 'scripts/frontend/fixtures.mjs',
    'scripts/frontend/navigation.mjs', 'scripts/frontend/verify.mjs', 'scripts/deploy-paging-review-20261008.mjs',
    'scripts/frontend/review-paging-progress-20261008.mjs', 'test/ranking-recovery-races.test.mjs',
    'test/ranking-notice-visibility.test.mjs', 'scripts/capture-ranking-notice-baseline-20261008.mjs', 'package.json'];
const protectedPaths = ['db.js', 'db-deadlines.js', 'db-transaction.js', 'ranking-service.js',
    'model-comparison.js', 'navigation-service.js', 'benchmark-family-service.js', 'score-field-service.js',
    'score-sync-service.js', 'arena-sync.js', 'moderation-admin.js', 'moderation-email.js', 'write-idempotency.js',
    'private/home.html', 'private/how-it-works.html', 'public/js/home.js', 'public/js/discussion.js',
    'public/js/shared/workspace-channel.js', 'public/js/shared/account-identity.js', 'public/js/shared/write-intent.js',
    'public/js/shared/http.js', 'public/js/workspace/comparison-profiles.js',
    'public/js/navigation/sidebar.js', 'public/js/workspace/comparison-profile-menu.js'];
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const options = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const registrationPattern = /API\.post\('(\/[^']+)',[^\n]*\brequireAccountWriteOwner\b/;
const arg = key => process.argv.find(value => value.startsWith(`--${key}=`))?.slice(key.length + 3);
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const ssh = (source, timeout = 90000) => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host,
    'node --input-type=module'], { input: source, encoding: 'utf8', timeout, windowsHide: true });
async function unitInputs(directory = 'test') {
    const paths = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) paths.push(...await unitInputs(path));
        else if (/\.test\.m?js$/.test(entry.name)) paths.push(path);
    }
    return paths.sort();
}
async function fingerprint() {
    const hashes = {};
    for (const path of new Set([...names, ...proofSources, ...await unitInputs()])) hashes[path] = await sha(path);
    return hashes;
}
async function runCheck(label, args, path) {
    const result = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true,
        maxBuffer: 64 * 1024 * 1024, timeout: 1200000 });
    await writeFile(path, (result.stdout ?? '') + (result.stderr ?? ''), { flag: 'wx' });
    assert.equal(result.error, undefined, label);
    assert.equal(result.status, 0, `${label} failed; inspect ${path}`);
}
function requireUnitPass(text) {
    const total = Number(text.match(/^# tests (\d+)$/m)?.[1]);
    assert.ok(total >= 1000, 'Full current test tree must be exercised');
    assert.match(text, new RegExp(`^# pass ${total}$`, 'm'));
    for (const key of ['fail', 'skipped', 'cancelled']) assert.match(text, new RegExp(`^# ${key} 0$`, 'm'));
    return total;
}
async function gates() {
    const index = await json(join(output, 'verification-index.json'));
    assert.match(index.directory, /^verification-[a-z0-9-]+$/);
    const directory = join(output, index.directory);
    const verification = await json(join(directory, 'verification.json'));
    assert.deepEqual(verification.sourceHashes, await fingerprint(), 'Sources changed after regression');
    assert.deepEqual(await json(join(directory, 'unit-inputs.json')), await unitInputs(), 'Current test inventory changed');
    const total = requireUnitPass(await readFile(join(directory, 'unit-final.tap'), 'utf8'));
    const frontend = await json(join(directory, 'frontend-results.json'));
    assert.equal(frontend.length, 62); assert.ok(frontend.every(result => result.passed));
    return { unitTests: total, frontendChecks: frontend.length, sourceHashesVerified: true,
        verificationDirectory: directory };
}
await mkdir(output, { recursive: true });
if (process.argv.includes('--tests')) {
    const run = arg('run'); assert.match(run ?? '', /^[a-z0-9-]+$/);
    const directory = join(output, `verification-${run}`); await mkdir(directory);
    const before = await fingerprint();
    const inputs = await unitInputs();
    assert.ok(inputs.includes('test/ranking-resume.test.mjs') && inputs.includes('test/review-score-field-refresh-20261008.test.mjs'));
    assert.ok(inputs.includes('test/ranking-recovery-races.test.mjs') && inputs.includes('test/ranking-notice-visibility.test.mjs'));
    await writeFile(join(directory, 'unit-inputs.json'), JSON.stringify(inputs, null, 2), { flag: 'wx' });
    await runCheck('Full current unit test tree', ['--test', ...inputs], join(directory, 'unit-final.tap'));
    const unitTests = requireUnitPass(await readFile(join(directory, 'unit-final.tap'), 'utf8'));
    await runCheck('Scoped lint', ['node_modules/eslint/bin/eslint.js',
        ...new Set([...names, ...proofSources].filter(path => /\.m?js$/.test(path)))], join(directory, 'lint-final.txt'));
    await runCheck('Full frontend suite', ['scripts/frontend/verify.mjs'], join(directory, 'frontend-final.txt'));
    const frontend = await json('artifacts/frontend/results.json');
    assert.equal(frontend.length, 62); assert.ok(frontend.every(result => result.passed));
    await writeFile(join(directory, 'frontend-results.json'), JSON.stringify(frontend, null, 2), { flag: 'wx' });
    assert.deepEqual(await fingerprint(), before, 'Sources changed during regression; retain this run and repeat');
    await writeFile(join(directory, 'verification.json'), JSON.stringify({ sourceHashes: before,
        unitTests, frontendChecks: frontend.length, completedAt: new Date().toISOString() }, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'verification-index.json'), JSON.stringify({ directory: `verification-${run}` }, null, 2));
    console.log(JSON.stringify({ fullRegression: 'pass', unitTests, frontendChecks: frontend.length, sourceHashesStable: true }));
} else if (process.argv.includes('--prepare')) {
    const verification = await gates();
    const signoff = await json(join(output, 'browser-signoff.json'));
    assert.equal(signoff.approved, true); assert.equal(signoff.productionWrites, false);
    assert.ok(signoff.reports.length >= 2);
    for (const proof of signoff.reports) assert.equal(await sha(proof.path), proof.hash);
    for (const path of names) assert.equal(signoff.sourceHashes[path], await sha(path));
    const baseline = await json(join(output, 'production-before.json'));
    const noticeBaseline = await json(join(output, 'production-notice-before.json'));
    const baselineFiles = [...baseline.hashes, ...noticeBaseline.hashes];
    assert.deepEqual(baselineFiles.map(file => file.path), names);
    const files = [], diffs = [];
    for (const file of baselineFiles) {
        if (file.hash !== null) {
            const old = join(file.path === 'public/js/workspace/ranking-notice.js'
                ? noticeBaseline.baseline : baseline.baseline, file.path);
            assert.equal(await sha(old), file.hash);
            try { diffs.push(execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--no-ext-diff', '--',
                old, resolve(file.path)], { encoding: 'utf8', windowsHide: true })); }
            catch (error) { if (error.status !== 1) throw error; diffs.push(String(error.stdout)); }
        } else {
            assert.equal(file.path, 'public/js/shared/ranking-resume.js');
            diffs.push(`NEW ${file.path}\n${await readFile(file.path, 'utf8')}`);
        }
        const after = await sha(file.path); assert.notEqual(after, file.hash);
        execFileSync(process.execPath, ['--check', file.path]);
        files.push({ path: file.path, before: file.hash, after });
    }
    const protectedState = JSON.parse(ssh(`import {readFile} from 'node:fs/promises'; import {createHash} from 'node:crypto';
const files=[]; for(const path of ${JSON.stringify(protectedPaths)}) files.push({path,hash:createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+path)).digest('hex')});
const source=await readFile('/home/ubuntu/benchpoll/server.js','utf8');
const registrations=[...source.matchAll(new RegExp(${JSON.stringify(registrationPattern.source)},'g'))].map(match=>match[1]);
console.log(JSON.stringify({files,registrations}));`));
    const registrations = [...(await readFile('server.js', 'utf8')).matchAll(new RegExp(registrationPattern.source, 'g'))].map(match => match[1]);
    assert.equal(registrations.length, 26); assert.deepEqual(protectedState.registrations, registrations);
    assert.equal(protectedState.files.length, protectedPaths.length);
    const release = `launch-20261008-${Date.now()}`;
    const manifest = { release, files, protectedFiles: protectedState.files, protectedRegistrations: registrations };
    await writeFile(join(output, 'installed-baseline.diff'), diffs.join('\n'), { flag: 'wx' });
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ ...verification, release,
        protectedFiles: protectedState.files.length, protectedRegistrations: registrations.length,
        originalBaselinePreserved: true, databaseChanged: false, browserSignoff: signoff }, null, 2), { flag: 'wx' });
    const archive = join(output, `${release}.tar`);
    execFileSync('tar.exe', ['-cf', archive, '-C', process.cwd(), ...names, 'ops/launch-release.mjs',
        'ops/review-installed-startup-20261008.mjs', '-C', output, 'manifest.json']);
    console.log(JSON.stringify({ release, archive, prepared: true, files: files.length, verification }));
} else if (process.argv.includes('--apply')) {
    await gates();
    const manifest = await json(join(output, 'manifest.json'));
    assert.match(manifest.release, /^launch-20261008-\d+$/); assert.deepEqual(manifest.files.map(file => file.path), names);
    for (const file of manifest.files) assert.equal(await sha(file.path), file.after);
    execFileSync('C:/WINDOWS/System32/OpenSSH/scp.exe', [...options, join(output, `${manifest.release}.tar`),
        `${host}:/tmp/${manifest.release}.tar`], { stdio: 'inherit', windowsHide: true });
    const receipt = JSON.parse(ssh(`import {mkdir} from 'node:fs/promises'; import {execFileSync} from 'node:child_process';
const stage='/tmp/${manifest.release}'; await mkdir(stage); execFileSync('tar',['-xf',stage+'.tar','-C',stage]);
process.chdir(stage); execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000));
    assert.equal(receipt.release, manifest.release); assert.equal(receipt.healthy, true); assert.equal(receipt.files, names.length);
    await writeFile(join(output, 'deployment-result.json'), JSON.stringify(receipt, null, 2), { flag: 'wx' });
    const guards = JSON.parse(ssh(`import {execFileSync} from 'node:child_process';
execFileSync('node',['/tmp/${manifest.release}/ops/review-installed-startup-20261008.mjs','--manifest=/tmp/${manifest.release}/manifest.json'],{stdio:'inherit'});`));
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify(guards, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(receipt));
} else if (process.argv.includes('--assets')) {
    const manifest = await json(join(output, 'manifest.json'));
    const versions = { 'public/js/home-workspace.js': ['?v=review-pagination-20261008'],
        'public/js/workspace/contracts.js': ['?v=review-evidence-20261008', '?v=fallback-discovery-20261005'],
        'public/js/workspace/benchmark-fallback-catalogue.js': ['?v=fallback-discovery-20261005'],
        'public/js/contribution/score-fields.js': ['?v=write-replay-20261008'],
        'public/js/workspace/ranking-notice.js': ['?v=percentile-ranking-20261007'] };
    const results = [];
    for (const file of manifest.files.filter(file => file.path.startsWith('public/js/'))) {
        for (const query of versions[file.path] ?? ['']) {
            const url = 'https://benchpoll.com' + file.path.replace(/^public/, '') + query;
            const start = performance.now();
            const bytes = execFileSync('curl.exe', ['--fail', '--silent', '--show-error', '--max-time', '45', url],
                { maxBuffer: 4 * 1024 * 1024, timeout: 50000, windowsHide: true });
            const hash = createHash('sha256').update(bytes).digest('hex');
            results.push({ path: file.path, url, expected: file.after, hash, matches: hash === file.after,
                elapsedMs: Math.round(performance.now() - start) });
        }
    }
    await writeFile(join(output, 'public-assets.json'), JSON.stringify({ release: manifest.release, results,
        databaseAccess: false, writes: false }, null, 2), { flag: 'wx' });
    assert.equal(results.length, 7); assert.ok(results.every(item => item.matches));
    console.log(JSON.stringify({ release: manifest.release, publicAssetHashes: results.length, matched: true }));
} else throw new Error('Use --tests --run=name, --prepare, --apply or --assets');
