import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/contribution-polish-20261004/ui';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
try {
    for (const reviewEmailEnabled of [false, true]) {
        const preview = await startPreview({ reviewEmailEnabled });
        const page = await browser.newPage();
        try {
            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            await page.locator('#form-surface:not([hidden])').waitFor();
            const notice = await page.locator('.submission-email-notice').innerText();
            assert.match(notice, reviewEmailEnabled ? /receive the review result by email/ : /Email notifications are currently unavailable/);
            assert.match(await page.locator('#submit-success-dialog [slot="body"]').textContent(),
                reviewEmailEnabled ? /We will email/ : /Email notifications are currently unavailable/);
            checks.push({ reviewEmailEnabled, noticeAccurate: true });
        } finally { await page.close(); await preview.close(); }
    }
    for (const width of [1440, 390, 320]) {
        const preview = await startPreview({ secondaryBenchmark: true });
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(12000);
        try {
            await page.goto(preview.url);
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            await page.locator('#benchmark-scores-open:not([hidden])').waitFor();
            await page.waitForTimeout(400);
            const panelBox = await page.locator('.discussion-main').boundingBox();
            assert.ok(panelBox.x >= -1 && panelBox.x + panelBox.width <= width + 1, 'Open rail must fit the viewport');
            assert.equal(await page.locator('.discussion-heading #category-path').count(), 0);
            assert.equal(await page.locator('#benchmark-discussion-view #category-path').count(), 1);
            assert.match(await page.locator('#benchmark-information-age').textContent(), /^\(.+\)$/);
            const gap = await page.locator('.benchmark-information-meta').evaluate(host => {
                const label = host.firstElementChild.getBoundingClientRect();
                return host.querySelector('time').getBoundingClientRect().left - label.right;
            });
            assert.ok(gap >= 0 && gap <= 9, `Date should sit next to the label, got ${gap}`);
            await page.screenshot({ path: `${output}/information-${width}.png`, fullPage: true });
            await page.locator('#benchmark-scores-open').click();
            await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 50);
            assert.equal(await page.locator('#discussion-composer').isVisible(), false);
            assert.equal(await page.locator('#category-path').isVisible(), false);
            assert.equal(await page.locator('.benchmark-score-value').first().textContent(), '88.5%');
            await page.locator('.benchmark-score-fields summary').first().click();
            await page.locator('.benchmark-score-fields dl').first().waitFor();
            await page.waitForTimeout(230);
            assert.equal(await page.locator('.benchmark-score-fields dd').first().textContent(), 'Agent A');
            await page.locator('.discussion-scroll').evaluate(host => { host.scrollTop = 0; });
            await page.screenshot({ path: `${output}/scores-${width}.png`, fullPage: true });
            await page.locator('#benchmark-scores-more').click();
            await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 55);
            assert.equal(await page.locator('#benchmark-scores-more').isVisible(), false);
            const condition = await page.locator('#benchmark-scores-condition option').nth(1).getAttribute('value');
            await page.locator('#benchmark-scores-condition').selectOption(condition);
            await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 2);
            await page.locator('#benchmark-scores-back').click();
            assert.equal(await page.locator('#discussion-composer').isVisible(), true);
            await page.locator('#discussion-close').click();

            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            await page.locator('[data-evaluation-name]').fill('A new benchmark');
            const checkbox = page.locator('[data-score-percentage]');
            const style = await checkbox.locator('..').evaluate(host => {
                const css = getComputedStyle(host); return { border: css.borderTopWidth, background: css.backgroundColor };
            });
            assert.deepEqual(style, { border: '0px', background: 'rgba(0, 0, 0, 0)' });
            assert.ok(await page.locator('.field > span').first().evaluate(host => parseFloat(getComputedStyle(host).fontSize)) >= 14);
            assert.notEqual(await page.locator('.submission-email-notice').evaluate(host => getComputedStyle(host).backgroundColor), 'rgb(240, 245, 241)');
            await checkbox.uncheck();
            await page.locator('[data-field="scoreMin"]').fill('-500');
            await page.locator('[data-field="scoreMax"]').fill('1500');
            await page.screenshot({ path: `${output}/form-${width}.png`, fullPage: true });
            await page.locator('#contribution-page-help').click();
            const guide = page.locator('#contribution-guide-dialog');
            await guide.waitFor();
            assert.equal(await guide.locator('.contribution-guide section').count(), 5);
            const geometry = await guide.evaluate(host => {
                const content = host.shadowRoot.querySelector('.dialog-content').getBoundingClientRect();
                const body = host.shadowRoot.querySelector('.dialog-body');
                const button = host.querySelector('global-dialog-action').shadowRoot.querySelector('button');
                return { left: content.left, right: content.right, top: content.top, bottom: content.bottom,
                    overflow: body.scrollHeight > body.clientHeight, shadow: getComputedStyle(button).boxShadow,
                    color: getComputedStyle(button).color };
            });
            assert.ok(geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 950);
            assert.equal(geometry.overflow, true);
            assert.equal(geometry.shadow, 'none');
            assert.equal(geometry.color, 'rgb(255, 255, 255)');
            await guide.getByRole('link', { name: 'Scores', exact: true }).click();
            await page.waitForTimeout(230);
            await page.goBack();
            assert.equal(await guide.isVisible(), true);
            assert.equal(await page.locator('[data-evaluation-name]').inputValue(), 'A new benchmark');
            await page.screenshot({ path: `${output}/guide-${width}.png` });
            await page.keyboard.press('Escape');
            assert.equal(await guide.isVisible(), false);
            assert.equal(await page.locator('#contribution-page-help').evaluate(host => host === document.activeElement), true);
            assert.equal(await page.locator('[data-evaluation-name]').inputValue(), 'A new benchmark');

            await page.goto(`${preview.url}/contribute/score-fields`);
            await page.locator('.checkbox-field').first().waitFor();
            const boxSize = await page.locator('.checkbox-field input').first().boundingBox();
            assert.equal(boxSize.width, 16); assert.equal(boxSize.height, 16);
            await page.locator('select[aria-label="Field type"]').selectOption('enum');
            await page.locator('.score-field-option-definition input[type="text"]').fill('Standard');
            await page.getByRole('button', { name: 'Add option', exact: true }).click();
            assert.equal(await page.locator('.score-field-option-definition').count(), 2);
            await page.screenshot({ path: `${output}/field-form-${width}.png`, fullPage: true });
            for (const path of ['models/new', 'scores/new', 'benchmarks/101/edit', 'scores/501/edit', 'feedback']) {
                await page.goto(`${preview.url}/contribute/${path}`);
                await page.locator('#form-surface:not([hidden])').waitFor();
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false, `${path} must not overflow at ${width}`);
            }
            assert.deepEqual(errors, []);
            checks.push({ width, scores: true, conditionSwitch: true, pagination: true, dateAdjacent: true,
                categoryOnlyInDiscussion: true, guideKeyboard: true, checkbox: true, browserErrors: errors });
        } finally { await page.close(); await preview.close(); }
    }

    const preview = await startPreview({ authenticated: false, secondaryBenchmark: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    try {
        await page.goto(preview.url);
        await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
        await page.locator('#benchmark-scores-open:not([hidden])').waitFor();
        let fail = true;
        await page.route('**/api/get_benchmark_scores', async route => {
            if (fail) { fail = false; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture_failure"}' }); }
            return route.continue();
        });
        await page.locator('#benchmark-scores-open').click();
        await page.locator('#benchmark-scores-retry').waitFor();
        await page.locator('#benchmark-scores-retry').click();
        await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 50);
        await page.unroute('**/api/get_benchmark_scores');
        await page.route('**/api/get_benchmark_scores', async route => {
            const data = route.request().postDataJSON();
            if (data.beforeID) await new Promise(resolve => setTimeout(resolve, 600));
            return route.continue();
        });
        await page.locator('#benchmark-scores-more').click();
        const alternate = await page.locator('#benchmark-scores-condition option').nth(1).getAttribute('value');
        await page.locator('#benchmark-scores-condition').selectOption(alternate);
        await page.waitForFunction(() => document.querySelectorAll('.benchmark-score-row').length === 2);
        await page.waitForTimeout(800);
        assert.equal(await page.locator('.benchmark-score-row').count(), 2);
        assert.equal(await page.locator('#benchmark-scores-condition').inputValue(), alternate);
        checks.push({ guest: true, retry: true, stalePagesIgnored: true });
        await page.route('**/js/contribute.js*', async route => {
            await new Promise(resolve => setTimeout(resolve, 800));
            await route.continue();
        });
        await page.goto(`${preview.url}/contribute/benchmarks/new`, { waitUntil: 'commit' });
        await page.locator('#contribution-page-help').waitFor();
        assert.equal(await page.locator('#contribution-page-help').isDisabled(), true);
        await page.locator('#contribution-page-help').click();
        await page.locator('#contribution-guide-dialog:not([hidden])').waitFor();
        checks.push({ guideLoadingState: true });
    } finally { await page.close(); await preview.close(); }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks }));
