import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';
import { SEARCH_LEGAL_SOURCES } from './search-legal-paths-20261101.mjs';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const manifests = process.argv.slice(3);
if (!manifests.length) manifests.push('D:/Codex-artifacts/website1/weight-treemap-20261031-1793459100012/manifest.json');
const baseline = new Map();
// Small follow-up releases do not repeat every source from the preceding release.
for (const path of manifests) {
    const manifest = JSON.parse(await readFile(path, 'utf8'));
    for (const row of manifest.sources) baseline.set(row.path, row.before);
    for (const row of manifest.files) baseline.set(row.path, row.after);
}
const files = [];
for (const path of SEARCH_LEGAL_SOURCES) {
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex'), before = baseline.get(path) ?? null;
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.length, baselineUnknown: files.filter(file => file.baseline === null).map(file => file.path) }, null, 2));
