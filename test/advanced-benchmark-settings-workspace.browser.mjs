import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { weightedEntries } from '../scripts/frontend/fixtures.mjs';

const output = process.env.BP_SETTINGS_ARTIFACTS ?? 'artifacts/advanced-benchmark-settings';
const built = process.env.BP_TEST_BUILT === '1';
await mkdir(output, { recursive: true });

async function setup(t, engine, width, height, options = {}) {
    const fixture = await startPreview({ communityVersions: true, secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true },
            { conditionID: 2, weightBasisPoints: 4000 }]),
        communityEstimationVotes: [{ conditionID: 901, supportCount: 5, opposeCount: 2 }],
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
        const scoreExtended = settings.getByRole('button', { name: 'Use Extended for scoring', exact: true });
        const supportDefault = settings.getByRole('button', { name: 'Support Default evaluation for score estimation', exact: true });
        const opposeExtended = settings.getByRole('button', { name: 'Oppose Extended for score estimation', exact: true });
        assert.equal(await settings.locator('.bp-version-choice-row').count(), 3);
        assert.equal(await page.locator('#fallback-picker').count(), 0);
        assert.equal(await settings.locator('.bp-fallback-picker-embedded, [aria-expanded], #inline-fallback-settings').count(), 0);
        assert.equal(await opposeExtended.textContent(), '2');
        const geometry = await settings.evaluate(node => {
            const row = node.querySelector('.bp-version-choice-row');
            const actions = [...row.querySelectorAll('button')].map(button => button.getBoundingClientRect().toJSON());
            return { overflow: node.scrollWidth - node.clientWidth, actions,
                right: node.getBoundingClientRect().right };
        });
        assert.ok(geometry.overflow <= 1 && geometry.actions.length === 3, JSON.stringify(geometry));
        assert.ok(geometry.actions.every((action, index) => (width > 760 || action.height >= 44 && action.width >= 44)
            && (!index || action.left >= geometry.actions[index - 1].right) && action.right <= geometry.right + 1), JSON.stringify(geometry));

        const versionSave = await saveAfter(page, () => scoreDefault.click());
        assert.equal(versionSave.entries.find(entry => entry.conditionID === 1).followCommunityVersion, undefined);
        const supportSave = await saveAfter(page, () => width < 760 ? supportDefault.tap() : supportDefault.click());
        assert.deepEqual(supportSave.estimationVotes, [{ conditionID: 1, vote: 'support' }]);
        assert.equal(await supportDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await scoreDefault.getAttribute('aria-pressed'), 'true');
        const opposeSave = await saveAfter(page, () => opposeExtended.click());
        assert.deepEqual(opposeSave.estimationVotes, [{ conditionID: 1, vote: 'support' }, { conditionID: 901, vote: 'oppose' }]);
        assert.deepEqual(opposeSave.fallbackRules, []);
        await page.waitForFunction(() => document.querySelector('#benchmark-settings [data-condition-id="901"] [data-vote="oppose"]')?.textContent === '3');
        const change = await saveAfter(page, () => scoreExtended.click());
        assert.deepEqual(change.estimationVotes, opposeSave.estimationVotes);
        assert.equal(await scoreExtended.getAttribute('aria-pressed'), 'true');
        const clear = await saveAfter(page, () => scoreExtended.click());
        assert.deepEqual(clear.entries.find(entry => entry.conditionID === 1),
            { conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true });
        assert.deepEqual(clear.estimationVotes, opposeSave.estimationVotes);
        assert.equal(await settings.locator('.bp-version-choice[aria-pressed="true"]').count(), 0);

        const clearedVote = await saveAfter(page, () => opposeExtended.click());
        assert.deepEqual(clearedVote.estimationVotes, [{ conditionID: 1, vote: 'support' }]);
        const undo = await saveAfter(page, () => page.locator('#workspace-undo').click());
        assert.deepEqual(undo.estimationVotes, opposeSave.estimationVotes);
        assert.equal(await opposeExtended.getAttribute('aria-pressed'), 'true');
        const redo = await saveAfter(page, () => page.locator('#workspace-redo').click());
        assert.deepEqual(redo.estimationVotes, clearedVote.estimationVotes);
        assert.equal(await opposeExtended.getAttribute('aria-pressed'), 'false');
        assert.deepEqual(fixture.state.personalEstimationVotes, clearedVote.estimationVotes);

        await page.locator('#weight-pie [data-object-id="2"]').click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await supportDefault.getAttribute('aria-pressed'), 'false');
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await supportDefault.getAttribute('aria-pressed'), 'true');
        await page.reload();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await supportDefault.getAttribute('aria-pressed'), 'true');
        await supportDefault.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-${built ? 'built' : 'source'}.png` });

        await page.locator('#pie-mode-public').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await page.locator('#public-fallback-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.getByRole('status').textContent(), 'Read-only');
        assert.equal(await settings.locator('[aria-pressed], [aria-current]').count(), 0);
        assert.equal(await settings.getByRole('img', { name: '1 vote supporting Default evaluation for score estimation', exact: true }).textContent(), '1');
        assert.equal(await settings.getByRole('img', { name: '5 votes supporting Extended for score estimation', exact: true }).textContent(), '5');
        assert.equal(await settings.getByRole('img', { name: '2 votes opposing Extended for score estimation', exact: true }).textContent(), '2');
    });
}

test(`guest can edit and restore personal estimation votes ${built ? 'built' : 'source'}`, async t => {
    const { page, fixture } = await setup(t, chromium, 1440, 900, { authenticated: false });
    await page.locator('#personal-pie-create').click();
    await page.locator('#personal-pie-start-public').click();
    await page.locator('#weight-pie [data-object-id="1"]').click();
    await page.locator('#inline-fallback-toggle').click();
    const settings = page.locator('#benchmark-settings');
    const support = settings.getByRole('button', { name: 'Support Extended for score estimation', exact: true });
    const preview = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
        && response.request().postDataJSON().previewPersonalPie?.estimationVotes?.some(item => item.conditionID === 901));
    await support.click();
    await preview;
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
    assert.equal(await support.textContent(), '5');
    assert.equal(fixture.state.requests.some(request => request.path === '/api/save_personal_pie'), false);
    await page.reload();
    await page.locator('#weight-pie [data-object-id="1"]').click();
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
});

test(`removing a benchmark clears its source votes and undo restores them ${built ? 'built' : 'source'}`, async t => {
    const initialVotes = [{ conditionID: 1, vote: 'support' }, { conditionID: 2, vote: 'support' },
        { conditionID: 901, vote: 'oppose' }];
    const { page } = await setup(t, chromium, 1440, 900, {
        personalEntries: weightedEntries([{ conditionID: 901, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }]),
        personalEstimationVotes: initialVotes
    });
    await page.locator('#pie-mode-personal').click();
    const remove = page.locator('#benchmark-rows [data-condition-id="901"] [data-benchmark-control="remove"]');
    const removed = await saveAfter(page, () => remove.click());
    assert.deepEqual(removed.estimationVotes, [{ conditionID: 2, vote: 'support' }]);
    const restored = await saveAfter(page, () => page.locator('#workspace-undo').click());
    assert.deepEqual(restored.estimationVotes, initialVotes);
    assert.deepEqual((await saveAfter(page, () => remove.click())).estimationVotes, removed.estimationVotes);
    await page.locator('#benchmark-search').fill('General knowledge');
    const add = page.locator('#benchmark-rows [data-condition-id="1"] [data-benchmark-control="add"]');
    const added = await saveAfter(page, () => add.click());
    assert.equal(added.entries.find(entry => entry.conditionID === 1).followCommunityVersion, true);
    assert.deepEqual(added.estimationVotes, removed.estimationVotes);
});
