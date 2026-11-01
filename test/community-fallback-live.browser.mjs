import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/community-fallback-live-20261030';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    for (const width of [390, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', hasTouch: width < 760 });
        try {
            const page = await context.newPage(), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.setDefaultTimeout(60000);
            await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
            assert.equal((await page.locator('h1').textContent()).replace(/\s+/g, ' ').trim(), 'We believe in benchmarks. Not a narrow selection.');
            await page.locator('.th-card[data-preview-state="loaded"] .th-model').first().waitFor();
            const topicURL = await page.locator('.th-card-title a').first().getAttribute('href');
            await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
            await page.getByRole('tab', { name: 'Search topics', exact: true }).click();
            const search = page.getByRole('searchbox', { name: 'Search topics', exact: true });
            await search.fill('Coding');
            assert.equal(await search.isVisible(), true);
            await page.evaluate(() => scrollTo(0, 0));
            await search.waitFor({ state: 'hidden' });
            await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
            assert.equal(await search.isVisible(), false);
            await page.getByRole('tab', { name: 'Popular', exact: true }).click();
            await page.locator('#topics-score-toggle').click();
            const range = page.locator('.th-model-range').first();
            await range.waitFor();
            assert.equal(await range.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(146, 158, 172)');
            await page.screenshot({ path: `${output}/home-${width}.png` });
            await page.goto(new URL(topicURL, 'https://benchpoll.com').href, { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
            assert.equal(await page.locator('#model-leaderboard-heading').textContent(), 'Public AI Index');
            assert.equal(await page.locator('#inline-fallback-add-other-versions').count(), 0);
            if (width < 760) {
                assert.equal(await page.locator('#model-leaderboard-heading').isVisible(), false);
                assert.equal(await page.locator('#model-index-tab').textContent(), 'Public AI Index');
                await page.evaluate(() => scrollTo(0, 300));
                const top = await page.locator('.bp-context-identity').evaluate(node => node.getBoundingClientRect().top);
                assert.ok(top >= 59 && top <= 61, String(top));
                await page.locator('#model-index-tab').click();
            }
            await page.locator('.bp-scoring-help').click();
            await page.locator('#bp-help-popover').waitFor({ state: 'visible' });
            assert.match(await page.locator('#bp-help-popover').textContent(), /Estimated score/);
            await page.screenshot({ path: `${output}/workspace-${width}.png` });
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ width, homepageRange: true, searchClosesAtHero: true, publicIndex: true, tooltip: true }));
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
