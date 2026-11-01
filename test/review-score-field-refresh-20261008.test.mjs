import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runScoreFieldRefreshReview, scoreFieldRefreshScenarios } from '../scripts/frontend/review-score-field-refresh-20261008.mjs';

test('historical field services remain available but public definition and option mutation controls are withdrawn', async () => {
    const root = process.env.SCORE_FIELD_REFRESH_BASELINE
        ? resolve(process.env.SCORE_FIELD_REFRESH_BASELINE) : fileURLToPath(new URL('../', import.meta.url));
    const service = await readFile(join(root, 'score-field-service.js'), 'utf8');
    const editor = await readFile(join(root, 'public/js/contribution/score-fields.js'), 'utf8');
    assert.match(service, /definition\.type !== current\.field_type\) error\('field_type_immutable', 409\)/);
    assert.match(editor, /\['effort', 'harness'\]/);
    assert.doesNotMatch(editor, /createFieldForm|submit_contribution|Propose|Change field|Change option/);
});

for (const engine of ['chromium', 'webkit']) {
    for (const width of [1440, 390]) {
        test(`actual mountScoreFields refresh controls: ${engine} ${width}`, { timeout: 180000 }, async () => {
            const report = await runScoreFieldRefreshReview({
                baseline: process.env.SCORE_FIELD_REFRESH_BASELINE,
                output: process.env.SCORE_FIELD_REFRESH_OUTPUT ? join(process.env.SCORE_FIELD_REFRESH_OUTPUT, `${engine}-${width}`) : undefined,
                engines: [engine], widths: [width]
            });
            assert.equal(report.total, scoreFieldRefreshScenarios.length);
            assert.equal(report.offline, true);
            assert.equal(report.appServerStarted, false);
            assert.deepEqual(report.results.flatMap(result => result.unexpectedRequests), []);
            assert.deepEqual(report.results.flatMap(result => result.errors), []);
            assert.deepEqual(report.results.filter(result => !result.passed)
                .map(result => ({ scenario: result.scenario, failures: result.failedChecks })), []);
        });
    }
}
