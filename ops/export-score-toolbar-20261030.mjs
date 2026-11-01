import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const manifest = JSON.parse(await readFile('D:/Codex-artifacts/website1/site-navigation-20261029/audit-fixes-manifest-20261030.json', 'utf8'));
const baseline = new Map([...manifest.sources.map(row => [row.path, row.before]), ...manifest.files.map(row => [row.path, row.after])]);
const paths = ['pairwise-score.js', 'privacy-headers.js', 'public/js/shared/available-score.js',
    'public/js/workspace/model-scores.js', 'private/how-it-works.html',
    'public/css/model-comparison.css', 'public/css/topics-home.css'];
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
console.log(JSON.stringify({ output, files: files.length, paths: files.map(file => file.path) }, null, 2));
