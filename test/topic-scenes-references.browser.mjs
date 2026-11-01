import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startConfigSidebarPreview } from './helpers/config-sidebar-fixture-20261022.mjs';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { workspace, weightedEntries } from '../scripts/frontend/fixtures.mjs';
import { entryFromContext } from '../public/js/navigation/model.js';
import { startProposalFixture } from './fixtures/topic-proposals-server.mjs';

const output = 'D:/Codex-artifacts/website1/topic-scenes-references-20261031';
const localBrowserEnv = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
    NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
const sceneList = categoryID => [
    { ID: categoryID * 100 + 2, name: 'Vector images', slug: 'vector-images', description: 'Editable vector output', isDefault: false },
    { ID: categoryID * 100 + 1, name: 'General', slug: 'general', description: 'General-purpose output', isDefault: true },
    ...['Reference editing', 'Real-time creation', 'Single image', 'Multiple images', 'Long scene name for layout'].map((name, i) => ({
        ID: categoryID * 100 + i + 3, name, slug: `scene-${i}`, description: 'A specific image generation goal', isDefault: false
    }))
];
const targets = [
    { contextID: 16701, categoryID: 167, sceneID: 16701, name: 'Research / General', topicName: 'Research', sceneName: 'General',
        description: 'Research tasks', isPrivate: false, hasWeights: true, url: '/research?scene=16701' },
    { contextID: 16702, categoryID: 167, sceneID: 16702, name: 'Research / Photon experiments', topicName: 'Research', sceneName: 'Photon experiments',
        description: 'Laser and photonics', isPrivate: false, hasWeights: true, url: '/research?scene=16702' },
    { contextID: 19001, categoryID: 190, sceneID: null, name: 'Coding', topicName: 'Coding', sceneName: null,
        description: 'Programming tasks', isPrivate: false, hasWeights: true, url: '/coding' },
    { contextID: 99901, categoryID: 999, sceneID: null, name: 'Private plans', topicName: 'Private plans', sceneName: null,
        description: 'Personal only', isPrivate: true, hasWeights: true, url: '/personal/999' }
];

