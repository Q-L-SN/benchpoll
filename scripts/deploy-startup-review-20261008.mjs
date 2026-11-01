import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, join } from 'node:path';

const output = resolve('artifacts/review-20261008/startup-deployment');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
const sha = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const key = 'C:/Users/18665/Documents/Codex/2026-09-13/ba/work/keys/lightsail-us-east-2.pem';
const options = ['-i', key, '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=20'];
const host = 'ubuntu@18.226.222.18';
const registrationPattern = /API\.post\('(\/[^']+)',[^\n]*\brequireAccountWriteOwner\b/;
const ssh = (source, timeout = 90000) => execFileSync('C:/WINDOWS/System32/OpenSSH/ssh.exe', [...options, host,
    'node --input-type=module'], { input: source, encoding: 'utf8', timeout });
const names = ['ranking-service.js', 'ranking-pagination.js', 'private/home.html'];
const protectedPaths = ['server.js', 'db.js', 'db-deadlines.js', 'db-transaction.js', 'model-comparison.js',
    'navigation-service.js', 'benchmark-family-service.js', 'score-field-service.js', 'score-sync-service.js',
    'arena-sync.js', 'moderation-admin.js', 'moderation-email.js', 'write-idempotency.js', 'private/how-it-works.html',
    'public/js/home-workspace.js', 'public/js/home.js', 'public/js/discussion.js', 'public/js/shared/workspace-channel.js',
    'public/js/shared/account-identity.js', 'public/js/shared/write-intent.js'];

async function gates() {
    const unitPath = 'artifacts/review-20261008/startup-unit-final.tap';
    const unit = await readFile(unitPath, 'utf8'), tests = Number(unit.match(/# tests (\d+)/)?.[1]);
    assert.equal(tests, 1372); assert.match(unit, /# pass 1372/); assert.match(unit, /# fail 0/);
    assert.match(unit, /# skipped 0/); assert.match(unit, /# cancelled 0/);
    const frontend = await json('artifacts/frontend/results.json');
    assert.equal(frontend.length, 62); assert.ok(frontend.every(result => result.passed));
    const discovery = await json('artifacts/review-20261008/startup-discovery-direct/results.json');
    assert.equal(discovery.results.length, 16); assert.ok(discovery.results.every(result => result.passed));
    for (const result of discovery.results.filter(result => result.variant === 'after')) {
        assert.equal(result.htmlHash, await sha('private/home.html'));
        assert.equal(result.moduleRequests, 69); assert.equal(result.workspaceRequests, 1);
    }
    const applied = await json('artifacts/review-20261008/startup-server-applied-results.json');
    assert.equal(applied.result, 'pass'); assert.equal(applied.repetitions, 2);
    for (const source of applied.sources) assert.equal(source.currentSHA256, await sha(source.file));
    return { unitTests: tests, frontendChecks: frontend.length, discoveryScenarios: discovery.results.length,
        exactWorkspaceCases: 10, exactWorkspaceRepetitions: applied.repetitions, sourceHashesVerified: true };
}

await mkdir(output, { recursive: true });
if (process.argv.includes('--prepare')) {
    const verification = await gates();
    const baseline = await json(join(output, 'production-before.json'));
    assert.deepEqual(baseline.hashes.map(file => file.path), names);
    const files = [], diffs = [];
    for (const file of baseline.hashes) {
        const old = join(baseline.baseline, file.path);
        assert.equal(await sha(old), file.hash);
        const after = await sha(file.path);
        assert.notEqual(after, file.hash);
        if (file.path.endsWith('.js')) execFileSync(process.execPath, ['--check', file.path]);
        files.push({ path: file.path, before: file.hash, after });
        try { diffs.push(execFileSync('git', ['diff', '--no-index', '--ignore-space-at-eol', '--no-ext-diff', '--', old, resolve(file.path)], { encoding: 'utf8' })); }
        catch (error) { if (error.status !== 1) throw error; diffs.push(String(error.stdout)); }
    }
    const protectedState = JSON.parse(ssh(`import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
const paths=${JSON.stringify(protectedPaths)};
const files=[];
for(const path of paths) files.push({path,hash:createHash('sha256').update(await readFile('/home/ubuntu/benchpoll/'+path)).digest('hex')});
const source=await readFile('/home/ubuntu/benchpoll/server.js','utf8');
const registrations=[...source.matchAll(new RegExp(${JSON.stringify(registrationPattern.source)},'g'))].map(match=>match[1]);
console.log(JSON.stringify({files,registrations}));`));
    assert.equal(protectedState.files.length, 20);
    const expectedRegistrations = [...(await readFile('server.js', 'utf8'))
        .matchAll(new RegExp(registrationPattern.source, 'g'))].map(match => match[1]);
    assert.ok(expectedRegistrations.length >= 15);
    assert.deepEqual(protectedState.registrations, expectedRegistrations);
    const release = `launch-20261008-${Date.now()}`;
    const manifest = { release, files, protectedFiles: protectedState.files, protectedRegistrations: protectedState.registrations };
    await writeFile(join(output, 'installed-baseline.diff'), diffs.join('\n'));
    await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(output, 'preflight.json'), JSON.stringify({ ...verification, release,
        protectedFiles: protectedState.files.length, protectedRegistrations: protectedState.registrations.length,
        originalBaselinePreserved: true, databaseChanged: false }, null, 2));
    await writeFile(join(output, 'frontend-results.json'), JSON.stringify(await json('artifacts/frontend/results.json'), null, 2));
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
    const deployment = ssh(`import {mkdir} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
const stage='/tmp/${manifest.release}';
await mkdir(stage); execFileSync('tar',['-xf',stage+'.tar','-C',stage]);
process.chdir(stage);
execFileSync('node',['ops/launch-release.mjs'],{stdio:'inherit'});`, 180000);
    const receipt = JSON.parse(deployment);
    assert.equal(receipt.release, manifest.release); assert.equal(receipt.healthy, true); assert.equal(receipt.files, 3);
    await writeFile(join(output, 'deployment-result.json'), JSON.stringify(receipt, null, 2));
    const guards = ssh(`import {execFileSync} from 'node:child_process';
execFileSync('node',['/tmp/${manifest.release}/ops/review-installed-startup-20261008.mjs','--manifest=/tmp/${manifest.release}/manifest.json'],{stdio:'inherit'});`);
    await writeFile(join(output, 'installed-guards.json'), JSON.stringify(JSON.parse(guards), null, 2));
    console.log(JSON.stringify(receipt));
} else throw new Error('Use --prepare or --apply');
