import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = resolve(process.env.FRONTEND_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-composition-20261021/touch');
await mkdir(output, { recursive: true });
const app = await startPreview({ rankingStress: true });
const browser = await chromium.launch({ headless: true, env: { ...process.env,
    HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [], reports = [];
page.on('pageerror', error => errors.push(error.message));
const session = await context.newCDPSession(page);
try {
    await page.goto(`${app.url}/Language-models?view=showcase`);
    await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
    await page.evaluate(() => document.fonts.ready);
    const bars = page.locator('#weight-bars');
    for (const [name, position, distance, intendedPage, target = 'list'] of [
        ['inside-from-top', 'top', 85, false],
        ['inside-near-bottom', 'near-bottom', 130, false],
        ['inside-near-top', 'near-top', -100, false],
        ['next-gesture-at-bottom', 'bottom', 100, true],
        ['next-gesture-at-top', 'top', -100, true],
        ['weight-heading-scrolls-list', 'top', 85, false, 'heading'],
        ['weight-heading-at-bottom-scrolls-page', 'bottom', 100, true, 'heading']
    ]) {
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const travel = scene.offsetHeight - document.documentElement.clientHeight - scene.querySelector('.bp-showcase-stage').offsetHeight;
            scrollTo({ top: travel * .55, behavior: 'instant' });
        });
        await bars.evaluate((node, position) => {
            const maximum = node.scrollHeight - node.clientHeight;
            node.scrollTop = position === 'bottom' ? maximum : position === 'near-bottom' ? maximum - 10
                : position === 'near-top' ? 10 : 0;
        }, position);
        await page.waitForTimeout(300);
        const before = await bars.evaluate(node => ({ inner: node.scrollTop, page: scrollY,
            maximum: node.scrollHeight - node.clientHeight }));
        assert.ok(before.maximum > 30, 'The fixture must have a scrollable weight list');
        const box = await (target === 'heading' ? page.locator('.bp-weight-bars-heading') : bars).boundingBox();
        const start = { x: box.x + box.width / 2,
            y: target === 'heading' ? box.y + box.height / 2
                : distance > 0 ? Math.min(box.y + box.height - 12, 720) : box.y + 12, id: 19 };
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
        for (const fraction of [.12, .3, .5, .75, 1]) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, y: start.y - distance * fraction }] });
            await page.waitForTimeout(70);
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await page.waitForTimeout(400);
        const after = await bars.evaluate(node => ({ inner: node.scrollTop, page: scrollY }));
        const pageMoved = Math.abs(after.page - before.page) > 2;
        const innerMoved = Math.abs(after.inner - before.inner) > 2;
        const passed = pageMoved === intendedPage && (intendedPage || innerMoved);
        reports.push({ name, before, after, intendedPage, passed });
        console.log(JSON.stringify(reports.at(-1)));
    }
    await page.screenshot({ path: resolve(output, 'touch-result.png') });
    await writeFile(resolve(output, 'results.json'), JSON.stringify({ reports, errors }, null, 2));
    assert.deepEqual(errors, []);
    if (!process.argv.includes('--observe')) assert.ok(reports.every(report => report.passed), 'A gesture for the list must not accidentally scroll the whole overview.');
} finally { await session.detach(); await context.close(); await browser.close(); await app.close(); }
