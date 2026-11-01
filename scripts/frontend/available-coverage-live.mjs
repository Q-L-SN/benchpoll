import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';

const output = 'D:/Codex-artifacts/website1/available-factor-20261019/live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const userAgentPage = await browser.newPage();
const userAgent = await userAgentPage.evaluate(() => navigator.userAgent);
await userAgentPage.close();
const results = [];
try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 950 }, userAgent: `${userAgent} BenchPoll-QA/coverage-factor-20261019` });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(25000);
        try {
            await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
            const response = await page.goto('https://benchpoll.com/Intelligence');
            assert.equal(response.status(), 200);
            await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
            if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
            const read = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                && response.request().postDataJSON()?.scoreMode === 'available');
            await page.locator('[data-score-mode="available"]').click();
            const ranking = await read;
            assert.equal(ranking.status(), 200);
            assert.equal(ranking.request().postDataJSON().availableInferenceVersion, 4);
            const payload = validateWorkspacePayload(await ranking.json());
            const rows = payload.modelLeaderboards.public.filter(row => row.availableInference);
            assert.ok(rows.length);
            let penalized = 0;
            for (const row of rows) {
                const inference = row.availableInference;
                assert.equal(inference.method, 'pairwise-anchored-coverage-factor');
                assert.ok(Math.abs(inference.coverageFactor - inference.coverageFraction ** .35) < .000001);
                const applied = inference.unpenalizedScore < 0 ? 2 - inference.coverageFactor : inference.coverageFactor;
                assert.ok(Math.abs(inference.appliedFactor - applied) < .000001);
                assert.ok(Math.abs(row.lower - inference.unpenalizedScore * applied) < .011);
                if (inference.coverageFactor < 1) penalized++;
            }
            assert.ok(penalized > 0);
            assert.match(await page.locator('.bp-scoring-help').getAttribute('data-help-text'), /reduces the total when measured coverage is incomplete/);
            await page.locator('.bp-model-row').first().waitFor();
            await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
            await page.locator('#model-rows').evaluate(async rows => {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                await Promise.all(rows.getAnimations({ subtree: true }).filter(animation =>
                    animation.effect.getComputedTiming().iterations !== Infinity).map(animation => animation.finished.catch(() => {})));
            });
            await page.screenshot({ path: `${output}/ranking-${width}.png` });
            await page.goto('https://benchpoll.com/AGI');
            await page.locator('#agi-promo').waitFor();
            await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false'
                && !document.querySelector('#last-updated').textContent.includes('Updating'));
            await page.locator('#agi-promo').evaluate(async promo => {
                await Promise.all(promo.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {})));
            });
            const shared = await page.locator('#agi-promo').evaluate(promo => {
                const path = document.querySelector('#bp-breadcrumb').getBoundingClientRect(), rect = promo.getBoundingClientRect();
                return Boolean(promo.closest('.bp-context-row')) && path.top < rect.bottom && path.bottom > rect.top;
            });
            assert.equal(shared, true);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
            await page.screenshot({ path: `${output}/agi-${width}.png` });
            await page.goto('https://benchpoll.com/account/privacy');
            assert.equal(await page.locator('label[for="request-email"]').innerText(), 'Contact email');
            assert.equal(await page.locator('label[for="request-message"]').innerText(), 'Request details');
            assert.deepEqual(errors, []);
            results.push({ width, availableReadVersion: 4, validatedRows: rows.length, penalizedRows: penalized,
                agiSharesPathRow: true, privateRequestsSubmitted: 0, passed: true });
            console.log(`PASS live ${width}`);
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
