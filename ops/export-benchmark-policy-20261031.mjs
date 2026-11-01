import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const baselineManifest = JSON.parse(await readFile(
    process.argv[3] || 'D:/Codex-artifacts/website1/benchmark-policy-20261031-1793434121098/manifest.json', 'utf8'));
const baseline = new Map(baselineManifest.sources.map(row => [row.path, row.before]));
for (const row of baselineManifest.files) baseline.set(row.path, row.after);
const paths = [
    'public/css/topics-home.css', 'public/js/shared/aa-ranking-policy.js',
    'benchmark-details.js', 'benchmark-scores.js', 'public/js/discussion.js',
    'public/js/workspace/benchmark-scores.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/contracts.js', 'ranking-service.js', 'server.js', 'aa-archive-policy.js'
];
const files = [];
for (const path of paths) {
    if (!baseline.has(path)) throw new Error('Missing reviewed baseline: ' + path);
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex'), before = baseline.get(path);
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.map(file => file.path) }, null, 2));
