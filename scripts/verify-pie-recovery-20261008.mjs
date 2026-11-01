import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

const argument = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const runtimeRoot = resolve(argument('runtime-root') ?? '.'), full = process.argv.includes('--full');
const output = resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008/verification-' + Date.now());
const root = join(output, 'workspace'), sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function files(directory) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) found.push(...await files(path));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}
await mkdir(root, { recursive: true });
const copied = new Map(), hashes = {}, sources = {};
async function copy(path, name) {
    if (copied.has(name)) return;
    const bytes = await readFile(path), target = join(root, name);
    await mkdir(dirname(target), { recursive: true }); await writeFile(target, bytes, { flag: 'wx' });
    copied.set(name, true); hashes[name] = sha(bytes); sources[name] = resolve(path);
}
const runtime = ['package.json', ...(await readdir(runtimeRoot)).filter(path => /\.js$/.test(path))];
for (const dir of ['public/js', 'public/css', 'private']) {
    runtime.push(...(await files(join(runtimeRoot, dir))).map(path => relative(runtimeRoot, path).replaceAll('\\', '/')));
}
for (const path of runtime) await copy(join(runtimeRoot, path), path);
const support = ['AGENTS.md', 'eslint.config.js', 'package-lock.json', 'public/favicon.ico',
    'artifacts/review-20261008/coordination-after2/webkit-desktop/failure.json'];
for (const dir of ['test', 'scripts', 'ops', 'public/vendor', 'public/assets/fonts', 'public/assets/vendors', 'artifacts/arc-official-20261006']) {
    support.push(...(await files(dir)).map(path => path.replaceAll('\\', '/')));
}
support.push(...(await readdir('public/assets', { withFileTypes: true })).filter(entry => entry.isFile()).map(entry => 'public/assets/' + entry.name));
for (const path of support) await copy(path, path);
for (const [path, expected] of Object.entries(hashes)) assert.equal(sha(await readFile(sources[path])), expected, 'Changed during capture: ' + path);
await symlink(resolve('node_modules'), join(root, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
await writeFile(join(output, 'capture.json'), JSON.stringify({ sourceRoot: root, runtimeRoot, capturedAt: new Date().toISOString(),
    hashes, runtime, applicationChanges: false, productionBusinessDataWritten: false }, null, 2), { flag: 'wx' });
const focus = ['test/pie-recovery.test.mjs', 'test/pie-recovery-workspace.test.mjs', 'test/pie-recovery-release-guard.test.mjs', 'test/personal-pie-save.test.mjs',
    'test/guest-drafts.test.mjs', 'test/guest-workspace-restoration.test.mjs', 'test/guest-preview-lifecycle.test.mjs', 'test/write-idempotency.test.mjs'];
const inputs = full ? (await files(join(root, 'test'))).filter(path => path.endsWith('.test.mjs')).map(path => relative(root, path)) : focus;
const checks = [];
async function run(name, args) {
    const child = spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', windowsHide: true,
        timeout: 1200000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
            http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const text = (child.stdout ?? '') + (child.stderr ?? ''), path = join(output, name + '.txt');
    await writeFile(path, text, { flag: 'wx' });
    const summary = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)].map(([, key, count]) => [key, Number(count)]));
    checks.push({ name, passed: child.status === 0 && !child.error, exitCode: child.status, report: path, sha256: sha(text), summary });
}
await run('unit', ['--test', ...inputs]);
await run('lint', ['node_modules/eslint/bin/eslint.js', ...focus, 'public/js/home-workspace.js', 'public/js/shared/write-intent.js',
    'public/js/workspace/state.js', 'public/js/workspace/guest-drafts.js', 'public/js/workspace/draft-records.js',
    'public/js/workspace/pie-recovery.js', 'scripts/pie-recovery-harness.mjs']);
const sourceDrift = [];
for (const [path, expected] of Object.entries(hashes)) if (sha(await readFile(join(root, path))) !== expected) sourceDrift.push(path);
const passed = checks.every(check => check.passed) && sourceDrift.length === 0;
const report = { passed, sourceRoot: root, runtimeRoot, fullTestTree: full, sourceDrift, checks,
    capture: join(output, 'capture.json'), applicationChanges: false, productionBusinessDataWritten: false };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ ...report, checks: checks.map(({ name, passed, summary }) => ({ name, passed, summary })), output }));
assert.equal(passed, true, 'Declared checks must pass without frozen-source drift');
