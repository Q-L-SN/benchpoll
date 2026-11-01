import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { models, weightedEntries } from './fixtures.mjs';
import { openOverview } from './showcase-interactions.mjs';

const output = process.env.SCORE_COLORS_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/fixed-appearance-20261015/colors';
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const app = await startPreview({ comparisonModels: models.slice(0, 3).map((model, index) => ({ ...model, modelName: model.name,
        vendor: model.vendorName, results: new Map([1, 6].map(ID => [String(ID), { normalizedScore: [100, .7, 0][index] }])) })),
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]) });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const label = `${engine}-${width}${builtRoot ? '-built' : ''}`, errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const ready = () => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready' && document.querySelectorAll('.bp-model-row').length === 3);
    try {
        if (html || engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            if (html && route.request().resourceType() === 'document') return route.fulfill({ body: html, contentType: 'text/html' });
            if (html && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
            return route.fallback();
        });
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            localStorage.setItem('benchpoll-score-bar-colors-v1', 'uniform');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', scoreMode: 'available' }));
        });
        await page.goto(app.url); await ready(); await page.evaluate(() => document.fonts.ready);
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.waitForFunction(() => [...document.querySelectorAll('.bp-model-score')].slice(1)
            .every(label => label.getBoundingClientRect().height > 0 && label.dataset.barLabelOverflow === 'true'));
        const placements = await page.locator('.bp-score-track').evaluateAll(tracks => tracks.map(track => {
            const label = track.querySelector('.bp-model-score'), box = label.getBoundingClientRect(), fill = track.querySelector('.bp-score-known').getBoundingClientRect();
            return { text: label.textContent, overflow: label.dataset.barLabelOverflow, color: getComputedStyle(label).color,
                opacity: getComputedStyle(label).opacity, inside: box.left >= fill.left - 1 && box.right <= fill.right + 1,
                toRight: box.left >= fill.right - 1, width: fill.width, scoreWidth: box.width };
        }));
        assert.equal(placements[0].inside, true); assert.equal(placements[0].color, 'rgb(255, 255, 255)');
        assert.deepEqual(placements.map(value => value.text), ['100.00', '0.70', '0.00']);
        for (const placement of placements.slice(1)) {
            assert.equal(placement.overflow, 'true'); assert.equal(placement.toRight, true, JSON.stringify(placement));
            assert.equal(placement.color, 'rgb(17, 17, 17)'); assert.equal(placement.opacity, '1');
        }
        assert.equal(await page.locator('.bp-score-colors-toggle,.bp-fallback-style-control').count(), 0);
        assert.equal(await page.locator('html').getAttribute('data-score-colors'), null);
        const before = app.state.requests.length;
        const signature = await page.locator('#model-rows').evaluate(node => { window.savedRows = [...node.children]; return node.innerHTML; });
        const vendors = await page.locator('.bp-score-known').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
        assert.ok(new Set(vendors).size > 1, JSON.stringify(vendors));
        await page.evaluate(() => {
            localStorage.setItem('benchpoll-score-bar-colors-v1', 'uniform');
            window.dispatchEvent(new StorageEvent('storage', { key: 'benchpoll-score-bar-colors-v1', newValue: 'uniform' }));
        });
        assert.deepEqual(await page.locator('.bp-score-known').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor)), vendors);
        assert.equal(await page.locator('#model-rows').innerHTML(), signature);
        assert.equal(await page.locator('#model-rows').evaluate(node => window.savedRows.every((row, index) => row === node.children[index])), true);
        assert.equal(app.state.requests.length, before, 'Retired color preferences must not fetch or save rankings');
        await page.screenshot({ path: join(output, `${label}-vendor.png`) });
        const toolbar = await page.locator('.bp-model-toolbar').evaluate(node => {
            const title = node.querySelector('h2').getBoundingClientRect();
            return { overflow: node.scrollWidth > node.clientWidth + 1, titleHeight: title.height,
                lineHeight: parseFloat(getComputedStyle(node.querySelector('h2')).lineHeight) };
        });
        assert.equal(toolbar.overflow, false);
        if (width === 390) assert.ok(toolbar.titleHeight <= toolbar.lineHeight + 1, JSON.stringify(toolbar));
        await page.reload(); await ready();
        assert.deepEqual(await page.locator('.bp-score-known').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor)), vendors);
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        await openOverview(page, width < 760, { native: false });
        await page.waitForFunction(() => document.querySelectorAll('.bp-model-column').length === 3);
        assert.equal(await page.locator('.bp-score-colors-toggle').count(), 0);
        const columns = await page.locator('.bp-column-known').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).backgroundColor));
        assert.deepEqual(columns, vendors);
        await page.screenshot({ path: join(output, `${label}-columns.png`) });
        assert.deepEqual(errors, []);
        reports.push({ label, placements, vendors, columns });
        console.log(JSON.stringify({ label, passed: true }));
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
