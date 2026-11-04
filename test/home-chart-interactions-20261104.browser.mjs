import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = 'D:/Codex-artifacts/website1/ui-hover-weights-20261104';
const launch = { headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } };

async function geometry(card) {
    return card.locator('.th-treemap').evaluate(tree => ({
        width: tree.clientWidth, height: tree.clientHeight,
        mask: getComputedStyle(tree).maskImage || getComputedStyle(tree).webkitMaskImage,
        tiles: [...tree.querySelectorAll('.th-tile')].map(tile => ({
            key: tile.dataset.weightKey, weight: Number(tile.dataset.weight), share: Number(tile.dataset.share),
            x: parseFloat(tile.style.left), y: parseFloat(tile.style.top),
            width: parseFloat(tile.style.width), height: parseFloat(tile.style.height)
        }))
    }));
}

for (const engine of [chromium, webkit]) for (const width of [390, 1440]) {
    test(`${engine.name()} ${width}: quiet model bars, landscape full weights and unchanged mixed view`, async t => {
        const app = await startTopicsPreview({ built: process.env.BP_UI_BUILT === '1' });
        t.after(() => app.close());
        const browser = await engine.launch(launch);
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(app.url);
        const card = page.locator('.th-card[data-topic-id="54"]');
        await page.waitForSelector('.th-card[data-topic-id="54"][data-preview-state="loaded"]');
        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
        const panel = page.locator('#bp-help-popover');
        const mixed = await geometry(card);
        assert.match(mixed.mask, /gradient/);

        for (const mode of ['available', 'range']) {
            if (mode === 'range') {
                await page.locator('#topics-score-toggle').click();
                await card.locator('.th-model-range').first().waitFor();
            }
            const column = card.locator('a.th-model').first();
            const bar = column.locator('.th-model-bar');
            const plot = column.locator('.th-model-plot');
            await page.mouse.move(0, 0);
            await page.evaluate(() => document.activeElement?.blur());
            const background = await plot.evaluate(node => getComputedStyle(node).backgroundColor);
            const barColor = await bar.evaluate(node => getComputedStyle(node).backgroundColor);
            await bar.hover();
            await page.waitForTimeout(350);
            assert.equal(await card.locator('.th-model[data-tooltip], .th-model[title]').count(), 0);
            assert.equal(await panel.isVisible(), false, `${mode}: bar hover has no tooltip`);
            assert.notEqual(await plot.evaluate(node => getComputedStyle(node).backgroundColor), background, 'plot still highlights');
            assert.equal(await bar.evaluate(node => getComputedStyle(node).backgroundColor), barColor, 'vendor color is unchanged');
            assert.match(await column.getAttribute('aria-label'), /Open GPT-5\. Score(?: range)? 100/);
            assert.match(await column.getAttribute('aria-label'), /87% benchmark coverage/);
            await column.focus();
            assert.equal(await panel.isVisible(), false, 'keyboard focus does not restore the tooltip');
        }

        await page.locator('#topics-score-toggle').click();
        await card.locator('.th-model-range').first().waitFor({ state: 'detached' });
        await page.locator('#topics-view-toggle').click();
        await card.locator('.th-visual[data-view="weights"]').waitFor();
        const full = await geometry(card);
        assert.equal(full.mask, 'none');
        assert.deepEqual(full.tiles.map(tile => [tile.key, tile.weight]), mixed.tiles.map(tile => [tile.key, tile.weight]));
        const wide = full.tiles.filter(tile => tile.width > tile.height * 1.2);
        assert.ok(wide.length >= Math.ceil(full.tiles.length * 2 / 3), `${wide.length}/${full.tiles.length} tiles are wide`);
        assert.ok(wide.reduce((sum, tile) => sum + tile.share, 0) >= .7);
        for (const key of ['condition:1', 'condition:2']) {
            assert.equal(await card.locator(`.th-tile[data-weight-key="${key}"] .th-tile-name`).getAttribute('data-overflow'), 'false',
                'leading benchmark names fit on a horizontal line');
        }
        assert.ok(Math.abs(full.tiles.reduce((sum, tile) => sum + tile.width * tile.height, 0) - full.width * full.height) < 1);
        assert.equal(full.tiles.reduce((sum, tile) => sum + tile.weight, 0), 10000);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await mkdir(output, { recursive: true });
        await card.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 180));
        await page.mouse.move(width - 1, 880);
        await card.screenshot({ path: join(output, `${engine.name()}-${width}-full-weights.png`) });
        const weight = card.locator('.th-tile[data-weight-key="other"]');
        await weight.hover();
        await panel.waitFor({ state: 'visible' });
        assert.equal(await panel.textContent(), await weight.getAttribute('data-tooltip'), 'home weight explanations remain unchanged');
        await page.keyboard.press('Escape');

        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
        await page.locator('#topics-view-toggle').click();
        await card.locator('.th-visual[data-view="default"]').waitFor();
        assert.deepEqual(await geometry(card), mixed, 'mixed view retains its original exposure-priority geometry and fade');
        await card.evaluate(node => scrollTo(0, node.getBoundingClientRect().top + scrollY - 180));
        const column = card.locator('a.th-model').first();
        await column.locator('.th-model-bar').hover();
        await page.waitForTimeout(350);
        assert.equal(await panel.isVisible(), false);
        await card.screenshot({ path: join(output, `${engine.name()}-${width}-mixed-hover.png`) });
        const destination = new URL(await column.getAttribute('href'), app.url).href;
        assert.equal(new URL(destination).searchParams.get('focusModel'), await column.getAttribute('data-model-key'));
        await page.route(destination, route => route.fulfill({ contentType: 'text/html', body: '<title>Model destination</title>' }));
        await column.locator('.th-model-bar').click();
        await page.waitForURL(destination);
        assert.equal(page.url(), destination, 'bar click still follows the exact model link');
        assert.deepEqual(errors, []);
    });
}
