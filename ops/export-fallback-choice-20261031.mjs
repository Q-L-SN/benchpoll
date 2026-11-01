import { readFile, mkdir, copyFile, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join, dirname, relative, isAbsolute, sep } from 'node:path';

const root = resolve('.'), output = resolve(process.argv[2] || '.');
const offset = relative(root, output);
if (!process.argv[2] || !offset || !isAbsolute(offset) && offset !== '..' && !offset.startsWith('..' + sep)) throw new Error('Use an external artifact directory');
const releases = ['topic-scenes-20261031-1793459100007', 'weight-treemap-20261031-1793459100008'];
const hashes = ['a3db8d2e65625e98c0aa87134e519b96688f0460f397d27f7db23c071f0e775d', '031e2e1be81bcd0869d94d4217935c26c6194d4a726072ce066ec2e863811b66'];
const baseline = new Map();
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
for (const [index, release] of releases.entries()) {
    const bytes = await readFile(`D:/Codex-artifacts/website1/${release}/manifest.json`);
    if (sha(bytes) !== hashes[index]) throw new Error('Unexpected production baseline');
    const manifest = JSON.parse(bytes);
    for (const source of manifest.sources) if (!baseline.has(source.path)) baseline.set(source.path, source.before);
    for (const file of manifest.files) baseline.set(file.path, file.after);
}
const paths = [
    'private/home.html', 'ranking-service.js', 'topic-home-service.js', 'scripts/migrate-fallback-choice-source-20261031.mjs',
    'public/js/home-workspace.js', 'public/js/topics-home.js',
    'public/js/shared/fallback-choice.js', 'public/js/shared/topic-label.js',
    'public/js/workspace/fallback-picker.js', 'public/js/workspace/contracts.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/pie-renderer.js', 'public/js/workspace/pie-label-layout.js',
    'public/js/workspace/topic-references.js', 'public/js/workspace/topic-reference-search.js', 'public/js/workspace/scenes.js',
    'public/css/ui/workspace.css', 'public/css/ui/fallback.css', 'public/css/ui/fallback-picker.css',
    'public/css/ui/evidence.css', 'public/css/ui/topic-scenes.css'
];
const files = [];
for (const path of paths) {
    const bytes = await readFile(join(root, path)), after = sha(bytes), before = baseline.get(path) ?? null;
    if (after === before) continue;
    await mkdir(dirname(join(output, 'payload', path)), { recursive: true });
    await copyFile(join(root, path), join(output, 'payload', path));
    files.push({ path, baseline: before, after });
}
await mkdir(output, { recursive: true });
await mkdir(join(output, 'tools'), { recursive: true });
for (const path of ['flat-topics-stage-20261022.mjs', 'launch-release.mjs', 'prepare-fallback-choice-schema-20261031.mjs']) {
    await copyFile(join(root, 'ops', path), join(output, 'tools', path));
}
await writeFile(join(output, 'request.json'), JSON.stringify({ migration: 'migrate-fallback-choice-source-20261031.mjs', files }, null, 2), { flag: 'wx' });
console.log(JSON.stringify({ output, files: files.length, newFiles: files.filter(file => file.baseline === null).map(file => file.path) }));
