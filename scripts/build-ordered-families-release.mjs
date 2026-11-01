import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/ordered-families-20261004');
const baseline = JSON.parse(fs.readFileSync(path.join(output, 'remote-before/baseline.json'), 'utf8'));
const files = [
    'ranking-service.js', 'ranking-pagination.js', 'condition-impact.js', 'server.js', 'benchmark-family-service.js',
    'private/home.html', 'private/how-it-works.html', 'public/css/home-v2.css', 'public/css/ui/fallback.css',
    'public/js/home-workspace.js', 'public/js/workspace/contracts.js', 'public/js/workspace/constants.js',
    'public/js/workspace/state.js', 'public/js/workspace/guest-drafts.js', 'public/js/workspace/model-scores.js',
    'public/js/workspace/family-view.js', 'public/js/shared/benchmark-families.js', 'public/js/shared/benchmark-condition-groups.js',
    'scripts/migrate-ordered-benchmark-families.mjs', 'scripts/check-ranking-integrity.mjs',
    'scripts/rehearse-ordered-families.mjs', 'scripts/prepare-ordered-families-release.mjs',
    'test/benchmark-families.test.mjs', 'test/public-fallback.test.mjs', 'test/personal-fallback-contract.test.mjs',
    'scripts/frontend/fixtures.mjs'
];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    expected: baseline.find(row => row.path === file)?.sha256 ?? null,
    sha256: createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex') })) };
fs.writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
