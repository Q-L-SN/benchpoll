import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { familyEntries, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const built = process.env.BP_TEST_BUILT === '1';
for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) {
    test(`${engine.name()} ${width}: version and fallback order change only on returning ${built ? 'built' : 'source'}`, async t => {
        const families = [[2, 3], [4, 2]].map((IDs, index) => ({ primaryConditionID: 1, familyID: 51 + index,
            mode: 'ordered', entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) }));
        const app = await startPreview({ communityVersions: true, secondaryBenchmark: true, sparseBenchmark: true, families,
            publicFamilyComposition: [{ primaryConditionID: 1, configuredPieCount: 2, isDefault: false,
                families: families.map((family, index) => ({ ...family, weightBasisPoints: [8000, 2000][index],
                    overallWeightBasisPoints: [2080, 520][index] })) }],
            personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }]) });
        t.after(() => app.close());
        const browser = await engine.launch({ headless: true });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760,
            reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, []));
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(app.url + '/1', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
        await page.goto(app.url + '/1');
        await page.locator('#pie-mode-personal').click();
        await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        const disclosure = page.locator('#inline-fallback-toggle');
        await disclosure.click();
        const settings = page.locator('#benchmark-settings'), versions = settings.locator('.bp-version-choice');
        const version = ID => settings.locator(`.bp-version-choice[data-condition-id="${ID}"]`);
        const order = () => versions.evaluateAll(nodes => nodes.map(node => Number(node.dataset.conditionId)));
        const choose = async action => {
            const result = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
                && response.request().postDataJSON().initialMode === 'personal');
            await action(); await result;
            await page.locator('#model-card[aria-busy="false"]').waitFor();
            await page.waitForFunction(() => document.querySelector('#workspace-update-indicator')?.dataset.phase !== 'pending');
        };
        assert.deepEqual(await order(), [1, 901, 900]);
        await choose(() => version(900).click());
        await page.waitForFunction(() => document.querySelector('.bp-version-choice[data-condition-id="900"] .bp-version-choice-share')?.textContent === '100%');
        assert.equal(await version(900).getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await order(), [1, 901, 900], 'Saving a new version updates its share without moving its button');
        await disclosure.click(); await disclosure.click();
        assert.deepEqual(await order(), [900, 1, 901], 'Reopening uses the updated community proportions');
        await choose(() => version(900).click());
        assert.equal(await version(900).getAttribute('aria-pressed'), 'false');
        assert.deepEqual(await order(), [900, 1, 901], 'Deselecting also keeps the current visit stable');
        await page.locator('#weight-pie [data-object-id="2"]').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.deepEqual(await order(), [1, 901, 900], 'Returning from another benchmark starts a fresh order');
        await choose(() => version(1).click());
        const cards = settings.locator('.bp-fallback-picker-column');
        const cardOrder = () => cards.evaluateAll(nodes => nodes.map(node => node.dataset.familyKey));
        const card = key => settings.locator(`[data-family-key='${key}'] .bp-fallback-picker-card-toggle`);
        await card('[1,4,2]').waitFor();
        const initial = await cardOrder();
        assert.ok(initial.indexOf('[1,4,2]') > 0);
        await choose(() => card('[1,4,2]').click());
        assert.deepEqual(await cardOrder(), initial, 'Fallback selection stays in place through saving and ranking refresh');
        assert.equal(await card('[1,4,2]').getAttribute('aria-pressed'), 'true');
        await disclosure.click(); await disclosure.click();
        assert.equal((await cardOrder())[0], '[1,4,2]');
        const reopened = await cardOrder();
        await choose(() => card('[1,4,2]').click());
        assert.deepEqual(await cardOrder(), reopened, 'Clearing fallback does not move its card');
        await page.locator('#weight-pie [data-object-id="2"]').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal((await cardOrder())[0], '[1,2,3]');
    });
}
