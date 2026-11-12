import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { familyEntries, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const output = process.env.BP_SETTINGS_ARTIFACTS ?? 'artifacts/advanced-benchmark-settings';
const built = process.env.BP_TEST_BUILT === '1';
await mkdir(output, { recursive: true });
for (const [engine, width, height] of [[chromium, 1440, 900], [chromium, 390, 844], [chromium, 320, 568], [webkit, 390, 660]]) {
    test(`${engine.name()} ${width}x${height}: real composition pane pins Accordion headers and preserves the original editor ${built ? 'built' : 'source'}`, async t => {
        const families = [[2, 3], [4, 2], [5, 6, 3]].map((IDs, index) => ({ primaryConditionID: 1,
            familyID: 51 + index, mode: 'ordered', entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) }));
        const fixture = await startPreview({ communityVersions: true, secondaryBenchmark: true, sparseBenchmark: true, families,
            publicFamilyComposition: [{ primaryConditionID: 1, configuredPieCount: 3, isDefault: false,
                families: families.map((family, index) => ({ ...family, weightBasisPoints: [6000, 3000, 1000][index],
                    overallWeightBasisPoints: [1560, 780, 260][index] })) }],
            personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true },
                { conditionID: 2, weightBasisPoints: 4000 }]) });
        t.after(() => fixture.close());
        const browser = await engine.launch({ headless: true });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760,
            reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, []));
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(fixture.url + '/1', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
        await page.goto(fixture.url + '/1');
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        await page.locator('#inline-fallback-toggle').click();
        const settings = page.locator('#benchmark-settings');
        await settings.getByRole('button', { name: 'Accordion', exact: true }).click();
        await page.waitForFunction(() => {
            const settings = document.getElementById('benchmark-settings');
            let root = settings.parentElement;
            while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
            const footer = settings.querySelector('.bp-benchmark-settings-fallback .bp-benchmark-settings-section-heading').getBoundingClientRect();
            return footer.bottom <= root.getBoundingClientRect().bottom - (parseFloat(getComputedStyle(root).scrollPaddingBottom) || 0) + 1;
        });
        const geometry = await settings.evaluate(node => {
            let root = node.parentElement;
            while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
            const bounds = selector => document.querySelector(selector).getBoundingClientRect().toJSON();
            return { selected: bounds('#pie-focus-bar'), versions: bounds('.bp-benchmark-settings-versions .bp-benchmark-settings-section-heading'),
                fallback: bounds('.bp-benchmark-settings-fallback .bp-benchmark-settings-section-heading'),
                pane: root.getBoundingClientRect().toJSON(), bottom: parseFloat(getComputedStyle(root).scrollPaddingBottom) || 0,
                overflow: getComputedStyle(node.querySelector('.bp-benchmark-settings-scroll')).overflowY };
        });
        assert.equal(geometry.overflow, 'visible', 'Accordion shares the composition pane scroll instead of creating a taller nested viewport');
        assert.ok(geometry.fallback.top >= geometry.selected.bottom && geometry.fallback.bottom <= geometry.pane.bottom - geometry.bottom + 1, JSON.stringify(geometry));
        if (geometry.bottom > 0) assert.equal(await page.evaluate(box => Boolean(document.elementFromPoint(box.left + 20, box.bottom + 8)
            ?.closest('.bp-version-choice')), geometry.fallback), false, 'Choices cannot show or receive clicks beneath the closed fallback footer');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-workspace-versions-${built ? 'built' : 'source'}.png` });
        const save = async action => {
            const saved = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.status() === 200);
            await action(); await saved;
            await page.waitForFunction(() => document.getElementById('workspace-update-indicator')?.dataset.phase !== 'pending');
        };
        await save(() => settings.locator('.bp-version-choice[data-condition-id="1"]').click());
        assert.equal(await page.locator('#benchmark-settings-fallback-trigger').getAttribute('aria-expanded'), 'true');
        await settings.evaluate(node => {
            let root = node.parentElement;
            while (root && !/(auto|scroll)/.test(getComputedStyle(root).overflowY)) root = root.parentElement;
            root.scrollTop += 160;
        });
        const pinned = await settings.evaluate(node => ({
            selected: document.getElementById('pie-focus-bar').getBoundingClientRect().toJSON(),
            version: node.querySelector('.bp-benchmark-settings-versions .bp-benchmark-settings-section-heading').getBoundingClientRect().toJSON() }));
        assert.ok(Math.abs(pinned.version.top - pinned.selected.bottom) <= 1, JSON.stringify(pinned));
        await settings.getByRole('button', { name: 'Create my own', exact: true }).click();
        await settings.locator('#inline-fallback-editor').waitFor();
        assert.equal(await settings.locator('.bp-custom-fallback-editor').count(), 0);
        const add = settings.locator('#inline-fallback-add-benchmark');
        const shape = await add.evaluate(node => ({ button: node.getBoundingClientRect().toJSON(),
            frame: node.closest('.bp-inline-fallback-frame').getBoundingClientRect().toJSON() }));
        assert.ok(shape.button.height >= 44 && Math.abs(shape.button.width - shape.frame.width) <= 2, JSON.stringify(shape));
        await add.click();
        await page.locator('#benchmark-search').fill('Advanced reasoning');
        await page.locator('.bp-benchmark-row[data-condition-id="2"] .bp-benchmark-add').click();
        await page.locator('#benchmark-search').fill('Code generation');
        await page.locator('.bp-benchmark-row[data-condition-id="3"] .bp-benchmark-add').click();
        await settings.locator('[data-family-focus^="up-"]').nth(1).click();
        assert.match(await settings.locator('#inline-fallback-chart .bp-family-member').first().textContent(), /Code generation/);
        await add.scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-workspace-custom-${built ? 'built' : 'source'}.png` });
        await settings.locator('#inline-fallback-done').click();
        await settings.getByRole('button', { name: 'Edit my order', exact: true }).click();
        assert.equal(await settings.locator('#inline-fallback-chart .bp-family-member').count(), 2);
        assert.match(await settings.locator('#inline-fallback-chart .bp-family-member').first().textContent(), /Code generation/);
        await settings.locator('#inline-fallback-done').click();
        await settings.getByRole('button', { name: 'Pages', exact: true }).click();
        assert.equal(await settings.locator('.bp-fallback-picker-column:visible').count(), 2);
        assert.equal(await settings.evaluate(node => node.scrollWidth > node.clientWidth + 1), false);
        await page.locator('#inline-fallback-toggle').click();
        assert.equal(await page.locator('#inline-fallback-settings').evaluate(node => node.parentElement.id), 'inline-fallback');
    });
}
