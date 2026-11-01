import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const manifest = JSON.parse(await readFile('D:/Codex-artifacts/website1/score-toolbar-20261030-1793329500000/manifest.json', 'utf8'));
const baseline = new Map([...manifest.sources.map(row => [row.path, row.before]), ...manifest.files.map(row => [row.path, row.after])]);
const paths = [
    'server.js', 'ranking-service.js', 'benchmark-family-service.js',
    'scripts/migrate-community-fallback-20261030.mjs',
    'private/home.html', 'private/index.html', 'private/how-it-works.html', 'private/censor.html', 'private/topic-proposals.html',
    'public/js/censor.js', 'public/js/contribute.js', 'public/js/discussion.js', 'public/js/global.js',
    'public/js/home.js', 'public/js/home-workspace.js', 'public/js/topic-proposals.js', 'public/js/topics-home.js',
    'public/js/navigation/sidebar.js',
    'public/js/shared/bar-label.js', 'public/js/shared/benchmark-families.js', 'public/js/shared/comparison-display.js',
    'public/js/shared/config-sidebar.js', 'public/js/shared/custom-select.js', 'public/js/shared/input-clear.js',
    'public/js/shared/floating-search-layer.js', 'public/js/shared/help-popover.js', 'public/js/shared/mobile-panels.js',
    'public/js/shared/model-search.js', 'public/js/shared/organization-logos.js',
    'public/js/shared/site-header.js', 'public/js/shared/topic-identity.js', 'public/js/shared/ui-components.js',
    'public/js/workspace/basic-comparison-controls.js', 'public/js/workspace/benchmark-scores.js',
    'public/js/workspace/chart-workspace.js', 'public/js/workspace/comparison-controls.js',
    'public/js/workspace/comparison-profile-menu.js', 'public/js/workspace/contracts.js',
    'public/js/workspace/discussion-entry.js', 'public/js/workspace/fallback-picker.js', 'public/js/workspace/family-view.js',
    'public/js/workspace/guest-drafts.js', 'public/js/workspace/model-bar-chart.js', 'public/js/workspace/model-list.js',
    'public/js/workspace/model-scores.js', 'public/js/workspace/pie-recovery.js', 'public/js/workspace/ranking-motion.js',
    'public/js/workspace/state.js', 'public/js/workspace/weights.js',
    'public/css/global.css', 'public/css/contribute.css', 'public/css/model-comparison.css', 'public/css/topics-home.css',
    'public/css/workspace-layout.css', 'public/css/ui/workspace.css', 'public/css/ui/config-sidebar.css',
    'public/css/ui/fallback.css', 'public/css/ui/fallback-picker.css', 'public/css/ui/benchmark-chain-layouts.css',
    'public/css/ui/model-search.css', 'public/css/ui/tooltip.css'
];
const deletions = ['benchmark-version-preferences.js', 'public/js/workspace/version-group-dialog.js'];
const files = [];
for (const path of paths) {
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex'), before = baseline.get(path) ?? null;
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
for (const path of deletions) {
    if (!baseline.get(path)) throw new Error('Missing reviewed deletion baseline: ' + path);
    try { await readFile(join(root, path)); throw new Error('Retired file still exists: ' + path); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    files.push({ path, baseline: baseline.get(path), after: null });
}
await mkdir(output, { recursive: true });
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: 'migrate-community-fallback-20261030.mjs', files }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.length, captureRequired: files.filter(file => file.baseline === null).map(file => file.path) }, null, 2));