async function mountWorkspaceFixture(page, app) {
    const sceneCatalog = new Map([[54, sceneList(54)], [998, sceneList(998)]]), saved = new Map(), saves = [], reads = [], writes = [], summaries = [], discussions = [];
    let issues = [];
    function metadata(categoryID) {
        const topic = app.topics.find(topic => topic.ID === categoryID) ?? app.topics[0];
        return { ...topic, categoryID: topic.ID, categoryName: topic.name, description: 'An image-generation index.',
            isMine: topic.isPrivate === true, configured: true, scenes: sceneCatalog.get(topic.ID) ?? [], defaultContextID: topic.ID * 100 + 1,
            rootContextID: topic.ID * 100 + 1, contextValues: {}, dimensions: [],
            url: topic.isPrivate ? `/personal/${topic.ID}` : `/${topic.slug}`, lineage: [{ ID: topic.ID, name: topic.name }] };
    }
    const entriesFor = id => saved.get(id)?.entries ?? [{ conditionID: 1, weightBasisPoints: 10000 }];
    function decorate(entries) {
        return entries.map(entry => entry.conditionID > 0 ? weightedEntries([entry])[0]
            : { ...targets.find(target => target.contextID === -entry.conditionID), ...entry,
                referenceContextID: -entry.conditionID, type: 'topic', weight: entry.weightBasisPoints / 100 });
    }
    await page.route('**/api/get_topic', route => {
        const body = route.request().postDataJSON();
        return route.fulfill({ json: metadata(Number(body.categoryID) || app.topics.find(topic => topic.slug === body.slug)?.ID || 54) });
    });
    await page.route('**/api/get_private_category', route => route.fulfill({ json: metadata(Number(route.request().postDataJSON().categoryID)) }));
    await page.route('**/api/get_topics', route => route.fulfill({ json: { userID: app.state.userID, topics: app.topics.map(topic => metadata(topic.ID)) } }));
    await page.route('**/api/get_category_navigation', route => route.fulfill({ json: { items: app.topics.filter(topic => !topic.isPrivate).map(topic => entryFromContext(metadata(topic.ID))) } }));
    await page.route('**/api/get_personal_navigation', route => route.fulfill({ json: { userID: app.state.userID, items: [] } }));
    await page.route('**/api/get_weighted_workspace', route => {
        const body = route.request().postDataJSON(); reads.push(body);
        const categoryID = Number(body.categoryID), meta = metadata(categoryID);
        const sceneID = Number(body.contextValues?.scene) || meta.scenes.find(scene => scene.isDefault)?.ID || null;
        const contextID = sceneID ?? meta.rootContextID;
        const desired = body.previewPersonalPie?.entries ?? (app.state.authenticated ? entriesFor(contextID) : []);
        const base = workspace({ ...app.state, personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 10000 }]), fallbackRules: [] },
            { ...body, previewPersonalPie: undefined, categoryID: 1, contextValues: {} });
        base.context = { ...base.context, ...meta, ID: contextID, categoryPath: meta.url.slice(1), sceneID,
            contextValues: sceneID ? { scene: String(sceneID) } : {}, dimensions: [] };
        base.personalPie.entries = decorate(desired);
        base.personalPie.revision = saved.get(contextID)?.revision ?? 1;
        base.personalPie.isDraft = Boolean(body.previewPersonalPie) || !app.state.authenticated;
        base.personalPie.communityFallbackComposition = desired.filter(entry => entry.conditionID > 0).map(entry => ({
            primaryConditionID: entry.conditionID, families: [{ primaryConditionID: entry.conditionID,
                familyID: null, entries: [], weightBasisPoints: 10000, overallWeightBasisPoints: entry.weightBasisPoints }]
        }));
        base.personalPie.referenceIssues = desired.some(entry => entry.conditionID < 0) ? issues : [];
        base.personalPie.effectiveEntries = weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 2, weightBasisPoints: 4000 }]);
        for (const mode of ['personal', 'public']) {
            base.modelLeaderboards[mode] = []; base.rankingPagination[mode] = { total: 0, nextOffset: 0, hasMore: false };
        }
        return route.fulfill({ json: base });
    });
    await page.route('**/api/get_topic_reference_targets', route => route.fulfill({ json: { targets } }));
    await page.route('**/api/save_personal_pie', route => {
        const body = route.request().postDataJSON(); saves.push(body);
        const id = Number(body.contextValues?.scene) || body.categoryID * 100 + 1;
        const revision = (saved.get(id)?.revision ?? 1) + 1;
        saved.set(id, { entries: body.entries, revision });
        return route.fulfill({ json: { saved: true, requestKey: route.request().headers()['idempotency-key'], userID: app.state.userID,
            categoryID: body.categoryID, contextValues: body.contextValues,
            personalPie: { revision, entries: body.entries, fallbackRules: body.fallbackRules } } });
    });
    await page.route('**/api/create_topic_scene', route => {
        const body = route.request().postDataJSON(); writes.push(body);
        const scenes = sceneCatalog.get(body.categoryID), scene = { ID: body.categoryID * 100 + 99, name: body.name, description: body.description, slug: 'new-scene', isDefault: false };
        scenes.push(scene); return route.fulfill({ json: { scene } });
    });
    await page.route('**/api/update_topic_scene', route => {
        const body = route.request().postDataJSON(); writes.push(body);
        const scene = sceneCatalog.get(body.categoryID).find(scene => scene.ID === body.sceneID);
        Object.assign(scene, { name: body.name, description: body.description });
        return route.fulfill({ json: { scene } });
    });
    await page.route('**/api/get_discussion_summary', route => {
        const body = route.request().postDataJSON(); summaries.push(body);
        return route.fulfill({ json: { count: Number(body.contextValues?.scene) % 100 || 0 } });
    });
    await page.route('**/api/get_discussion', route => {
        const body = route.request().postDataJSON(); discussions.push(body);
        const context = { ...metadata(body.categoryID), contextValues: body.contextValues };
        return route.fulfill({ json: { context, contexts: [], posts: [], root: null, total: 0, hasMore: false,
            authenticated: app.state.authenticated, userID: app.state.userID } });
    });
    await page.route('**/api/set_default_topic_scene', route => {
        const body = route.request().postDataJSON(); writes.push(body);
        sceneCatalog.get(body.categoryID).forEach(scene => { scene.isDefault = scene.ID === body.sceneID; });
        return route.fulfill({ json: { sceneID: body.sceneID } });
    });
    return { saves, reads, saved, writes, summaries, discussions, setIssues(value) { issues = value; } };
}

