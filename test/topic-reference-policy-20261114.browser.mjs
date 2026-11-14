import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { referenceCondition } from '../topic-reference-service.js';

const built = process.env.BP_TEST_BUILT === '1';
for (const engine of [webkit, chromium]) for (const width of [390, 1440]) {
    test(`${engine.name()} ${width}px reference eligibility ${built ? 'built' : 'source'}`, async t => {
        const targets = [
            { contextID: 101, categoryID: 1, name: 'Current topic', url: '/1', hasWeights: true },
            { contextID: 201, categoryID: 2, name: 'Other topic', url: '/2', hasWeights: true },
            { contextID: 202, categoryID: 3, name: 'Empty topic', url: '/3', hasWeights: false }
        ].map(target => referenceCondition({ ...target, topicName: target.name, sceneID: null, isPrivate: false }));
        const fixture = await startPreview({ communityVersions: true, additionalBenchmarkVersions: targets });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(url => url.origin === fixture.url && url.pathname === '/1', async route => route.fulfill({
            contentType: 'text/html', body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8')
        }));
        await page.goto(fixture.url);
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#benchmark-search').fill('topic');
        const self = page.locator('.bp-benchmark-row[data-context-id="101"] .bp-benchmark-add');
        const empty = page.locator('.bp-benchmark-row[data-context-id="202"] .bp-benchmark-add');
        const eligible = page.locator('.bp-benchmark-row[data-context-id="201"] .bp-benchmark-add');
        await self.waitFor(); await empty.waitFor(); await eligible.waitFor();
        assert.equal(await self.getAttribute('aria-disabled'), 'true');
        assert.match(await self.getAttribute('aria-label'), /same scene or topic/);
        assert.equal(await empty.getAttribute('aria-disabled'), 'true');
        assert.match(await empty.getAttribute('aria-label'), /no weights yet/);
        assert.equal(await eligible.getAttribute('aria-disabled'), 'false');
        await self.evaluate(node => node.click()); await empty.evaluate(node => node.click());
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 0);
        await Promise.all([
            page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.status() === 200),
            eligible.click()
        ]);
        await page.waitForFunction(() => document.querySelector('#model-card').getAttribute('aria-busy') === 'false');
        assert.ok(fixture.state.personalEntries.some(entry => entry.conditionID === -201));
        assert.ok(fixture.state.personalEntries.every(entry => ![-101, -202].includes(entry.conditionID)));
    });
}
