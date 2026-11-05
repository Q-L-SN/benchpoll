import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { workspace, weightedEntries, benchmarks } from '../scripts/frontend/fixtures.mjs';
import { buildBenchmarkList } from '../ranking-service.js';
import { expandTopicReferences, referenceCondition } from '../topic-reference-service.js';
import { createRankingPager } from '../ranking-pagination.js';

const built = process.env.BP_TEST_BUILT === '1';
const output = process.env.BP_EXPANDED_ARTIFACTS ?? '/tmp/benchpoll-expanded-topics';
await mkdir(output, { recursive: true });
const targets = [
    { contextID: 101, categoryID: 2, sceneID: 101, name: 'Coding / PHP', topicName: 'Coding', sceneName: 'PHP',
        url: '/coding/php', isPrivate: false, hasWeights: true },
    { contextID: 102, categoryID: 3, sceneID: null, name: 'Intelligence', topicName: 'Intelligence',
        url: '/intelligence', isPrivate: false, hasWeights: true }
];
const e = (conditionID, weightBasisPoints) => ({ conditionID, weightBasisPoints });
const decorate = entries => entries.map(entry => entry.conditionID > 0 ? weightedEntries([entry])[0]
    : { ...referenceCondition(targets.find(target => target.contextID === -entry.conditionID)), ...entry, weight: entry.weightBasisPoints / 100 });

