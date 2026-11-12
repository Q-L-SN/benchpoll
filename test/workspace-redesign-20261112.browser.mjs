import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { weightedEntries } from '../scripts/frontend/fixtures.mjs';
import { referenceCondition } from '../topic-reference-service.js';

const output = process.env.BP_WORKSPACE_ARTIFACTS ?? '/workspace/benchpoll-work/workspace-redesign';
await mkdir(output, { recursive: true });
const scenes = [{ ID: 301, name: 'Overall', sceneNumber: 1, isDefault: true, url: '/1/1' },
    { ID: 302, name: 'Specialist', sceneNumber: 2, isDefault: false, url: '/1/2' }];
const reference = referenceCondition({ contextID: 201, categoryID: 2, publicID: 2, name: 'Research',
    topicName: 'Research', sceneName: '', hasWeights: true, url: '/2', configurationCount: 8, favoriteCount: 4, coverageIndex: 3.8 });
function scenario() {
    return { communityVersions: true, topics: [{ ID: 1, publicID: 1, name: 'Intelligence', isOfficial: true, scenes },
        { ID: 2, publicID: 2, name: 'Research', isOfficial: true }],
    referenceTargets: scenes.map(scene => ({ ...scene, contextID: scene.ID, categoryID: 1, topicName: 'Intelligence',
        sceneName: scene.name, hasWeights: true, configured: scene.ID === 301, configurationCount: 7, favoriteCount: 12, coverageIndex: 9.9 })),
    transformWorkspace(data, body) {
        if (Number(body.categoryID) !== 1) return;
        const sceneID = Number(body.contextValues?.scene ?? 301);
        Object.assign(data.context, { ID: sceneID, contextID: sceneID, sceneID, categoryName: 'Intelligence',
            sceneName: scenes.find(scene => scene.ID === sceneID).name, scenes, contextValues: { scene: String(sceneID) },
            defaultContextID: 301, rootContextID: 101, url: `/1/${sceneID === 301 ? 1 : 2}` });
        if (sceneID !== 301) return;
        const raw = weightedEntries([{ conditionID: 1, weightBasisPoints: 5000 }, { ...reference, weightBasisPoints: 5000 }]);
        const expanded = weightedEntries([{ conditionID: 1, weightBasisPoints: 7000 }, { conditionID: 2, weightBasisPoints: 3000 }]);
        for (const mode of ['personal', 'public']) {
            data[`${mode}Pie`].entries = structuredClone(raw);
            data[`${mode}Pie`].effectiveEntries = structuredClone(expanded);
            data[`${mode}Pie`].referenceCompositions = [{ referenceContextID: 201,
                entries: weightedEntries([{ conditionID: 1, weightBasisPoints: 4000 }, { conditionID: 2, weightBasisPoints: 6000 }]), issues: [] }];
        }
        const families = [{ primaryConditionID: 1, configuredPieCount: 0, isDefault: true,
            families: [{ primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 10000, overallWeightBasisPoints: 5000 }] }];
        data.publicPie.familyComposition = structuredClone(families);
        data.personalPie.communityFallbackComposition = structuredClone(families);
        data.communityFallbackComposition = structuredClone(families);
        data.benchmarks.push({ ...reference, rank: 2, publicWeight: 50, personalWeight: 50, coverageIndex: 3.8 });
    } };
}
async function setup(t, engine, width, options = {}) {
    const fixture = await startPreview(options); t.after(() => fixture.close());
    const browser = await engine.launch({ headless: true }); t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height: width < 760 ? 844 : 1000 },
        isMobile: width < 760, hasTouch: width < 760 });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
    page.setDefaultTimeout(10000);
    t.after(() => assert.deepEqual(errors, []));
    await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
    await page.goto(fixture.url + '/1');
    await page.locator('.bp-benchmark-row').first().waitFor();
    return { page, fixture };
}
for (const [engine, width] of [[chromium, 1440], [chromium, 390], [webkit, 390]]) {
    test(`${engine.name()} ${width}: no default selection, normal scrolling, compact controls and explicit deselection`, async t => {
        const { page, fixture } = await setup(t, engine, width, { communityVersions: true });
        assert.equal(await page.locator('#pie-instruction').textContent(), '');
        assert.equal(await page.locator('#workspace-undo').isVisible(), false);
        assert.equal(await page.locator('#public-pie-count').textContent(), '128');
        assert.match(await page.locator('#public-pie-summary').getAttribute('data-tooltip'), /128/);
        assert.equal(await page.locator('#ranking-coverage-index [data-coverage-value]').textContent(), '6');
        assert.ok((await page.locator('.bp-benchmark-search').boundingBox()).height <= 34);
        const title = await page.locator('#workspace-headline').boundingBox();
        const summary = await page.locator('#workspace-topic-summary').boundingBox();
        assert.ok(summary.y >= title.y + title.height - 1);
        await page.locator('#workspace-header-layout').evaluate(e => { e.value = 'inline'; e.dispatchEvent(new Event('change', { bubbles: true })); });
        assert.equal(await page.locator('body').getAttribute('data-header-layout'), 'inline');
        await page.locator('#pie-mode-personal').click();
        assert.equal(await page.locator('#pie-instruction').textContent(), '');
        await page.locator('#weight-pie').dispatchEvent('wheel', { deltaY: 100 });
        assert.equal(fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 0);
        assert.equal(await page.locator('#weight-pie').evaluate(e => getComputedStyle(e).touchAction), 'pan-x pan-y');
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await page.locator('#pie-adjustment-hint').isVisible(), true);
        assert.equal(await page.locator('#pie-instruction a').count(), 1);
        assert.equal(await page.locator('#pie-instruction a .bp-evidence-count').count(), 0);
        assert.equal(await page.locator('#pie-context-note .bp-evidence-count-value').textContent(), '6');
        await page.locator('#pie-selection-clear').click();
        assert.equal(await page.locator('#pie-instruction').textContent(), '');
        assert.equal(await page.locator('#pie-adjustment-hint').isVisible(), false);
        assert.equal(await page.locator('#weight-pie').evaluate(e => getComputedStyle(e).touchAction), 'pan-x pan-y');
        const favorite = page.locator('#bp-breadcrumb .bp-topic-favorite');
        await favorite.click();
        await page.waitForFunction(() => document.querySelector('#bp-breadcrumb .bp-topic-favorite').getAttribute('aria-busy') === 'false');
        assert.equal(await favorite.getAttribute('aria-pressed'), 'true');
        assert.equal(await favorite.locator('.bp-topic-favorite-count').textContent(), '13');
        await page.screenshot({ path: `${output}/${engine.name()}-${width}.png` });
    });
}
test('expanded reference mode retains only valid selections, resets across unsupported scenes and scene discovery exits cleanly', async t => {
    const { page } = await setup(t, chromium, 1440, scenario());
    assert.match(page.url(), /\/1\/1$/);
    await page.locator('#weight-pie [data-object-id="-201"]').click();
    await page.locator('#weight-topic-view').click();
    assert.equal(await page.locator('#pie-instruction').textContent(), '');
    assert.equal(await page.locator('#expanded-weight-note').isVisible(), true);
    assert.equal(await page.locator('#weight-topic-view').isVisible(), false);
    await page.locator('#weight-pie [data-object-id="1"]').click();
    await page.locator('#expanded-weight-close').click();
    assert.match(await page.locator('#pie-instruction').textContent(), /General knowledge/);
    await page.locator('#weight-topic-view').click();
    await page.locator('#weight-pie [data-object-id="2"]').click();
    await page.locator('#expanded-weight-close').click();
    assert.equal(await page.locator('#pie-instruction').textContent(), '');
    await page.locator('#weight-topic-view').click();
    await page.locator('#bp-template-strip [data-scene-id="302"]').click();
    await page.waitForURL('**/1/2');
    assert.equal(await page.locator('#expanded-weight-note').isVisible(), false);
    await page.locator('#bp-template-strip [data-scene-id="301"]').click();
    await page.waitForURL('**/1/1');
    assert.equal(await page.locator('#expanded-weight-note').isVisible(), false);
    await page.locator('#benchmark-search').focus();
    await page.waitForFunction(() => document.querySelectorAll('#benchmark-rows .bp-benchmark-row').length === 2);
    const rows = page.locator('#benchmark-rows .bp-benchmark-row');
    assert.match(await rows.nth(0).innerText(), /Overall/);
    assert.match(await rows.nth(1).innerText(), /Specialist/);
    await page.locator('#benchmark-search-clear').click();
    assert.ok(await rows.count() > 2);
    assert.equal(await page.locator('#benchmark-search-clear').isVisible(), false);
});

