import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const output = path.resolve(process.env.BENCHPOLL_MODEL_RUN_RELEASE_OUTPUT || path.join(root, 'artifacts/model-run-suffixes-20261004'));
mkdirSync(output, { recursive: true });
const files = ['model-run-configuration.js', 'scripts/migrate-model-run-configurations.mjs',
    'scripts/register-model-run-fields.mjs', 'scripts/rehearse-model-run-suffixes.mjs',
    'scripts/prepare-review-fixes-release.mjs', 'scripts/build-model-run-suffix-release.mjs',
    'test/model-run-configuration.test.mjs', 'test/model-run-migration.test.mjs',
    'test/model-run-fields.test.mjs', 'docs/arena-source-import.md'];
const manifest = { createdAt: new Date().toISOString(), files: files.map(file => ({ path: file,
    sha256: createHash('sha256').update(readFileSync(path.join(root, file))).digest('hex') })) };
writeFileSync(path.join(output, 'release-manifest.json'), JSON.stringify(manifest, null, 2));
execFileSync('tar', ['-cf', path.join(output, 'release.tar'), '-C', output, 'release-manifest.json', '-C', root, ...files]);
console.log(JSON.stringify({ files: files.length, archive: path.join(output, 'release.tar') }));
