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
        assert.equal(await settings.locator('.bp-fallback-picker-embedded, [aria-expanded]:not(.bp-version-nomination), #inline-fallback-settings').count(), 0);
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

for (const [engine, width, height] of [[chromium, 1440, 900], [chromium, 320, 568], [webkit, 390, 660]]) {
    test(`${engine.name()} ${width}: nominate from a pinned external versions dock ${built ? 'built' : 'source'}`, async t => {
        const extraVersions = (benchmark, firstID, count, name) => Array.from({ length: count }, (_, index) => ({
            ...benchmark, ID: firstID + index, conditionID: firstID + index,
            isDefaultCondition: false, isPrimaryCondition: false, conditionKey: name + index, conditionName: name + ' ' + (index + 1)
        }));
        const sameBenchmark = extraVersions(benchmarks[0], 1001, 18, 'Scoring version');
        const external = extraVersions(benchmarks[2], 1101, 14, 'Source version');
        const { page, fixture } = await setup(t, engine, width, height, {
            publicWeights: [{ conditionID: 1, weightBasisPoints: 1000 }, { conditionID: 2, weightBasisPoints: 6000 },
                { conditionID: 3, weightBasisPoints: 3000 }],
            communityEstimationVotes: external.map(version => ({
                targetConditionID: 1, sourceConditionID: version.conditionID, supportCount: 1, opposeCount: 0
            })),
            additionalBenchmarkVersions: [...sameBenchmark, ...external, { ...benchmarks[1], ID: 902, conditionID: 902,
                isDefaultCondition: false, isPrimaryCondition: false, conditionKey: 'variant', conditionName: 'Variant' }],
            transformWorkspace(data) {
                for (const group of data.versionComposition) for (const version of group.versions) {
                    version.globalWeightBasisPoints = version.conditionID === 7 ? 80000 : 0;
                }
            }
        });
        const card = page.locator('#benchmark-card');
        const search = card.locator('#benchmark-search');
        const settings = page.locator('#benchmark-settings');
        const dock = settings.locator('.bp-external-versions');
        const nominate = dock.getByRole('button', { name: 'Nominate a version from another benchmark', exact: true });
        const picker = settings.locator('#external-version-picker');
        const versionSearch = picker.getByRole('searchbox');
        const results = picker.getByRole('list', { name: 'Versions available to nominate' });
        const resultIDs = () => results.locator('li').evaluateAll(rows => rows.map(row => Number(row.dataset.conditionId)));
        const nominated = conditionID => dock.locator('[data-external-condition-id="' + conditionID + '"]');
        const chooseScoring = name => saveAfter(page, () => settings.getByRole('button', {
            name: 'Use ' + name + ' for scoring', exact: true
        }).click());

        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie [data-object-id="1"]').click();
        const toggle = page.locator('#inline-fallback-toggle');
        await toggle.click();
        assert.equal(await dock.isVisible(), false, 'An explicit scoring choice enables the dock');
        await chooseScoring('Default evaluation');
        await dock.waitFor();
        assert.equal(await nominate.getAttribute('aria-controls'), 'external-version-picker');
        assert.equal(await nominate.getAttribute('aria-expanded'), 'false');
        const bounds = () => dock.evaluate(node => {
            const main = node.previousElementSibling;
            const versions = node.querySelector('ul');
            return {
                position: getComputedStyle(node).position,
                height: node.offsetHeight, hostHeight: node.parentElement.offsetHeight,
                top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom,
                hostBottom: node.parentElement.getBoundingClientRect().bottom,
                mainCanScroll: main.scrollHeight > main.clientHeight,
                externalCanScroll: versions.scrollHeight > versions.clientHeight
            };
        });
        const start = await bounds();
        assert.equal(start.position, 'absolute');
        assert.ok(Math.abs(start.bottom - start.hostBottom) < 1);
        assert.ok(start.height <= Math.max(49, Math.min(start.hostHeight * .38, 216)) + 1
            && start.externalCanScroll && start.mainCanScroll, JSON.stringify(start));
        await settings.locator('.bp-benchmark-settings-scroll').evaluate(node => { node.scrollTop = node.scrollHeight; });
        const scrolled = await bounds();
        assert.equal(scrolled.top, start.top);
        const externalScroll = await dock.locator('ul').evaluate(node => { node.scrollTop = node.scrollHeight; return node.scrollTop; });
        assert.ok(externalScroll > 0);

        await search.fill('Code generation');
        await card.getByRole('button', { name: 'Add Code generation to Personal Weights', exact: true }).waitFor();
        const evaluationRows = await card.locator('.bp-benchmark-row').count();
        await nominate.click();
        assert.equal(await nominate.getAttribute('aria-expanded'), 'true');
        assert.equal(await nominate.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(22, 101, 117)');
        assert.ok((await picker.boundingBox()).y + (await picker.boundingBox()).height < (await dock.boundingBox()).y);
        assert.equal(await versionSearch.inputValue(), '');
        assert.equal(await search.inputValue(), 'Code generation');
        assert.equal(await card.locator('.bp-benchmark-row').count(), evaluationRows);
        assert.deepEqual((await resultIDs()).slice(0, 4), [2, 902, 3, 7]);
        assert.equal(await results.locator('li[data-condition-id="1101"]').count(), 0, 'Already nominated versions stay in the dock');
        assert.match(await picker.textContent(), /Select Add version again to close/);

        await versionSearch.fill('variant');
        assert.deepEqual(await resultIDs(), [902]);
        await versionSearch.press('Escape');
        assert.equal(await picker.isVisible(), false);
        assert.equal(await nominate.evaluate(node => node === document.activeElement), true);
        assert.equal(await search.inputValue(), 'Code generation');

        await nominate.click();
        await nominate.click();
        assert.equal(await picker.isVisible(), false);
        await nominate.click();
        await versionSearch.fill('variant');
        const pair = { targetConditionID: 1, sourceConditionID: 902 };
        const savedWeights = structuredClone(fixture.state.personalEntries);
        const saveCount = fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
        const choice = picker.getByRole('button', { name: 'Nominate Advanced reasoning, Variant', exact: true });
        assert.deepEqual(await voteAfter(page, () => choice.click()), { ...pair, vote: 'support', nominate: true });
        await nominated(902).waitFor({ state: 'attached' });
        assert.equal(await nominated(902).locator('.bp-estimation-rate').textContent(), '100%');
        assert.equal(await picker.isVisible(), false);
        assert.deepEqual(fixture.state.personalEntries, savedWeights);
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length, saveCount);

        await nominate.click();
        await toggle.click();
        assert.equal(await picker.isVisible(), false);
        await toggle.click();
        assert.equal(await nominate.getAttribute('aria-expanded'), 'false');
        await page.locator('#pie-mode-public').click();
        await page.locator('#pie-mode-public[aria-selected="true"][aria-busy="false"]').waitFor();
        await settings.getByRole('button', { name: 'Inspect estimation sources for Default evaluation', exact: true }).click();
        assert.equal(await nominated(902).locator('.bp-estimation-rate').textContent(), '100%');
        assert.equal(await nominate.isVisible(), false);
        assert.equal(await dock.locator('button[data-vote]').count(), 0);
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

test(`WebKit keeps the title and summary spacing through refresh ${built ? 'built' : 'source'}`, async t => {
    const { page } = await setup(t, webkit, 390, 660, {
        workspaceDelay: 200,
        transformWorkspace(data) {
            data.context.categoryName = 'Communication & EQ1';
            data.context.description = 'Personal benchmark weights for Communication & EQ.';
        }
    });
    const indicator = page.locator('.bp-workspace-refresh-slot #workspace-update-indicator');
    const geometry = () => page.evaluate(() => {
        const headline = document.getElementById('workspace-headline').getBoundingClientRect();
        const summary = document.getElementById('workspace-topic-summary').getBoundingClientRect();
        return { height: headline.height, gap: summary.top - headline.bottom };
    });
    await indicator.and(page.locator('[data-phase="idle"]')).waitFor();
    const initial = await geometry();
    assert.ok(initial.gap >= 0 && initial.gap < 8);
    await page.locator('#workspace-refresh').click();
    await indicator.and(page.locator('[data-phase="pending"]')).waitFor();
    assert.deepEqual(await geometry(), initial);
    await indicator.and(page.locator('[data-phase="complete"]')).waitFor();
    assert.deepEqual(await geometry(), initial);
    await indicator.and(page.locator('[data-phase="idle"]')).waitFor();
    assert.deepEqual(await geometry(), initial);
    assert.equal(await indicator.evaluate(node => getComputedStyle(node).position), 'absolute');
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
