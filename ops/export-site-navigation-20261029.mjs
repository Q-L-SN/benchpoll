import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const manifest = JSON.parse(await readFile('D:/Codex-artifacts/website1/topics-cleanup-20261028/released-manifest.json', 'utf8'));
const baseline = new Map([...manifest.sources.map(row => [row.path, row.before]), ...manifest.files.map(row => [row.path, row.after])]);
const paths = [
    'private/index.html', 'private/home.html', 'private/dialogPage.html', 'private/topic-proposals.html', 'private/account-privacy.html',
    'public/js/shared/site-header.js', 'public/css/ui/site-header.css', 'public/js/shared/page-header.js', 'public/js/global.js',
    'public/js/topics-home.js', 'public/js/home-workspace.js', 'public/js/account-privacy.js', 'public/js/topic-proposals.js', 'public/js/discussion.js',
    'public/js/shared/aa-ranking-policy.js', 'public/js/workspace/fallback-picker.js', 'public/js/workspace/model-scores.js', 'public/js/workspace/benchmark-scores.js',
    'public/css/topics-home.css', 'public/css/topic-proposals.css', 'public/css/model-comparison.css', 'public/css/discussion.css',
    'public/css/ui/config-sidebar.css', 'public/css/ui/account-center.css', 'public/css/ui/benchmark-families.css', 'public/css/ui/model-search.css',
    'public/css/ui/fallback.css', 'public/css/ui/workspace.css',
    'ranking-service.js', 'benchmark-version-preferences.js', 'topic-proposal-service.js'
];
const files = [];
for (const path of paths) {
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex');
    const before = baseline.get(path) ?? null;
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2));
console.log(JSON.stringify({ output, files: files.length, paths: files.map(file => file.path) }, null, 2));
