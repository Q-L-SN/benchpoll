import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, relative, isAbsolute, sep, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TOPIC_LIFECYCLE_SOURCES, isTopicLifecyclePath } from './topic-lifecycle-paths-20261102.mjs';

const root = fileURLToPath(new URL('../', import.meta.url)), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) {
    throw new Error('Use an artifact directory outside the source checkout');
}
const branch = execFileSync('git', ['branch', '--show-current'], { cwd: root, encoding: 'utf8' }).trim();
if (branch !== 'codex/cloud-handoff-20261101') throw new Error('Export from the handoff branch only');
const sourceCommit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const paths = new Set(TOPIC_LIFECYCLE_SOURCES), buildInputs = new Map();
for (const page of ['home', 'index']) {
    const path = `private/${page}-assets.json`;
    const manifest = JSON.parse(await readFile(join(root, path), 'utf8'));
    paths.add(path);
    for (const file of manifest.files) paths.add(file);
    for (const source of manifest.sources) {
        if (hash(await readFile(join(root, source.path))) !== source.sha256) throw new Error('Stale frontend build: ' + source.path);
        buildInputs.set(source.path, source.sha256);
    }
}
await mkdir(output, { recursive: true, mode: 0o700 });
const files = [];
for (const path of [...paths].sort()) {
    if (!isTopicLifecyclePath(path)) throw new Error('Outside reviewed release allowlist: ' + path);
    const bytes = await readFile(join(root, path)), after = hash(bytes);
    const target = join(output, 'payload', path);
    await mkdir(dirname(target), { recursive: true });
    await copyFile(join(root, path), target);
    if (hash(await readFile(target)) !== after) throw new Error('Release copy mismatch: ' + path);
    files.push({ path, sha256: after, bytes: bytes.length });
}
const manifest = { version: 1, release: 'topic-lifecycle-20261102', createdAt: new Date().toISOString(), branch, sourceCommit,
    readyForInstallation: false,
    pending: ['Permitted production SSH/TCP route', 'Live baseline hashes and concurrent-change guard', 'Fresh verified database backup', 'Narrow installation and public health checks'],
    migration: { path: 'scripts/migrate-topic-snapshots-20261102.mjs', creates: ['topic_proposal_snapshots'],
        rewritesExistingData: false, requiresVerifiedBackup: true, replayHistoricalMigrations: false },
    files, unchangedBuildInputs: [...buildInputs].filter(([path]) => !paths.has(path)).map(([path, sha256]) => ({ path, sha256 })) };
const text = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(join(output, 'request.json'), text, { flag: 'wx', mode: 0o600 });
await writeFile(join(output, 'request.sha256'), hash(text) + '  request.json\n', { flag: 'wx', mode: 0o600 });
await copyFile(join(root, 'docs/topic-lifecycle-20261102.md'), join(output, 'RELEASE.md'));
console.log(JSON.stringify({ output, files: files.length, bytes: files.reduce((sum, file) => sum + file.bytes, 0),
    readyForInstallation: false, manifestSHA256: hash(text) }));
