import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const scope = process.argv[3] || 'workspace';
if (!['workspace', 'forms'].includes(scope)) throw new Error('Unknown release scope');
const manifests = scope === 'forms'
    ? ['community-fallback-20261030-1793374824933', 'weight-treemap-20261031-1793426668420']
    : ['weight-treemap-20261031-1793424381803'];
const baseline = new Map();
for (const release of manifests) {
    const manifest = JSON.parse(await readFile(`D:/Codex-artifacts/website1/${release}/manifest.json`, 'utf8'));
    for (const row of manifest.sources) baseline.set(row.path, row.before);
    for (const row of manifest.files) baseline.set(row.path, row.after);
}
const paths = scope === 'forms' ? ['public/js/contribute.js', 'public/css/contribute.css', 'public/js/home-workspace.js'] : [
    'private/home.html',
    'public/css/ui/workspace.css', 'public/css/model-comparison.css', 'public/css/ui/contribution-layouts.css',
    'public/js/workspace/model-list.js', 'public/css/ui/config-sidebar.css', 'public/css/topics-home.css',
    'public/css/ui/account-center.css', 'public/js/topics-home.js', 'public/js/global.js',
    'public/js/shared/http.js', 'public/js/shared/legal-acceptance.js', 'public/css/ui/legal-acceptance.css',
    'public/js/shared/help-popover.js'
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
console.log(JSON.stringify({ output, scope, files: files.length, newFiles: files.filter(file => file.baseline === null).map(file => file.path) }, null, 2));
