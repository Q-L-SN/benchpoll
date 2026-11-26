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

async function voteAfter(page, action) {
    const response = page.waitForResponse(result => result.url().endsWith('/api/save_estimation_vote'));
    const workspace = page.waitForResponse(result => result.url().endsWith('/api/get_weighted_workspace') && result.ok());
    await action();
    const voted = await response;
    assert.equal(voted.status(), 200, await voted.text());
    await workspace;
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
    const { expectedUserID, ...ballot } = voted.request().postDataJSON();
    assert.equal(expectedUserID, '1');
    assert.ok(voted.request().headers()['idempotency-key']);
    return ballot;
}

function evaluationRow(page, conditionID) {
    return page.locator(`#benchmark-rows [data-condition-id="${conditionID}"][data-benchmark-control="selection"]`);
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
            name: 'Oppose mutual estimation between Default evaluation and Extended', exact: true
        });
        const supportExtendedForExperimental = settings.getByRole('button', {
            name: 'Support mutual estimation between Experimental and Extended', exact: true
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
        assert.equal(Object.hasOwn(versionSave, 'estimationVotes'), false);
        assert.equal(await scoreDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await row(1).locator('.bp-estimation-rate, button[data-vote]').count(), 0);
        assert.equal(await row(900).locator('.bp-estimation-rate').isVisible(), false);
        assert.deepEqual(await row(900).locator('button[data-vote]').allTextContents(), ['0', '0']);
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
        const opposeSave = await voteAfter(page, async () => {
            if (width < 760) await opposeExtendedForDefault.tap();
            else await opposeExtendedForDefault.click();
        });
        assert.deepEqual(opposeSave, { ...defaultVote, nominate: false });
        assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await rateExtended.textContent(), '62.5%');
        const change = await saveAfter(page, () => scoreExperimental.click());
        assert.equal(Object.hasOwn(change, 'estimationVotes'), false);
        assert.equal(await scoreExperimental.getAttribute('aria-pressed'), 'true');
        assert.equal(await supportExtendedForExperimental.getAttribute('aria-pressed'), 'false');
        assert.equal(await rateExtended.textContent(), '25%');
        const supportSave = await voteAfter(page, () => supportExtendedForExperimental.click());
        assert.deepEqual(supportSave, { ...experimentalVote, nominate: false });
        assert.equal(await rateExtended.textContent(), '40%');
        const clear = await saveAfter(page, () => scoreExperimental.click());
        assert.deepEqual(clear.entries.find(entry => entry.conditionID === 1),
            { conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true });
        assert.equal(Object.hasOwn(clear, 'estimationVotes'), false);
        assert.equal(await settings.locator('.bp-version-choice[aria-pressed="true"]').count(), 0);
        assert.equal(await settings.locator('.bp-estimation-rate, button[data-vote]').count(), 0);

        const reselect = await saveAfter(page, () => scoreDefault.click());
        assert.equal(Object.hasOwn(reselect, 'estimationVotes'), false);
        assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await rateExtended.textContent(), '62.5%');
        const clearedVote = await voteAfter(page, () => opposeExtendedForDefault.click());
        assert.deepEqual(clearedVote, { ...defaultVote, vote: null, nominate: false });
        const undo = await saveAfter(page, () => page.locator('#workspace-undo').click());
        assert.equal(Object.hasOwn(undo, 'estimationVotes'), false);
        assert.equal(undo.entries.find(entry => entry.conditionID === 1).followCommunityVersion, true);
        assert.equal(await settings.locator('button[data-vote]').count(), 0);
        const redo = await saveAfter(page, () => page.locator('#workspace-redo').click());
        assert.equal(Object.hasOwn(redo, 'estimationVotes'), false);
        assert.equal(await scoreDefault.getAttribute('aria-pressed'), 'true');
        assert.equal(await opposeExtendedForDefault.getAttribute('aria-pressed'), 'false');
        assert.deepEqual(fixture.state.personalEstimationVotes, [experimentalVote]);

        await saveAfter(page, () => scoreExperimental.click());
        await evaluationRow(page, 2).press('Enter');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.locator('button[data-vote]').count(), 0);
        await evaluationRow(page, 900).press('Enter');
        assert.equal(await supportExtendedForExperimental.getAttribute('aria-pressed'), 'true');
        await page.reload();
        await evaluationRow(page, 900).press('Enter');
        assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await supportExtendedForExperimental.getAttribute('aria-pressed'), 'true');
        await supportExtendedForExperimental.scrollIntoViewIfNeeded();
        await page.mouse.move(1, 1);
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${height}-${built ? 'built' : 'source'}.png` });

        await page.locator('#pie-mode-public').click();
        await page.locator('#pie-mode-public[aria-selected="true"][aria-busy="false"]').waitFor();
        await evaluationRow(page, 1).press('Enter');
        const publicToggle = page.locator('#public-fallback-toggle');
        assert.equal(await publicToggle.getAttribute('aria-expanded'), 'true');
        assert.equal(await settings.locator('.bp-version-choice-share').count(), 3);
        assert.equal(await settings.locator('.bp-estimation-rate, [aria-pressed="true"]').count(), 0);
        const saves = () => fixture.state.requests.filter(request => request.path.startsWith('/api/save_')).length;
        const initialSaveCount = saves();
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
        assert.equal(saves(), initialSaveCount);
        assert.ok(fixture.state.personalEntries.some(entry => entry.conditionID === 900));
    });
}

for (const [engine, width, height] of [[chromium, 1440, 900], [webkit, 390, 660]]) {
    test(`${engine.name()} ${width}: nominate a concrete version from Evaluation items ${built ? 'built' : 'source'}`, async t => {
        const { page, fixture } = await setup(t, engine, width, height, {
            personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000, followCommunityVersion: true },
                { conditionID: 2, weightBasisPoints: 4000 }]),
            communityEstimationVotes: [],
            additionalBenchmarkVersions: [{ ...benchmarks[1], ID: 902, conditionID: 902, isDefaultCondition: false,
                isPrimaryCondition: false, conditionKey: 'variant', conditionName: 'Variant' }]
        });
        const card = page.locator('#benchmark-card');
        const targetMode = card.and(page.locator('.is-fallback-target-active'));
        const search = card.locator('#benchmark-search');
        const rows = card.locator('#benchmark-rows .bp-benchmark-row');
        const rowIDs = () => rows.evaluateAll(nodes => nodes.map(node => Number(node.dataset.conditionId)).sort((a, b) => a - b));
        const addCode = card.getByRole('button', { name: 'Add Code generation to Personal Weights', exact: true });
        const addBenchmark = page.getByRole('button', { name: 'Add benchmark or topic', exact: true });
        const toggle = page.locator('#inline-fallback-toggle');
        const settings = page.locator('#benchmark-settings');
        const nominate = settings.getByRole('button', { name: 'Nominate a version from another benchmark', exact: true });
        const nominated = conditionID => settings.getByRole('list', { name: 'Nominated external versions' })
            .locator(`[data-external-condition-id="${conditionID}"]`);
        const chooseScoring = name => saveAfter(page, () => settings.getByRole('button', {
            name: `Use ${name} for scoring`, exact: true
        }).click());
        const disclosureAngle = trigger => trigger.locator('.bp-ui-disclosure-chevron').evaluate(icon =>
            Math.round(Math.asin(new DOMMatrixReadOnly(getComputedStyle(icon).transform).b) * 180 / Math.PI));

        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await disclosureAngle(toggle), 0);
        await toggle.click();
        assert.equal(await disclosureAngle(toggle), 90);
        assert.equal(await nominate.count(), 0);
        assert.equal(await targetMode.count(), 0);
        await chooseScoring('Default evaluation');

        assert.equal(await nominate.getAttribute('aria-controls'), 'benchmark-card');
        assert.equal(await nominate.getAttribute('aria-pressed'), 'false');
        assert.deepEqual(await nominate.evaluate(button => {
            const style = getComputedStyle(button);
            return [style.backgroundColor, style.color];
        }), ['rgb(233, 245, 246)', 'rgb(22, 101, 117)']);
        await search.fill('Code generation');
        await addCode.waitFor();
        assert.deepEqual(await rowIDs(), [3]);
        await nominate.click();
        await targetMode.waitFor();
        assert.equal(await search.inputValue(), '');
        assert.equal(await nominate.getAttribute('aria-pressed'), 'true');
        assert.equal(await nominate.evaluate(button => getComputedStyle(button).backgroundColor), 'rgb(22, 101, 117)');
        assert.deepEqual(await rowIDs(), [2, 3, 4, 5, 6, 7, 8, 902]);
        assert.equal(await rows.locator('[data-benchmark-control="remove"]').count(), 0);
        assert.equal(await rows.and(page.locator('[data-benchmark-control="selection"]')).count(), 0);
        assert.equal(await card.getByRole('button', { name: /^Add .+ to Personal Weights$/ }).count(), 0);
        await search.fill('Advanced reasoning');
        assert.deepEqual(await rowIDs(), [2, 902]);
        const identity = rows.filter({ has: page.locator('.bp-benchmark-condition', { hasText: /^Variant$/ }) })
            .locator('.bp-benchmark-information-link');
        assert.equal(await identity.textContent(), 'Advanced reasoning Variant');
        const separated = await identity.evaluate(link => {
            const name = link.querySelector('.bp-benchmark-link-name').getBoundingClientRect();
            const version = link.querySelector('.bp-benchmark-condition').getBoundingClientRect();
            return version.left > name.right || version.top >= name.bottom;
        });
        assert.equal(separated, true);
        const rowNominate = card.getByRole('button', { name: 'Nominate Advanced reasoning, Variant', exact: true });
        assert.equal(await card.getByRole('button', { name: 'Nominate Advanced reasoning, Default evaluation', exact: true }).count(), 1);
        assert.equal(await rowNominate.count(), 1);
        await nominate.click();
        assert.equal(await targetMode.count(), 0);
        assert.equal(await nominate.getAttribute('aria-pressed'), 'false');
        assert.equal(await search.inputValue(), 'Code generation');
        await addCode.waitFor();
        assert.deepEqual(await rowIDs(), [3]);
        assert.equal(await card.getByRole('button', { name: /^Nominate / }).count(), 0);
        assert.equal(await disclosureAngle(toggle), 90);

        await nominate.click();
        assert.equal(await search.inputValue(), '');
        await search.fill('Variant');
        assert.deepEqual(await rowIDs(), [902]);
        assert.equal(await addBenchmark.isVisible(), false);
        await toggle.click();
        await targetMode.waitFor({ state: 'detached' });
        await addBenchmark.click();
        await page.waitForFunction(() => document.activeElement === document.getElementById('benchmark-search'));
        await toggle.click();
        assert.equal(await nominate.getAttribute('aria-pressed'), 'false');
        assert.equal(await search.inputValue(), 'Code generation');
        await addCode.waitFor();
        assert.deepEqual(await rowIDs(), [3]);
        assert.equal(await card.getByRole('button', { name: /^Nominate / }).count(), 0);

        await search.clear();
        await card.getByRole('button', { name: 'Add Mathematics to Personal Weights', exact: true }).waitFor();
        await nominate.click();
        const pair = { targetConditionID: 1, sourceConditionID: 902 };
        const saves = () => fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
        const saveCount = saves();
        const weights = structuredClone(fixture.state.personalEntries);
        assert.deepEqual(await voteAfter(page, () => rowNominate.click()), { ...pair, vote: 'support', nominate: true });
        const forward = nominated(902);
        await forward.waitFor();
        assert.equal(await forward.locator('.bp-version-choice-name').textContent(), 'Advanced reasoning · Variant');
        assert.equal(await forward.locator('.bp-estimation-rate').textContent(), '100%');
        assert.equal(await forward.locator('button[data-vote="support"]').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(fixture.state.personalEstimationVotes, [{ ...pair, vote: 'support' }]);
        assert.equal(saves(), saveCount);
        assert.deepEqual(fixture.state.personalEntries, weights);

        await page.locator('#pie-mode-public').click();
        await page.locator('#pie-mode-public[aria-selected="true"][aria-busy="false"]').waitFor();
        const publicToggle = page.locator('#public-fallback-toggle');
        await settings.getByRole('button', { name: 'Inspect estimation sources for Default evaluation', exact: true }).click();
        assert.equal(await disclosureAngle(publicToggle), 90);
        assert.equal(await forward.locator('.bp-estimation-rate').textContent(), '100%');
        assert.equal(await settings.locator('button[data-vote]').count(), 0);
        assert.equal(await nominate.count(), 0);
        assert.equal(await targetMode.count(), 0);

        await page.locator('#pie-mode-personal').click();
        await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
        await evaluationRow(page, 2).press('Enter');
        await chooseScoring('Variant');
        const reverse = nominated(1);
        await reverse.waitFor();
        assert.equal(await reverse.locator('.bp-version-choice-name').textContent(), 'General knowledge · Default evaluation');
        assert.equal(await reverse.locator('button[data-vote="support"]').getAttribute('aria-pressed'), 'true');
        assert.deepEqual(await voteAfter(page, () => reverse.locator('button[data-vote="support"]').click()), {
            targetConditionID: 902, sourceConditionID: 1, vote: null, nominate: false
        });
        await reverse.waitFor({ state: 'hidden' });
        assert.deepEqual(fixture.state.personalEstimationVotes, []);

        await evaluationRow(page, 1).press('Enter');
        assert.equal(await forward.count(), 0);
        await nominate.click();
        assert.deepEqual(await voteAfter(page, () => rowNominate.click()), { ...pair, vote: 'support', nominate: true });
        assert.deepEqual(await voteAfter(page, () => forward.locator('button[data-vote="oppose"]').click()), {
            ...pair, vote: 'oppose', nominate: false
        });
        await forward.waitFor({ state: 'hidden' });
        assert.deepEqual(fixture.state.personalEstimationVotes, [{ ...pair, vote: 'oppose' }]);
        await nominate.click();
        await targetMode.waitFor({ state: 'detached' });
        await evaluationRow(page, 902).press('Enter');
        assert.equal(await reverse.count(), 0);
    });
}

test(`guest can edit and restore personal estimation votes ${built ? 'built' : 'source'}`, async t => {
    const { page, fixture } = await setup(t, chromium, 1440, 900, { authenticated: false });
    await page.locator('#personal-pie-create').click();
    await page.locator('#personal-pie-start-public').click();
    await page.locator('#weight-pie [data-object-id="1"]').click();
    await page.locator('#inline-fallback-toggle').click();
    const settings = page.locator('#benchmark-settings');
    const support = settings.getByRole('button', { name: 'Support mutual estimation between Default evaluation and Extended', exact: true });
    const scoreDefault = settings.getByRole('button', { name: 'Use Default evaluation for scoring', exact: true });
    assert.equal(await support.count(), 0);
    await scoreDefault.click();
    assert.equal(await settings.getByRole('button', { name: /Nominate a version/ }).count(), 0);
    assert.equal(await settings.getByRole('link', { name: 'Sign in to nominate a version' }).isVisible(), true);
    const preview = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
        && response.request().postDataJSON().previewPersonalPie?.estimationVotes?.some(item => item.targetConditionID === 1
            && item.sourceConditionID === 901 && item.vote === 'support'));
    await support.click();
    await preview;
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
    assert.equal(await support.textContent(), '5');
    assert.equal(fixture.state.requests.some(request => request.path.startsWith('/api/save_')), false);
    await page.reload();
    await evaluationRow(page, 1).press('Enter');
    assert.equal(await support.getAttribute('aria-pressed'), 'true');
});

test(`removing and restoring a benchmark leaves sitewide pair votes intact ${built ? 'built' : 'source'}`, async t => {
    const otherVote = { targetConditionID: 2, sourceConditionID: 902, vote: 'support' };
    const initialVotes = [{ targetConditionID: 1, sourceConditionID: 901, vote: 'support' }, otherVote];
    const { page, fixture } = await setup(t, chromium, 1440, 900, {
        personalEntries: weightedEntries([{ conditionID: 901, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }]),
        personalEstimationVotes: initialVotes,
        additionalBenchmarkVersions: [{ ...benchmarks[1], ID: 902, conditionID: 902, isDefaultCondition: false,
            isPrimaryCondition: false, conditionKey: 'variant', conditionName: 'Variant' }]
    });
    await page.locator('#pie-mode-personal').click();
    const remove = page.locator('#benchmark-rows [data-condition-id="901"] [data-benchmark-control="remove"]');
    const removed = await saveAfter(page, () => remove.click());
    assert.equal(Object.hasOwn(removed, 'estimationVotes'), false);
    assert.equal(removed.entries.some(entry => entry.conditionID === 901), false);
    assert.deepEqual(fixture.state.personalEstimationVotes, initialVotes);
    const restored = await saveAfter(page, () => page.locator('#workspace-undo').click());
    assert.equal(Object.hasOwn(restored, 'estimationVotes'), false);
    assert.equal(restored.entries.find(entry => entry.conditionID === 901)?.weightBasisPoints, 6000);
    await page.locator('#weight-pie [data-object-id="901"]').click();
    await page.locator('#inline-fallback-toggle').click();
    const reverseVote = page.getByRole('button', { name: 'Support mutual estimation between Extended and Default evaluation', exact: true });
    assert.equal(await reverseVote.getAttribute('aria-pressed'), 'true');
    await saveAfter(page, () => remove.click());
    await page.locator('#benchmark-search').fill('General knowledge');
    const add = page.locator('#benchmark-rows [data-condition-id="1"] [data-benchmark-control="add"]');
    const added = await saveAfter(page, () => add.click());
    const addedEntry = added.entries.find(entry => entry.conditionID === 1);
    assert.equal(addedEntry.followCommunityVersion, true);
    assert.equal(Object.hasOwn(added, 'estimationVotes'), false);
    await page.locator('#inline-fallback-toggle[aria-expanded="true"]').click();
    const pie = page.locator('#weight-pie');
    await pie.waitFor();
    const adjusted = await saveAfter(page, () => pie.dispatchEvent('wheel', { deltaY: -100 }));
    assert.ok(adjusted.entries.find(entry => entry.conditionID === 1).weightBasisPoints > addedEntry.weightBasisPoints);
    assert.equal(adjusted.entries.reduce((total, entry) => total + entry.weightBasisPoints, 0), 10000);
    assert.equal(Object.hasOwn(adjusted, 'estimationVotes'), false);
    assert.deepEqual(fixture.state.personalEstimationVotes, initialVotes);
});