for (const engine of [chromium, webkit]) {
    test(`${engine.name()}: mobile sidebar animates and content resizing cannot reset a page swipe`, async t => {
        const { page } = await setup(t, engine, 390, { communityVersions: true, rankingStress: true });
        assert.equal(await page.locator('#config-mobile-home').isVisible(), true);
        assert.equal(await page.locator('#back-to-topics').isVisible(), false);
        const home = await page.locator('#config-mobile-home').boundingBox();
        const social = await page.locator('#config-site-links .th-social').boundingBox();
        const menu = await page.locator('#taxonomy-toggle').boundingBox();
        assert.ok(social.x < home.x && home.x < menu.x);
        await page.evaluate(() => document.querySelector('#taxonomy-toggle').click());
        await page.waitForFunction(() => {
            const rect = document.querySelector('#config-sidebar').getBoundingClientRect();
            return rect.x > -rect.width && rect.x < -1;
        }, null, { polling: 'raf' });
        const during = await page.locator('#config-sidebar').boundingBox();
        assert.ok(during.x < -1 && during.x > -during.width, JSON.stringify(during));
        await page.waitForFunction(() => Math.abs(document.querySelector('#config-sidebar').getBoundingClientRect().x) < 1);
        await page.locator('#taxonomy-close').click();
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        await page.locator('.bp-mobile-panels [data-mobile-panel="models"]').click();
        await page.waitForFunction(() => document.querySelector('#workspace-scene-panel').scrollLeft / document.querySelector('#workspace-scene-panel').clientWidth > .99);
        const panel = page.locator('#workspace-scene-panel');
        const before = await panel.evaluate(e => {
            e.style.scrollSnapType = 'none'; e.scrollLeft = e.clientWidth * 1.5;
            e.dispatchEvent(new Event('scroll'));
            document.querySelector('#discussion-feed').style.minHeight = '1600px';
            return e.scrollLeft;
        });
        await page.waitForTimeout(140);
        assert.ok(Math.abs(await panel.evaluate(e => e.scrollLeft) - before) < 2);
        await page.locator('.bp-mobile-panels [data-mobile-panel="discussion"]').click();
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'discussion'
            && document.querySelector('.bp-discussion-workspace').inert === false);
        assert.equal(await page.locator('.bp-mobile-panels').isVisible(), true);
        assert.equal(await page.locator('#discussion-title').isVisible(), false);
        assert.equal(await page.locator('#discussion-composer').isVisible(), true);
        await page.screenshot({ path: `${output}/${engine.name()}-discussion.png` });
    });
}
