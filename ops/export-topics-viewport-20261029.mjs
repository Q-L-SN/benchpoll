import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const prior = JSON.parse(await readFile('D:/Codex-artifacts/website1/topics-cleanup-20261028/released-manifest.json', 'utf8'));
const baseline = new Map(prior.sources.map(source => [source.path, source.before]));
for (const file of prior.files) baseline.set(file.path, file.after);
const paths = ['private/index.html', 'private/home.html', 'public/css/topics-home.css',
    'public/js/topics-home.js', 'public/css/discussion.css', 'public/js/discussion.js'];
const files = [];
for (const path of paths) {
    if (!baseline.has(path)) throw new Error(`Missing production baseline: ${path}`);
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex'), before = baseline.get(path);
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2));
console.log(JSON.stringify({ output, files: files.length, paths: files.map(file => file.path) }));
