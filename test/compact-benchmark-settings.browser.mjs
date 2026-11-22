import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { benchmarks, familyEntries, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_SETTINGS_ARTIFACTS ?? 'artifacts/compact-benchmark-settings-20261104';
await mkdir(output, { recursive: true });
for (const [engine, width, height] of built ? [[chromium, 1440, 900], [chromium, 320, 568]]
    : [[chromium, 1440, 900], [chromium, 390, 844], [chromium, 320, 568], [webkit, 390, 660]]) {
    test(`${engine.name()} ${width}x${height}: inline version and fallback sections retain choice semantics ${built ? 'built' : 'source'}`, async t => {
        const families = [[2, 3], [4, 2], [5, 6, 3]].map((IDs, index) => ({ primaryConditionID: 1,
            familyID: 51 + index, mode: 'ordered', entries: familyEntries(IDs.map(conditionID => ({ conditionID }))) }));
        const variants = ['Thinking', 'Verified', 'Short', 'Full', 'Overall', 'Task-macro rubric pass rate, model-specific conditions',
            ...Array.from({ length: 20 }, (_, index) => `Evaluation ${index + 1}`)].map((name, index) => ({
            ...benchmarks[0], ID: 100 + index, conditionID: 100 + index, isPrimaryCondition: false,
            isDefaultCondition: false, conditionKey: `variant-${index}`, conditionName: name, scoreCount: 25 - index,
            publicWeight: 0, personalWeight: null }));
        const fixture = await startPreview({ communityVersions: true, additionalBenchmarkVersions: variants, families,
            publicFamilyComposition: [{ primaryConditionID: 1, configuredPieCount: 3, isDefault: false,
                families: families.map((family, index) => ({ ...family, weightBasisPoints: [6000, 3000, 1000][index],
                    overallWeightBasisPoints: [1560, 780, 260][index] })) }],
            personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 3500, followCommunityVersion: true },
                { conditionID: 2, weightBasisPoints: 2500 }, { conditionID: 3, weightBasisPoints: 2000 }, { conditionID: 4, weightBasisPoints: 2000 }]) });
        t.after(() => fixture.close());
        const browser = await engine.launch({ headless: true });
        t.after(() => browser.close());
        const page = await browser.newPage({ viewport: { width, height }, hasTouch: width < 760, isMobile: width < 760, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(() => assert.deepEqual(errors, []));
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(fixture.url + '/1', async route => route.fulfill({ contentType: 'text/html', body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
        await page.goto(fixture.url + '/1');
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        await page.locator('#inline-fallback-toggle').click();
        const settings = page.locator('#benchmark-settings'); await settings.waitFor();
        assert.equal(await settings.getByRole('button', { name: /Follow community/i }).count(), 0);
        assert.doesNotMatch(await settings.locator('.bp-version-choices').innerText(), /approved|scores|Primary version/);
        for (const text of await settings.locator('.bp-evidence-count-value').allTextContents()) assert.match(text, /^\d+$/);
        assert.equal(await settings.locator('.bp-choice-pagination').count(), 0);
        const versions = settings.locator('.bp-benchmark-settings-versions');
        assert.equal(await versions.locator('[aria-expanded]').getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.locator('#benchmark-settings-fallback-trigger').getAttribute('aria-disabled'), 'true');
        const pills = versions.locator('.bp-version-choice');
        const widths = await pills.evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().width)));
        assert.ok(new Set(widths).size > 1, 'Version choices retain their natural widths in narrow panes');
        const primaryVersion = versions.locator('[data-condition-id="1"]');
        while (!await primaryVersion.count()) {
            const count = await pills.count();
            await versions.locator('.bp-choice-load-sentinel').evaluate(node => node.scrollIntoView({ block: 'center' }));
            await page.waitForFunction(before => document.querySelectorAll('.bp-version-choice').length > before, count);
        }
        const save = async action => {
            const response = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie') && response.status() === 200);
            await Promise.all([response, action()]);
        };
        await save(() => primaryVersion.click());
        const picker = settings.locator('.bp-fallback-picker-embedded'); await picker.waitFor();
        await picker.locator('[data-family-key="[1,2,3]"]').waitFor();
        assert.equal(await page.locator('#fallback-picker').isVisible(), false);
        const bounds = await settings.evaluate(root => {
            const card = root.querySelector('.bp-fallback-picker-card-toggle');
            const column = card.closest('.bp-fallback-picker-column');
            return { tag: root.tagName, parent: root.parentElement.id, panel: root.getBoundingClientRect().toJSON(),
                horizontalOverflow: root.scrollWidth - root.clientWidth, card: card.getBoundingClientRect().toJSON(),
                column: column.getBoundingClientRect().toJSON(), stepsHeight: column.querySelector('.bp-fallback-picker-steps').clientHeight };
        });
        assert.equal(bounds.tag, 'SECTION');
        assert.equal(bounds.parent, 'inline-fallback');
        assert.ok(bounds.horizontalOverflow <= 1, JSON.stringify(bounds));
        assert.equal(await settings.locator('#benchmark-settings-fallback-trigger').getAttribute('aria-expanded'), 'true');
        assert.equal(await versions.locator('[aria-expanded]').getAttribute('aria-expanded'), 'false');
        assert.ok(bounds.stepsHeight >= 32 && bounds.card.top >= bounds.column.top
            && bounds.card.bottom <= bounds.column.bottom && bounds.column.bottom <= bounds.panel.bottom + 1, JSON.stringify(bounds));
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-${built ? 'built' : 'source'}.png` });
        const toggle = picker.locator('[data-family-key="[1,2,3]"] .bp-fallback-picker-card-toggle');
        await save(() => toggle.click());
        assert.equal(await toggle.getAttribute('aria-pressed'), 'true');
        assert.deepEqual(fixture.state.fallbackRules[0].entries.map(entry => entry.conditionID), [2, 3]);
        await save(() => toggle.click());
        assert.equal(fixture.state.fallbackRules.length, 0);
        assert.equal(await settings.locator('.bp-version-choice[data-condition-id="1"]').getAttribute('aria-pressed'), 'true');
        assert.match(await settings.locator('.bp-benchmark-settings-status').textContent(), /Fallback follows community/);
        await settings.locator('#benchmark-settings-versions-trigger').click();
        await save(() => primaryVersion.click());
        assert.equal(await picker.isVisible(), false);
        assert.equal(fixture.state.personalEntries.find(entry => entry.conditionID === 1).followCommunityVersion, true);
        await page.locator('#inline-fallback-toggle').click();
        await page.reload();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        await page.locator('#inline-fallback-toggle').click();
        assert.match(await settings.locator('.bp-benchmark-settings-status').textContent(), /Versions and fallback follow community/);
    });
}
