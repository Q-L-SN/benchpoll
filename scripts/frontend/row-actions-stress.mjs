import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

const runs = [];
for (let iteration = 1; iteration <= 3; iteration++) {
    const output = execFileSync(process.execPath, ['scripts/frontend/benchmark-row-inspection.mjs'], {
        encoding: 'utf8', env: { ...process.env, BENCHMARK_ROW_CHECK: 'chromium-inspection-390', BENCHMARK_ROW_MOTION: 'no-preference' }
    });
    assert.match(output, /PASS chromium-inspection-390/);
    runs.push({ iteration, passed: true });
    console.log(`PASS mobile row actions ${iteration}/3`);
}
await writeFile('artifacts/fallback-chain-polish-20261006/row-actions/repeated-mobile-checks.json', JSON.stringify(runs, null, 2));
