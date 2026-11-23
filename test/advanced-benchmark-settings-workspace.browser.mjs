import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { benchmarks, weightedEntries } from '../scripts/frontend/fixtures.mjs';

const output = process.env.BP_SETTINGS_ARTIFACTS ?? 'artifacts/advanced-benchmark-settings';
const built = process.env.BP_TEST_BUILT === '1';
await mkdir(output, { recursive: true });

async function setup(t, engine, width, height, options = {}) {
    const fixture = await startPreview({ communityVersions: true, secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true },
            { conditionID: 2, weightBasisPoints: 4000 }]),
        communityEstimationVotes: [
            { targetConditionID: 1, sourceConditionID: 901, supportCount: 5, opposeCount: 2 },
            { targetConditionID: 900, sourceConditionID: 901, supportCount: 1, opposeCount: 3 }
        ],
        ...options });
    const browser = await engine.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760,
        reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
    page.setDefaultTimeout(10000);
    await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
    if (built) await page.route(fixture.url + '/1', async route => route.fulfill({ contentType: 'text/html',
        body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
    await page.goto(fixture.url + '/1');
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
    return { page, fixture };
}

async function saveAfter(page, action) {
    const response = page.waitForResponse(result => result.url().endsWith('/api/save_personal_pie') && result.ok());
    await action();
    const saved = await response;
    await page.waitForFunction(() => document.getElementById('workspace-update-indicator')?.dataset.phase !== 'pending');
    return saved.request().postDataJSON();
}

for (const [engine, width, height] of [[chromium, 1440, 900], [chromium, 320, 568], [webkit, 390, 660]]) {
    test(`${engine.name()} ${width}x${height}: workspace saves, undoes and restores separate scoring and estimation choices ${built ? 'built' : 'source'}`, async t => {
        const { page, fixture } = await setup(t, engine, width, height, {
            transformWorkspace(data) {
                // Allocation fields belong to ranking rows, not the version catalogue.
                for (const group of data.versionComposition) for (const version of group.versions) {
                    delete version.publicWeight;
                    delete version.publicWeightBasisPoints;
                }
            }
        });
        const allocation = page.locator('#benchmark-rows [data-condition-id="1"] .bp-benchmark-public-weight');
        assert.equal(await allocation.textContent(), '26.00%');
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        const toggle = page.locator('#inline-fallback-toggle'), settings = page.locator('#benchmark-settings');
        await toggle.click();
        assert.equal(await toggle.innerText(), 'Advanced settings');
        if (width === 320) await page.waitForFunction(() => {
            const bounds = selector => document.querySelector(selector)?.getBoundingClientRect();
            const heading = bounds('.bp-version-choices-heading'), firstRow = bounds('.bp-version-choice-row');
            return heading && firstRow && heading.top >= bounds('#pie-focus-bar').bottom
                && firstRow.bottom <= bounds('.bp-mobile-panels').top + 1;
        });
        const scoreDefault = settings.getByRole('button', { name: 'Use Default evaluation for scoring', exact: true });
        const scoreExperimental = settings.getByRole('button', { name: 'Use Experimental for scoring', exact: true });
        const opposeExtendedForDefault = settings.getByRole('button', {
            name: 'Oppose Extended as an estimation source for Default evaluation', exact: true
        });
        const supportExtendedForExperimental = settings.getByRole('button', {
            name: 'Support Extended as an estimation source for Experimental', exact: true
        });
        const row = conditionID => settings.locator(`.bp-version-choice-row[data-condition-id="${conditionID}"]`);
        const rateExtended = row(901).locator('.bp-estimation-rate');
        assert.equal(await settings.locator('.bp-version-choice-row').count(), 3);
        assert.equal(await settings.locator('.bp-version-choice-share').count(), 3);
        assert.equal(await settings.locator('.bp-estimation-rate, button[data-vote]').count(), 0);
        assert.equal(await page.locator('#fallback-picker').count(), 0);
        assert.equal(await settings.locator('.bp-fallback-picker-embedded, [aria-expanded], #inline-fallback-settings').count(), 0);
        const versionSave = await saveAfter(page, () => scoreDefault.click());
        assert.equal(versionSave.entries.find(entry => entry.conditionID === 1).followCommunityVersion, undefined);
        assert.equal(await scoreDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await row(1).locator('.bp-estimation-rate, button[data-vote]').count(), 0);
        assert.equal(await row(900).locator('.bp-estimation-rate').textContent(), 'No votes · Eligible by default');
        assert.equal(await rateExtended.textContent(), '71.43%');
        assert.equal(await opposeExtendedForDefault.textContent(), '2');
        const geometry = await settings.evaluate(node => {
            const row = node.querySelector('.bp-version-choice-row[data-condition-id="901"]');
            const actions = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON());
            return { overflow: node.scrollWidth - node.clientWidth, actions,
                right: node.getBoundingClientRect().right };
        });
        assert.ok(geometry.overflow <= 1 && geometry.actions.length === 3, JSON.stringify(geometry));
        assert.ok(geometry.actions.every((action, index) => (width > 760 || action.height >= 44 && action.width >= 44)
            && (!index || action.left >= geometry.actions[index - 1].right) && action.right <= geometry.right + 1), JSON.stringify(geometry));

        const defaultVote = { targetConditionID: 1, sourceConditionID: 901, vote: 'oppose' };
        const experimentalVote = { targetConditionID: 900, sourceConditionID: 901, vote: 'support' };
        const opposeSave = await saveAfter(page, async () => {
            if (width < 760) await opposeExtendedForDefault.tap();
            else await opposeExtendedForDefault.click();
            assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'true');
            assert.equal(await rateExtended.textContent(), '71.43%');
        });
        assert.deepEqual(opposeSave.estimationVotes, [defaultVote]);
        assert.deepEqual(opposeSave.fallbackRules, []);
        await page.waitForFunction(() => document.querySelector('#benchmark-settings [data-condition-id="901"] [data-vote="oppose"]')?.textContent === '3');
        assert.equal(await rateExtended.textContent(), '62.5%');
        const change = await saveAfter(page, () => scoreExperimental.click());
        assert.deepEqual(change.estimationVotes, [defaultVote]);
        assert.equal(await scoreExperimental.getAttribute('aria-pressed'), 'true');
        assert.equal(await supportExtendedForExperimental.getAttribute('aria-pressed'), 'false');
        assert.equal(await rateExtended.textContent(), '25%');
        const supportSave = await saveAfter(page, () => supportExtendedForExperimental.click());
        assert.deepEqual(supportSave.estimationVotes, [defaultVote, experimentalVote]);
        assert.equal(await rateExtended.textContent(), '40%');
        const clear = await saveAfter(page, () => scoreExperimental.click());
        assert.deepEqual(clear.entries.find(entry => entry.conditionID === 1),
            { conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true });
        assert.deepEqual(clear.estimationVotes, supportSave.estimationVotes);
        assert.equal(await settings.locator('.bp-version-choice[aria-pressed="true"]').count(), 0);
        assert.equal(await settings.locator('.bp-estimation-rate, button[data-vote]').count(), 0);

        const reselect = await saveAfter(page, () => scoreDefault.click());
        assert.deepEqual(reselect.estimationVotes, supportSave.estimationVotes);
        assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await rateExtended.textContent(), '62.5%');
        const clearedVote = await saveAfter(page, () => opposeExtendedForDefault.click());
        assert.deepEqual(clearedVote.estimationVotes, [experimentalVote]);
        const undo = await saveAfter(page, () => page.locator('#workspace-undo').click());
        assert.deepEqual(undo.estimationVotes, supportSave.estimationVotes);
        assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'true');
        const redo = await saveAfter(page, () => page.locator('#workspace-redo').click());
        assert.deepEqual(redo.estimationVotes, clearedVote.estimationVotes);
        assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'false');
        assert.deepEqual(fixture.state.personalEstimationVotes, clearedVote.estimationVotes);

        await saveAfter(page, () => scoreExperimental.click());
        await page.locator('#weight-pie [data-object-id="2"]').click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.locator('button[data-vote]').count(), 0);
        await page.locator('#weight-pie [data-object-id="900"]').click();
        assert.equal(await supportExtendedForExperimental.getAttribute('aria-pressed'), 'true');
        await page.reload();
        await page.locator('#weight-pie [data-object-id="900"]').click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await supportExtendedForExperimental.getAttribute('aria-pressed'), 'true');
        await supportExtendedForExperimental.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-${built ? 'built' : 'source'}.png` });

        await page.locator('#pie-mode-public').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        const publicToggle = page.locator('#public-fallback-toggle');
        assert.equal(await publicToggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.locator('.bp-version-choice-share').count(), 3);
        assert.equal(await settings.locator('.bp-estimation-rate, [aria-pressed="true"]').count(), 0);
        const saves = fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
        const inspectDefault = settings.getByRole('button', { name: 'Inspect estimation sources for Default evaluation', exact: true });
        const inspectExperimental = settings.getByRole('button', { name: 'Inspect estimation sources for Experimental', exact: true });
        if (width < 760) await inspectDefault.tap();
        else await inspectDefault.press('Space');
        assert.equal(await row(1).locator('.bp-estimation-rate').count(), 0);
        assert.equal(await rateExtended.textContent(), '71.43%');
        await inspectExperimental.click();
        assert.equal(await rateExtended.textContent(), '40%');
        assert.equal(await settings.locator('button[data-vote]').count(), 0);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-${built ? 'built' : 'source'}-public.png` });
        await publicToggle.click();
        await publicToggle.click();
        assert.equal(await settings.locator('.bp-estimation-rate, [aria-pressed="true"]').count(), 0);
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length, saves);
        assert.ok(fixture.state.personalEntries.some(entry => entry.conditionID === 900));
    });
}

