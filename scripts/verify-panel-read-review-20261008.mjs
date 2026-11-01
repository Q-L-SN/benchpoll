import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const output = resolve(`artifacts/review-20261008/panel-read-verification-${Date.now()}`);
await mkdir(output, { recursive: false });
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
async function paths(directory, pattern) {
    const found = [];
    for (const entry of await readdir(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name).replaceAll('\\', '/');
        if (entry.isDirectory()) found.push(...await paths(path, pattern));
        else if (pattern.test(path)) found.push(path);
    }
    return found.sort();
}
async function fingerprint() {
    const all = [...await paths('public/js', /\.js$/), ...await paths('public/css', /\.css$/),
        ...await paths('private', /\.html$/), ...await paths('scripts', /\.mjs$/),
        ...await paths('test', /\.test\.mjs$/),
        ...((await readdir('.')).filter(path => /\.js$/.test(path))),
        'package.json', 'package-lock.json', 'eslint.config.js',
        'scripts/verify-panel-read-review-20261008.mjs', 'scripts/review-coordination-20261008.mjs',
        'scripts/deploy-panel-read-review-20261008.mjs', 'ops/launch-release.mjs',
        'ops/review-installed-startup-20261008.mjs'];
    const fingerprints = {};
    for (const path of [...new Set(all)].sort()) {
        try { fingerprints[path] = hash(await readFile(path)); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    return fingerprints;
}
const before = await fingerprint();
await writeFile(join(output, 'source-before.json'), JSON.stringify(before, null, 2), { flag: 'wx' });
const tests = await paths('test', /\.test\.mjs$/);
await writeFile(join(output, 'unit-inputs.json'), JSON.stringify(tests, null, 2), { flag: 'wx' });
const checks = [];
function run(name, args, env = {}) {
    const child = spawnSync(process.execPath, args, { encoding: 'utf8', windowsHide: true, timeout: 1200000,
        maxBuffer: 64 * 1024 * 1024, env: { ...process.env, ...env } });
    const content = (child.stdout ?? '') + (child.stderr ?? '');
    const report = join(output, name + '.txt');
    checks.push({ name, report, content, status: child.status, error: child.error?.message ?? null,
        passed: child.status === 0 && !child.error });
    console.log(`${name}: ${checks.at(-1).passed ? 'PASS' : 'FAIL'}`);
}
run('unit', ['--test', ...tests]);
run('frontend', ['scripts/frontend/verify.mjs'], { FRONTEND_OUTPUT: join(output, 'frontend'),
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' });
run('lint', ['node_modules/eslint/bin/eslint.js', ...JSON.parse(await readFile('package.json', 'utf8')).scripts.lint.split(/\s+/).slice(1)]);
for (const check of checks) {
    await writeFile(check.report, check.content, { flag: 'wx' });
    check.sha256 = hash(check.content);
    if (check.name === 'unit') check.summary = Object.fromEntries([...check.content.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)]
        .map(([, name, count]) => [name, Number(count)]));
    else if (check.name === 'frontend') check.summary = { passed: (check.content.match(/^PASS /gm) ?? []).length,
        failed: (check.content.match(/^FAIL /gm) ?? []).length };
    delete check.content;
}
const after = await fingerprint();
const sourceDrift = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
await writeFile(join(output, 'source-after.json'), JSON.stringify(after, null, 2), { flag: 'wx' });
const passed = checks.every(check => check.passed) && sourceDrift.length === 0;
await writeFile(join(output, 'verification.json'), JSON.stringify({ passed, checks, sourceDrift,
    before, after, scope: 'Current local source, actual entire test tree, isolated frontend fixtures and lint. No deployment, database or social actions. Browser motion/panel proofs are separate evidence.' }, null, 2), { flag: 'wx' });
console.log(join(output, 'verification.json'));
assert.equal(passed, true, 'A failing check or changed source cannot be presented as a stable release gate');