for (const width of [390, 1440]) test(`scenes and references: keyboard, search, editing, save and restoration at ${width}`, async t => {
    await mkdir(output, { recursive: true });
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message)); page.setDefaultTimeout(15000);
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    const fixture = await mountWorkspaceFixture(page, app);
    await page.goto(app.url + '/intelligence?scene=5402');
    await page.waitForSelector('#scene-tab-5402[aria-selected="true"]');
    assert.equal(await page.getByRole('link', { name: 'Propose a scene', exact: true }).count(), 0);
    assert.equal(await page.locator('.bp-scene-actions').isVisible(), false);
    await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
    await page.screenshot({ path: `${output}/workspace-scene-tabs-${width}.png` });
    if (await page.locator('#personal-pie-create').isVisible()) await page.locator('#personal-pie-create').click();
    assert.equal(await page.locator('.bp-scene-tab').first().getAttribute('data-scene-id'), '5401');
    assert.equal(await page.locator('.bp-scene-default').count(), 0);
    assert.equal(await page.locator('.bp-template-picker').count(), 0);
    await page.locator('#scene-tab-5402').focus(); await page.keyboard.press('Home'); await page.keyboard.press('Enter');
    await page.waitForURL('**/intelligence?scene=5401');
    await page.locator('#scene-tab-5401').focus(); await page.keyboard.press('End');
    assert.equal(await page.evaluate(() => document.activeElement.dataset.sceneId), '5407');
    if (width < 760) assert.ok(await page.getByRole('tablist', { name: 'Scenes', exact: true }).evaluate(node => node.scrollLeft > 0));
    assert.equal(await page.getByRole('tablist', { name: 'Scenes', exact: true }).evaluate(node => [...node.children].every(tab => tab.offsetTop === node.children[0].offsetTop)), true);
    await page.locator('#pie-mode-personal').click();
    await page.locator('#benchmark-search').fill('Research');
    const inlineTopics = page.locator('.bp-benchmark-topic-results');
    const researchDisclosure = inlineTopics.getByRole('button', { name: 'Research', exact: true });
    const inlineAddActions = inlineTopics.getByRole('button', { name: 'Add', exact: true });
    await researchDisclosure.waitFor();
    assert.equal(await researchDisclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await inlineAddActions.count(), 0, 'Collapsed scenes expose no Add actions');
    for (const id of ['16701', '16702']) {
        assert.equal(await inlineTopics.locator(`[data-context-id="${id}"]`).isVisible(), false, 'Retained scene nodes stay visually hidden');
    }
    await researchDisclosure.click();
    assert.equal(await researchDisclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(await inlineAddActions.count(), 2);
    assert.equal(await inlineTopics.getByRole('link', { name: 'Research / General', exact: true }).getAttribute('href'), '/research?scene=16701');
    assert.equal(await inlineTopics.getByRole('link', { name: 'Research / Photon experiments', exact: true }).getAttribute('href'), '/research?scene=16702');
    await researchDisclosure.press('Space');
    assert.equal(await researchDisclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await inlineAddActions.count(), 0, 'Keyboard collapse removes scene actions from the accessibility tree');
    await researchDisclosure.press('Enter');
    assert.equal(await researchDisclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(await inlineAddActions.count(), 2);
    assert.equal(fixture.saves.length, 0, 'Disclosure changes do not add references');
    await page.locator('#benchmark-search').fill('Photon');
    await inlineTopics.locator('[data-context-id="16702"]').waitFor();
    assert.equal(await inlineTopics.locator('.fa-layer-group').count(), 1);
    assert.equal(await inlineTopics.locator('.fa-angle-right').count(), 1);
    await page.locator('#benchmark-search').fill('');
    await page.locator('#weight-add-topic').click();
    const picker = page.locator('#topic-reference-dialog');
    await picker.getByRole('searchbox').fill('Research');
    assert.equal(await picker.locator('[data-context-id]').count(), 0, 'parent-name search requires a separate scene choice');
    assert.equal(await picker.getByRole('button', { name: 'Research', exact: true }).getAttribute('aria-expanded'), 'false');
    await picker.getByRole('button', { name: 'Research', exact: true }).click();
    assert.equal(await picker.locator('[data-context-id]').count(), 2);
    assert.equal(fixture.saves.length, 0, 'choosing a topic with scenes is not an implicit reference');
    await picker.getByRole('button', { name: 'All topics', exact: true }).click();
    await picker.getByRole('searchbox').fill('Photon');
    const firstSave = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
    await picker.locator('[data-context-id="16702"]').getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForSelector('[data-reference-id="16702"]');
    await firstSave;
    await page.waitForSelector('#topic-reference-weights summary');
    assert.ok(fixture.saves.some(save => save.entries.some(entry => entry.conditionID === -16702)));
    assert.equal(await page.getByText('Added to Personal Weights.', { exact: true }).isVisible(), false, 'Reference adjustment has no overlapping success toast');
    await page.locator('#weight-pie > g[data-object-id="-16702"]').click();
    assert.equal(await page.locator('#pie-instruction .fa-layer-group').count(), 1);
    assert.match(await page.locator('#pie-instruction').textContent(), /Research.*Photon experiments/);
    assert.equal(await page.locator('#inline-fallback').isVisible(), false);
    await page.locator('#topic-reference-weights summary').click();
    assert.match(await page.locator('.bp-reference-composition').innerText(), /Advanced reasoning/);
    await page.screenshot({ path: `${output}/workspace-${width}.png` });
    await page.locator('#workspace-undo').click();
    await page.waitForFunction(() => !document.querySelector('[data-reference-id="16702"]'));
    const redoSave = page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie')
        && response.request().postDataJSON().entries.some(entry => entry.conditionID === -16702));
    await page.locator('#workspace-redo').click();
    await page.waitForSelector('[data-reference-id="16702"]');
    await redoSave;
    await page.waitForSelector('#topic-reference-weights summary');
    await page.reload();
    await page.waitForSelector('[data-reference-id="16702"]');
    await page.locator('#weight-add-topic').click();
    await picker.getByRole('searchbox').fill('Private');
    assert.equal(await picker.locator('[data-context-id]').count(), 0, 'private targets excluded for a public source');
    await picker.getByRole('button', { name: 'Close topic selector' }).click();
    fixture.setIssues([{ targetContextID: 16702, name: 'Research / Photon experiments', reason: 'empty' }]);
    await page.locator('#workspace-refresh').click();
    await page.waitForSelector('.bp-reference-warnings');
    assert.match(await page.locator('.bp-reference-warnings').textContent(), /No weights/);
    const contextID = Number(new URL(page.url()).searchParams.get('scene'));
    fixture.saved.set(contextID, { revision: fixture.saved.get(contextID).revision,
        entries: [{ conditionID: 1, weightBasisPoints: 4000 }, { conditionID: -16702, weightBasisPoints: 6000 }] });
    await page.locator('#workspace-refresh').click();
    await page.waitForSelector('#weight-pie g[data-object-id="-16702"] .fa-layer-group');
    assert.equal(await page.locator('#weight-pie g[data-object-id="-16702"] .fa-angle-right').count(), 1);
    await page.screenshot({ path: `${output}/topic-label-${width}.png` });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
});

