import { readFile, writeFile, mkdir, copyFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url)), output = process.argv[2] && resolve(process.argv[2]);
if (!output || process.argv.length !== 3) throw new Error('Supply a new release directory outside the source checkout');
// The previous exporter verifies the branch, frontend inputs and its narrow
// allowlist. Keep all earlier authorized but undeployed changes in this package.
execFileSync(process.execPath, [join(root, 'ops/export-estimation-lab-20261103.mjs'), output], { cwd: root, stdio: 'pipe' });
const hash = value => createHash('sha256').update(value).digest('hex');
const path = join(output, 'request.json'), manifest = JSON.parse(await readFile(path, 'utf8'));
for (const name of ['benchmark-harness-split.js', 'scripts/split-arc-harness-conditions-20261103.mjs', 'ops/arc-harness-review-20261103.json']) {
    const bytes = await readFile(join(root, name)), destination = join(output, 'payload', name);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, bytes, { flag: 'wx' });
    if (hash(await readFile(destination)) !== hash(bytes)) throw new Error('Harness release copy mismatch');
    manifest.files.push({ path: name, sha256: hash(bytes), bytes: bytes.length });
}
manifest.release = 'harness-conditions-20261103';
manifest.createdAt = new Date().toISOString();
manifest.files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
manifest.dataMigrations = [{ path: 'scripts/split-arc-harness-conditions-20261103.mjs',
    review: 'ops/arc-harness-review-20261103.json', reviewSHA256: hash(await readFile(join(root, 'ops/arc-harness-review-20261103.json'))),
    reviewedAcceptedScores: 611, scoreConditionMoves: 71, createsConditions: 5, schemaChanges: false,
    rewritesScoreValues: false, rewritesSavedWeights: false, requiresFreshDatabasePlanAndVerifiedBackup: true,
    replayHistoricalMigrations: false }];
manifest.pending.push('Fresh database harness inventory, pending moderation review and guarded data plan');
const serialized = JSON.stringify(manifest, null, 2) + '\n';
await writeFile(path, serialized, { mode: 0o600 });
await writeFile(join(output, 'request.sha256'), hash(serialized) + '  request.json\n', { mode: 0o600 });
await copyFile(join(output, 'RELEASE.md'), join(output, 'ESTIMATION-CHANGES.md'));
await copyFile(join(root, 'docs/harness-conditions-20261103.md'), join(output, 'RELEASE.md'));
console.log(JSON.stringify({ output, files: manifest.files.length, readyForInstallation: false, manifestSHA256: hash(serialized) }));
