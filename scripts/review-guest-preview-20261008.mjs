import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const evidence = resolve('artifacts/review-20261008/guest-preview-lifecycle-20261008');
const sourceFiles = ['public/js/home-workspace.js', 'public/js/shared/http.js', 'public/js/shared/write-intent.js',
    'public/js/workspace/state.js', 'public/js/workspace/guest-drafts.js', 'public/js/workspace/contracts.js',
    'public/js/workspace/weights.js', 'public/js/shared/benchmark-families.js', 'ranking-service.js',
    'server.js', 'package.json', 'package-lock.json'];
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprints = async () => Object.fromEntries(await Promise.all(sourceFiles.map(async path => [path, hash(await readFile(path))])));
if (process.argv.includes('--capture')) {
    await mkdir(evidence, { recursive: false });
    const hashes = await fingerprints();
    for (const path of sourceFiles) {
        const destination = join(evidence, 'before', path);
        await mkdir(dirname(destination), { recursive: true });
        await writeFile(destination, await readFile(path), { flag: 'wx' });
    }
    await writeFile(join(evidence, 'baseline.json'), JSON.stringify({ capturedAt: new Date().toISOString(), hashes,
        scope: 'Actual guest preview and HTTP helper with controlled, non-cooperative transport. Synthetic fixtures only; no live network, authentication or database mutation.' }, null, 2), { flag: 'wx' });
    console.log(evidence);
} else {
    const label = process.argv.find(arg => arg.startsWith('--run='))?.slice(6);
    assert.match(label ?? '', /^(before|after)-[a-z0-9-]+$/);
    const before = label.startsWith('before');
    const baseline = JSON.parse(await readFile(join(evidence, 'baseline.json'), 'utf8'));
    const start = await fingerprints();
    if (before) assert.deepEqual(start, baseline.hashes, 'Baseline implementation must not have been edited.');
    for (const path of sourceFiles.filter(path => before || path !== 'public/js/home-workspace.js')) {
        assert.equal(start[path], baseline.hashes[path], 'Unowned implementation drift: ' + path);
    }
    const child = spawnSync(process.execPath, ['--test', 'test/guest-preview-lifecycle.test.mjs'], {
        encoding: 'utf8', windowsHide: true, timeout: 30000,
        env: { ...process.env, ...(before ? { GUEST_PREVIEW_REVIEW_SOURCE_DIR: join(evidence, 'before') } : {}) }
    });
    const text = (child.stdout ?? '') + (child.stderr ?? '');
    await writeFile(join(evidence, label + '.tap'), text, { flag: 'wx' });
    const summary = Object.fromEntries([...text.matchAll(/^# (tests|pass|fail|cancelled|skipped) (\d+)$/gm)]
        .map(([, key, value]) => [key, Number(value)]));
    const end = await fingerprints();
    const drift = sourceFiles.filter(path => start[path] !== end[path]);
    const report = { phase: before ? 'before' : 'after', status: child.status, error: child.error?.message ?? null,
        summary, fingerprints: end, drift, testSHA256: hash(await readFile('test/guest-preview-lifecycle.test.mjs')) };
    await writeFile(join(evidence, label + '.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(JSON.stringify(report));
    assert.deepEqual(drift, []);
    assert.equal(summary.tests, 14); assert.equal(summary.cancelled, 0);
    if (!before) assert.equal(child.status, 0);
    else { assert.equal(summary.fail, 12); assert.equal(summary.pass, 2); }
}
