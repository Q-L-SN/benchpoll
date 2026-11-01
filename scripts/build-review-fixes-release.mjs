import { readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.join(root, 'artifacts/review-fixes-20261004');
mkdirSync(output, { recursive: true });
const files = [
    'arena-import-plan.js', 'arena-sync.js', 'arena-sync-conflicts.js', 'model-run-configuration.js',
    'model-comparison.js', 'ranking-service.js', 'score-evidence.js', 'moderation-admin.js', 'server.js',
    'condition-precision-filter.js', 'cross-benchmark-score-audit.js', 'condition-score-overlap.js',
    'private/censor.html', 'public/js/censor.js', 'public/js/home-workspace.js',
    'public/js/workspace/comparison-controls.js', 'public/js/workspace/contracts.js', 'public/js/workspace/model-scores.js',
    'scripts/import-arena-latest.mjs', 'scripts/migrate-model-run-configurations.mjs', 'scripts/install-score-sync.mjs',
    'scripts/migrate-arena-review-conflicts.mjs', 'scripts/rehearse-review-fixes.mjs',
    'scripts/prepare-review-fixes-release.mjs', 'scripts/build-review-fixes-release.mjs',
    'scripts/frontend/review-regressions.mjs', 'scripts/frontend/fixtures.mjs', 'scripts/frontend/server.mjs',
    'scripts/apply-curated-condition-merges.mjs', 'scripts/import-top16-official.mjs', 'scripts/prepare-precision-semantic-merges.mjs',
    'test/arena-import-plan.test.mjs', 'test/arena-sync.test.mjs', 'test/arena-sync-conflicts.test.mjs',
    'test/model-run-configuration.test.mjs', 'test/model-run-migration.test.mjs', 'test/model-comparison.test.mjs',
    'test/scoring-mode-samples.test.mjs', 'test/current-score-contract.test.mjs', 'test/ranking-performance-contract.test.mjs',
    'test/ranking-service.test.mjs', 'test/score-aggregation.test.mjs', 'test/score-fields.test.mjs', 'test/score-evidence.test.mjs',
    'docs/arena-source-import.md', 'docs/score-fields.md', 'README.md', 'package.json'
];
const releaseFiles = [...new Set([...files, ...readdirSync(path.join(root, 'test')).filter(file => file.endsWith('.mjs')).map(file => `test/${file}`)])];
const manifest = { createdAt: new Date().toISOString(), files: releaseFiles.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...releaseFiles]);
console.log(JSON.stringify({ files: releaseFiles.length, archive: path.join(output, 'release.tar') }));
