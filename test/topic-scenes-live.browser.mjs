import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium, webkit, request } from 'playwright';

const origin = process.env.BENCHPOLL_TEST_ORIGIN || 'https://benchpoll.com';
const output = 'D:/Codex-artifacts/website1/topic-scenes-references-20261031';
const proxyURL = process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
const parsedProxy = proxyURL ? new URL(proxyURL) : null;
const proxy = parsedProxy ? { server: parsedProxy.origin,
    ...(parsedProxy.username ? { username: decodeURIComponent(parsedProxy.username), password: decodeURIComponent(parsedProxy.password) } : {}) } : undefined;
const api = async (client, path, body = {}) => {
    const response = await client.post(origin + '/api/' + path, { data: body });
    assert.equal(response.status(), 200, path); return response.json();
};

for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) test(`live scenes and guest references ${engine.name()} ${width}`, async t => {
    await mkdir(output, { recursive: true });
    const client = await request.newContext({ proxy });
    t.after(() => client.dispose());
    const { topics } = await api(client, 'get_topics');
    const images = topics.find(topic => topic.ID === 172), coding = topics.find(topic => topic.ID === 180);
    assert.ok(images.scenes.length > 1 && images.scenes[0].isDefault);
    const selectedScene = images.scenes.find(scene => scene.name === 'Single Reference Image'); assert.ok(selectedScene);
    assert.equal(topics.length, 32);
    assert.equal(topics.find(topic => topic.ID === 176).name, 'GUI Operation');
    assert.equal(topics.find(topic => topic.ID === 196).name, 'Office');
    assert.equal(topics.some(topic => topic.ID === 231), false);
    assert.equal(topics.find(topic => topic.ID === 219).scenes.length, 185);
    const audio = topics.find(topic => topic.ID === 190);
    assert.deepEqual(audio.scenes.map(scene => scene.name), ['Non-Real-Time Audio', 'Real-Time Audio']);
    assert.ok(audio.scenes[0].isDefault);
    const { targets } = await api(client, 'get_topic_reference_targets');
    const target = targets.find(item => item.categoryID === coding.ID && item.sceneID === null);
    assert.ok(target?.hasWeights);
    const browser = await engine.launch({ headless: true, proxy });
    const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: 'reduce',
        ...(width < 600 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    page.setDefaultTimeout(60000);
    const errors = [], writes = [], responses = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (/\/api\/(save_|create_|propose_|vote_)/.test(request.url())) writes.push(request.url());
    });
    page.on('response', response => { if (response.status() >= 500) responses.push([response.url(), response.status()]); });
    t.after(async () => {
        await page.screenshot({ path: `${output}/live-last-${engine.name()}-${width}.png` }).catch(() => {});
        await browser.close(); assert.deepEqual(errors, []); assert.deepEqual(writes, []); assert.deepEqual(responses, []);
    });
    await page.goto(origin + images.url, { waitUntil: 'domcontentloaded' });
    await page.locator(`#scene-tab-${images.scenes[0].ID}[aria-selected="true"]`).waitFor();
    assert.equal(await page.locator('.bp-scene-tab').first().getAttribute('data-scene-id'), String(images.scenes[0].ID));
    assert.equal(await page.locator('.bp-scene-default').count(), 0);
    assert.equal(await page.locator('.bp-template-picker').count(), 0);
    await page.screenshot({ path: `${output}/live-tabs-${engine.name()}-${width}.png` });
    await page.locator(`#scene-tab-${selectedScene.ID}`).click();
    await page.waitForURL(url => url.searchParams.get('scene') === String(selectedScene.ID));
    await page.locator(`#scene-tab-${selectedScene.ID}[aria-selected="true"]`).waitFor();
    await page.locator(`#scene-tab-${images.scenes[0].ID}`).click();
    await page.locator(`#scene-tab-${images.scenes[0].ID}[aria-selected="true"]`).waitFor();
    if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
    await page.locator('#personal-pie-create:visible, #pie-mode-personal:visible, #pie-empty-compact-action:visible').first().click();
    await page.locator('#benchmark-search').fill(coding.name);
    const picker = page.locator('.bp-benchmark-topic-results');
    await picker.locator('.fa-layer-group').first().waitFor();
    const preview = page.waitForResponse(response => response.url().includes('/api/get_weighted_workspace')
        && response.request().postDataJSON()?.previewPersonalPie?.entries.some(entry => entry.conditionID === -target.contextID));
    await picker.locator(`[data-context-id="${target.contextID}"]`).getByRole('button', { name: 'Add', exact: true }).click();
    const data = await (await preview).json();
    assert.deepEqual(data.personalPie.referenceIssues, []);
    assert.ok(data.personalPie.effectiveEntries.some(entry => entry.conditionID > 0));
    await page.locator(`[data-reference-id="${target.contextID}"]`).waitFor();
    await page.locator('#weight-pie .fa-layer-group').waitFor();
    await page.locator('#pie-instruction .fa-layer-group').waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `${output}/live-reference-${engine.name()}-${width}.png` });
    await page.locator('#pie-mode-public').click();
    await page.locator('#pie-mode-public[aria-selected="true"]').waitFor({ state: 'attached' });
    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    await page.locator('.th-card').first().waitFor();
    await page.evaluate(() => document.getElementById('topics').scrollIntoView());
    await page.locator('#topics-filters:not([hidden])').waitFor();
    const island = await page.locator('#topics-filters').boundingBox();
    const header = await page.locator('.th-header-inner').boundingBox();
    assert.ok(Math.abs(width > 760 ? island.x - header.x : island.x + island.width / 2 - width / 2) < 1);
    await page.locator('#topic-search-toggle').click();
    await page.locator('#topic-search').fill('Single Reference Image');
    const card = page.locator(`.th-card[data-scene-id="${selectedScene.ID}"]`);
    await card.waitFor();
    assert.equal(new URL(await card.locator('.th-topic-link').getAttribute('href'), origin).searchParams.get('scene'), String(selectedScene.ID));
    await page.screenshot({ path: `${output}/live-search-${engine.name()}-${width}.png` });
    await page.locator('#topic-search').fill('Language');
    const language = page.locator('.th-card[data-topic-id="219"]:not([data-scene-id])');
    await language.waitFor();
    assert.equal(await page.locator('.th-card[data-topic-id="219"][data-scene-id]:visible').count(), 0);
    await language.locator('.th-scene-toggle').click();
    await page.waitForFunction(() => [...document.querySelectorAll('.th-card[data-topic-id="219"][data-scene-id]')]
        .filter(card => card.getClientRects().length).length === 185);
    assert.equal(await page.locator('.th-card[data-topic-id="219"][data-scene-id]:visible').first().getAttribute('data-scene-id'),
        String(topics.find(topic => topic.ID === 219).scenes[0].ID));
    if (!await page.locator('#topic-search').isVisible()) await page.locator('#topic-search-toggle').click();
    await page.locator('#topic-search').fill('English');
    await page.waitForFunction(() => [...document.querySelectorAll('.th-card[data-scene-id]')].some(card => card.getClientRects().length && card.textContent.includes('English')));
    await page.goto(origin + topics.find(topic => topic.ID === 54).url, { waitUntil: 'domcontentloaded' });
    await page.locator('#weight-pie .bp-weight-tile').first().waitFor();
    await page.locator('#last-updated').waitFor({ state: 'hidden' });
    assert.equal(await page.locator('#last-updated').textContent(), '');
    if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
    await page.evaluate(() => document.fonts.ready);
    const countGaps = await page.locator('.bp-benchmark-row .bp-benchmark-identity').evaluateAll(nodes => nodes.flatMap(node => {
        const name = node.querySelector('.bp-benchmark-link-name'), icon = node.querySelector('.bp-evidence-count i');
        if (!name || !icon || !node.querySelector('.bp-benchmark-condition')?.textContent.trim()) return [];
        const range = document.createRange(); range.selectNodeContents(name);
        if (range.getClientRects().length !== 1) return [];
        return [icon.getBoundingClientRect().left - range.getBoundingClientRect().right];
    }));
    if (width > 760) assert.ok(countGaps.length > 0);
    assert.ok(countGaps.every(gap => gap >= -0.1 && gap <= 6.1), JSON.stringify(countGaps));
    await page.locator('#public-fallback-toggle').click();
    const noFallback = page.locator('.bp-fallback-picker-column').filter({ has: page.locator('.bp-fallback-picker-column-title strong', { hasText: /^No fallback$/ }) });
    await noFallback.waitFor();
    assert.equal(await noFallback.locator('.bp-fallback-picker-share strong').textContent(), '0%');
    await page.screenshot({ path: `${output}/live-fallback-${engine.name()}-${width}.png` });
    await page.locator('.bp-fallback-picker-cancel').click();
    await page.evaluate(() => document.fonts.ready);
    const tiles = await page.locator('#weight-pie .bp-weight-tile').evaluateAll(nodes => nodes.map(node => {
        const { width, height } = node.getBBox(); return { width, height };
    }));
    assert.ok(tiles.filter(tile => tile.width > tile.height).length >= Math.ceil(tiles.length / 2));
    if (width > 760) {
        await page.waitForFunction(() => document.body.dataset.configSidebarPhase === 'idle');
        const iconsFit = await page.locator('#config-sidebar-toggle').evaluate(button => {
            const box = button.getBoundingClientRect();
            return [...button.querySelectorAll('i')].every(icon => {
                const bounds = icon.getBoundingClientRect();
                return bounds.left >= box.left + 3 && bounds.right <= box.right - 3;
            });
        });
        assert.equal(iconsFit, true);
    } else await page.locator('#model-index-tab').click();
    await page.locator('#model-rows .bp-model-row').first().waitFor();
    await page.locator('[data-quick-comparison="reasoning"]').click();
    await page.locator('#model-rows .bp-model-parameters').first().waitFor();
    const labels = await page.locator('#model-rows .bp-model-display-name').evaluateAll(nodes => nodes.map(node => ({
        height: node.getBoundingClientRect().height, lineHeight: parseFloat(getComputedStyle(node).lineHeight),
        whiteSpace: getComputedStyle(node).whiteSpace, text: node.textContent.trim(), clipped: node.scrollWidth > node.clientWidth + 1
    })));
    assert.ok(labels.every(label => label.whiteSpace === 'nowrap' && label.height <= label.lineHeight + 1), JSON.stringify(labels));
    const ordinaryNames = labels.filter(label => ['gpt-6-astra', 'Gemini 4 Argon', 'muse-wonder'].includes(label.text));
    assert.ok(ordinaryNames.length > 0 && ordinaryNames.every(label => !label.clipped), JSON.stringify(ordinaryNames));
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await page.screenshot({ path: `${output}/live-config-polish-${engine.name()}-${width}.png` });
});
