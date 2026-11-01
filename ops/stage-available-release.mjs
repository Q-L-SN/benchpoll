import { readFile, writeFile, mkdir, cp, copyFile, readdir, symlink, readlink } from 'node:fs/promises';
import { resolve, join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

const stage = resolve(process.argv[2]), root = '/home/ubuntu/benchpoll';
if (!/^\/home\/ubuntu\/benchpoll\/scripts\/(?:available-score-upgrade|ui-discussion|chart-workspace|showcase-view)-20261012\//.test(stage)) throw new Error('Unsafe staging root');
const manifest = JSON.parse(await readFile(join(stage, 'manifest.json'), 'utf8'));
if (!/^(?:available|ui-discussion|charts|showcase)-20261012-\d+$/.test(manifest.release)) throw new Error('Invalid release');
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const existing = async path => { try { return await hash(path); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
for (const file of manifest.files) {
    if (file.path.split('/').includes('..') || !/^(?:server\.js|ranking-service\.js|ranking-read-cache\.js|pairwise-score\.js|score-field-service\.js|model-comparison\.js|model-run-configuration\.js|score-condition-normalization\.js|run-field-preset-migration\.js|privacy-controls\.js|privacy-headers\.js|moderation-email\.js|scripts\/(?:import-scale-official|import-top16-official|migrate-run-field-presets-20261013|migrate-privacy-controls|check-moderation-email)\.mjs|(?:public|private)\/[a-zA-Z0-9_./-]+)$/.test(file.path)) throw new Error('Unsafe file');
    if (await hash(join(stage, file.path)) !== file.after || await existing(join(root, file.path)) !== file.before) throw new Error('Source changed: ' + file.path);
}
const candidate = join(stage, 'candidate');
await mkdir(candidate, { recursive: true });
for (const entry of await readdir(root)) if (entry.endsWith('.js') || entry === 'package.json') await copyFile(join(root, entry), join(candidate, entry));
await cp(join(root, 'public'), join(candidate, 'public'), { recursive: true });
await cp(join(root, 'private'), join(candidate, 'private'), { recursive: true });
try { await symlink(join(root, 'node_modules'), join(candidate, 'node_modules')); }
catch (e) { if (e.code !== 'EEXIST' || await readlink(join(candidate, 'node_modules')) !== join(root, 'node_modules')) throw e; }
for (const file of manifest.files) {
    await mkdir(dirname(join(candidate, file.path)), { recursive: true });
    await copyFile(join(stage, file.path), join(candidate, file.path));
}
await copyFile(join(root, 'scripts/build-home-assets.mjs'), join(stage, 'build-tools/build-home-assets.mjs'));
const { buildHomeAssets } = await import(join(stage, 'build-tools/build-home-assets.mjs'));
const assets = await buildHomeAssets(candidate);
manifest.sources = [];
for (const source of assets.sources) if (!manifest.files.some(f => f.path === source.path)) {
    const before = await hash(join(root, source.path));
    if (before !== source.sha256) throw new Error('Concurrent build source change: ' + source.path);
    manifest.sources.push({ path: source.path, before });
}
for (const path of [...assets.files, 'private/home-assets.json']) {
    const before = await existing(join(root, path)), after = await hash(join(candidate, path));
    if (before === after) continue;
    await mkdir(dirname(join(stage, path)), { recursive: true });
    await copyFile(join(candidate, path), join(stage, path));
    manifest.files.push({ path, before, after });
}
await writeFile(join(stage, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(JSON.stringify({ candidate, release: manifest.release, files: manifest.files.length, sourceGuards: manifest.sources.length, businessWrites: 0 }));
