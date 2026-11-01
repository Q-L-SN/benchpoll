import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const record = process.argv.includes('--record-before');
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const output = process.env.CONTROL_HEIGHTS_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/fixed-appearance-20261015/control-heights';
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const comparisonLast = { mode: 'best', keys: ['model'], filters: [{ key: 'model', operator: 'eq', value: 301 }] };
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    if (record && engine !== 'chromium') continue;
    const app = await startPreview({ comparisonLast });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 1000 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = [], label = `${engine}-${width}${builtRoot ? '-built' : ''}`;
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    if (html || engine === 'webkit') await page.route(`${app.url}/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        if (html && route.request().resourceType() === 'document' && !path.startsWith('/contribute')) return route.fulfill({ body: html, contentType: 'text/html' });
        if (html && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
        if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
        return route.fallback();
    });
    await context.addInitScript(() => {
        localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
        localStorage.setItem('benchpoll-comparison-settings-v1:1', JSON.stringify({ experimental: true }));
    });
    const measurements = [];
    async function measure(name, controls) {
        await page.evaluate(() => document.fonts.ready);
        const geometry = await controls.evaluateAll(nodes => nodes.map(node => {
            const rect = node.getBoundingClientRect(), css = getComputedStyle(node);
            return { label: node.getAttribute('aria-label') || node.name || node.type, height: rect.height, top: rect.top,
                boxSizing: css.boxSizing, fontSize: css.fontSize, lineHeight: css.lineHeight, padding: css.padding };
        }));
        measurements.push({ name, geometry });
        assert.ok(geometry.length >= 2, name);
        if (!record) assert.ok(geometry.every(control => Math.abs(control.height - geometry[0].height) < .5), JSON.stringify({ width, name, geometry }));
    }
    try {
        await page.goto(liveURL ?? app.url);
        await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
        assert.equal(await page.locator('#model-comparison-toggle,#model-comparison-panel,#experimental-comparison').count(), 0);
        await page.goto(new URL('/contribute/benchmarks/new', liveURL ?? app.url).href);
        const direction = page.getByRole('combobox', { name: 'Which scores are better?', exact: true });
        await direction.click();
        await page.getByRole('option', { name: 'Closer to a target value', exact: true }).click();
        await page.locator('input[data-field="targetValue"]').waitFor();
        await measure('score-direction-and-target', page.locator('[data-field="scoreDirection"] + .bp-ui-select > button, input[data-field="targetValue"]'));
        if (!record) {
            await measure('composite-and-plain-fields', page.locator('.evaluation-combobox > input, .tag-editor'));
            assert.equal(await page.locator('.tag-editor > input').evaluate(input => getComputedStyle(input).borderWidth), '0px');
        }
        await page.locator('input[data-field="targetValue"]').scrollIntoViewIfNeeded();
        await page.screenshot({ path: join(output, `${label}-${record ? 'before' : 'after'}-form.png`) });
        assert.deepEqual(errors, []);
        reports.push({ label, measurements });
        console.log(JSON.stringify({ label, measurements, record }));
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, record ? 'before.json' : 'results.json'), JSON.stringify(reports, null, 2));
