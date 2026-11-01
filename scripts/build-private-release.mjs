import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
const files = [
    'server.js', 'ranking-service.js', 'navigation-service.js', 'discussion-service.js', 'private-category-service.js', 'snapshot-condition-cleanup.js',
    'private/home.html', 'private/how-it-works.html', 'public/css/ui/private-categories.css',
    'public/js/home.js', 'public/js/home-workspace.js', 'public/js/navigation/model.js', 'public/js/navigation/sidebar.js',
    'public/js/shared/category-route.js', 'public/js/shared/context-selection.js', 'public/js/workspace/state.js',
    'public/js/workspace/discussion-entry.js', 'public/js/discussion.js',
    'ops/task-taxonomy-20261002.json', 'scripts/migrate-private-categories.mjs', 'scripts/migrate-expanded-taxonomy.mjs',
    'scripts/cleanup-condition-snapshots.mjs', 'scripts/prepare-private-release.mjs',
    'test/private-categories.test.mjs', 'test/snapshot-condition-cleanup.test.mjs'
];
const manifest = { createdAt: new Date().toISOString(), files: files.map(path => ({ path,
    sha256: createHash('sha256').update(readFileSync(path)).digest('hex') })) };
writeFileSync('release-manifest.json', JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', 'artifacts/taxonomy-private-pies-20261002/release.tar', 'release-manifest.json', ...files]);
console.log(JSON.stringify({ files: files.length, archive: 'artifacts/taxonomy-private-pies-20261002/release.tar' }));
