import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const deployment = resolve('artifacts/review-20261008/personal-pie-commit-20261008/deployment');
const stage = join(deployment, 'stage');
const integration = process.argv.includes('--integration');
const focused = process.argv.includes('--focused');
assert.equal(integration && focused, false);
const runtimeRoot = integration ? process.cwd() : stage;
const output = resolve(`artifacts/review-20261008/personal-pie-commit-20261008/immutable-${Date.now()}`);
const workspace = join(output, 'workspace');
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const json = async path => JSON.parse((await readFile(path, 'utf8')).replace(/^\uFEFF/, ''));
async function files(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await files(path));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}
await mkdir(workspace, { recursive: true });
const baseline = await json(join(deployment, 'baseline.json'));
// The capture omitted one zero-byte stylesheet; reconstruct only a verified empty file.
for (const file of baseline.hashes.filter(file => file.hash === sha(Buffer.alloc(0)))) {
    const path = join(stage, file.path);
    try { assert.equal(sha(await readFile(path)), file.hash); }
    catch (error) {
        if (error.code !== 'ENOENT') throw error;
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, Buffer.alloc(0), { flag: 'wx' });
    }
}
const stagedPaths = integration
    ? [...await files('public/js'), ...await files('public/css'), ...await files('private'),
        ...(await readdir('.')).filter(path => /\.js$/.test(path)), 'package.json',
        'scripts/migrate-write-requests.mjs', 'ops/review-personal-pie-save.mjs', 'scripts/personal-pie-save-fixture.mjs'].map(path => resolve(path))
    : await files(stage);
const copied = new Set(), runtime = {};
async function copy(path, relativePath) {
    const bytes = await readFile(path), target = join(workspace, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, bytes, { flag: 'wx' });
    copied.add(relativePath);
    return sha(bytes);
}
for (const path of stagedPaths) {
    const relativePath = path.slice(runtimeRoot.length + 1).replaceAll('\\', '/');
    runtime[relativePath] = await copy(path, relativePath);
}
const directories = ['test', 'scripts', 'ops', 'public/vendor', 'public/assets/fonts', 'public/assets/vendors',
    'artifacts/arc-official-20261006'];
const supporting = ['AGENTS.md', 'eslint.config.js', 'package-lock.json', 'public/favicon.ico',
    'artifacts/review-20261008/coordination-after2/webkit-desktop/failure.json',
    ...(await readdir('public/assets', { withFileTypes: true })).filter(entry => entry.isFile())
        .map(entry => 'public/assets/' + entry.name)];
for (const directory of directories) supporting.push(...(await files(directory)).map(path => path.replaceAll('\\', '/')));
const supportHashes = {};
for (const path of [...new Set(supporting)].sort()) {
    // The installed module wins if a local test dependency shares its path.
    if (!copied.has(path)) supportHashes[path] = await copy(path, path);
}
for (const [path, expected] of Object.entries(supportHashes)) {
    assert.equal(sha(await readFile(path)), expected, 'Supporting source changed while copying: ' + path);
}
for (const [path, expected] of Object.entries(runtime)) {
    assert.equal(sha(await readFile(join(runtimeRoot, path))), expected, 'Runtime source changed while copying: ' + path);
}
await symlink(resolve('node_modules'), join(workspace, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
assert.equal((await stat(join(workspace, 'node_modules/eslint/bin/eslint.js'))).isFile(), true);
if (!integration) assert.ok(baseline.hashes.every(file => file.hash === null || Object.hasOwn(runtime, file.path)));
const capturedAt = new Date().toISOString();
await writeFile(join(output, 'capture.json'), JSON.stringify({ capturedAt, sourceRoot: workspace,
    runtimeRoot, runtimeMode: integration ? 'local_integration' : 'installed_stage', runtime, supporting: supportHashes,
    scope: integration ? 'Frozen current application and complete test tree, including concurrent UI work. No current application file is replaced.'
        : 'Exact installed runtime plus the eight reviewed save repair files; frozen local tests, tools and asset fixtures. No current application file is replaced.' }, null, 2), { flag: 'wx' });
const unitInputs = ['test/personal-pie-save.test.mjs', 'test/ranking-service.test.mjs', 'test/ranking-recovery-races.test.mjs',
    'test/personal-pie-release-guard.test.mjs', 'test/family-lifecycle.test.mjs', 'test/private-categories.test.mjs', 'test/write-idempotency.test.mjs'];
const child = spawnSync(process.execPath, focused ? ['--test', ...unitInputs] : ['scripts/verify-panel-read-review-20261008.mjs'], {
    cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 1200000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '',
        all_proxy: '', NO_PROXY: '*', no_proxy: '*' }
});
await writeFile(join(output, 'run.txt'), (child.stdout ?? '') + (child.stderr ?? ''), { flag: 'wx' });
let verification, reportPath;
if (focused) {
    reportPath = join(output, 'focused-unit.json');
    const summary = Object.fromEntries([...(child.stdout ?? '').matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)]
        .map(([, name, count]) => [name, Number(count)]));
    verification = { passed: child.status === 0 && !child.error && summary.pass === summary.tests && summary.fail === 0,
        sourceDrift: [], checks: [{ name: 'focused-unit', passed: child.status === 0 && !child.error, summary,
            report: join(output, 'run.txt'), sha256: sha((child.stdout ?? '') + (child.stderr ?? '')) }],
        unitInputs, scope: 'Seven save-protocol regression suites against the exact installed runtime plus the reviewed repair. This is not a complete test-tree pass.' };
    await writeFile(reportPath, JSON.stringify(verification, null, 2), { flag: 'wx' });
} else {
    const reportPaths = (await files(join(workspace, 'artifacts/review-20261008'))).filter(path => path.endsWith('verification.json'));
    assert.equal(reportPaths.length, 1);
    reportPath = reportPaths[0]; verification = await json(reportPath);
}
const runtimeDrift = [];
for (const [path, expected] of Object.entries(runtime)) {
    if (sha(await readFile(join(workspace, path))) !== expected || (!integration && sha(await readFile(join(stage, path))) !== expected)) runtimeDrift.push(path);
}
for (const [path, expected] of Object.entries(supportHashes)) if (sha(await readFile(join(workspace, path))) !== expected) runtimeDrift.push(path);
const passed = child.status === 0 && !child.error && verification.passed && runtimeDrift.length === 0;
const resultPath = join(output, integration ? 'integration-verification.json' : focused ? 'focused-verification.json' : 'staged-verification.json');
await writeFile(resultPath, JSON.stringify({ passed, sourceRoot: workspace,
    capture: join(output, 'capture.json'), verification: reportPath, checks: verification.checks,
    runtimeDrift, sourceDrift: verification.sourceDrift, productionBusinessDataWritten: false,
    localApplicationFilesChanged: false, runtimeMode: integration ? 'local_integration' : 'installed_stage',
    scope: verification.scope }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ passed, output, sourceRoot: workspace, resultPath, verification: reportPath,
    checks: verification.checks.map(({ name, passed, summary }) => ({ name, passed, summary })), runtimeDrift }));
assert.equal(passed, true, 'An isolated verification must pass every declared check without source drift');
