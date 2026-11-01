import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/arena-current-scores-20261003');
mkdirSync(output, { recursive: true });
const files = ['server.js', 'ranking-service.js', 'score-aggregation.js', 'score-source-policy.js',
    'moderation-admin.js', 'arena-sync.js', 'arena-import-plan.js', 'README.md',
    'private/contribute.html', 'private/how-it-works.html', 'public/js/contribute.js',
    'public/js/contribution/contracts.js', 'public/css/contribute.css', 'docs/arena-source-import.md',
    'scripts/fetch-arena-latest.mjs', 'scripts/import-arena-latest.mjs', 'scripts/migrate-arena-sync-state.mjs',
    'scripts/rehearse-arena-current-scores.mjs', 'scripts/prepare-arena-current-scores-release.mjs',
    'scripts/backup-arena-current-scores.mjs', 'test/arena-sync.test.mjs', 'test/current-score-contract.test.mjs',
    'scripts/verify-arena-current-scores.mjs',
    'test/score-source-policy.test.mjs', 'test/canonical-data-contract.test.mjs',
    'test/object-notes.test.mjs', 'test/home-change-ui-contract.test.mjs'];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
