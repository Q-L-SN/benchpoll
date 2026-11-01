import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/privacy-mobile-20261002');
mkdirSync(output, { recursive: true });
const files = [
    'server.js', 'private/privacy.html', 'private/terms.html', 'private/home.html',
    'private/contribute.html', 'private/how-it-works.html',
    'public/js/legal.js', 'public/js/home.js', 'public/js/home-workspace.js',
    'public/js/shared/category-route.js', 'public/js/shared/taxonomy-drawer.js',
    'public/css/legal.css', 'public/css/home-v2.css', 'public/css/ui/shell.css',
    'public/css/ui/workspace.css', 'public/css/ui/private-categories.css',
    'test/privacy-mobile.test.mjs', 'test/home-workspace-view-contract.test.mjs',
    'scripts/prepare-privacy-mobile-release.mjs'
];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
