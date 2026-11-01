import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const base = 'D:/Codex-artifacts/website1';
const baseline = new Map(JSON.parse(await readFile(join(base, 'topic-identity-ui-20261026/workspace-baseline.json'), 'utf8'))
    .map(row => [row.path, row.sha256]));
for (const path of ['sign-in-simplification-20261027/previous-release-manifest.json',
    'sign-in-simplification-20261027/topics-account-20261027-1793116037417/manifest.json',
    'topic-proposal-limits-20261028/topics-account-20261027-1793124165460/manifest.json']) {
    const previous = JSON.parse(await readFile(join(base, path), 'utf8'));
    for (const source of previous.sources) baseline.set(source.path, source.before);
    for (const file of previous.files) baseline.set(file.path, file.after);
}
const arenaBaseline = await readFile(join(base, 'topics-cleanup-20261028/import-arena-live.mjs'));
baseline.set('scripts/import-arena-latest.mjs', createHash('sha256').update(arenaBaseline).digest('hex'));
const paths = [
    'server.js', 'privacy-controls.js', 'moderation-admin.js', 'ranking-service.js', 'ranking-pagination.js',
    'ranking-cache-schema.js', 'topic-home-service.js', 'scripts/import-arena-latest.mjs',
    'private/index.html', 'private/home.html', 'private/sign-in.html', 'private/account-privacy.html',
    'private/privacy.html', 'private/terms.html', 'private/contribute.html',
    'public/js/topics-home.js', 'public/css/topics-home.css', 'public/css/model-comparison.css',
    'public/css/ui/config-sidebar.css', 'public/js/shared/config-sidebar.js', 'public/js/home-workspace.js',
    'public/js/workspace/model-scores.js', 'public/css/ui/evidence.css',
    'public/js/shared/account-center.js', 'public/css/ui/account-center.css',
    'public/js/shared/model-search.js', 'public/css/ui/model-search.css',
    'public/css/workspace-model-focus.css', 'public/js/workspace/model-focus.js',
    'public/js/workspace/fallback-picker.js', 'public/css/ui/fallback-picker.css',
    'public/js/contribute.js', 'public/js/contribution/contracts.js', 'public/css/contribute.css',
    'public/js/account-privacy.js', 'public/js/sign-in.js'
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
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2));
console.log(JSON.stringify({ output, files: files.length, paths: files.map(file => file.path) }));
