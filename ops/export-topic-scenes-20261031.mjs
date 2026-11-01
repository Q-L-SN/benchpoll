import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const manifest = JSON.parse(await readFile(process.argv[3]
    || 'D:/Codex-artifacts/website1/benchmark-policy-20261031-1793435233259/manifest.json', 'utf8'));
const baseline = new Map(manifest.sources.map(row => [row.path, row.before]));
for (const row of manifest.files) baseline.set(row.path, row.after);
const previous = JSON.parse(await readFile('D:/Codex-artifacts/website1/community-fallback-20261030-1793374824933/manifest.json', 'utf8'));
for (const row of previous.files) if (!baseline.has(row.path)) baseline.set(row.path, row.after);
baseline.set('scripts/check-ranking-integrity.mjs', 'f172c7b465ed25670630f14d570a6b4839ba9bdedf576222e1b41974123e977a');
baseline.set('scripts/delete-benchmarks-before-id.mjs', 'e7f73b23cbf2d61abc82327a7fd7cea2be0cc0b7aad3632fdd74f3f2243afd06');
const paths = [
    'server.js', 'ranking-service.js', 'discussion-service.js', 'navigation-service.js',
    'topic-service.js', 'topic-proposal-service.js', 'topic-home-service.js',
    'topic-scenes-service.js', 'topic-reference-service.js', 'scripts/migrate-topic-scenes-20261031.mjs',
    'private/how-it-works.html', 'public/js/censor.js',
    'private/home.html', 'private/topic-proposals.html', 'public/css/topics-home.css', 'public/css/ui/topic-scenes.css',
    'public/css/ui/config-sidebar.css', 'public/css/model-comparison.css', 'public/js/shared/comparison-display.js',
    'public/js/home-workspace.js', 'public/js/topics-home.js', 'public/js/discussion.js', 'public/js/topic-proposals.js',
    'public/js/navigation/model.js', 'public/js/navigation/sidebar.js', 'public/js/navigation/scenes.js',
    'public/js/shared/ranking-url.js', 'public/js/workspace/contracts.js', 'public/js/workspace/discussion-entry.js',
    'public/js/workspace/pie-recovery.js', 'public/js/workspace/scenes.js', 'public/js/workspace/state.js',
    'public/js/workspace/topic-references.js', 'public/js/workspace/weight-treemap-layout.js',
    'scripts/check-ranking-integrity.mjs', 'scripts/delete-benchmarks-before-id.mjs', 'ops/rehearse-topic-scenes-20261031.mjs',
    'scripts/migrate-topic-scenes-taxonomy-20261031.mjs', 'ops/topic-scenes-taxonomy-20261031.json'
];
const added = new Set(['topic-scenes-service.js', 'topic-reference-service.js', 'scripts/migrate-topic-scenes-20261031.mjs',
    'public/css/ui/topic-scenes.css', 'public/js/navigation/scenes.js', 'public/js/workspace/scenes.js',
    'public/js/workspace/topic-references.js', 'ops/rehearse-topic-scenes-20261031.mjs',
    'scripts/migrate-topic-scenes-taxonomy-20261031.mjs', 'ops/topic-scenes-taxonomy-20261031.json']);
const files = [];
for (const path of paths) {
    if (!baseline.has(path) && !added.has(path)) throw new Error('Missing reviewed baseline: ' + path);
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex'), before = baseline.get(path) ?? null;
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: 'migrate-topic-scenes-20261031.mjs',
    taxonomyMigration: 'migrate-topic-scenes-taxonomy-20261031.mjs', files }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.map(file => file.path) }, null, 2));
