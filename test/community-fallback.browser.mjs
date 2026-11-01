import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { familyEntries } from '../scripts/frontend/fixtures.mjs';

let chrome, safari;
before(async () => {
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    chrome = await chromium.launch({ headless: true, env });
    safari = await webkit.launch({ headless: true, env });
});
after(async () => { await chrome?.close(); await safari?.close(); });

for (const [engine, width] of [['chromium', 1440], ['chromium', 390], ['webkit', 375]]) {
    test(`${engine} ${width}: add without interruption, save explicit none, restore community, and create a chain`, async t => {
        const chain = { primaryConditionID: 5, familyID: 50, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }]) };
        const app = await startPreview({ topicHome: true, families: [chain], publicFamilyComposition: [{ primaryConditionID: 5,
            configuredPieCount: 2, isDefault: false, families: [{ ...chain, weightBasisPoints: 10000, overallWeightBasisPoints: 1000 }] }] });
        const page = await (engine === 'webkit' ? safari : chrome).newPage({ viewport: { width, height: 900 },
            hasTouch: width < 760, reducedMotion: 'reduce' });
        const errors = [];
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await page.close(); await app.close(); assert.deepEqual(errors, []); });
        const saved = async action => {
            const response = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.status() === 200);
            await action(); await response;
        };
        await page.goto(`${app.url}/Intelligence`);
        await page.locator('#pie-mode-personal').click();
        const add = page.locator('.bp-benchmark-row[data-condition-id="5"] [data-benchmark-control="add"]').first();
        await saved(() => add.click());
        assert.equal(await page.locator('#fallback-picker').isVisible(), false);
        assert.ok(app.state.personalEntries.some(entry => entry.conditionID === 5));
        assert.equal(app.state.fallbackRules.some(rule => rule.primaryConditionID === 5), false);
        assert.equal(await page.locator('#inline-fallback-toggle').innerText(), 'Fallback: Follow community');
        await page.locator('#inline-fallback-toggle').click();
        assert.equal(await page.locator('.bp-fallback-picker-selection-status').getAttribute('data-selection'), 'community');
        assert.equal(await page.locator('.bp-fallback-picker-column[data-family-key="community"]').count(), 0);
        assert.equal(await page.locator('.bp-fallback-picker-electorate').textContent(), '2 explicit choices');
        await mkdir('D:/Codex-artifacts/website1/fallback-choice-state-20261031', { recursive: true });
        await page.screenshot({ path: `D:/Codex-artifacts/website1/fallback-choice-state-20261031/picker-${engine}-${width}.png` });
        const bounds = await page.locator('#fallback-picker').evaluate(node => node.getBoundingClientRect().toJSON());
        assert.ok(bounds.width <= width + 1, JSON.stringify(bounds));
        const noFallback = page.locator('.bp-fallback-picker-column[data-family-key="[5]"] .bp-fallback-picker-card-toggle');
        await saved(() => noFallback.click());
        assert.deepEqual(app.state.fallbackRules.find(rule => rule.primaryConditionID === 5)?.entries, []);
        assert.equal(app.state.fallbackRules.find(rule => rule.primaryConditionID === 5)?.familyID, null);
        assert.equal(await noFallback.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#inline-fallback-toggle').textContent().then(text => text.trim()), 'Fallback: No fallback');
        await page.reload();
        await page.locator('#pie-mode-personal').click();
        await page.locator('.bp-benchmark-row[data-condition-id="5"]').first().click();
        const entry = page.locator('#inline-fallback-toggle');
        if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
        assert.equal(await page.locator('#fallback-picker').isVisible(), false);
        await entry.click();
        assert.equal(await entry.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.locator('#fallback-picker').isVisible(), false);
        await entry.click();
        await page.locator('#inline-fallback-preview').click({ position: { x: 2, y: 2 } });
        assert.equal(await page.locator('#fallback-picker').isVisible(), false, 'Preview is not a hidden chooser trigger');
        await page.locator('#inline-fallback-configurations').click();
        assert.equal(await noFallback.getAttribute('aria-pressed'), 'true');
        await saved(() => noFallback.click());
        assert.equal(app.state.fallbackRules.some(rule => rule.primaryConditionID === 5), false);
        assert.equal(await page.locator('.bp-fallback-picker-selection-status').getAttribute('data-selection'), 'community');
        assert.equal(await page.locator('#inline-fallback-toggle').textContent().then(text => text.trim()), 'Fallback: Follow community');
        const shared = page.locator('.bp-fallback-picker-column[data-family-key="[5,2]"] .bp-fallback-picker-card-toggle');
        app.state.saveDelay = 900;
        await saved(async () => {
            await shared.click();
            assert.equal(await page.locator('#inline-fallback-toggle').textContent().then(text => text.trim()), 'Fallback: Selected configuration');
            assert.equal(app.state.fallbackRules.some(rule => rule.primaryConditionID === 5), false, 'The local state changes before the save receipt');
        });
        assert.equal(await page.locator('.bp-fallback-picker-customize').isVisible(), true);
        await saved(() => shared.click());
        await saved(async () => {
            await page.locator('.bp-fallback-picker-customize').click();
            assert.equal(await entry.innerText(), 'Fallback: Custom');
            assert.equal(app.state.fallbackRules.some(rule => rule.primaryConditionID === 5), false, 'The custom label changes before saving or adding a backup');
        });
        assert.equal(app.state.fallbackRules.find(rule => rule.primaryConditionID === 5)?.selectionSource, 'custom');
        app.state.saveDelay = 0;
        await page.locator('#inline-fallback-add-benchmark').click();
        assert.equal(await entry.innerText(), 'Fallback: Custom');
        await saved(() => page.locator('.bp-benchmark-row[data-condition-id="2"] [data-benchmark-control="add"]').first().click());
        assert.deepEqual(app.state.fallbackRules.find(rule => rule.primaryConditionID === 5)?.entries.map(entry => entry.conditionID), [2]);
        assert.equal(await page.locator('#inline-fallback-add-other-versions').count(), 0);
        await page.locator('#inline-fallback-done').click();
        assert.equal(await entry.innerText(), 'Fallback: Custom');
        await page.locator('#inline-fallback-configurations').click();
        assert.equal(await page.locator('.bp-fallback-picker-customize').isVisible(), false);
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        await page.reload();
        await page.locator('.bp-benchmark-row[data-condition-id="5"]').first().click();
        assert.equal(await entry.innerText(), 'Fallback: Custom');
        if (await entry.getAttribute('aria-expanded') !== 'true') await entry.click();
        await page.locator('#inline-fallback-configurations').click();
        assert.equal(await page.locator('.bp-fallback-picker-customize').isVisible(), false, 'Custom source survives a complete reload');
        await page.getByRole('button', { name: 'Close', exact: true }).click();
        assert.equal(await page.locator('#model-leaderboard-heading').textContent(), 'Personal AI Index');
        if (width < 760) {
            assert.equal(await page.locator('#model-leaderboard-heading').isVisible(), false);
            assert.equal(await page.locator('#model-index-tab').textContent(), 'Personal AI Index');
            await page.evaluate(() => window.scrollTo(0, 280));
            const sticky = await page.locator('.bp-context-identity').evaluate(node => ({
                position: getComputedStyle(node).position, top: node.getBoundingClientRect().top,
                bottom: node.getBoundingClientRect().bottom
            }));
            assert.equal(sticky.position, 'sticky');
            assert.ok(sticky.top >= 59 && sticky.top <= 61, JSON.stringify(sticky));
            const tabs = await page.locator('.bp-mobile-panels').boundingBox();
            assert.ok(tabs.y >= sticky.bottom - 1, JSON.stringify({ sticky, tabs }));
        }
        await page.goto(app.url + '/');
        assert.equal(await page.locator('h1').textContent().then(text => text.replace(/\s+/g, ' ').trim()), 'We believe in benchmarks. Not a narrow selection.');
        assert.equal(await page.locator('#topics-score-toggle span').textContent(), 'Estimated score');
    });
}