test('public topics without scenes leave no empty scene action strip', async t => {
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true, env: localBrowserEnv });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    await mountWorkspaceFixture(page, app);
    const topic = app.topics.find(topic => !topic.isPrivate && topic.ID !== 54);
    assert.ok(topic);
    await page.goto(app.url + '/' + topic.slug);
    await page.waitForSelector('#model-card[aria-busy="false"]', { state: 'attached' });
    assert.equal(await page.locator('#bp-template-strip').isVisible(), false);
    assert.equal(await page.getByRole('link', { name: 'Propose a scene', exact: true }).count(), 0);
});

test('benchmark search adds a concrete topic reference without opening the separate topic picker', async t => {
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true, env: localBrowserEnv });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    const fixture = await mountWorkspaceFixture(page, app);
    await page.goto(app.url + '/intelligence?scene=5401');
    await page.locator('#pie-mode-personal').click();
    await page.locator('#benchmark-search').fill('Photon');
    const row = page.locator('.bp-benchmark-topic-results [data-context-id="16702"]');
    await row.getByRole('button', { name: 'Add', exact: true }).click();
    await page.waitForSelector('[data-reference-id="16702"]');
    await page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie'));
    assert.ok(fixture.saves.at(-1).entries.some(entry => entry.conditionID === -16702));
    assert.equal(await page.locator('#topic-reference-dialog').isVisible(), false);
    assert.equal(await row.getByRole('button', { name: 'Added', exact: true }).isDisabled(), true);
    await page.locator('#benchmark-search').fill('Private');
    assert.equal(await page.locator('.bp-benchmark-topic-results [data-context-id]').count(), 0);
});

