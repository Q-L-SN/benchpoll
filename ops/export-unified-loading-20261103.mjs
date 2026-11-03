import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Exact additional source paths for the shared loading presentation change.
const LOADING_SOURCES = Object.freeze([
    'private/account-privacy.html',
    'private/adminlogin.html',
    'private/censor.html',
    'private/home.html',
    'private/index.html',
    'private/topic-proposal-preview.html',
    'private/topic-proposals.html',
    'public/css/ui/loading.css',
    'public/css/ui/ranking-motion.css',
    'public/js/account-privacy.js',
    'public/js/censor.js',
    'public/js/discussion.js',
    'public/js/home-workspace.js',
    'public/js/navigation/sidebar.js',
    'public/js/shared/account-center.js',
    'public/js/shared/legal-acceptance.js',
    'public/js/shared/loading.js',
    'public/js/shared/model-search.js',
    'public/js/shared/private-topic-editor.js',
    'public/js/shared/profile-editor.js',
    'public/js/sign-in.js',
    'public/js/topic-proposal-preview.js',
    'public/js/topic-proposals.js',
    'public/js/topics-home.js',
    'public/js/workspace/benchmark-scores.js',
    'public/js/workspace/chart-workspace.js',
    'public/js/workspace/fallback-picker.js',
    'public/js/workspace/model-list.js',
    'public/js/workspace/model-scores.js',
    'public/js/workspace/reference-coverage.js',
    'public/js/workspace/topic-reference-search.js',
    'public/js/workspace/topic-references.js',
]);
const root = fileURLToPath(new URL('../', import.meta.url)), output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Supply a new release directory outside the source checkout');
// Preserve every earlier authorized, undeployed change and verify both frontend builds.
execFileSync(process.execPath, [join(root, 'ops/export-harness-conditions-20261103.mjs'), output], { cwd: root, stdio: 'pipe' });
const hash = value => createHash('sha256').update(value).digest('hex');
const manifestPath = join(output, 'request.json'), manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const files = new Map(manifest.files.map(file => [file.path, file]));
for (const path of LOADING_SOURCES) {
    const bytes = await readFile(join(root, path)), destination = join(output, 'payload', path);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes);
    if (hash(await readFile(destination)) !== hash(bytes)) throw new Error('Loading release copy mismatch: ' + path);
    files.set(path, { path, sha256: hash(bytes), bytes: bytes.length });
}
manifest.release = 'unified-loading-20261103';
manifest.createdAt = new Date().toISOString();
manifest.files = [...files.values()].sort((a, b) => a.path.localeCompare(b.path, 'en'));
manifest.unchangedBuildInputs = manifest.unchangedBuildInputs.filter(file => !files.has(file.path));
manifest.presentationChanges = ['One accessible spinner across loading states', 'All scores empty parameter label spacing'];
const serialized = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(manifestPath, serialized, { mode: 0o600 });
await writeFile(join(output, 'request.sha256'), hash(serialized) + '  request.json\n', { mode: 0o600 });
await copyFile(join(output, 'RELEASE.md'), join(output, 'HARNESS-CHANGES.md'));
await copyFile(join(root, 'docs/unified-loading-20261103.md'), join(output, 'RELEASE.md'));
console.log(JSON.stringify({ output, files: manifest.files.length, readyForInstallation: false, manifestSHA256: hash(serialized) }));
