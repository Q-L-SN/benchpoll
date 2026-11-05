import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_SCROLL_ARTIFACTS ?? '/tmp/benchpoll-continuous-ranking';
await mkdir(output, { recursive: true });

for (const engine of [chromium, webkit]) for (const width of [390, 1440]) {
    test(`${engine.name()} ${width} ${built ? 'built' : 'source'}: search and seamless bidirectional ranking`, { timeout: 45000 }, async t => {
        const app = await startPreview();
        app.state.comparisonModels = Array.from({ length: 220 }, (_, index) => ({
            ID: 5000 + index, modelID: 3000 + index, modelName: `Scroll model ${index + 1}`, name: `Scroll model ${index + 1}`,
            vendor: 'Synthetic', vendorSlug: 'openai', condition: { name: '', parameters: {}, scoreFields: [] },
            results: new Map(Array.from({ length: 8 }, (_, condition) => [String(condition + 1), { normalizedScore: 100 - index * .3 }]))
        }));
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 760, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        let release = () => {};
        t.after(async () => { release(); await browser.close(); await app.close(); assert.deepEqual(errors, []); });
        if (built) await page.route(app.url + '/Intelligence', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        await page.goto(app.url + '/Intelligence');
        await page.locator('#model-rows .bp-model-row').first().waitFor();
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.locator('#ranking-model-search .bp-model-search-toggle').click();
        const search = page.getByRole('combobox', { name: 'Search models' });
        await search.fill('Scroll model 121');
        await page.getByRole('option', { name: 'Scroll model 121', exact: true }).waitFor();
        await search.press('ArrowDown'); await search.press('Enter');
        await page.locator('#model-rows [data-rank="121"].is-model-jump-focus').waitFor();
        assert.equal(await page.locator('.bp-model-focus-pagination').count(), 0);
        assert.equal(await page.getByRole('button', { name: /^(Previous models|Next models|Top of ranking)$/ }).count(), 0);
        const position = await page.evaluate(async () => {
            const { modelScrollViewport } = await import('/js/workspace/model-scroll-window.js');
            const rows = document.getElementById('model-rows');
            const viewport = modelScrollViewport(rows), target = rows.querySelector('[data-rank="121"]');
            window.rankingScrollQA = { rows, viewport: () => modelScrollViewport(rows) };
            return { target: target.getBoundingClientRect().toJSON(), start: viewport.start, end: viewport.end };
        });
        assert.ok(position.target.top >= position.start && position.target.bottom <= position.end, JSON.stringify(position));

        let started;
        const requestStarted = new Promise(resolve => { started = resolve; });
        const gate = new Promise(resolve => { release = resolve; });
        let previousRequests = 0;
        await page.route('**/api/get_ranking_page', async route => {
            const body = route.request().postDataJSON();
            if (body.list === 'public' && body.offset === 50) { previousRequests++; started(); await gate; }
            await route.continue().catch(() => {});
        });
        await page.evaluate(() => {
            const { rows, viewport } = window.rankingScrollQA, v = viewport();
            rows.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -10 }));
            v.root.scrollTop += v.position(rows.querySelector('[data-model-key]')) - v.start + 80;
        });
        await requestStarted;
        await page.evaluate(() => {
            const { rows, viewport } = window.rankingScrollQA, v = viewport();
            rows.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -10 }));
            rows.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch', pointerId: 9 }));
            v.root.scrollTop += 12;
        });
        await page.waitForTimeout(60);
        const before = await page.evaluate(() => {
            const { rows, viewport } = window.rankingScrollQA, v = viewport();
            const node = [...rows.querySelectorAll('[data-model-key]')].find(node => v.tail(node) > v.start);
            window.rankingScrollQA.anchor = node;
            return { key: node.dataset.modelKey, top: node.getBoundingClientRect().top };
        });
        release();
        await page.locator('#model-rows [data-rank="51"]').waitFor();
        await page.waitForTimeout(80);
        const after = await page.evaluate(() => {
            const node = window.rankingScrollQA.anchor;
            return { key: node.dataset.modelKey, top: node.getBoundingClientRect().top, connected: node.isConnected };
        });
        assert.equal(previousRequests, 1, 'Scrolling does not cancel or duplicate a segment request');
        assert.equal(after.connected, true, 'Already visible rows keep their DOM identity');
        assert.equal(after.key, before.key);
        assert.ok(Math.abs(after.top - before.top) <= 1.5, JSON.stringify({ before, after }));

        const scrollEdge = async direction => page.evaluate(direction => {
            const { rows, viewport } = window.rankingScrollQA, v = viewport();
            rows.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: direction === 'next' ? 20 : -20 }));
            const models = rows.querySelectorAll('[data-model-key]');
            const node = direction === 'next' ? models[models.length - 1] : models[0];
            v.root.scrollTop += direction === 'next' ? v.tail(node) - v.end + 80 : v.position(node) - v.start + 80;
        }, direction);
        for (const rank of [175, 200, 220]) {
            await scrollEdge('next');
            await page.locator(`#model-rows [data-rank="${rank}"]`).waitFor();
        }
        for (const rank of [26, 1]) {
            await scrollEdge('previous');
            await page.locator(`#model-rows [data-rank="${rank}"]`).waitFor();
        }
        const ranks = await page.locator('#model-rows [data-model-key]').evaluateAll(nodes => nodes.map(node => Number(node.dataset.rank)));
        assert.deepEqual(ranks, Array.from({ length: 220 }, (_, index) => index + 1));
        assert.equal(await page.locator('[data-model-window-edge]').count(), 0, 'Both ends stop requesting at the real ranking boundaries');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${built ? 'built' : 'source'}.png` });
    });
}