test('private owner creates scenes and changes the default without changing the active scene identity', async t => {
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    t.after(async () => { await browser.close(); await app.close(); });
    const fixture = await mountWorkspaceFixture(page, app);
    await page.goto(app.url + '/personal/998?scene=99802');
    await page.waitForSelector('#scene-tab-99802[aria-selected="true"]');
    await page.getByRole('button', { name: 'Set as default', exact: true }).click();
    await page.waitForFunction(() => document.querySelector('.bp-scene-tab')?.dataset.sceneId === '99802');
    assert.equal(new URL(page.url()).searchParams.get('scene'), '99802');
    await page.getByRole('button', { name: 'Add scene', exact: true }).click();
    await page.locator('#scene-editor').getByLabel('Name', { exact: true }).fill('Photon design');
    await page.locator('#scene-editor').getByLabel('One-sentence summary', { exact: true }).fill('Design precise optical diagrams.');
    await page.getByRole('button', { name: 'Create scene', exact: true }).click();
    await page.waitForSelector('#scene-tab-99899[aria-selected="true"]');
    assert.equal(new URL(page.url()).searchParams.get('scene'), '99899');
    assert.equal(fixture.writes.at(-1).expectedUserID, '1');
    await page.getByRole('button', { name: 'Edit scene', exact: true }).click();
    await page.locator('#scene-name').fill('Optical design');
    await page.getByRole('button', { name: 'Save scene', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('scene-tab-99899')?.textContent === 'Optical design');
    assert.equal(new URL(page.url()).searchParams.get('scene'), '99899', 'renaming never changes reference identity');
    assert.equal(fixture.writes.at(-1).sceneID, 99899);
    await page.locator('#weight-add-topic').click();
    await page.locator('#topic-reference-dialog').getByRole('searchbox').fill('Private plans');
    await page.locator('#topic-reference-dialog [data-context-id="99901"]').waitFor();
});

test('guest references use read-only previews and retain independent scene drafts', async t => {
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true });
    app.setAccount(null);
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = [], details = []; page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (/get_benchmark_information|fallback/.test(request.url()) && request.url().includes('/api/')) details.push(request.url()); });
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    const fixture = await mountWorkspaceFixture(page, app);
    await page.goto(app.url + '/intelligence?scene=5402');
    await page.waitForSelector('#scene-tab-5402[aria-selected="true"]');
    await page.locator('#personal-pie-create').click();
    const picker = page.locator('#topic-reference-dialog');
    for (const name of ['Photon', 'Coding']) {
        await page.locator('#weight-add-topic').click();
        await picker.getByRole('searchbox').fill(name);
        const preview = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
            && response.request().postDataJSON().previewPersonalPie?.entries.some(entry => entry.conditionID < 0));
        await picker.getByRole('button', { name: 'Add', exact: true }).click(); await preview;
        await page.waitForSelector('#topic-reference-weights summary');
    }
    await page.locator('#weight-pie > g[data-object-id="-16702"]').click();
    const initial = fixture.reads.at(-1).previewPersonalPie.entries.find(entry => entry.conditionID === -16702).weightBasisPoints;
    const adjusted = page.waitForResponse(response => response.url().endsWith('/api/get_weighted_workspace')
        && response.request().postDataJSON().previewPersonalPie?.entries.some(entry => entry.conditionID === -16702 && entry.weightBasisPoints !== initial));
    await page.locator('#weight-pie').dispatchEvent('wheel', { deltaY: -100 }); await adjusted;
    await page.waitForSelector('#topic-reference-weights summary');
    assert.equal(await page.locator('#inline-fallback').isVisible(), false);
    assert.equal(details.length, 0, 'references never request benchmark details or fallback APIs');
    assert.equal(fixture.saves.length, 0, 'guest weights never reach the save endpoint');
    await page.locator('#scene-tab-5401').click();
    await page.waitForSelector('#scene-tab-5401[aria-selected="true"]');
    assert.equal(await page.locator('[data-reference-id]').count(), 0);
    await page.locator('#scene-tab-5402').click();
    await page.waitForSelector('[data-reference-id="16702"]');
    await page.waitForSelector('#topic-reference-weights summary');
    await page.reload();
    await page.waitForSelector('[data-reference-id="16702"]');
    assert.equal(fixture.saves.length, 0);
    assert.deepEqual(fixture.reads.at(-1).contextValues, { scene: '5402' });
});

