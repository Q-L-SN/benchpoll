import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models } from './fixtures.mjs';

const output = process.env.RANKING_NUMBER_OUTPUT ?? 'D:/Codex-artifacts/website1/ranking-number-display-20261016/source';
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const publicWeights = [9000, 694, 243, 62, 1].map((weightBasisPoints, index) => ({ conditionID: index + 1, weightBasisPoints }));
const rawScores = [86.51, 86.5, 65.49, .49, -.5];
const comparisonModels = rawScores.map((score, index) => ({ ...models[index],
    results: new Map(benchmarks.map(item => [String(item.conditionID), { normalizedScore: score }])) }));
const expectedScores = ['87', '87', '65', '0', '-1'];
const reports = [];
await mkdir(output, { recursive: true });

for (const [engine, launcher, width, height] of [['chromium', chromium, 1440, 900], ['chromium', chromium, 390, 844],
    ['chromium', chromium, 320, 640], ['webkit', webkit, 390, 844]]) {
    const app = await startPreview({ publicWeights, personalEntries: [], comparisonModels });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const label = `${engine}-${width}`, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    if (html || engine === 'webkit' && !liveURL) await page.route(`${app.url}/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        if (html && route.request().resourceType() === 'document') return route.fulfill({ body: html, contentType: 'text/html' });
        if (html && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))),
            contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
        if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
        return route.fallback();
    });
    const ready = () => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
    async function inspectLabels(selector, expectOutside) {
        await page.locator('.bp-score-fill, .bp-score-known, .bp-score-uncertain').evaluateAll(nodes =>
            Promise.allSettled(nodes.flatMap(node => node.getAnimations().map(animation => animation.finished))));
        const viewportWidth = page.viewportSize().width;
        await page.waitForFunction(selector => [...document.querySelectorAll(selector)].every(node => {
            const track = node.parentElement, width = node.getBoundingClientRect().width;
            const end = parseFloat(node.style.getPropertyValue('--bar-label-position'));
            const start = parseFloat(node.style.getPropertyValue('--bar-label-start'));
            return track.clientWidth > 0 && width > 0
                && node.dataset.barLabelOverflow === String(track.clientWidth * Math.max(0, end - start) / 100 < width);
        }), selector);
        const measured = await page.locator(selector).evaluateAll(labels => labels.map(node => {
            const css = getComputedStyle(node), box = node.getBoundingClientRect(), track = node.parentElement;
            const fill = track.querySelector('.bp-weight-bar-fill, .bp-score-known').getBoundingClientRect();
            return { text: node.textContent, outside: node.dataset.barLabelOverflow === 'true', color: css.color,
                opacity: css.opacity, rightOfBar: box.left >= fill.right - 1, inside: box.left >= fill.left - 1 && box.right <= fill.right + 1,
                width: box.width, right: box.right, trackRight: track.getBoundingClientRect().right };
        }));
        for (const item of measured) {
            assert.equal(item.opacity, '1', JSON.stringify(item));
            assert.equal(item.color, item.outside ? 'rgb(17, 17, 17)' : 'rgb(255, 255, 255)', JSON.stringify(item));
            assert.equal(item.outside ? item.rightOfBar : item.inside, true, JSON.stringify(item));
            assert.ok(item.width > 0 && item.right <= viewportWidth + 1, JSON.stringify(item));
        }
        if (expectOutside) assert.ok(measured.some(item => item.outside), JSON.stringify(measured));
        return measured;
    }
    try {
        await page.goto(liveURL ?? app.url); await ready(); await page.evaluate(() => document.fonts.ready);
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const hold = scene.querySelector('.bp-showcase-stage').offsetHeight;
            scrollTo({ top: (scene.offsetHeight - document.documentElement.clientHeight - hold) * .55, behavior: 'instant' });
        });
        await page.waitForFunction(() => getComputedStyle(document.body).getPropertyValue('--showcase-reveal').trim() === '1'
            && getComputedStyle(document.body).getPropertyValue('--showcase-outro').trim() === '0');
        assert.deepEqual(await page.locator('.bp-weight-bar-value').allTextContents(), ['90%', '7%', '2%', '1%', '0%']);
        assert.deepEqual(await page.locator('.bp-model-column-value').allTextContents(), expectedScores);
        assert.deepEqual(await page.locator('.bp-weight-bar-fill').evaluateAll(nodes => nodes.map(node => node.title)), ['90%', '7%', '2%', '1%', '0%']);
        const weights = await inspectLabels('.bp-weight-bar-value', true);
        const endpoints = await page.locator('.bp-weight-bar-row').evaluateAll(rows => rows.map(row => parseFloat(row.style.getPropertyValue('--weight-width'))));
        for (let index = 0; index < endpoints.length; index++) assert.ok(Math.abs(endpoints[index] - publicWeights[index].weightBasisPoints / 9000 * 100) < 1e-10);
        assert.ok((await page.locator('.bp-model-chart-axis span').allTextContents()).every(value => /^-?\d+$/.test(value)));
        await page.screenshot({ path: join(output, `${label}-overview.png`) });
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.display === 'standard');
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        const rowScores = () => page.locator('.bp-model-score > span').allTextContents();
        assert.deepEqual(await rowScores(), expectedScores);
        const order = await page.locator('.bp-model-row').evaluateAll(nodes => nodes.map(node => node.dataset.modelKey));
        const rangeTitles = await page.locator('.bp-model-row').evaluateAll(nodes => nodes.map(node => node.title));
        assert.ok(rangeTitles.every(value => /^-?\d+\u2013-?\d+, \d+% benchmark coverage$/.test(value)), JSON.stringify(rangeTitles));
        const geometry = await page.locator('.bp-score-known').evaluateAll(nodes => nodes.map(node => node.style.width));
        assert.ok(Math.abs(parseFloat(geometry[0]) - parseFloat(geometry[1])) > .001, 'Display ties must not change true bar lengths');
        const rangeScores = await inspectLabels('.bp-score-track > .bp-model-score', true);
        assert.equal(await page.locator('.bp-score-track').evaluateAll(nodes => nodes.every(node => node.getBoundingClientRect().height === 26)), true);
        await page.screenshot({ path: join(output, `${label}-range.png`) });
        await page.locator('[data-score-mode="available"]').click(); await ready();
        await page.waitForFunction(() => document.querySelector('[data-score-mode="available"]').getAttribute('aria-pressed') === 'true');
        assert.deepEqual(await rowScores(), expectedScores);
        assert.deepEqual(await page.locator('.bp-model-row').evaluateAll(nodes => nodes.map(node => node.dataset.modelKey)), order);
        const scores = await inspectLabels('.bp-score-track > .bp-model-score', true);
        await page.locator('.bp-model-row').first().click(); await page.locator('#model-scores-dialog').waitFor();
        assert.match(await page.locator('#model-scores-summary').textContent(), /^87 total, 100% covered/);
        await page.locator('#model-scores-dialog .dialog-close-button').click();
        await page.screenshot({ path: join(output, `${label}-scores.png`) });
        await page.setViewportSize({ width: width === 1440 ? 1280 : 430, height });
        await page.waitForTimeout(300);
        await inspectLabels('.bp-score-track > .bp-model-score', true);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(app.state.requests.some(request => /save_personal_pie|submit_contribution/.test(request.path)), false);
        assert.deepEqual(errors, []);
        reports.push({ label, roundedScores: expectedScores, weights, rangeScores, scores, geometry, rawScores, noCalculationWrites: true });
        console.log(`PASS ${label}: rounded rankings, original precision, visible short-bar labels and resize`);
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
