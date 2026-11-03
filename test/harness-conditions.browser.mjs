import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { createLifecycleDatabase } from './helpers/lifecycle-mysql.mjs';
import { harnessReview, seedHarnessReview } from './helpers/harness-conditions-fixture.mjs';
import { previewHarnessSplit, applyHarnessSplit } from '../scripts/split-arc-harness-conditions-20261103.mjs';
import { getBenchmarkScores } from '../benchmark-scores.js';
import { getBenchmarkInformation } from '../benchmark-details.js';
import { getRankingWorkspace, savePersonalPie } from '../ranking-service.js';
import { createRankingPager } from '../ranking-pagination.js';
import { ensureTopicRootContext } from '../topic-scenes-service.js';

test('desktop and mobile show the standard default and let readers open the separate official adapter scores', { timeout: 90000 }, async t => {
    const database = await createLifecycleDatabase(); t.after(() => database.close());
    const { pool } = database; await seedHarnessReview(pool);
    await pool.execute("INSERT INTO categories (ID, name, slug, description) VALUES (54, 'Intelligence', 'intelligence', 'ARC harness preview.')");
    await ensureTopicRootContext(pool, 54);
    await savePersonalPie(pool, { userID: '42', writeIdentity: randomUUID(), categoryID: 54, contextValues: {}, expectedRevision: 0,
        entries: [{ conditionID: 22186, weightBasisPoints: 10000 }], fallbackRules: [] });
    const connection = await pool.getConnection();
    try {
        const plan = await previewHarnessSplit(connection, harnessReview);
        await applyHarnessSplit(connection, harnessReview, { expectedPlanHash: plan.planHash });
    } finally { connection.release(); }
    const preview = await startConfigSidebarPreview(); preview.state.authenticated = false;
    t.after(() => preview.close());
    const pager = createRankingPager(), requests = [], errors = [];
    for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) {
        await t.test(`${engine.name()} ${width}`, async () => {
            const browser = await engine.launch({ headless: true });
            try {
                const page = await browser.newPage({ viewport: { width, height: 1000 }, isMobile: width < 500, hasTouch: width < 500 });
                page.on('pageerror', error => errors.push(error.message));
                await page.route('**/api/**', async route => {
                    const path = new URL(route.request().url()).pathname, body = route.request().postDataJSON();
                    requests.push(path);
                    let payload;
                    if (path === '/api/get_weighted_workspace') {
                        const workspace = await getRankingWorkspace(pool, { userID: null, categoryID: 54, contextValues: {},
                            scoreMode: body.scoreMode, estimationAlgorithm: body.estimationAlgorithm,
                            comparison: { mode: 'best', keys: ['model'] }, previewPersonalPie: body.previewPersonalPie, jsonMemberMetadata: true });
                        payload = pager.create(workspace, { userID: null, initialMode: 'public' });
                    } else if (path === '/api/get_benchmark_information') payload = await getBenchmarkInformation(pool, body);
                    else if (path === '/api/get_benchmark_scores') payload = await getBenchmarkScores(pool, body);
                    else return route.continue();
                    await route.fulfill({ contentType: 'application/json', body: JSON.stringify(payload) });
                });
                await page.goto(preview.url + '/intelligence');
                await page.waitForSelector('.bp-model-row');
                if (width < 500) await page.locator('button[data-mobile-panel="mix"]').click();
                const row = page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="22186"]');
                await row.waitFor({ state: 'visible' });
                await row.evaluate(element => element.scrollIntoView({ block: 'center' }));
                await mkdir('artifacts/harness-conditions-20261103', { recursive: true });
                await page.screenshot({ path: `artifacts/harness-conditions-20261103/${engine.name()}-${width}-composition.png` });
                await row.locator('.bp-benchmark-information-link .bp-benchmark-link-name').click();
                await page.waitForSelector('#benchmark-information[aria-busy="false"]');
                assert.equal((await page.locator('#benchmark-information-condition').innerText()).trim(), 'Standard harness · Semi-private');
                await page.locator('#benchmark-scores-open').click();
                await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 45);
                assert.equal(await page.locator('#benchmark-scores-condition').inputValue(), '22186');
                assert.equal(await page.locator('#benchmark-scores-count').innerText(), '45 approved scores');
                await mkdir('artifacts/harness-conditions-20261103', { recursive: true });
                await page.screenshot({ path: `artifacts/harness-conditions-20261103/${engine.name()}-${width}-standard.png` });
                await page.getByRole('combobox', { name: 'Benchmark version' }).click();
                await page.getByRole('option', { name: 'Provider Adapter · Semi-private (16)', exact: true }).click();
                await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 16);
                assert.equal(await page.locator('#benchmark-scores-count').innerText(), '16 approved scores');
                assert.match(await page.locator('.benchmark-score-row').first().innerText(), /99\.945712/);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
                await page.screenshot({ path: `artifacts/harness-conditions-20261103/${engine.name()}-${width}-adapter.png` });
            } finally { await browser.close(); }
        });
    }
    assert.deepEqual(errors, []);
    assert.equal(requests.some(path => /submit|save|vote|delete/.test(path)), false);
});
