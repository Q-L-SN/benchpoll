import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = Object.freeze([
    'private/home.html', 'private/how-it-works.html',
    'public/css/ui/fallback-picker.css', 'public/css/ui/mobile-workspace.css',
    'public/js/discussion.js', 'public/js/home-workspace.js',
    'public/js/shared/benchmark-version-choice.js', 'public/js/shared/mobile-panels.js',
    'public/js/shared/ranking-number.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/benchmark-link.js', 'public/js/workspace/benchmark-settings.js',
    'public/js/workspace/contracts.js', 'public/js/workspace/state.js', 'public/js/workspace/weights.js',
    'ranking-pagination.js', 'ranking-service.js', 'topic-snapshot-service.js',
    'scripts/migrate-community-versions-20261103.mjs'
]);
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Supply a new release directory outside the checkout');
const offset = relative(root, output);
if (!offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Release output must be outside the checkout');
}
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
if (branch !== 'codex/cloud-handoff-20261101') throw new Error('Export from the handoff branch only');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = new Set(SOURCES), buildInputs = new Map();
// Earlier lifecycle/harness/loading changes are already deployed. Export only
// this release and fresh bundles; never enqueue those historical migrations.
for (const page of ['home', 'index']) {
    execFileSync(process.execPath, [join(root, 'scripts/build-home-assets.mjs'), ...(page === 'index' ? ['--index'] : [])],
        { cwd: root, stdio: 'pipe' });
    const path = `private/${page}-assets.json`, build = JSON.parse(await readFile(join(root, path), 'utf8'));
    paths.add(path);
    for (const file of build.files) {
        if (file !== `private/${page}-built.html` && !new RegExp(`^public/build/${page}/[A-Za-z0-9_-]+\\.(js|css)$`).test(file)) {
            throw new Error('Unexpected build artifact: ' + file);
        }
        paths.add(file);
    }
    for (const source of build.sources) {
        if (hash(await readFile(join(root, source.path))) !== source.sha256) throw new Error('Stale build input: ' + source.path);
        buildInputs.set(source.path, source.sha256);
    }
}
await mkdir(output, { mode: 0o700 }); // An existing release must never be overwritten.
const files = [];
for (const path of [...paths].sort()) {
    const bytes = await readFile(join(root, path)), destination = join(output, 'payload', path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    if (hash(await readFile(destination)) !== hash(bytes)) throw new Error('Release copy mismatch: ' + path);
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
}
const manifest = { version: 1, release: 'community-versions-20261103', createdAt: new Date().toISOString(),
    branch, sourceCommit, sourceState: 'working-tree', readyForInstallation: false,
    baselineNote: 'docs/releases/20261103-local-rollout.md; verify base release plus server.js transport override',
    pending: ['Permitted production SSH/TCP route', 'Live baseline hashes and concurrency guard',
        'Verified backup and additive schema preparation', 'Narrow installation and public health checks'],
    migration: { path: 'scripts/migrate-community-versions-20261103.mjs', requiredBeforeBackend: true,
        addsColumn: 'personal_pie_weights.follow_community_version', defaultValue: 0,
        rewritesExistingData: false, requiresVerifiedBackup: true, replayHistoricalMigrations: false },
    files, unchangedBuildInputs: [...buildInputs].filter(([path]) => !paths.has(path)).map(([path, sha256]) => ({ path, sha256 })) };
const serialized = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(join(output, 'request.json'), serialized, { mode: 0o600 });
await writeFile(join(output, 'request.sha256'), hash(serialized) + '  request.json\n', { mode: 0o600 });
await copyFile(join(root, 'docs/community-versions-20261103.md'), join(output, 'RELEASE.md'));
console.log(JSON.stringify({ output, files: manifest.files.length, readyForInstallation: false, manifestSHA256: hash(serialized) }));
