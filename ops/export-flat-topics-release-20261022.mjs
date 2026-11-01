import { readFile, readdir, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname } from 'node:path';

const root = resolve('.');
const output = resolve(process.argv[2] || '');
if (!process.argv[2] || output === root) throw new Error('An external artifact directory is required');
const baselinePath = process.argv.find(arg => arg.startsWith('--baseline='))?.slice(11)
    || 'D:/Codex-artifacts/website1/flat-topics-home-20261022/workspace-baseline.json';
const migration = process.argv.find(arg => arg.startsWith('--migration='))?.slice(12) || 'migrate-flat-topics-20261022.mjs';
if (!['none', 'migrate-flat-topics-20261022.mjs', 'migrate-topic-slugs-20261023.mjs', 'migrate-topic-name-urls-20261026.mjs', 'migrate-topic-taxonomy-20261026.mjs', 'migrate-topic-summaries-20261026.mjs'].includes(migration)) throw new Error('Unknown release migration');
const baseline = new Map(JSON.parse(await readFile(baselinePath, 'utf8'))
    .map(row => [row.path, row.sha256]));
const paths = [];
async function collect(directory) {
    for (const entry of await readdir(join(root, directory), { withFileTypes: true })) {
        const path = directory + '/' + entry.name;
        if (path === 'public/build' || /^private\/(?:home|index)-(?:assets\.json|built\.html)$/.test(path)) continue;
        if (entry.isDirectory()) await collect(path);
        else if (entry.isFile()) paths.push(path);
    }
}
await collect('public'); await collect('private');
for (const entry of await readdir(root)) if (/^[a-z0-9-]+\.js$/.test(entry)) paths.push(entry);
paths.push('scripts/build-home-assets.mjs');
if (migration !== 'none') paths.push('scripts/' + migration);
if (migration === 'migrate-topic-taxonomy-20261026.mjs') paths.push('ops/topic-taxonomy-20261026.json');
const files = [];
for (const path of paths) {
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex');
    const before = baseline.get(path) ?? null;
    if (after === before) continue;
    files.push({ path, baseline: before, after });
    const target = join(output, 'payload', path);
    await mkdir(dirname(target), { recursive: true }); await copyFile(join(root, path), target);
}
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: migration === 'none' ? null : migration, files }, null, 2));
console.log(JSON.stringify({ files: files.length, paths: files.map(row => row.path), output }));
