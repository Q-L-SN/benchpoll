import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/contribution-polish-20261004');
mkdirSync(output, { recursive: true });
const baseline = JSON.parse(readFileSync(path.join(output, 'remote-baseline.json'), 'utf8'));
if (baseline.some(file => file.match !== true)) throw Error('Local pre-edit files differ from production');
const files = [
    'benchmark-scores.js', 'server.js', 'private/home.html', 'private/contribute.html',
    'public/js/discussion.js', 'public/js/workspace/benchmark-scores.js', 'public/js/shared/relative-date.js',
    'public/js/contribute.js', 'public/js/contribution/score-fields.js', 'public/js/global.js',
    'public/css/contribute.css', 'public/css/discussion.css', 'public/css/site-palette.css',
    'test/benchmark-scores.test.mjs', 'test/relative-date.test.mjs',
    'scripts/frontend/server.mjs', 'scripts/frontend/contribution-polish.mjs', 'scripts/frontend/contribution-polish-live.mjs', 'scripts/build-contribution-polish-release.mjs'
];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