test('discussion deep links, summaries and drafts are isolated by scene', async t => {
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    const fixture = await mountWorkspaceFixture(page, app);
    await page.goto(app.url + '/intelligence?scene=5402&discussion=1&categoryID=54');
    await page.waitForSelector('#discussion-context [data-scene-id="5402"][aria-selected="true"]');
    assert.ok(fixture.discussions.every(body => body.contextValues.scene === '5402'));
    assert.equal(await page.locator('#posting-context').textContent(), 'Vector images');
    await page.locator('#discussion-compose-toggle').click();
    await page.locator('#discussion-text').fill('Vector-only draft');
    await page.locator('#discussion-context [data-scene-id="5401"]').click();
    await page.waitForSelector('#discussion-context [data-scene-id="5401"][aria-selected="true"]');
    assert.equal(await page.locator('#discussion-text').inputValue(), '');
    await page.locator('#discussion-context [data-scene-id="5402"]').click();
    await page.waitForSelector('#discussion-context [data-scene-id="5402"][aria-selected="true"]');
    assert.equal(await page.locator('#discussion-text').inputValue(), 'Vector-only draft');
    await page.locator('#discussion-text').fill('');
    await page.locator('#discussion-close').click();
    await page.locator('#scene-tab-5401').click();
    await page.waitForFunction(() => document.getElementById('discussion-entry')?.dataset.discussionCount === '1');
    assert.ok(fixture.summaries.some(body => body.contextValues.scene === '5401'));
    assert.ok(fixture.summaries.some(body => body.contextValues.scene === '5402'));
    assert.match(await page.locator('#discussion-entry').getAttribute('href'), /scene=5401/);
});

