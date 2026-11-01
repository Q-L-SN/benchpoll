import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.');
const output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an external artifact directory');
}
const baselinePath = 'D:/Codex-artifacts/website1/topic-identity-ui-20261026/workspace-baseline.json';
const previousPath = 'D:/Codex-artifacts/website1/sign-in-simplification-20261027/previous-release-manifest.json';
const baseline = new Map(JSON.parse(await readFile(baselinePath, 'utf8')).map(row => [row.path, row.sha256]));
const previous = JSON.parse(await readFile(previousPath, 'utf8'));
for (const source of previous.sources) baseline.set(source.path, source.before);
for (const file of previous.files) baseline.set(file.path, file.after);

const paths = [
    'server.js', 'privacy-controls.js', 'privacy-headers.js', 'topic-service.js',
    'ranking-service.js', 'topic-home-service.js', 'moderation-email.js', 'user-profile-service.js',
    'discussion-service.js', 'topic-proposal-service.js',
    'private/sign-in.html', 'private/loginCallback.html', 'private/account-privacy.html',
    'private/terms.html', 'private/privacy.html', 'private/home.html', 'private/index.html',
    'private/how-it-works.html', 'private/topic-proposals.html',
    'public/js/sign-in.js', 'public/js/loginCallback.js', 'public/js/global.js',
    'public/js/home.js', 'public/js/home-workspace.js', 'public/js/topics-home.js', 'public/js/home-startup.js',
    'public/js/navigation/sidebar.js', 'public/js/shared/sign-in.js', 'public/js/shared/account-center.js',
    'public/js/shared/config-sidebar.js', 'public/js/shared/topic-identity.js',
    'public/js/shared/topics.js', 'public/js/shared/category-route.js',
    'public/js/shared/available-score.js', 'public/js/shared/coverage-penalty.js',
    'public/js/workspace/contracts.js', 'public/js/workspace/state.js', 'public/js/workspace/model-scores.js',
    'public/js/discussion.js', 'public/js/censor.js', 'public/js/topic-proposals.js',
    'public/css/sign-in.css', 'public/css/topics-home.css', 'public/css/ui/config-sidebar.css',
    'public/css/ui/private-categories.css', 'public/css/ui/topic-identity.css', 'public/css/ui/account-center.css',
    'public/css/topic-proposals.css', 'public/css/ui/profile-editor.css',
    'scripts/migrate-topic-proposals-20261027.mjs', 'scripts/migrate-public-github-profile-20261027.mjs'
];
const files = [];
for (const path of paths) {
    const bytes = await readFile(join(root, path));
    const after = createHash('sha256').update(bytes).digest('hex');
    const before = baseline.get(path) ?? null;
    if (before === after) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: null, files }, null, 2));
console.log(JSON.stringify({ output, files: files.length, paths: files.map(file => file.path) }));
