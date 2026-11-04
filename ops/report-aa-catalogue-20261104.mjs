import { readFile, writeFile } from 'node:fs/promises';

const receipt = JSON.parse(await readFile(process.argv[2], 'utf8'));
if (!receipt.applied || !receipt.verified) throw new Error('A verified production receipt is required');
const cell = value => String(value).replaceAll('|', '\\|').replaceAll('\n', ' ');
const aaParents = new Set(receipt.benchmarks.map(row => row.ID));
const lines = [
    '# AA Catalogue Archive: 2026-11-04', '',
    `Applied and verified at ${receipt.appliedAt}.`, '',
    `- Archived benchmarks: ${receipt.benchmarks.length}.`,
    `- Archived versions: ${receipt.versions.length}, including versions under the archived benchmarks.`,
    `- Archived accepted score rows: ${receipt.archivedResultCount}. Original values and provenance were preserved.`,
    `- New empty default versions: ${receipt.createdDefaults.length}. No AA scores were transferred.`,
    `- Removed personal-weight sectors: ${receipt.removedWeights}. The affected allocation was entirely AA and is now empty.`,
    '- Independent versions and independently sourced scores on mixed benchmarks remain available.',
    '- The existing conservative exclusion of possibly AA-derived rows outside the archived versions remains unchanged; uncertain provenance alone was not used to archive independent versions.',
    '', '## Archived Benchmarks', '', '| ID | Benchmark | Archived versions |', '| --- | --- | ---: |'
];
for (const row of receipt.benchmarks) lines.push(`| ${row.ID} | ${cell(row.name)} | ${receipt.versions.filter(version => version.benchmarkID === row.ID).length} |`);
lines.push('', '## AA Versions Archived Under Retained Benchmarks', '', '| Version ID | Benchmark | Version |', '| --- | --- | --- |');
for (const row of receipt.versions.filter(version => !aaParents.has(version.benchmarkID))) lines.push(`| ${row.ID} | ${cell(row.benchmark)} | ${cell(row.name)} |`);
lines.push('', '## New Empty Defaults', '', '| Benchmark | New version ID | Name | Scores |', '| --- | --- | --- | ---: |');
for (const row of receipt.createdDefaults) lines.push(`| ${cell(row.benchmark)} | ${row.ID} | default | 0 |`);
lines.push('', '## Replacement Primary Versions', '', '| Benchmark | Version ID | Retained independent version |', '| --- | --- | --- |');
for (const row of receipt.primaryChanges) lines.push(`| ${cell(row.benchmark)} | ${row.ID} | ${cell(row.name)} |`);
lines.push('', '## Complete Version Inventory', '', '| Version ID | Benchmark ID | Benchmark | Version | Original key |', '| --- | --- | --- | --- | --- |');
for (const row of receipt.versions) lines.push(`| ${row.ID} | ${row.benchmarkID} | ${cell(row.benchmark)} | ${cell(row.name)} | ${cell(row.key)} |`);
lines.push('', '## Operational Record', '',
    '- Batch: `aa-catalogue-archive-20261104` in `aa_data_archive_runs` and `aa_data_archive_items`.',
    '- Fresh full database backup passed gzip and SHA-256 verification before mutation.',
    '- Archival uses inactive benchmark rows, soft-deleted version rows, archived score status, and complete original-row audit records. No score rows were deleted.',
    '- The transaction verified every score identity and raw value, unaffected result statuses, and protected user/discussion/proposal/mail/Arena tracking records.',
    '- Existing version keys were retained as tombstones. The scheduled Arena importer had zero tracking overlap with this batch.',
    '- Do not blindly rerun historical AA restoration or Scale import scripts against archived identities.',
    '- Restoration requires the committed archive-state digest and refuses changed rows. Review intervening changes before any production restoration.',
    '- No unrelated source deployment or pending cloud scene migration was included.', '');
await writeFile(process.argv[3], lines.join('\n'));