for (const browserType of [chromium, webkit]) for (const width of [390, 1440]) test(`${browserType.name()} home scene search previews and links share the selected scene at ${width}`, async t => {
    await mkdir(output, { recursive: true });
    const app = await startTopicsPreview(), browser = await browserType.launch({ headless: true, env: localBrowserEnv });
    app.state.topics[0].scenes = [{ ID: 102, name: 'Photon design', description: 'Coding: Laser systems', isDefault: false },
        { ID: 101, name: 'General', description: 'Coding: General programming', isDefault: true }];
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    await page.route('**/api/get_topic_preview', async route => {
        const body = route.request().postDataJSON(), response = await route.fetch(), data = await response.json();
        await route.fulfill({ json: { ...data, contextValues: body.sceneID ? { scene: String(body.sceneID) } : {},
            weights: [{ ...targets[1], conditionID: -16702, type: 'topic', weightBasisPoints: 6000 },
                ...data.weights.map(weight => ({ ...weight, weightBasisPoints: weight.weightBasisPoints * .4 }))] } });
    });
    await page.goto(app.url);
    await page.waitForSelector('.th-card[data-topic-id="54"][data-preview-state="loaded"]');
    assert.equal(await page.locator('.th-card[data-topic-id="54"] .th-tile-name .fa-layer-group').count(), 1);
    assert.equal(await page.locator('.th-card[data-topic-id="54"] .th-tile-name .fa-angle-right').count(), 1);
    assert.equal(await page.locator('.th-card[data-scene-id]:visible').count(), 0);
    await page.evaluate(() => document.getElementById('topics').scrollIntoView());
    await page.locator('#topic-search-toggle').click();
    await page.locator('#topic-search').fill('Coding');
    assert.equal(await page.locator('.th-card:visible').count(), 1);
    assert.equal(await page.locator('.th-card[data-scene-id]:visible').count(), 0);
    assert.equal(app.state.requests.some(request => request.path === '/api/get_topic_preview' && request.body.sceneID), false,
        'collapsed scenes do not fetch previews');
    const disclosure = page.locator('.th-card[data-topic-id="1"]:not([data-scene-id]) .th-scene-toggle');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    await disclosure.focus(); await page.keyboard.press('Enter');
    assert.equal(new URL(page.url()).pathname, '/', 'disclosure does not activate card navigation');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.deepEqual(await page.locator('.th-card[data-scene-id]:visible').evaluateAll(nodes => nodes.map(node => node.dataset.sceneId)), ['101', '102']);
    await page.locator('.th-card[data-scene-id="101"][data-preview-state="loaded"]').waitFor();
    if (width > 760) await page.locator('.th-card[data-scene-id="102"][data-preview-state="loaded"]').waitFor();
    await page.screenshot({ path: `${output}/home-parent-expanded-${browserType.name()}-${width}.png` });
    await disclosure.focus(); await page.keyboard.press('Space');
    assert.equal(await page.locator('.th-card[data-scene-id]:visible').count(), 0);
    await page.screenshot({ path: `${output}/home-parent-collapsed-${browserType.name()}-${width}.png` });
    await disclosure.click();
    if (!await page.locator('#topic-search').isVisible()) await page.locator('#topic-search-toggle').click();
    await page.locator('#topic-search').fill('Photon');
    const card = page.locator('.th-card[data-scene-id="102"]');
    await card.locator('.th-model').first().waitFor();
    assert.equal(await page.locator('.th-card:visible').count(), 1);
    assert.equal(new URL(await card.locator('.th-topic-link').getAttribute('href'), app.url).searchParams.get('scene'), '102');
    assert.equal(new URL(await card.locator('.th-model').first().getAttribute('href'), app.url).searchParams.get('scene'), '102');
    assert.ok(app.state.requests.some(request => request.path === '/api/get_topic_preview' && request.body.sceneID === 102));
    await page.screenshot({ path: `${output}/home-search-${browserType.name()}-${width}.png` });
    await page.locator('#topic-search').fill('Coding');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false', 'changing the query resets parent expansion');
    assert.equal(await page.locator('.th-card[data-scene-id]:visible').count(), 0);
    assert.equal(await page.locator('.th-card[data-topic-id="1"]:not([data-scene-id]) .th-topic-name')
        .evaluate(node => node.scrollWidth <= node.clientWidth), true, 'disclosure does not squeeze the short topic name');
    assert.equal(await page.locator('body').evaluate(node => node.scrollWidth <= innerWidth), true);
});

