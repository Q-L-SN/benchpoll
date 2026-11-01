import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { comparisonDisplayParts } from '../../public/js/shared/comparison-display.js';
import { partitionNavigationDiagnostics } from './browser-diagnostics.mjs';

const origin = process.argv[2] || 'https://127.0.0.1:18442';
const engineOnly = process.argv.find(value => value.startsWith('--engine='))?.slice(9);
const output = resolve(process.env.FLAT_TOPICS_OUTPUT || 'D:/Codex-artifacts/website1/flat-topics-home-20261022/live-browser');
await mkdir(output, { recursive: true });
const report = { origin, checks: [], errors: [], requestFailures: [], passed: false };
async function revealFilters(page) {
    if (await page.locator('#topics-filters').evaluate(node => node.hidden)) {
        await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
    }
    await page.waitForFunction(() => !document.getElementById('topics-filters').hidden);
}

async function checkTreemapLabels(page) {
    const labels = await page.locator('.th-card.is-featured .th-tile-name, .th-card.is-featured .th-tile-version').evaluateAll(nodes => nodes.map(node => {
        const style = getComputedStyle(node);
        return { version: node.classList.contains('th-tile-version'), font: parseFloat(style.fontSize), align: style.textAlign,
            overflow: node.dataset.overflow === 'true', mask: style.maskImage || style.webkitMaskImage,
            width: node.clientWidth, textWidth: node.scrollWidth };
    }));
    assert.ok(labels.length > 0);
    for (const label of labels) {
        assert.equal(label.font, label.version ? 12 : 14);
        assert.equal(label.align, label.overflow ? 'left' : 'center');
        assert.ok(label.overflow ? label.mask.includes('linear-gradient(to right') : label.mask === 'none');
        if (!label.overflow) assert.ok(label.textWidth <= label.width + 1);
    }
    return { count: labels.length, centered: labels.filter(label => !label.overflow).length,
        fading: labels.filter(label => label.overflow).length };
}

