import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const liveURL = process.env.TYPOGRAPHY_URL;
const output = 'artifacts/completion-audit-20261007/typography';
const results = [];
await mkdir(output, { recursive: true });

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [1440, 390, 320]) {
            const app = await startPreview();
            const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage();
            page.setDefaultTimeout(liveURL ? 60000 : 15000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
                const metrics = await page.evaluate(async () => {
                    const weights = [400, 500, 600, 700, 800];
                    for (const weight of weights) await document.fonts.load(`${weight} 60px Manrope`);
                    return weights.map(weight => {
                        const canvas = document.createElement('canvas'); canvas.width = 800; canvas.height = 100;
                        const context = canvas.getContext('2d'); context.font = `${weight} 60px Manrope`;
                        const text = 'Rank models'; context.fillText(text, 10, 70);
                        const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
                        let ink = 0;
                        for (let index = 3; index < pixels.length; index += 4) ink += pixels[index] / 255;
                        return { weight, ink, width: context.measureText(text).width };
                    });
                });
                for (let index = 1; index < metrics.length; index++) {
                    assert.ok(metrics[index].ink > metrics[index - 1].ink * 1.08, `${engine}: heavier strokes at ${metrics[index].weight}`);
                }
                assert.ok(metrics.at(-1).ink > metrics[0].ink * 1.5, engine + ': headline is visibly heavier than body');
                assert.equal(await page.locator('.bp-page-heading h1').evaluate(node => getComputedStyle(node).fontWeight), '800');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${width}.png`, fullPage: true, animations: 'disabled' });
                for (const path of ['/contribute/benchmarks/new', '/how-it-works']) {
                    await page.goto(new URL(path, liveURL ?? app.url).href, { waitUntil: 'domcontentloaded' });
                    await page.evaluate(() => document.fonts.ready);
                    assert.match(await page.locator('body').evaluate(node => getComputedStyle(node).fontFamily), /Manrope/);
                    assert.equal(await page.locator('link[href*="typography.css"]').getAttribute('href'), '/css/typography.css?v=manrope-static-20261007');
                    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                }
                assert.deepEqual(errors, []);
                results.push({ engine, width, metrics, passed: true });
                console.log(`PASS ${engine} ${width}px: five distinct font weights, headline, form, guide`);
            } catch (error) {
                results.push({ engine, width, errors, passed: false, error: error.stack });
                await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${width}-failure.png`, fullPage: true });
                console.error(`FAIL ${engine} ${width}px: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/${liveURL ? 'live-' : ''}results.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
