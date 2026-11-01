import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const args = process.argv.slice(2);
if (args.some(argument => !['--sync-fetch-only', '--model-config-only'].includes(argument)) || args.length > 1) throw new Error('Unknown release argument');
const fetchOnly = args.includes('--sync-fetch-only');
const configOnly = args.includes('--model-config-only');
const output = path.join(root, fetchOnly ? 'artifacts/arena-source-fetch-20261004'
    : configOnly ? 'artifacts/arena-model-config-20261004' : 'artifacts/arena-workspace-20261003');
mkdirSync(output, { recursive: true });
const files = fetchOnly ? ['arena-source-fetch.js', 'arena-sync.js', 'scripts/fetch-arena-latest.mjs',
    'test/arena-source-fetch.test.mjs', 'test/arena-sync.test.mjs', 'docs/arena-source-import.md', 'README.md']
    : configOnly ? ['model-run-configuration.js', 'test/model-run-configuration.test.mjs', 'docs/arena-source-import.md']
    : ['server.js', 'benchmark-details.js', 'score-sync-service.js', 'model-run-configuration.js', 'arena-source-fetch.js',
    'arena-sync.js', 'discussion-service.js', 'moderation-admin.js', 'package.json', 'package-lock.json', 'README.md',
    'private/home.html', 'private/contribute.html', 'private/how-it-works.html',
    'public/js/home-workspace.js', 'public/js/discussion.js', 'public/js/contribute.js',
    'public/js/home.js', 'public/js/navigation/sidebar.js', 'public/css/ui/navigation.css',
    'public/js/workspace/discussion-entry.js', 'public/js/workspace/comparison-controls.js',
    'public/css/home-v2.css', 'public/css/ui/workspace.css', 'public/css/discussion.css', 'public/css/contribute.css',
    'docs/arena-source-import.md', 'scripts/fetch-arena-latest.mjs', 'scripts/import-arena-latest.mjs',
    'scripts/register-score-sync.mjs', 'scripts/run-score-sync.mjs', 'scripts/migrate-benchmark-details.mjs',
    'scripts/migrate-model-run-configurations.mjs', 'scripts/rehearse-arena-workspace.mjs',
    'scripts/model-identity-resolutions-20261004.json',
    'scripts/score-configuration-resolutions-20261004.json',
    'scripts/prepare-arena-workspace-release.mjs', 'scripts/install-score-sync.mjs',
    'ops/systemd/benchpoll-score-sync.service', 'ops/systemd/benchpoll-score-sync.timer',
    'test/benchmark-details.test.mjs', 'test/score-sync-service.test.mjs', 'test/model-run-configuration.test.mjs',
    'test/arena-sync.test.mjs', 'test/arena-source-fetch.test.mjs', 'test/canonical-data-contract.test.mjs', 'test/moderation-admin.test.mjs',
    'test/home-workspace-view-contract.test.mjs', 'test/home-change-ui-contract.test.mjs'];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
