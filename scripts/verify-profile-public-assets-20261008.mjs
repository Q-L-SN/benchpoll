import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const output = 'artifacts/review-20261008/profile-read-deployment';
const manifest = JSON.parse(await readFile(`${output}/manifest.json`, 'utf8'));
const versions = { 'public/js/home-workspace.js': '?v=review-pagination-20261008',
    'public/js/navigation/sidebar.js': '?v=comparison-experiment-20261007' };
const results = [];
for (const file of manifest.files.filter(file => file.path.startsWith('public/js/'))) {
    const url = 'https://benchpoll.com' + file.path.replace(/^public/, '') + (versions[file.path] ?? '');
    const start = performance.now();
    const bytes = execFileSync('curl.exe', ['--fail', '--silent', '--show-error', '--max-time', '45', url],
        { maxBuffer: 4 * 1024 * 1024, timeout: 50000, windowsHide: true });
    const hash = createHash('sha256').update(bytes).digest('hex');
    results.push({ path: file.path, url, expected: file.after, hash, matches: hash === file.after,
        elapsedMs: Math.round(performance.now() - start) });
}
await writeFile(`${output}/public-assets.json`, JSON.stringify({ release: manifest.release,
    scope: 'Five public JavaScript assets through HTTPS/CDN using actual page module URLs; no API, login, database or write request.',
    results }, null, 2), { flag: 'wx' });
assert.equal(results.length, 5); assert.ok(results.every(item => item.matches));
console.log(JSON.stringify({ release: manifest.release, publicAssetHashes: 5, matched: true }));
