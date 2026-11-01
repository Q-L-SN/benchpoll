import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const manifest = JSON.parse(await readFile('D:/Codex-artifacts/website1/community-fallback-20261030-1793374824933/manifest.json', 'utf8'));
const baseline = new Map([...manifest.sources.map(row => [row.path, row.before]), ...manifest.files.map(row => [row.path, row.after])]);
const paths = [
    'private/home.html',
    'public/js/home-workspace.js', 'public/js/shared/config-sidebar.js', 'public/js/shared/evidence-count.js',
    'public/js/workspace/pie-renderer.js', 'public/js/workspace/pie-label-layout.js', 'public/js/workspace/weight-treemap-layout.js',
    'public/css/ui/workspace.css', 'public/css/ui/fallback.css', 'public/css/ui/evidence-count.css',
    'public/css/ui/config-sidebar.css', 'public/css/ui/topic-identity.css', 'public/css/ui/site-header.css'
];
const files = [];
for (const path of paths) {
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex'), before = baseline.get(path) ?? null;
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.length, newFiles: files.filter(file => file.baseline === null).map(file => file.path) }, null, 2));