for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    if (engineOnly && engineOnly !== name) continue;
    const browser = await engine.launch({ headless: true });
    try {
        for (const width of [1440, 390]) {
            const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true,
                isMobile: width < 761, hasTouch: width < 761 });
            const page = await context.newPage();
            let phase = 'initial home';
            page.setDefaultTimeout(45000);
            page.on('pageerror', async error => {
                const entry = { name, width, phase, receivedAt: Date.now(), message: error.message, stack: error.stack, url: page.url() };
                report.errors.push(entry);
                entry.domEvents = await page.evaluate(() => window.topicJavaScriptErrors).catch(() => null);
            });
            page.on('requestfailed', request => {
                if (/\/api\/get_(?:topic_preview|weighted_workspace)$/.test(request.url())) report.requestFailures.push({ name, width, phase, receivedAt: Date.now(), endpoint: new URL(request.url()).pathname,
                    url: page.url(), body: request.postDataJSON(), failure: request.failure()?.errorText });
            });
            await context.addInitScript(() => {
                window.topicPolicyViolations = [];
                window.topicJavaScriptErrors = [];
                window.addEventListener('error', event => window.topicJavaScriptErrors.push({ type: 'error', message: event.message }));
                window.addEventListener('unhandledrejection', event => window.topicJavaScriptErrors.push({ type: 'unhandledrejection', message: String(event.reason) }));
                document.addEventListener('securitypolicyviolation', event => {
                    // Cloudflare may inject its analytics tag at the edge; it must remain blocked.
                    if (!String(event.blockedURI).includes('cloudflareinsights')) window.topicPolicyViolations.push(event.effectiveDirective);
                });
            });
            const response = await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
            assert.equal(response.status(), 200);
            assert.equal(new URL(page.url()).pathname, '/');
            await page.locator('.th-card[data-topic-id="54"][data-preview-state="loaded"]').waitFor();
            await page.waitForFunction(() => [...document.querySelectorAll('.th-card[data-topic-id="54"] .th-vendor-mark img')]
                .every(image => image.complete && image.naturalWidth > 0));
            await page.evaluate(() => document.fonts.ready);
            await page.waitForTimeout(250);
            const home = await page.evaluate(() => {
                const card = document.querySelector('.th-card[data-topic-id="54"]');
                const scroll = card.querySelector('.th-model-scroll').getBoundingClientRect();
                const leader = card.querySelector('.th-model');
                return { cards: document.querySelectorAll('.th-card').length,
                    firstID: document.querySelector('.th-card').dataset.topicId,
                    overflow: document.documentElement.scrollWidth - innerWidth,
                    active: document.querySelector('[data-score-mode][aria-pressed="true"]').dataset.scoreMode,
                    leaderScore: Number(leader.querySelector('.th-model-score').textContent),
                    leaderBarWidth: leader.querySelector('.th-model-bar').getBoundingClientRect().width,
                    layoutWidth: card.querySelector('.th-visual').clientWidth,
                    labelInset: parseFloat(getComputedStyle(card.querySelector('.th-chart-frame')).getPropertyValue('--th-label-inset')),
                    modelCount: card.querySelectorAll('.th-model').length,
                    leaderHeightRatio: leader.querySelector('.th-model-bar').getBoundingClientRect().height
                        / card.querySelector('.th-treemap').getBoundingClientRect().height,
                    initialColumns: [...card.querySelectorAll('.th-model')].filter(node => Number(getComputedStyle(node).opacity) > 0).map(node => node.getBoundingClientRect())
                        .filter(rect => rect.right > scroll.left + .5 && rect.left < scroll.right - .5)
                        .map(rect => ({ left: rect.left, right: rect.right, full: rect.left >= scroll.left - .7 && rect.right <= scroll.right + .7 })),
                    tiles: card.querySelectorAll('.th-tile').length,
                    policies: window.topicPolicyViolations };
            });
            assert.equal(home.firstID, '54'); assert.ok(home.cards > 1); assert.ok(home.overflow <= 1);
            assert.equal(home.active, 'available'); assert.ok(home.initialColumns.length > 0);
            if (home.leaderScore > 0) assert.ok(Math.abs(home.leaderHeightRatio - .75) < .001, 'Available results leader must be 75% of the treemap');
            assert.ok(home.initialColumns.every(column => column.full)); assert.ok(home.tiles > 0);
            assert.ok(home.leaderBarWidth >= 28 && home.leaderBarWidth <= 36);
            const shares = await page.locator('.th-card.is-featured .th-tile-share').evaluateAll(nodes => nodes.map(node => {
                const style = getComputedStyle(node), box = node.getBoundingClientRect(), tile = node.closest('.th-tile').getBoundingClientRect();
                return { font: parseFloat(style.fontSize), weight: style.fontWeight, color: style.color, opacity: style.opacity,
                    centerError: box.x + box.width / 2 - tile.x - tile.width / 2 };
            }));
            assert.ok(shares.some(share => share.font >= 28));
            assert.ok(shares.every(share => share.weight === '800' && share.color === 'rgb(138, 148, 159)'
                && share.opacity === '0.38' && Math.abs(share.centerError) < 1));
            home.largeCenteredShares = true;
            home.treemapLabels = await checkTreemapLabels(page);
            if (home.modelCount > 10) assert.equal(home.initialColumns.length,
                Math.min(home.modelCount, Math.max(1, Math.floor((home.layoutWidth - 2 * home.labelInset) / 48))), 'missing dense home columns');
            assert.equal(await page.locator('.th-card-footer, .th-pagination-status, .th-eyebrow, .th-intro-actions').count(), 0);
            assert.equal(await page.locator('#home-title').textContent(), 'Trust benchmarks. Question the selection.');
            assert.equal(await page.title(), 'BenchPoll - Trust benchmarks. Question the selection.');
            assert.equal(await page.locator('.th-intro-copy').textContent(), 'Choose what matters. Shape the weights together.');
            assert.equal(await page.locator('.th-card[data-topic-id="54"] .th-card-header .th-pagination').count(), 1);
            assert.equal(await page.locator('.th-card[data-topic-id="54"] .bp-topic-byline-prefix').textContent(), 'by');
            const controls = await page.locator('[data-topics-view]').evaluateAll(nodes => nodes.map(node => {
                const style = getComputedStyle(node);
                return { height: node.getBoundingClientRect().height, padding: style.padding,
                    font: style.font, radius: style.borderRadius };
            }));
            assert.equal(controls.length, 5);
            assert.equal(new Set(controls.map(control => JSON.stringify(control))).size, 1, 'Search must use the same navigation button treatment');
            const dock = await page.evaluate(() => ({
                sticky: getComputedStyle(document.querySelector('.th-directory-dock')).position,
                nav: getComputedStyle(document.querySelector('.th-navigation-shell')).position,
                filters: getComputedStyle(document.querySelector('.th-toolbar')).position
            }));
            assert.deepEqual(dock, { sticky: 'sticky', nav: 'relative', filters: 'relative' });
            assert.equal(await page.locator('#topics-filters').isVisible(), false, 'initial filters must be entirely hidden');
            assert.deepEqual(home.policies, []);
            await page.screenshot({ path: join(output, `${name}-${width}-home.png`) });
            const edge = await page.locator('.th-card.is-featured .th-model-scroll').evaluate(async scroll => {
                const track = scroll.firstElementChild, slot = parseFloat(track.style.getPropertyValue('--th-slot'));
                const inset = parseFloat(getComputedStyle(scroll).getPropertyValue('--th-label-inset'));
                const visible = Math.round((scroll.clientWidth - inset * 2) / slot);
                if (!track.children[visible]) return { scrollable: false };
                scroll.style.scrollSnapType = 'none'; scroll.scrollLeft = slot / 2;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                const result = { scrollable: true, outgoing: Number(getComputedStyle(track.children[0]).opacity),
                    incoming: Number(getComputedStyle(track.children[visible]).opacity),
                    visibility: getComputedStyle(track.children[0]).visibility };
                scroll.scrollLeft = 0;
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                scroll.style.removeProperty('scroll-snap-type'); return result;
            });
            if (edge.scrollable) {
                assert.ok(edge.outgoing > 0 && edge.outgoing < 1); assert.ok(edge.incoming > 0 && edge.incoming < 1);
                assert.equal(edge.visibility, 'visible');
            }
            home.continuousModelEdges = edge;
            await revealFilters(page);
            assert.equal(await page.locator('.th-island-brand').getAttribute('aria-hidden'), 'false');
            await page.waitForFunction(() => {
                const brand = document.querySelector('.th-island-brand');
                const image = brand.querySelector('img');
                return brand.getBoundingClientRect().width >= 31 && Number(getComputedStyle(brand).opacity) >= .99
                    && image.complete && image.naturalWidth > 0;
            });
            const glass = await page.locator('#topics-filters').evaluate(node => {
                const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
                return { x: rect.x, y: rect.y, width: rect.width, radius: style.borderRadius, shadow: style.boxShadow,
                    blur: style.backdropFilter || style.webkitBackdropFilter,
                    separated: document.querySelector('.th-island').getBoundingClientRect().top >= rect.bottom };
            });
            assert.deepEqual({ ...glass, blur: undefined }, { x: 0, y: 0, width, radius: '0px', shadow: 'none', blur: undefined, separated: true });
            assert.ok(glass.blur.includes('blur(20px)'));
            await page.screenshot({ path: join(output, `${name}-${width}-home-scrolled.png`) });
            await page.evaluate(() => scrollTo(0, 0));
            await page.waitForFunction(() => document.getElementById('topics-filters').hidden);
            await page.locator('#topic-search-toggle').click();
            await page.locator('#topic-search').fill('Intelligence');
            const matches = await page.locator('.th-card:not([hidden])').evaluateAll(cards => cards.map(card => ({
                ID: card.dataset.topicId, text: ['.th-topic-name', '.th-topic-summary', '.bp-topic-byline-name']
                    .map(selector => card.querySelector(selector)?.textContent ?? '').join(' ')
            })));
            assert.ok(matches.some(card => card.ID === '54'));
            assert.ok(matches.every(card => /intelligence/i.test(card.text)), 'Topic summaries are searchable too');
            await page.locator('#topic-search').press('Escape');
            phase = 'fixed appearance';
            assert.equal(await page.locator('#treemap-theme-picker,#card-style-picker').count(), 0);
            assert.equal(await page.locator('body').getAttribute('data-weight-theme'), 'frost-hatch');
            assert.equal(await page.locator('body').getAttribute('data-card-style'), 'outline');
            const chart = await page.locator('.th-card.is-featured .th-treemap').evaluate(node => ({
                texture: node.dataset.texture, hatch: getComputedStyle(node.firstElementChild, '::before').backgroundImage,
                firstColor: getComputedStyle(node.firstElementChild).backgroundColor,
                smallSymbols: [...node.querySelectorAll('.th-tile-share')].every(number =>
                    parseFloat(getComputedStyle(number.querySelector('.th-tile-share-symbol')).fontSize) === parseFloat(getComputedStyle(number).fontSize) / 2)
            }));
            assert.equal(chart.texture, 'hatch'); assert.ok(chart.hatch.includes('repeating-linear-gradient'));
            assert.equal(chart.firstColor, 'rgb(228, 234, 241)'); assert.equal(chart.smallSymbols, true);
            home.fixedAppearance = chart;
            await revealFilters(page);
            phase = 'weight view';
            await page.locator('[data-home-view="weights"]').click();
            home.weightViewLabels = await checkTreemapLabels(page);
            await page.screenshot({ path: join(output, `${name}-${width}-weights.png`) });
            await page.locator('[data-home-view="default"]').click();
            phase = 'effort/harness toggle';
            const splitResponse = page.waitForResponse(response => {
                if (!response.url().endsWith('/api/get_topic_preview')) return false;
                const body = response.request().postDataJSON();
                return body.categoryID === 54 && body.reasoning && body.harness && !body.snapshotID;
            });
            await page.locator('[data-comparison="reasoning"]').click();
            await page.locator('[data-comparison="harness"]').click();
            const split = await (await splitResponse).json();
            assert.ok(split.models.length > 0);
            assert.ok(split.models.every(model => typeof model.modelName === 'string' && model.modelName.length > 0));
            await page.locator('.th-card[data-topic-id="54"] .bp-model-display-parameter').first().waitFor();
            const labels = await page.locator('.th-card[data-topic-id="54"] .th-model').evaluateAll(nodes => nodes.filter(node => Number(getComputedStyle(node).opacity) > 0).map(node => {
                const label = node.querySelector('.th-model-name'), box = label.getBoundingClientRect();
                const frame = node.closest('.th-chart-frame').getBoundingClientRect(), parent = label.parentElement.getBoundingClientRect();
                const style = getComputedStyle(label), matrix = new DOMMatrix(style.transform), bar = node.querySelector('.th-model-bar').getBoundingClientRect();
                return { key: node.dataset.modelKey, base: node.querySelector('.bp-model-display-name').textContent,
                    transform: getComputedStyle(label).transform,
                    anchorError: parent.x + parseFloat(style.left) + label.offsetWidth * matrix.a + label.offsetHeight / 2 * matrix.c - bar.x - bar.width / 2,
                    wordsUnbroken: [...label.querySelectorAll('.th-label-word')].every(word => getComputedStyle(word).whiteSpace === 'nowrap'),
                    bounded: box.left >= frame.left - 1 && box.right <= frame.right + 1
                        && box.bottom <= frame.bottom + 1,
                    parameters: [...node.querySelectorAll('.bp-model-display-parameter')].map(part => ({
                        icon: part.querySelector('i')?.className, text: part.querySelector('span').textContent,
                        font: getComputedStyle(part.querySelector('span')).fontSize })) };
            }));
            for (const label of labels) {
                const model = split.models.find(row => row.comparisonIdentity === label.key);
                assert.ok(model); assert.equal(label.base, model.modelName);
                assert.ok(label.bounded); assert.notEqual(label.transform, 'none');
                assert.ok(Math.abs(label.anchorError) < 1); assert.equal(label.wordsUnbroken, true);
                const expected = comparisonDisplayParts(model, split.comparison).filter(part => part.kind === 'parameter');
                assert.deepEqual(label.parameters.map(part => part.text), expected.map(part => part.text));
                label.parameters.forEach((part, index) => { assert.ok(part.icon.includes(expected[index].icon)); assert.equal(part.font, '11px'); });
            }
            home.groupedCanonicalNames = true; home.angledLabelsBounded = true;
            await page.screenshot({ path: join(output, `${name}-${width}-parameters.png`) });
            const model = page.locator('.th-card[data-topic-id="54"] .th-model').first();
            const targetURL = new URL(await model.getAttribute('href'), origin);
            const targetModel = targetURL.searchParams.get('focusModel');
            assert.ok(targetModel);
            phase = 'open model';
            await model.click();
            await page.waitForURL(url => url.pathname === targetURL.pathname);
            await page.waitForFunction(() => document.getElementById('benchmark-card')?.getAttribute('aria-busy') === 'false');
            await page.waitForFunction(target => [...document.querySelectorAll('#model-rows [data-model-focus-id]')]
                .some(row => (row.dataset.comparisonIdentity === target || row.dataset.modelFocusId === target)
                    && row.classList.contains('is-model-jump-focus')), targetModel);
            await page.waitForTimeout(2100);
            const settledHighlight = await page.evaluate(target => {
                const row = [...document.querySelectorAll('#model-rows [data-model-focus-id]')]
                    .find(row => row.dataset.comparisonIdentity === target || row.dataset.modelFocusId === target);
                return row && { animated: row.classList.contains('is-model-jump-focus'), outline: getComputedStyle(row).outlineStyle };
            }, targetModel);
            assert.deepEqual(settledHighlight, { animated: false, outline: 'none' }, 'Automatic model focus must not leave a second outline');
            assert.equal(new URL(page.url()).searchParams.has('focusModel'), false);
            assert.equal(await page.locator('#showcase, #public-composition-toggle').count(), 0);
            const navModes = await page.locator('[data-navigation-view]').count(); assert.equal(navModes, 5);
            if (width > 760) {
                const beforeWidth = (await page.locator('.bp-workspace').boundingBox()).width;
                await page.locator('#config-sidebar-toggle').click();
                await page.waitForFunction(() => document.body.classList.contains('config-sidebar-collapsed')
                    && document.body.dataset.configSidebarPhase === 'idle');
                const box = await page.locator('.bp-workspace').boundingBox();
                assert.ok(Math.abs(box.width - beforeWidth) < 1);
                assert.ok(Math.abs(box.x + box.width / 2 - width / 2) < 1);
            }
            await page.screenshot({ path: join(output, `${name}-${width}-workspace.png`) });
            await page.locator('#discussion-entry').click();
            await page.waitForFunction(() => document.body.classList.contains('discussion-open'));
            await page.waitForTimeout(700);
            assert.ok(!/topics\s*\/\s*54/.test(await page.locator('#category-path').innerText()), 'Discussion needs a topic label, not a canonical URL');
            await page.screenshot({ path: join(output, `${name}-${width}-discussion.png`) });
            await page.locator('#discussion-close').click();
            const back = page.getByRole('link', { name: 'Back to topics', exact: true });
            assert.equal(await back.getAttribute('href'), '/');
            assert.equal(await back.isVisible(), true);
            const workspaceURL = page.url();
            phase = 'guide navigation';
            await page.goto(origin + '/how-it-works');
            assert.equal(await page.getByRole('link', { name: 'Back to topics', exact: true }).count(), 0);
            await page.goto(workspaceURL);
            phase = 'back to topics';
            await page.locator('#back-to-topics').click();
            await page.waitForURL(url => url.pathname === '/');
            await page.locator('#topics-grid').waitFor();
            home.configurationBackToTopics = true; home.guideHasNoBackToTopics = true;
            await page.waitForFunction(() => document.querySelector('.th-card.is-featured')?.dataset.previewState === 'loaded');
            assert.deepEqual(await page.evaluate(() => window.topicPolicyViolations), []);
            report.checks.push({ name, width, home });
            phase = 'context cleanup';
            await context.close();
        }
    } finally { await browser.close(); }
}
const classified = partitionNavigationDiagnostics(report.errors, report.requestFailures);
report.errors = classified.errors;
report.browserDiagnostics = classified.diagnostics;
report.passed = report.errors.length === 0;
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2));
assert.deepEqual(report.errors, []);
console.log(JSON.stringify({ passed: true, cases: report.checks.length, output }));
