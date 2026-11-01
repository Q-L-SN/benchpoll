import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.COPY_POLISH_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/polish/copy-source';
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390],
    ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const app = await startPreview();
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760,
        hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = engine + '-' + width;
    async function fits() {
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, page.url());
    }
    try {
        if (engine === 'webkit') await page.route(app.url + '/**', async route => {
            const response = await route.fetch({ maxRetries: 2 });
            return route.fulfill({ response, body: await response.body() });
        });
        await page.goto(app.url + '/how-it-works');
        await page.evaluate(() => document.fonts.ready);
        await page.getByRole('link', { name: 'Choose your benchmarks', exact: true }).waitFor();
        assert.equal(await page.locator('#calculation-details').getAttribute('open'), null);
        await fits();
        await page.screenshot({ path: join(output, label + '-guide.png') });
        await page.locator('#calculation-details > summary').click();
        await page.getByRole('button', { name: 'Expand all', exact: true }).click();
        const overview = page.locator('#calculation-details details').filter({ has: page.locator('summary', { hasText: 'How do I return to the overview?' }) });
        assert.match(await overview.textContent(), /pull down and release/);
        await fits();
        for (const path of ['benchmarks/new', 'models/new', 'scores/new', 'score-fields', 'feedback']) {
            await page.goto(app.url + '/contribute/' + path);
            await page.locator('#form-surface:not([hidden])').waitFor();
            await fits();
            if (path === 'benchmarks/new') {
                assert.equal(await page.locator('[data-condition-input]').first().getAttribute('maxlength'), '60');
                assert.equal(await page.locator('[data-condition-input]').first().getAttribute('placeholder'), 'e.g. v2 overall');
                await page.locator('[data-field="requestOfficialSync"]').check();
                await page.locator('[data-field="officialSyncURL"]').waitFor();
                await fits();
                await page.screenshot({ path: join(output, label + '-benchmark-form.png'), fullPage: true });
            }
            if (path === 'feedback') {
                const input = page.locator('textarea[data-bind="feedback"]');
                await input.fill('Please add the official leaderboard for this benchmark.');
                assert.equal(await input.inputValue(), 'Please add the official leaderboard for this benchmark.');
                await page.screenshot({ path: join(output, label + '-feedback-form.png'), fullPage: true });
            }
        }
        assert.deepEqual(errors, []);
        reports.push({ label, help: true, forms: 5, errors });
        console.log(JSON.stringify({ label, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, label + '-failure.png'), fullPage: true }).catch(() => {});
        throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