test('public scene proposals select a parent explicitly and preserve it during edits', async t => {
    const app = await startProposalFixture(), browser = await chromium.launch({ headless: true });
    app.state.topics.push({ ID: 999, name: 'Private plans', isPrivate: true });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); assert.deepEqual(app.state.failures, []); });
    await page.goto(app.url + '?parentTopicID=190');
    await page.locator('#open-proposal:not(:disabled)').click();
    await page.waitForFunction(() => document.querySelector('#proposal-target option[value="190"]')?.textContent === 'Scene in Coding');
    assert.equal(await page.locator('#proposal-target').inputValue(), '190');
    assert.equal(await page.locator('#proposal-target option[value="999"]').count(), 0);
    await page.locator('#proposal-name').fill('Embedded systems');
    await page.locator('#proposal-description').fill('Write and debug resource-constrained firmware.');
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    const submitted = app.state.requests.find(request => request.path === '/api/propose_topic');
    assert.equal(submitted.body.parentTopicID, 190);
    const row = page.locator('.tp-row').filter({ hasText: 'Embedded systems' });
    assert.match(await row.textContent(), /Scene in Coding/);
    await row.getByRole('button', { name: 'Edit Embedded systems' }).click();
    assert.equal(await page.locator('#proposal-target').isDisabled(), true);
    assert.equal(await page.locator('#proposal-target').inputValue(), '190');
    await page.locator('#proposal-name').fill('Embedded firmware');
    await page.locator('#proposal-submit').click();
    await page.waitForFunction(() => !document.getElementById('proposal-dialog').open);
    const edited = app.state.requests.find(request => request.path === '/api/edit_topic_proposal');
    assert.equal(Object.hasOwn(edited.body, 'parentTopicID'), false, 'an existing proposal cannot switch its target');
    assert.equal(app.state.proposals.find(proposal => proposal.name === 'Embedded firmware').parentTopicID, 190);
    await page.screenshot({ path: `${output}/scene-proposal-390.png` });
});

for (const width of [390, 1440]) test(`sidebar scene search groups parent matches and navigates to an explicit scene at ${width}`, async t => {
    const app = await startConfigSidebarPreview(), browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    t.after(async () => { await browser.close(); await app.close(); assert.deepEqual(errors, []); });
    const fixture = await mountWorkspaceFixture(page, app);
    await page.goto(app.url + '/intelligence?scene=5401');
    await page.waitForSelector('#scene-tab-5401[aria-selected="true"]');
    await page.locator(width < 760 ? '#taxonomy-toggle' : '#config-sidebar-toggle').click();
    await page.locator('#navigation-search-toggle').click();
    const results = page.locator('#category-search-results');
    await page.locator('#configured-search').fill('Intelligence');
    const disclosure = results.locator('[data-scene-disclosure="54"]');
    await disclosure.waitFor();
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await results.locator('[data-scene-id]').count(), 0);
    await disclosure.focus(); await page.keyboard.press('Space');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'true');
    assert.equal(await results.locator('[data-scene-id]').count(), 7);
    assert.equal(await results.locator('[data-scene-id]').first().getAttribute('data-scene-id'), '5401');
    await disclosure.focus(); await page.keyboard.press('Enter');
    assert.equal(await results.locator('[data-scene-id]').count(), 0);
    await page.screenshot({ path: `${output}/sidebar-parent-collapsed-${width}.png` });
    await disclosure.click();
    await page.locator('#configured-search').fill('General');
    await results.locator('[data-scene-id="5401"]').waitFor();
    assert.equal(await results.locator('[aria-current="page"]').count(), 1);
    assert.equal(await results.locator('[aria-current="page"]').getAttribute('data-scene-id'), '5401');
    await page.locator('#configured-search').fill('Intelligence');
    assert.equal(await disclosure.getAttribute('aria-expanded'), 'false');
    assert.equal(await results.locator('[data-scene-id]').count(), 0);
    await page.locator('#configured-search').fill('Editable vector output');
    await results.locator('[data-scene-id="5402"]').waitFor();
    assert.equal(await results.locator('[data-scene-id]').count(), 2, 'Matching descriptions include public and owned-private scenes');
    assert.equal(await results.locator('[data-scene-id="5402"]').getAttribute('href'), '/intelligence?scene=5402');
    await results.locator('[data-scene-id="5402"]').click();
    await page.waitForSelector('#scene-tab-5402[aria-selected="true"]');
    assert.equal(new URL(page.url()).searchParams.get('scene'), '5402');
    assert.equal(fixture.reads.at(-1).contextValues.scene, '5402');
});
