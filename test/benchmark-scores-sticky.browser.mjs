import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const output = 'D:/Codex-artifacts/website1/benchmark-sticky-20261029';
const browsers = new Map();
before(async () => {
    await mkdir(output, { recursive: true });
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

for (const engine of ['chromium', 'webkit']) for (const width of [320, 390, 1440]) {
    test(`${engine} ${width}px benchmark version remains opaque and clear of the scrollbar`, async t => {
        const app = await startPreview({ secondaryBenchmark: true });
        const context = await browsers.get(engine).newContext({ viewport: { width, height: 800 },
            hasTouch: width < 761, reducedMotion: 'reduce' });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(10000);
        t.after(async () => { await context.close(); await app.close(); assert.deepEqual(errors, []); });
        await page.goto(`${app.url}/Intelligence`);
        await page.waitForSelector('#benchmark-rows .bp-benchmark-information-link');
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
        await page.waitForSelector('#benchmark-information-name:not(:empty)');
        await page.waitForSelector('#benchmark-information-weights:not([hidden])');
        assert.equal(await page.locator('#discussion-panel #discussion-entry').count(), 0);
        const weights = await page.locator('#benchmark-information-weights').evaluate(host => {
            const context = host.querySelector('#benchmark-weight-context').getBoundingClientRect();
            const values = host.querySelector('dl').getBoundingClientRect();
            return { text: host.textContent, label: host.getAttribute('aria-label'), contextTop: context.top, valuesTop: values.top };
        });
        assert.doesNotMatch(weights.text, /Weight in /);
        assert.match(weights.label, /^Benchmark weights in /);
        assert.ok(Math.abs(weights.contextTop - weights.valuesTop) < 10, JSON.stringify(weights));
        const discussion = page.getByRole('tab', { name: 'Discussion', exact: true });
        const scores = page.getByRole('tab', { name: 'All scores', exact: true });
        const change = page.getByRole('link', { name: 'Change information', exact: true });
        assert.equal(await discussion.getAttribute('aria-selected'), 'true');
        assert.equal(await scores.getAttribute('aria-selected'), 'false');
        assert.equal(await page.locator('#benchmark-discussion-view').isVisible(), true);
        assert.match(await change.getAttribute('href'), /contribute/);
        const order = await page.locator('.benchmark-information-actions').evaluate(node =>
            [...node.querySelectorAll('[role="tab"], a')].map(item => item.textContent.trim()));
        assert.deepEqual(order, ['Discussion', 'All scores', 'Change information']);
        assert.equal(await page.locator('.benchmark-scores-heading').count(), 0);
        await page.locator('#benchmark-scores-open').click();
        await page.waitForSelector('#benchmark-scores-list .benchmark-score-row');
        assert.equal(await scores.getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('#benchmark-discussion-view').isVisible(), false);
        await scores.press('ArrowLeft');
        assert.equal(await discussion.getAttribute('aria-selected'), 'true');
        assert.equal(await page.locator('#benchmark-discussion-view').isVisible(), true);
        await discussion.press('ArrowRight');
        await page.waitForSelector('#benchmark-scores-list .benchmark-score-row');
        await page.locator('.discussion-scroll').evaluate(node => { node.scrollTop = 500; });
        await page.waitForFunction(() => document.querySelector('.discussion-scroll').scrollTop >= 300);
        const geometry = await page.evaluate(() => {
            const scroll = document.querySelector('.discussion-scroll');
            const label = document.querySelector('.benchmark-scores-condition');
            const select = label.querySelector('.bp-ui-select-trigger') ?? label.querySelector('select');
            const scrollRect = scroll.getBoundingClientRect(), labelRect = label.getBoundingClientRect();
            const selectRect = select.getBoundingClientRect(), heading = document.querySelector('.discussion-heading').getBoundingClientRect();
            const point = document.elementFromPoint(labelRect.left + Math.min(20, labelRect.width / 2), scrollRect.top + 1);
            return { top: labelRect.top - scrollRect.top, right: scrollRect.right - selectRect.right,
                headingGap: scrollRect.top - heading.bottom, hit: label.contains(point),
                before: getComputedStyle(label, '::before').backgroundColor,
                background: getComputedStyle(label).backgroundColor };
        });
        assert.ok(Math.abs(geometry.top) <= 1, JSON.stringify(geometry));
        assert.ok(geometry.right >= 7, JSON.stringify(geometry));
        assert.ok(geometry.headingGap >= -1 && geometry.hit, JSON.stringify(geometry));
        assert.equal(geometry.before, geometry.background);
        await page.locator('#discussion-panel').screenshot({ path: `${output}/${engine}-${width}.png` });
        const version = page.locator('.benchmark-scores-condition .bp-ui-select-trigger');
        const previous = await page.locator('#benchmark-scores-condition').inputValue();
        await version.click();
        const options = page.locator('.bp-ui-select-popup[data-ui-open="true"] [role="option"]:not([aria-disabled="true"])');
        await options.first().waitFor();
        assert.ok(await options.count() > 1);
        await options.nth(1).click();
        assert.notEqual(await page.locator('#benchmark-scores-condition').inputValue(), previous);
        await page.locator('#discussion-close').click();
        assert.equal(await page.locator('#discussion-entry').isVisible(), true);
        await page.locator('#discussion-entry').click();
        await page.waitForFunction(() => document.querySelector('#discussion-title').textContent === 'Discussion');
    });
}

for (const url of ['https://example.org/benchmark', '', 'javascript:alert(1)']) {
    test(`benchmark title uses only safe public URLs: ${url || 'missing'}`, async t => {
        const app = await startPreview({ benchmarkInfoURL: url });
        const context = await browsers.get('chromium').newContext({ viewport: { width: 390, height: 800 } });
        const page = await context.newPage();
        t.after(async () => { await context.close(); await app.close(); });
        await context.route('https://example.org/**', route => route.fulfill({ status: 200, body: 'Benchmark website' }));
        await page.goto(`${app.url}/Intelligence`);
        await page.waitForSelector('#benchmark-rows .bp-benchmark-information-link');
        await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
        await page.waitForSelector('#benchmark-information-name:not(:empty)');
        const link = page.locator('#benchmark-information-name a');
        if (!url.startsWith('https:')) { assert.equal(await link.count(), 0); return; }
        assert.equal(await link.getAttribute('href'), url);
        assert.equal(await link.getAttribute('target'), '_blank');
        assert.equal(await link.getAttribute('rel'), 'noopener noreferrer');
        const original = page.url();
        const [popup] = await Promise.all([page.waitForEvent('popup'), link.click()]);
        await popup.waitForURL(url);
        assert.equal(page.url(), original);
    });
}
