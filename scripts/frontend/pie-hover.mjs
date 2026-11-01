import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = resolve(process.env.FRONTEND_OUTPUT || 'D:/Codex-artifacts/website1/pie-hover-20261019');
await mkdir(output, { recursive: true });
const results = [];
for (const [engine, browserType] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await browserType.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [1440, 390, 320]) {
            const app = await startPreview();
            const context = await browser.newContext({ viewport: { width, height: 1000 } });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
                await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
                await page.goto(app.url);
                await page.locator('#weight-pie g[data-object-id]').first().waitFor();
                for (const mode of ['personal', 'public']) {
                    await page.locator(`#pie-mode-${mode}`).click();
                    await page.waitForFunction(mode => document.querySelector(`#pie-mode-${mode}`).getAttribute('aria-selected') === 'true'
                        && !document.querySelector('.bp-pie-flip-face'), mode);
                    const group = page.locator('#weight-pie g[data-object-id]').first();
                    await group.scrollIntoViewIfNeeded();
                    const point = await group.locator('.bp-pie-label').evaluate(label => {
                        const r = label.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                    });
                    await page.mouse.move(point.x, point.y);
                    await page.waitForFunction(() => {
                        const lift = document.querySelector('#weight-pie g:hover > .bp-pie-slice-lift');
                        return lift && Math.abs(new DOMMatrix(getComputedStyle(lift).transform).a - 1.08) < .001;
                    });
                    const geometry = await page.evaluate(() => {
                        const svg = document.querySelector('#weight-pie');
                        const rect = svg.getBoundingClientRect();
                        const slice = svg.querySelector('g:hover .bp-pie-slice').getBoundingClientRect();
                        return { rect: rect.toJSON(), slice: slice.toJSON(), overflow: document.documentElement.scrollWidth > innerWidth + 1 };
                    });
                    assert.equal(geometry.overflow, false);
                    assert(geometry.slice.left >= geometry.rect.left - 1 && geometry.slice.right <= geometry.rect.right + 1);
                    assert(geometry.slice.top >= geometry.rect.top - 1 && geometry.slice.bottom <= geometry.rect.bottom + 1);
                    await page.screenshot({ path: `${output}/${engine}-${width}-${mode}.png` });
                    if (mode === 'personal') {
                        await page.mouse.click(point.x, point.y);
                        const pie = await page.locator('#weight-pie').boundingBox();
                        await page.mouse.move(pie.x + pie.width / 2 + 30, pie.y + pie.height / 2);
                        await page.mouse.wheel(0, 60);
                        await page.waitForFunction(() => document.querySelector('.bp-pie-card').classList.contains('is-adjusting-weight'));
                        await page.waitForFunction(() => {
                            const lift = document.querySelector('#weight-pie g:hover > .bp-pie-slice-lift');
                            return lift && Math.abs(new DOMMatrix(getComputedStyle(lift).transform).a - 1) < .001;
                        });
                        await page.locator('#pie-adjustment-dismiss').click();
                    }
                    await page.mouse.move(0, 0);
                }
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true });
                console.log(`PASS ${engine} ${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}/${engine}-${width}-failure.png`, fullPage: true });
                console.error(JSON.stringify({ engine, width, errors, url: page.url(),
                    view: await page.locator('body').getAttribute('class'),
                    status: await page.locator('#workspace-status').textContent({ timeout: 1000 }).catch(() => null) }));
                throw error;
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
