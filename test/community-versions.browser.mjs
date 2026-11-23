import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { weightedEntries } from '../scripts/frontend/fixtures.mjs';

const output = process.env.BP_COMMUNITY_ARTIFACTS ?? '/tmp/benchpoll-community-versions';
const built = process.env.BP_TEST_BUILT === '1';
await mkdir(output, { recursive: true });
for (const [engine, width] of built ? [[chromium, 390]] : [[chromium, 1440], [chromium, 390], [webkit, 390], [chromium, 320]]) {
    test(`version choices and discussion page ${engine.name()} ${width} ${built ? 'built' : 'source'}`, { timeout: 90000 }, async t => {
        const fixture = await startPreview({ communityVersions: true, secondaryBenchmark: true, sparseBenchmark: true,
            personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 3500, followCommunityVersion: true },
                { conditionID: 2, weightBasisPoints: 2500 }, { conditionID: 3, weightBasisPoints: 2000 }, { conditionID: 4, weightBasisPoints: 2000 }]),
            versionVoters: [[20, { entries: [{ conditionID: 901, weightBasisPoints: 6000 }] }], [21, { entries: [{ conditionID: 1, weightBasisPoints: 2000 }] }]] });
        const browser = await engine.launch({ headless: true });
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        const errors = [];
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        const page = await context.newPage(); page.setDefaultTimeout(12000);
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        await page.route('**/api/get_discussion', async route => {
            const response = await route.fetch(); const data = await response.json();
            data.context.scenes = [{ ID: 1, name: 'General', slug: 'general', position: 0, isDefault: true },
                { ID: 2, name: 'Research', slug: 'research', position: 1, isDefault: false }];
            await route.fulfill({ response, json: data });
        });
        if (built) await page.route(fixture.url + '/1', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile('private/home-built.html', 'utf8') }));
        await page.goto(fixture.url + '/1');
        await page.locator('#weight-pie [data-object-id]').first().waitFor();
        if (built) assert.ok(await page.locator('script[src^="/build/home/"]').count());
        assert.equal(await page.locator('#benchmark-rows .bp-benchmark-row').count(), 8);
        assert.equal(await page.locator('#benchmark-rows .bp-benchmark-condition').count(), 0);
        await page.locator('#pie-mode-personal').click();
        await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
        assert.equal(await page.locator('.bp-inline-fallback-info').count(), 0);
        assert.equal(await page.locator('#weight-add-actions button').count(), 1);
        await page.locator('#weight-pie [data-object-id="1"]').click();
        const entry = page.locator('#inline-fallback-toggle');
        await page.getByRole('button', { name: 'Advanced settings', exact: true }).waitFor();
        assert.equal(await entry.innerText(), 'Advanced settings');
        await entry.click();
        const settings = page.locator('#benchmark-settings');
        await settings.waitFor();
        assert.match(await settings.getByRole('status').textContent(), /Following community/);
        assert.equal(await settings.locator('.bp-version-choice').first().getAttribute('data-condition-id'), '901');
        assert.equal(await settings.locator('.bp-version-choice[data-condition-id="901"] .bp-version-choice-share').textContent(), '75%');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}-settings.png` });
        const primary = settings.getByRole('button', { name: 'Use Default evaluation for scoring', exact: true });
        const extended = settings.getByRole('button', { name: 'Use Extended for scoring', exact: true });
        await extended.click();
        assert.equal(await extended.getAttribute('aria-pressed'), 'true');
        await primary.click();
        assert.equal(await primary.getAttribute('aria-pressed'), 'true');
        assert.equal(await extended.getAttribute('aria-pressed'), 'false');
        const save = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.ok());
        await primary.click();
        const { entries, fallbackRules } = (await save).request().postDataJSON();
        assert.equal(await primary.getAttribute('aria-pressed'), 'false');
        assert.match(await settings.getByRole('status').textContent(), /Following community/);
        assert.deepEqual(entries.find(item => item.conditionID === 1),
            { conditionID: 1, weightBasisPoints: 3500, followCommunityVersion: true });
        assert.deepEqual(fallbackRules, []);
        await entry.click();
        if (width < 760) {
            assert.equal(await page.locator('#discussion-entry').isVisible(), false);
            await page.locator('[data-mobile-panel="models"]').click();
            await page.waitForFunction(() => {
                const pager = document.getElementById('workspace-scene-panel');
                return Math.abs(pager.scrollLeft / pager.clientWidth - 1) < .01;
            });
            assert.equal(await page.locator('#workspace-scene-panel').evaluate(pager => getComputedStyle(pager).scrollSnapType), 'x mandatory');
            if (engine === chromium && width === 390) {
                const cdp = await context.newCDPSession(page);
                const finger = x => [{ x, y: 480, id: 1 }];
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: finger(width - 35) });
                for (let step = 1; step <= 8; step++) {
                    await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: finger(width - 35 - step * 35) });
                    await page.waitForTimeout(35);
                    if (step === 4) {
                        const progress = await page.locator('#workspace-scene-panel').evaluate(pager => pager.scrollLeft / pager.clientWidth);
                        assert.ok(progress > 1.1 && progress < 1.8, 'the page follows the finger before release');
                    }
                }
                // Release without momentum; native snapping still finishes on Discussion.
                await page.waitForTimeout(250);
                await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
                await cdp.detach();
            } else await page.locator('[data-mobile-panel="discussion"]').click();
            await page.locator('#discussion-feed .discussion-post').first().waitFor();
            await page.waitForFunction(() => {
                const pager = document.getElementById('workspace-scene-panel');
                return Math.abs(pager.scrollLeft / pager.clientWidth - 2) < .01
                    && pager.querySelector('.bp-left-workspace').inert && !document.getElementById('workspace-discussion-page').inert;
            });
            assert.equal(await page.locator('#discussion-panel').evaluate(node => node.parentElement.id), 'workspace-discussion-page');
            assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), false);
            assert.equal(await page.locator('.bp-breadcrumb-current').isVisible(), true);
            assert.equal(await page.locator('#discussion-context .bp-scene-default').count(), 0);
            assert.equal(await page.locator('#discussion-context .bp-scene-tab').first().textContent(), 'General');
            const composer = page.locator('#discussion-panel:not([inert]) #discussion-text');
            await composer.click();
            const draft = 'A draft that survives swiping between pages.';
            await composer.fill(draft);
            assert.equal(await composer.inputValue(), draft);
            await page.locator('[data-mobile-panel="mix"]').click();
            await page.waitForFunction(() => document.getElementById('workspace-discussion-page').inert);
            await page.locator('[data-mobile-panel="discussion"]').click();
            await page.waitForFunction(() => {
                const pager = document.getElementById('workspace-scene-panel');
                return !document.getElementById('workspace-discussion-page').inert && Math.abs(pager.scrollLeft / pager.clientWidth - 2) < .01;
            });
            await page.locator('#discussion-feed .discussion-post').first().waitFor();
            assert.equal(await composer.inputValue(), draft);
            await page.screenshot({ path: `${output}/${engine.name()}-${width}${built ? '-built' : ''}-discussion.png` });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            await page.setViewportSize({ width: 1440, height: 900 });
            assert.equal(await page.locator('#discussion-panel').evaluate(node => node.parentElement.classList.contains('bp-shell')), true);
            assert.equal(await page.locator('#discussion-entry').isVisible(), true);
        } else assert.equal(await page.locator('#discussion-entry').isVisible(), true);
    });
}
