import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { AA_DISPLAY_MESSAGE, AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';

const output = 'D:/Codex-artifacts/website1/aa-details-20261031';
const browsers = new Map();
before(async () => {
    await mkdir(output, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

async function setup(t, engine, width) {
    const app = await startPreview({ aaBenchmarks: true, secondaryBenchmark: true });
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 820 }, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await context.close(); await app.close(); assert.deepEqual(errors, []); });
    return { app, page, context };
}

for (const engine of ['chromium', 'webkit']) for (const width of [393, 1440]) {
    test(`${engine} ${width}px AA benchmark link shows a policy notice without protected detail content`, async t => {
        const { app, page, context } = await setup(t, engine, width);
        await context.route('**/api/get_benchmark_information', async route => {
            const body = route.request().postDataJSON();
            if (body.conditionID !== 9901) return route.continue();
            await route.fulfill({ json: { benchmarkID: 9902, conditionID: 9901, name: 'AA-Example', conditionName: 'Overall',
                isPrimaryCondition: true, introductionURL: 'https://example.org/aa', displayRestriction: AA_DISPLAY_RESTRICTION,
                description: 'Must not be rendered', differenceExplanation: 'Must not be rendered', scoresUpdatedAt: null } });
        });
        await context.route('**/api/get_benchmark_scores', route => route.fulfill({ json: {
            benchmarkID: 9902, conditionID: 9901, displayRestriction: AA_DISPLAY_RESTRICTION,
            conditions: [{ ID: 9901, name: 'Overall', usesPercentageScale: true, scoreCount: null, displayRestriction: AA_DISPLAY_RESTRICTION }],
            scores: [], nextBeforeID: null
        } }));
        await page.goto(`${app.url}/Intelligence`);
        await page.waitForSelector('#benchmark-rows .bp-benchmark-row');
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#benchmark-search').fill('AA Example');
        await page.locator('#benchmark-rows [data-condition-id="9901"] .bp-benchmark-information-link').click();
        await page.waitForFunction(message => document.querySelector('#benchmark-information-status').textContent === message, AA_DISPLAY_MESSAGE);
        assert.equal(await page.locator('#benchmark-information-name a').getAttribute('target'), '_blank');
        assert.equal(await page.locator('#benchmark-information-description').isVisible(), false);
        assert.equal(await page.locator('#benchmark-information-differences').isVisible(), false);
        assert.equal(await page.locator('#benchmark-information-weights').isVisible(), false);
        assert.equal(await page.locator('.benchmark-information-meta').isVisible(), false);
        assert.equal(await page.locator('#benchmark-information-change').isVisible(), false);
        assert.doesNotMatch(await page.locator('#discussion-panel').innerText(), /Must not be rendered|No scores yet/);
        await page.locator('#discussion-panel').screenshot({ path: `${output}/${engine}-${width}-information.png` });
        await page.locator('#benchmark-scores-open').click();
        await page.waitForFunction(message => document.querySelector('#benchmark-scores-status').textContent === message, AA_DISPLAY_MESSAGE);
        assert.equal(await page.locator('#benchmark-scores-list .benchmark-score-row').count(), 0);
        assert.equal(await page.locator('#benchmark-scores-count').innerText(), '');
        assert.equal(await page.locator('#benchmark-scores-retry').isVisible(), false);
        await page.locator('#benchmark-scores-back').click();
        assert.equal(await page.locator('#benchmark-information-status').innerText(), AA_DISPLAY_MESSAGE);
        assert.equal(await page.locator('#benchmark-information-status').isVisible(), true);
    });

    test(`${engine} ${width}px switching to AA clears scores, survives late replies and recovers on a normal version`, async t => {
        const { app, page, context } = await setup(t, engine, width);
        let versions, normalPayload, blockNext = false, releaseLate;
        const aa = { ID: 9999, name: 'Artificial Analysis run', usesPercentageScale: true, scoreCount: null,
            displayRestriction: AA_DISPLAY_RESTRICTION };
        await context.route('**/api/get_benchmark_scores', async route => {
            const request = route.request().postDataJSON();
            if (request.conditionID === aa.ID) {
                await route.fulfill({ json: { benchmarkID: request.benchmarkID, conditionID: aa.ID,
                    displayRestriction: AA_DISPLAY_RESTRICTION, conditions: versions, scores: [], nextBeforeID: null } });
            } else {
                const response = await route.fetch();
                normalPayload = await response.json();
                versions = [...normalPayload.conditions, aa];
                if (blockNext) { blockNext = false; await new Promise(resolve => { releaseLate = resolve; }); }
                await route.fulfill({ json: { ...normalPayload, conditions: versions, displayRestriction: null } });
            }
        });
        await page.goto(`${app.url}/Intelligence`);
        await page.waitForSelector('#benchmark-rows .bp-benchmark-information-link');
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
        await page.waitForSelector('#benchmark-information-name:not(:empty)');
        await page.locator('#benchmark-scores-open').click();
        await page.waitForSelector('#benchmark-scores-list .benchmark-score-row');
        const original = await page.locator('#benchmark-scores-condition').inputValue();
        const select = async value => page.locator('#benchmark-scores-condition').evaluate((node, value) => {
            node.value = value; node.dispatchEvent(new Event('change', { bubbles: true }));
        }, value);
        await select(String(aa.ID));
        await page.waitForFunction(message => document.querySelector('#benchmark-scores-status').textContent === message, AA_DISPLAY_MESSAGE);
        assert.equal(await page.locator('#benchmark-scores-list .benchmark-score-row').count(), 0);
        assert.equal(await page.locator('#benchmark-scores-count').innerText(), '');
        assert.equal(await page.locator('#benchmark-scores-more').isVisible(), false);
        assert.equal(await page.locator('#benchmark-scores-retry').isVisible(), false);
        await page.locator('#discussion-panel').screenshot({ path: `${output}/${engine}-${width}-mixed-version.png` });
        blockNext = true;
        await select(original);
        await page.waitForFunction(() => document.querySelector('#benchmark-scores-list').getAttribute('aria-busy') === 'true');
        while (!releaseLate) await new Promise(resolve => setTimeout(resolve, 20));
        await select(String(aa.ID));
        await page.waitForFunction(message => document.querySelector('#benchmark-scores-status').textContent === message, AA_DISPLAY_MESSAGE);
        releaseLate();
        await page.waitForTimeout(150);
        assert.equal(await page.locator('#benchmark-scores-condition').inputValue(), String(aa.ID));
        assert.equal(await page.locator('#benchmark-scores-list .benchmark-score-row').count(), 0);
        await select(original);
        await page.waitForSelector('#benchmark-scores-list .benchmark-score-row');
        assert.equal(await page.locator('#benchmark-scores-status').innerText(), '');
        assert.match(await page.locator('#benchmark-scores-count').innerText(), /approved scores/);
    });
}
