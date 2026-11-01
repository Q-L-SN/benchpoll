import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.HOVER_SCROLL_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/hover-scroll-20261014/browser';
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [], failures = [];

for (const [engine, launcher, width, height] of [
    ['chromium', chromium, 1440, 900], ['chromium', chromium, 390, 844], ['webkit', webkit, 1440, 900]
]) {
    const label = `${engine}-${width}${builtRoot ? '-built' : ''}`;
    const app = await startPreview({ rankingStress: true });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const report = { label, checks: [], errors };
    const check = (name, passed, details) => {
        report.checks.push({ name, passed, details });
        if (!passed) failures.push(`${label}: ${name}: ${JSON.stringify(details)}`);
    };
    try {
        if (builtHTML || engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            if (builtHTML && route.request().resourceType() === 'document') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
            if (builtHTML && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))),
                contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            if (engine === 'webkit') {
                const response = await route.fetch(); return route.fulfill({ response, body: await response.body() });
            }
            return route.fallback();
        });
        await page.goto(`${app.url}/Language-models`);
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
            && document.querySelectorAll('.bp-model-column').length > 0);
        await page.evaluate(() => document.fonts.ready);
        async function showCharts() {
            await page.evaluate(() => {
                const scene = document.getElementById('showcase');
                const start = scene.getBoundingClientRect().top + scrollY;
                const hold = scene.querySelector('.bp-showcase-stage').offsetHeight;
                scrollTo({ top: start + (scene.offsetHeight - document.documentElement.clientHeight - hold) * .55, behavior: 'instant' });
            });
            await page.waitForTimeout(160);
        }
        await showCharts();
        const weights = page.locator('#weight-bars');
        await weights.evaluate(node => { node.style.maxHeight = '140px'; });
        const weightLabel = await weights.locator('.bp-weight-bar-row').first().evaluate(row => {
            const fill = row.querySelector('.bp-weight-bar-fill').getBoundingClientRect();
            const label = row.querySelector('.bp-weight-bar-value'), box = label.getBoundingClientRect();
            const track = row.querySelector('.bp-weight-bar-track');
            return { color: getComputedStyle(label).color, height: fill.height,
                radius: getComputedStyle(track).borderRadius, background: getComputedStyle(track).backgroundColor,
                inside: box.left >= fill.left && box.right <= fill.right + 1 && box.top >= fill.top && box.bottom <= fill.bottom };
        });
        check('relative weight labels are white inside thicker non-pill bars', weightLabel.color === 'rgb(255, 255, 255)'
            && weightLabel.inside && weightLabel.height >= 22 && weightLabel.radius === '3px'
            && weightLabel.background === 'rgba(0, 0, 0, 0)', weightLabel);
        for (const [name, locator, edge] of [
            ['weights at bottom', weights, 'bottom'], ['weights at top', weights, 'top'],
            ['models at right edge', page.locator('.bp-model-chart-scroll'), 'right']
        ]) {
            await showCharts();
            const position = await locator.evaluate((node, edge) => {
                if (edge === 'bottom') node.scrollTop = node.scrollHeight - node.clientHeight;
                if (edge === 'top') node.scrollTop = 0;
                if (edge === 'right') node.scrollLeft = node.scrollWidth - node.clientWidth;
                return { top: node.scrollTop, height: node.clientHeight, contentHeight: node.scrollHeight };
            }, edge);
            await page.waitForTimeout(180);
            const before = await page.evaluate(() => scrollY);
            const box = await locator.boundingBox();
            await page.mouse.move(box.x + box.width / 2, box.y + Math.min(box.height / 2, 90));
            await page.mouse.wheel(0, edge === 'top' ? -100 : 100);
            await page.waitForTimeout(300);
            const after = await page.evaluate(() => scrollY);
            check(name + ' hands vertical scrolling to page', edge === 'top' ? after < before - 10 : after > before + 10, { before, after, position });
        }
        await showCharts(); await weights.evaluate(node => { node.scrollTop = 0; });
        const beforeInternal = await page.evaluate(() => scrollY);
        const box = await weights.boundingBox();
        await page.mouse.move(box.x + box.width / 2, box.y + 60); await page.mouse.wheel(0, 50);
        await page.waitForTimeout(300);
        const internal = await weights.evaluate(node => node.scrollTop);
        check('weights still scroll internally before their edge', internal > 10 && Math.abs(await page.evaluate(() => scrollY) - beforeInternal) < 1,
            { internal, before: beforeInternal, after: await page.evaluate(() => scrollY) });

        if (engine === 'chromium' && width < 760) {
            const session = await context.newCDPSession(page);
            try {
                for (const [name, locator] of [['weights', weights], ['models', page.locator('.bp-model-chart-scroll')]]) {
                    await showCharts();
                    await locator.evaluate(node => { node.scrollTop = node.scrollHeight; });
                    const before = await page.evaluate(() => scrollY), box = await locator.boundingBox();
                    const start = { x: box.x + box.width / 2, y: box.y + Math.min(box.height - 8, 100), id: 8 };
                    await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
                    for (const distance of [20, 40, 60, 80]) {
                        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, y: start.y - distance }] });
                        await page.waitForTimeout(60);
                    }
                    await page.waitForTimeout(300);
                    await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                    await page.waitForTimeout(300);
                    const after = await page.evaluate(() => scrollY);
                    check(name + ' passes a real upward touch to page at the edge', after > before + 10, { before, after });
                }
            } finally { await session.detach(); }
        }
        await showCharts();
        await page.screenshot({ path: join(output, `${label}-charts.png`) });
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(800);
        if (width > 760) {
            const title = page.locator('#showcase-trigger');
            await page.mouse.move(0, 0);
            const before = await title.locator(':scope > span:visible').boundingBox();
            await title.hover();
            const samples = await title.locator(':scope > span:visible').evaluate(async node => {
                const values = [], start = performance.now();
                do { values.push({ top: node.getBoundingClientRect().top, transform: getComputedStyle(node).transform });
                    await new Promise(requestAnimationFrame);
                } while (performance.now() - start < 300);
                return values;
            });
            check('headline never moves vertically while hovered', samples.every(value => Math.abs(value.top - before.y) < .5), { before, samples });
            const hint = await title.evaluate(node => {
                const css = getComputedStyle(node, '::after');
                return { content: css.content, left: parseFloat(css.left), width: node.getBoundingClientRect().width, opacity: css.opacity };
            });
            check('View overview stays to the right', hint.content.includes('View overview') && hint.left > hint.width && Number(hint.opacity) === 1, hint);
            await page.screenshot({ path: join(output, `${label}-hover.png`) });
        }
        check('no page errors', errors.length === 0, errors);
        console.log(JSON.stringify({ label, checks: report.checks.map(({ name, passed }) => ({ name, passed })) }));
        reports.push(report);
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
assert.deepEqual(failures, []);