for (const [engine, width] of [[chromium, 1440], [chromium, 320], [webkit, 390]]) {
    test(`${engine.name()} ${width}: selected topic breakdown and read-only expanded view ${built ? 'built' : 'source'}`, async t => {
        const app = await startPreview({ communityVersions: true }), pager = createRankingPager();
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width < 760, isMobile: width < 760, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = [], saves = [];
        let withReferences = true;
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        await page.route('**/api/get_weighted_workspace', async route => {
            const body = route.request().postDataJSON(), base = workspace(app.state, body, { paginate: false });
            for (const mode of ['personal', 'public']) {
                const raw = !withReferences ? [e(1, 10000)] : mode === 'personal' ? [e(-101, 4000), e(-102, 2000), e(1, 4000)] : [e(-101, 5000), e(2, 5000)];
                const expansion = await expandTopicReferences({ contextID: 1, entries: raw }, { loadTarget: async id => ({ contextID: id,
                    entries: id === 101 ? mode === 'personal' ? [e(1, 2500), e(2, 7500)] : [e(1, 6000), e(2, 4000)]
                        : id === 102 ? [e(-103, 10000)] : [e(1, 5000), e(3, 5000)] }) });
                Object.assign(base[mode + 'Pie'], { entries: decorate(raw), effectiveEntries: decorate(expansion.entries),
                    referenceIssues: [], referenceCompositions: expansion.referenceCompositions.map(item => ({ ...item, entries: decorate(item.entries) })) });
                base[mode + 'Pie'][mode === 'personal' ? 'communityFallbackComposition' : 'familyComposition'] = raw.filter(entry => entry.conditionID > 0)
                    .map(entry => ({ primaryConditionID: entry.conditionID, families: [{ primaryConditionID: entry.conditionID,
                        familyID: null, entries: [], weightBasisPoints: 10000, overallWeightBasisPoints: entry.weightBasisPoints }] }));
            }
            base.benchmarks = buildBenchmarkList([...benchmarks, ...targets.map(referenceCondition)], base.publicPie.entries, base.personalPie.entries);
            await route.fulfill({ json: pager.create(base, { userID: app.state.userID, initialMode: body.initialMode ?? 'public',
                query: body.benchmarkQuery ?? '', pinPersonal: false }) });
        });
        await page.route('**/api/get_ranking_page', route => route.fulfill({ json: pager.getPage({ ...route.request().postDataJSON(), userID: app.state.userID }) }));
        await page.route('**/api/get_topic_preview', route => route.fulfill({ json: { totalCoverageIndex: 64.63 } }));
        await page.route('**/api/save_personal_pie', route => { saves.push(route.request().postDataJSON()); return route.abort(); });
        if (built) await page.route(app.url + '/', async route => route.fulfill({ contentType: 'text/html', body: await readFile(new URL('../private/home-built.html', import.meta.url), 'utf8') }));
        await page.goto(app.url);
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        const topicTile = page.locator('#weight-pie [data-object-id="-101"]');
        const panel = page.locator('#topic-reference-weights');
        const view = page.locator('#weight-topic-view');
        assert.equal(await page.locator('#workspace-headline .bp-breadcrumb-current').innerText(), 'Language models');
        assert.equal(await page.locator('[data-headline-mode]').count(), 0);
        await topicTile.click();
        assert.deepEqual(await panel.locator('li strong').allTextContents(), ['60%', '40%']);
        assert.equal(await panel.locator('a').getAttribute('href'), '/coding/php');
        assert.equal(await panel.locator('a i').count(), 1);
        assert.equal(await panel.locator('.bp-reference-weight').count(), 0);
        const metric = page.locator('.bp-benchmark-row[data-condition-id="-101"] [data-coverage-value]');
        await metric.scrollIntoViewIfNeeded();
        await page.waitForFunction(() => document.querySelector('[data-condition-id="-101"] [data-coverage-value]')?.textContent === '65');
        const name = page.locator('[data-condition-id="-101"] .bp-benchmark-information-link');
        await name.hover();
        const underline = await name.locator('.bp-topic-link-label').evaluate(node => ({ text: node.textContent,
            icons: node.querySelectorAll('.fa-angle-right').length, color: getComputedStyle(node).borderBottomColor,
            ink: getComputedStyle(node).color, width: getComputedStyle(node).borderBottomWidth }));
        assert.equal(underline.icons, 1); assert.match(underline.text, /Coding.*PHP/);
        assert.equal(underline.color, underline.ink); assert.equal(underline.width, '1px');
        await page.locator('#weight-pie [data-object-id="2"]').click();
        const publicToggle = page.locator('#public-fallback-toggle');
        assert.equal(await publicToggle.innerText(), 'Benchmark settings');
        assert.equal(await publicToggle.evaluate(node => getComputedStyle(node).textDecorationLine), 'none');
        await publicToggle.click(); await page.locator('#benchmark-settings').waitFor();
        await topicTile.click();
        await view.click();
        assert.equal(await view.getAttribute('aria-pressed'), 'true');
        assert.equal(await view.locator('i').evaluate(node => getComputedStyle(node).color),
            await view.evaluate(node => getComputedStyle(node).color));
        assert.equal(await page.locator('#weight-pie [aria-pressed="true"]').count(), 0);
        assert.equal(await page.locator('#inline-fallback').isVisible(), false);
        assert.equal(await panel.isVisible(), false);
        const weights = () => page.locator('#weight-pie [data-object-id]').evaluateAll(nodes => Object.fromEntries(nodes.map(node => [node.dataset.objectId, Number(node.dataset.weight)])));
        assert.deepEqual(await weights(), { 1: 3000, 2: 7000 });
        assert.equal(await page.locator('.bp-benchmark-row[data-context-id]').count(), 0);
        assert.equal(await page.locator('.bp-benchmark-row').count(), 2);
        await view.click();
        await page.locator('#weight-pie [data-object-id="2"]').click();
        assert.equal(await publicToggle.getAttribute('aria-expanded'), 'true');
        await page.locator('#benchmark-settings').waitFor();
        await page.locator('#pie-mode-personal').click();
        await page.locator('#model-card[aria-busy="false"]').waitFor();
        await topicTile.click();
        assert.deepEqual(await panel.locator('li strong').allTextContents(), ['75%', '25%']);
        const visit = await panel.locator('a').boundingBox(), panelBox = await panel.boundingBox();
        assert.ok(Math.abs(visit.x + visit.width / 2 - panelBox.x - panelBox.width / 2) < 2, JSON.stringify({ visit, panelBox,
            style: await panel.locator('a').evaluate(node => ({ margin: getComputedStyle(node).margin, display: getComputedStyle(node).display })) }));
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${built ? 'built' : 'source'}-selected.png` });
        await view.click();
        assert.deepEqual(await weights(), { 1: 6000, 2: 3000, 3: 1000 });
        assert.equal(await page.locator('#workspace-undo').isDisabled(), true);
        assert.equal(await page.locator('#workspace-reset').isDisabled(), true);
        assert.ok(await page.locator('#workspace-reset').evaluate(node => Number(getComputedStyle(node).opacity)) < .5);
        assert.equal(await page.locator('#weight-add-actions').isVisible(), false);
        assert.equal(await page.locator('.bp-personal-weight-remove, .bp-benchmark-add').count(), 0);
        await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await page.locator('#inline-fallback').isVisible(), false);
        const blocked = await page.locator('#weight-pie').evaluate(node => {
            const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -120 });
            node.dispatchEvent(event); return event.defaultPrevented;
        });
        assert.equal(blocked, false);
        assert.deepEqual(await weights(), { 1: 6000, 2: 3000, 3: 1000 });
        await page.locator('#benchmark-search').fill('reasoning');
        assert.equal(await page.locator('.bp-benchmark-row').count(), 1);
        await page.locator('#benchmark-search').fill('');
        const tools = await page.locator('.bp-pie-tools').boundingBox(), chart = await page.locator('#weight-pie').boundingBox();
        assert.ok(tools.y + tools.height <= chart.y && Math.abs(tools.x + tools.width - chart.x - chart.width) < 20);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
        await page.locator('#pie-card').scrollIntoViewIfNeeded();
        await page.screenshot({ path: `${output}/${engine.name()}-${width}-${built ? 'built' : 'source'}-expanded.png` });
        await view.click(); await page.locator('#weight-pie [data-object-id="1"]').click();
        assert.equal(await page.locator('#inline-fallback-toggle').getAttribute('aria-expanded'), 'true');
        assert.equal(await page.locator('#workspace-reset').isEnabled(), true);
        assert.ok(await page.locator('.bp-personal-weight-remove').count() > 0);
        assert.equal(saves.length, 0, 'Inspecting and switching views never writes weights');
        withReferences = false;
        await page.locator('#workspace-refresh').click();
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        assert.equal(await view.isVisible(), false);
    });
}
