import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { test } from 'node:test';
import { chromium } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';

const output = 'D:/Codex-artifacts/website1/home-score-range-20261030';
const luminance = channels => channels.map(value => value / 255).map(value => value <= .04045
    ? value / 12.92 : ((value + .055) / 1.055) ** 2.4).reduce((sum, value, index) => sum + value * [.2126, .7152, .0722][index], 0);

for (const width of [390, 1440]) {
    test(`Home score ranges remain visible against the pale treemap at ${width}px`, async () => {
        await mkdir(output, { recursive: true });
        const app = await startTopicsPreview({ built: process.env.TOPICS_HOME_BUILT === '1' });
        const browser = await chromium.launch({ headless: true });
        try {
            const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
            page.setDefaultTimeout(10000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            await page.goto(app.url);
            await page.waitForSelector('.th-card[data-topic-id="54"][data-preview-state="loaded"]');
            await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
            await page.locator('#topics-score-toggle').click();
            const card = page.locator('.th-card[data-topic-id="54"]');
            await card.locator('.th-model-range').first().waitFor();
            const ranges = await card.locator('.th-model-range').evaluateAll(nodes => nodes.map(node => {
                const bar = node.parentElement.querySelector('.th-model-bar');
                return { color: getComputedStyle(node).backgroundColor, opacity: getComputedStyle(node).opacity,
                    height: node.getBoundingClientRect().height, knownHeight: bar.getBoundingClientRect().height };
            }));
            assert.ok(ranges.some(range => range.height > range.knownHeight + 8));
            for (const range of ranges) {
                const channels = range.color.match(/\d+/g).slice(0, 3).map(Number);
                assert.ok(1.05 / (luminance(channels) + .05) >= 2.5, `Low contrast range: ${range.color}`);
                assert.equal(range.opacity, '1');
            }
            await card.screenshot({ path: join(output, `score-range-${width}.png`) });
            assert.deepEqual(errors, []);
        } finally {
            await browser.close();
            await app.close();
        }
    });
}
