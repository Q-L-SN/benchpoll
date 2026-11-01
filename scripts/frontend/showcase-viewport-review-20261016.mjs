import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.SHOWCASE_VIEWPORT_OUTPUT ?? 'D:/Codex-artifacts/website1/review-showcase-viewport-20261016/source';
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [], failures = [];
for (const [engine, launcher, width, height] of [
    ['chromium', chromium, 1440, 900], ['chromium', chromium, 1440, 720], ['chromium', chromium, 1440, 650],
    ['chromium', chromium, 1024, 600], ['chromium', chromium, 820, 650], ['chromium', chromium, 390, 667],
    ['chromium', chromium, 320, 568], ['chromium', chromium, 844, 390], ['webkit', webkit, 1440, 650],
    ['webkit', webkit, 390, 667]
]) {
    const app = await startPreview({ rankingStress: true });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(30000);
    const label = `${engine}-${width}x${height}`, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    if (html || engine === 'webkit' && !liveURL) await page.route(`${app.url}/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        if (html && route.request().resourceType() === 'document') return route.fulfill({ body: html, contentType: 'text/html' });
        if (html && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
        if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
        return route.fallback();
    });
    try {
        await page.goto(liveURL ?? app.url);
        await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
        await page.evaluate(() => document.fonts.ready);
        const heroBounds = await page.evaluate(() => {
            const hero = document.querySelector('.bp-showcase-hero').getBoundingClientRect();
            return { top: hero.top, bottom: hero.bottom, footerTop: document.querySelector('.bp-showcase-footer').getBoundingClientRect().top };
        });
        await page.screenshot({ path: join(output, `${label}-hero.png`) });
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const hold = scene.querySelector('.bp-showcase-stage').offsetHeight;
            scrollTo({ top: (scene.offsetHeight - document.documentElement.clientHeight - hold) * .55, behavior: 'instant' });
        });
        await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--showcase-reveal').trim() === '1');
        const geometry = await page.evaluate(() => {
            const rect = selector => {
                const box = document.querySelector(selector).getBoundingClientRect();
                return { top: box.top, bottom: box.bottom, left: box.left, right: box.right, height: box.height };
            };
            const rows = document.getElementById('model-rows');
            const scrolling = document.querySelector('.bp-model-chart-scroll');
            const ticks = [...document.querySelectorAll('.bp-model-chart-axis > span')]
                .filter(node => getComputedStyle(node).display !== 'none')
                .map(node => ({ top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom }))
                .sort((a, b) => a.top - b.top);
            return { footer: rect('.bp-showcase-footer'), sceneHeading: rect('.bp-showcase-scene-heading'),
                grid: rect('.bp-workspace-grid'), toolbar: rect('.bp-model-toolbar'), models: rect('#model-rows'),
                weights: rect('#weight-bars'), legend: rect('.bp-model-chart-legend'),
                plot: rect('.bp-model-column-plot'), source: rect('.bp-pie-mode-row'),
                modelOverflow: getComputedStyle(rows).overflowY, modelScroll: rows.scrollHeight - rows.clientHeight,
                chartOverflow: getComputedStyle(scrolling).overflowY,
                chartScroll: scrolling.scrollHeight - scrolling.clientHeight,
                ticks,
                documentOverflow: document.documentElement.scrollWidth - innerWidth };
        });
        const checks = {
            heroAboveFooter: heroBounds.bottom <= heroBounds.footerTop + 1,
            modelContentAboveFooter: geometry.models.bottom <= geometry.footer.top + 1,
            legendAboveFooter: geometry.legend.bottom <= geometry.footer.top + 1,
            weightsAboveFooter: geometry.weights.bottom <= geometry.footer.top + 1,
            gridBelowHeading: geometry.grid.top >= geometry.sceneHeading.bottom - 1,
            noVerticalModelScroll: geometry.modelOverflow === 'visible' && geometry.modelScroll <= 1 && geometry.chartOverflow === 'hidden',
            visiblePlot: geometry.plot.height >= 40,
            noOverlappingAxisLabels: geometry.ticks.every((tick, index) => index === 0 || tick.top >= geometry.ticks[index - 1].bottom - .5),
            noDocumentHorizontalOverflow: geometry.documentOverflow <= 1,
            noPageErrors: errors.length === 0
        };
        await page.screenshot({ path: join(output, `${label}.png`) });
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            scrollTo({ top: scene.offsetHeight - document.documentElement.clientHeight - scene.querySelector('.bp-showcase-stage').offsetHeight, behavior: 'instant' });
        });
        await page.waitForFunction(() => Number(getComputedStyle(document.querySelector('.bp-showcase-outro')).opacity) === 1);
        const outroBounds = await page.evaluate(() => {
            const outro = document.querySelector('.bp-showcase-outro').getBoundingClientRect();
            return { top: outro.top, bottom: outro.bottom, footerTop: document.querySelector('.bp-showcase-footer').getBoundingClientRect().top };
        });
        checks.outroAboveFooter = outroBounds.bottom <= outroBounds.footerTop + 1;
        for (const [name, passed] of Object.entries(checks)) if (!passed) failures.push(`${label}: ${name}`);
        reports.push({ label, geometry, heroBounds, outroBounds, checks, errors });
        await page.screenshot({ path: join(output, `${label}-outro.png`) });
        console.log(JSON.stringify({ label, checks, modelBottom: geometry.models.bottom, footerTop: geometry.footer.top }));
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
assert.deepEqual(failures, []);
