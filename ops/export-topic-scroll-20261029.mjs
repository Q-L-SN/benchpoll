import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const prior = JSON.parse(await readFile('D:/Codex-artifacts/website1/topics-viewport-20261029/released-manifest.json', 'utf8'));
const path = 'public/css/topics-home.css';
const previous = prior.files.find(file => file.path === path);
if (!previous?.after) throw new Error(`Missing production baseline: ${path}`);
const after = createHash('sha256').update(await readFile(join(root, path))).digest('hex');
if (after === previous.after) throw new Error('No scroll fix to publish');
await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
await copyFile(join(root, path), join(output, 'payload', path));
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null,
    files: [{ path, baseline: previous.after, after }] }, null, 2));
console.log(JSON.stringify({ output, files: 1, path }));
