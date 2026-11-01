import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) throw new Error('Use an external artifact directory');
const base = 'D:/Codex-artifacts/website1';
const baseline = new Map(JSON.parse(await readFile(join(base, 'topic-identity-ui-20261026/workspace-baseline.json'), 'utf8')).map(row => [row.path, row.sha256]));
for (const path of ['sign-in-simplification-20261027/previous-release-manifest.json',
    'sign-in-simplification-20261027/topics-account-20261027-1793116037417/manifest.json']) {
    const previous = JSON.parse(await readFile(join(base, path), 'utf8'));
    for (const source of previous.sources) baseline.set(source.path, source.before);
    for (const file of previous.files) baseline.set(file.path, file.after);
}
const paths = ['server.js', 'topic-proposal-service.js', 'private/index.html', 'private/home.html',
    'private/how-it-works.html', 'private/topic-proposals.html', 'public/js/topic-proposals.js',
    'public/css/topic-proposals.css', 'public/js/topics-home.js', 'public/css/topics-home.css',
    'public/js/navigation/sidebar.js', 'public/js/navigation/preferences.js', 'public/js/navigation/model.js',
    'public/css/ui/navigation.css', 'public/css/ui/config-sidebar.css', 'public/css/ui/private-categories.css',
    'public/js/shared/topics.js', 'public/js/topics-home/layout.js',
    'scripts/migrate-topic-proposal-limits-20261028.mjs'];
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
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2));
console.log(JSON.stringify({ output, files: files.length, paths: files.map(file => file.path) }));
