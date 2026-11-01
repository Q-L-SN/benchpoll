import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/primary-benchmark-conditions-20261002');
const files = [
    'server.js', 'ranking-service.js', 'ranking-pagination.js', 'benchmark-primary-condition.js',
    'private/home.html', 'private/contribute.html', 'private/how-it-works.html', 'public/css/contribute.css',
    'public/js/home-workspace.js', 'public/js/contribute.js', 'public/js/workspace/contracts.js',
    'public/js/workspace/state.js', 'public/js/contribution/contracts.js', 'public/js/shared/benchmark-condition-groups.js',
    'scripts/migrate-primary-benchmark-conditions.mjs', 'scripts/rehearse-primary-benchmark-conditions.mjs',
    'scripts/prepare-primary-conditions-release.mjs', 'scripts/verify-primary-conditions-db.mjs',
    'scripts/import-arena-latest.mjs', 'scripts/import-aa-current.mjs', 'scripts/import-top16-official.mjs'
];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
