import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { contributionPath } from '../../public/js/shared/contribution-navigation.js';

const reproduce = process.argv.includes('--reproduce');
const liveURL = process.env.SEARCH_SPACING_URL;
const output = process.env.SEARCH_SPACING_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/fixes-20261013/search';
await mkdir(output, { recursive: true });
const results = [];
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const app = await startPreview();
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 45000 : 15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${engine}-${width}${liveURL ? '-live' : ''}`;
    const observations = [];
    try {
        if (liveURL) await page.route(`${liveURL}/api/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            assert.ok(path.startsWith('/api/get_'), 'Live form checks must only read a synthetic catalogue');
            await route.fulfill({ response: await route.fetch({ url: app.url + path }) });
        });
        if (engine === 'webkit') await page.route(`${liveURL ?? app.url}/**`, async route => {
            if (liveURL && new URL(route.request().url()).pathname.startsWith('/api/')) return route.fallback();
            const response = await route.fetch(); await route.fulfill({ response, body: await response.body() });
        });
        async function measure(control, name) {
            const geometry = await control.evaluate(node => {
                const input = node.matches('input') ? node : node.querySelector('input');
                const shell = input.closest('.evaluation-combobox, .bp-ui-field');
                const glyph = shell.querySelector(':scope > i, :scope > .vendor-mark');
                const text = input.getBoundingClientRect(), css = getComputedStyle(input);
                const icon = glyph && getComputedStyle(glyph).display !== 'none' ? glyph.getBoundingClientRect() : null;
                return { padding: parseFloat(css.paddingLeft), gap: icon ? text.left + parseFloat(css.borderLeftWidth) + parseFloat(css.paddingLeft) - icon.right : null,
                    input: text.toJSON(), icon: icon?.toJSON(), outline: css.outlineStyle, shadow: css.boxShadow,
                    overflow: document.documentElement.scrollWidth - innerWidth, value: input.value };
            });
            observations.push({ name, ...geometry });
            if (!reproduce) {
                assert.ok(geometry.gap === null || geometry.gap >= 7, `${name}: ${JSON.stringify(geometry)}`);
                assert.ok(geometry.overflow <= 1, `${name}: ${JSON.stringify(geometry)}`);
                assert.equal(geometry.outline, 'none'); assert.equal(geometry.shadow, 'none');
            }
            return geometry;
        }
        async function form(mode) {
            await page.goto((liveURL ?? app.url) + contributionPath(mode), { waitUntil: 'domcontentloaded' });
            await page.locator('#contribution-step input:visible').first().waitFor();
            await page.evaluate(() => document.fonts.ready);
        }
        await form('benchmark_result');
        const model = page.locator('[data-result-model-query]').first();
        for (let repetition = 0; repetition < 2; repetition++) await measure(model, 'score-model-empty-' + repetition);
        await page.screenshot({ path: join(output, `${label}-${reproduce ? 'before' : 'after'}-empty.png`), fullPage: true });
        await model.focus(); await measure(model, 'score-model-focused');
        await model.fill('Cedar'); await measure(model, 'score-model-typed');
        await page.locator('[data-select-result-model]').first().click();
        const selected = await measure(model, 'score-model-selected');
        if (!reproduce) assert.ok(selected.value.includes('Cedar'));
        const benchmark = page.locator('[data-result-object-query]').first();
        await measure(benchmark, 'score-benchmark-empty');
        await benchmark.fill('Reasoning'); await measure(benchmark, 'score-benchmark-typed');
        await page.locator('[data-select-result-object]').first().click();
        const noIcon = await measure(benchmark, 'score-benchmark-selected');
        if (!reproduce) assert.equal(noIcon.gap, null);
        await model.evaluate(node => node.blur());
        await page.screenshot({ path: join(output, `${label}-${reproduce ? 'before' : 'after'}-scores.png`), fullPage: true });
        await form('new_benchmark');
        const benchmarkName = page.locator('[data-evaluation-name]');
        await benchmarkName.fill('Test benchmark'); await measure(benchmarkName, 'new-benchmark');
        await form('new_model');
        await page.locator('.picker-summary').first().click();
        const vendor = page.locator('[data-vendor-search]'); await vendor.waitFor();
        await measure(vendor, 'vendor-empty'); await vendor.fill('Cedar'); await measure(vendor, 'vendor-typed');
        await page.screenshot({ path: join(output, `${label}-${reproduce ? 'before' : 'after'}-vendor.png`), fullPage: true });
        await page.locator('[data-select-vendor]').first().click();
        const modelName = page.locator('[data-subject-model-name]');
        await modelName.fill('Test model'); await measure(modelName, 'new-model');
        assert.deepEqual(errors, []);
        if (reproduce) assert.ok(observations.some(row => row.gap !== null && row.gap < 0), 'The reported overlap must reproduce before changing the styles');
        results.push({ label, observations, errors, reproduced: reproduce, passed: true });
        console.log(JSON.stringify({ label, reproduced: reproduce, observations: observations.map(({ name, gap }) => ({ name, gap })) }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {}); throw error;
    } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, reproduce ? 'reproduction.json' : 'verification.json'), JSON.stringify(results, null, 2));