test(`guest can edit and restore personal estimation votes ${built ? 'built' : 'source'}`, async t => {
    const { page, fixture } = await setup(t, chromium, 1440, 900, { authenticated: false });
    await page.locator('#personal-pie-create').click();
    await page.locator('#personal-pie-start-public').click();
    await page.locator('#weight-pie [data-object-id="1"]').click();
    await page.locator('#inline-fallback-toggle').click();
    const settings = page.locator('#benchmark-settings');
    const support = settings.getByRole('button', { name: 'Support Extended as an estimation source for Default evaluation', exact: true });
    const scoreDefault = settings.getByRole('button', { name: 'Use Default evaluation for scoring', exact: true });
    assert.equal(await support.count(), 0);
    await scoreDefault.click();
    const preview = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
        && response.request().postDataJSON().previewPersonalPie?.estimationVotes?.some(item => item.targetConditionID === 1
            && item.sourceConditionID === 901 && item.vote === 'support'));
    await support.click();
    await preview;
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
    assert.equal(await support.textContent(), '5');
    assert.equal(fixture.state.requests.some(request => request.path === '/api/save_personal_pie'), false);
    await page.reload();
    await page.locator('#weight-pie [data-object-id="1"]').click();
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
});

test(`removing a benchmark clears its directional votes and undo restores them ${built ? 'built' : 'source'}`, async t => {
    const otherVote = { targetConditionID: 2, sourceConditionID: 902, vote: 'support' };
    const initialVotes = [{ targetConditionID: 1, sourceConditionID: 901, vote: 'support' }, otherVote,
        { targetConditionID: 901, sourceConditionID: 1, vote: 'oppose' }];
    const { page } = await setup(t, chromium, 1440, 900, {
        personalEntries: weightedEntries([{ conditionID: 901, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }]),
        personalEstimationVotes: initialVotes,
        additionalBenchmarkVersions: [{ ...benchmarks[1], ID: 902, conditionID: 902, isDefaultCondition: false,
            isPrimaryCondition: false, conditionKey: 'variant', conditionName: 'Variant' }]
    });
    await page.locator('#pie-mode-personal').click();
    const remove = page.locator('#benchmark-rows [data-condition-id="901"] [data-benchmark-control="remove"]');
    const removed = await saveAfter(page, () => remove.click());
    assert.deepEqual(removed.estimationVotes, [otherVote]);
    const restored = await saveAfter(page, () => page.locator('#workspace-undo').click());
    assert.deepEqual(restored.estimationVotes, initialVotes);
    assert.deepEqual((await saveAfter(page, () => remove.click())).estimationVotes, removed.estimationVotes);
    await page.locator('#benchmark-search').fill('General knowledge');
    const add = page.locator('#benchmark-rows [data-condition-id="1"] [data-benchmark-control="add"]');
    const added = await saveAfter(page, () => add.click());
    assert.equal(added.entries.find(entry => entry.conditionID === 1).followCommunityVersion, true);
    assert.deepEqual(added.estimationVotes, removed.estimationVotes);
});
