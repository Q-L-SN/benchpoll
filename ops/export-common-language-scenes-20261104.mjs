import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SOURCES = [
    'private/home.html', 'public/js/shared/config-sidebar.js', 'public/js/shared/topics.js',
    'private-topic-service.js', 'topic-reference-service.js', 'topic-scenes-service.js',
    'scripts/migrate-common-language-scenes-20261104.mjs', 'ops/common-language-scenes-20261104.json'
];
const root = fileURLToPath(new URL('../', import.meta.url));
const output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Supply a new release directory outside the checkout');
const offset = relative(root, output);
if (!offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) throw new Error('Release output must be outside the checkout');
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
if (branch !== 'codex/cloud-handoff-20261101') throw new Error('Export from the handoff branch only');
if (execFileSync('git', ['status', '--porcelain'], { cwd: root, encoding: 'utf8' }).trim()) throw new Error('Commit the reviewed changes before exporting');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = new Set(SOURCES), buildInputs = new Map();
for (const page of ['home', 'index']) {
    execFileSync(process.execPath, [join(root, 'scripts/build-home-assets.mjs'), ...(page === 'index' ? ['--index'] : [])], { cwd: root, stdio: 'pipe' });
    const path = `private/${page}-assets.json`, build = JSON.parse(await readFile(join(root, path), 'utf8'));
    paths.add(path);
    for (const file of build.files) {
        if (file !== `private/${page}-built.html` && !new RegExp(`^public/build/${page}/[A-Za-z0-9_-]+\\.(js|css)$`).test(file)) throw new Error('Unexpected build artifact: ' + file);
        paths.add(file);
    }
    for (const source of build.sources) {
        if (hash(await readFile(join(root, source.path))) !== source.sha256) throw new Error('Stale build input: ' + source.path);
        buildInputs.set(source.path, source.sha256);
    }
}
await mkdir(output, { mode: 0o700 });
const files = [];
for (const path of [...paths].sort()) {
    const bytes = await readFile(join(root, path)), destination = join(output, 'payload', path);
    await mkdir(dirname(destination), { recursive: true }); await writeFile(destination, bytes);
    if (hash(await readFile(destination)) !== hash(bytes)) throw new Error('Release copy mismatch: ' + path);
    files.push({ path, sha256: hash(bytes), bytes: bytes.length });
}
const manifest = { version: 1, release: 'common-language-scenes-20261104', createdAt: new Date().toISOString(),
    branch, sourceCommit, sourceState: 'clean-commit', readyForInstallation: false,
    baselineNote: 'docs/releases/20261104-scene-community-rollout.md; reconcile any later deployment before installation',
    pending: ['Permitted production connection', 'Live baseline and dependency hashes', 'Paused writes and verified fresh backup',
        'Install allowlisted source/assets', 'Inspect and apply the exact reviewed scene plan', 'Resume services and verify public reads'],
    migrations: [{ path: 'scripts/migrate-common-language-scenes-20261104.mjs',
        specification: 'ops/common-language-scenes-20261104.json', applyAfterCode: true,
        requiresReviewedPlanHash: true, requiresVerifiedBackup: true, defaultReadOnly: true,
        retainedLanguageScenes: 9, retiredLanguageScenes: 176, codingScenes: 11,
        preservesExistingContextIDs: true, deletesUserData: false }],
    replayHistoricalMigrations: false, files,
    unchangedBuildInputs: [...buildInputs].filter(([path]) => !paths.has(path)).map(([path, sha256]) => ({ path, sha256 })) };
const serialized = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(join(output, 'request.json'), serialized, { mode: 0o600 });
await writeFile(join(output, 'request.sha256'), hash(serialized) + '  request.json\n', { mode: 0o600 });
await copyFile(join(root, 'docs/common-language-scenes-20261104.md'), join(output, 'RELEASE.md'));
console.log(JSON.stringify({ output, files: files.length, sourceCommit, readyForInstallation: false, manifestSHA256: hash(serialized) }));
