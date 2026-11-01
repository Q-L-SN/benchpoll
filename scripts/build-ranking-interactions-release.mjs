import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/ranking-interactions-20261002');
mkdirSync(output, { recursive: true });
const files = [
    'server.js', 'ranking-service.js', 'ranking-pagination.js', 'model-comparison.js',
    'package.json', 'package-lock.json', 'private/home.html', 'private/contribute.html', 'private/how-it-works.html',
    'public/js/shared/search.js', 'public/js/shared/benchmark-condition-groups.js',
    'public/js/vendor/fuse-7.5.0.js', 'public/js/vendor/fuse-LICENSE.txt',
    'public/js/home-workspace.js', 'public/js/contribute.js',
    'public/js/workspace/model-scores.js', 'public/js/workspace/contracts.js', 'public/js/workspace/comparison-controls.js',
    'public/js/navigation/model.js', 'public/js/navigation/sidebar.js',
    'public/js/contribution/fields.js', 'public/js/contribution/score-fields.js',
    'public/css/home-v2.css', 'public/css/ui/workspace.css', 'public/css/ui/evidence.css', 'public/css/model-comparison.css',
    'scripts/prepare-ranking-interactions-release.mjs', 'scripts/verify-ranking-interactions-db.mjs',
    'test/ranking-interactions.test.mjs', 'test/ranking-service.test.mjs',
    'test/model-comparison.test.mjs', 'test/ranking-pagination.test.mjs'
];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
