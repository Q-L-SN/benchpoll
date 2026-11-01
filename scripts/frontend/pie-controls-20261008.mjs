import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const liveURL = process.env.PIE_CONTROLS_URL;
const output = `artifacts/pie-controls-20261008/browser${liveURL ? '-live' : ''}`;
await mkdir(output, { recursive: true });
const results = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const near = (a, b, label) => assert.ok(Math.abs(a - b) < 1.1, `${label}: ${a} vs ${b}`);
async function ready(page) {
    await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
    await page.evaluate(() => document.fonts.ready);
}
async function questionIcons(page) {
    const icons = await page.locator('.fa-circle-question').evaluateAll(nodes => nodes.filter(node => node.getClientRects().length).map(node => {
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        return { fontSize: style.fontSize, width: rect.width, height: rect.height,
            regular: node.classList.contains('fa-regular'), glyph: getComputedStyle(node, '::before').content };
    }));
    assert.ok(icons.length > 0);
    for (const icon of icons) {
        assert.equal(icon.fontSize, '14px'); assert.equal(icon.regular, true);
        near(icon.width, 14, 'Question icon width'); near(icon.height, 14, 'Question icon height');
    }
    assert.equal(new Set(icons.map(icon => icon.glyph)).size, 1);
    return icons.length;
}
async function guidance(page) {
    const geometry = await page.locator('#personal-pie-guidance').evaluate(node => {
        const frame = node.getBoundingClientRect(); const style = getComputedStyle(node);
        const cells = [...node.querySelectorAll('p')].map(cell => {
            const rect = cell.getBoundingClientRect(); const style = getComputedStyle(cell);
            return { x: rect.x, right: rect.right, y: rect.y, width: rect.width,
                text: cell.textContent, align: style.textAlign, overflow: cell.scrollWidth > cell.clientWidth + 1 };
        });
        return { x: frame.x, right: frame.right, display: style.display, cells, icons: node.querySelectorAll('i').length };
    });
    assert.equal(geometry.display, 'grid'); assert.equal(geometry.icons, 0); assert.equal(geometry.cells.length, 2);
    const [left, right] = geometry.cells;
    near(left.y, right.y, 'Personal guidance shares a row');
    near(left.x, geometry.x + 16, 'Instruction left edge');
    near(right.right, geometry.right - 16, 'Count right edge');
    assert.ok(left.right < right.x); assert.equal(right.align, 'right');
    assert.ok(geometry.cells.every(cell => cell.text.length && !cell.overflow && cell.width > 0));
    return geometry;
}
async function footer(page) {
    const geometry = await page.locator('.bp-inline-fallback-frame').evaluate(frame => {
        const rect = frame.getBoundingClientRect(); const row = frame.querySelector('.bp-fallback-add-actions');
        const bounds = row.getBoundingClientRect(); const style = getComputedStyle(row);
        return { left: rect.left, right: rect.right, bottom: rect.bottom, row: { left: bounds.left, right: bounds.right,
            bottom: bounds.bottom, gap: style.gap, padding: style.padding },
        cells: [...row.querySelectorAll('button')].map(button => {
            const bounds = button.getBoundingClientRect(); const style = getComputedStyle(button);
            return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom,
                width: bounds.width, height: bounds.height, radius: style.borderRadius,
                borders: [style.borderTopWidth, style.borderRightWidth, style.borderBottomWidth, style.borderLeftWidth],
                overflow: button.scrollWidth > button.clientWidth + 1, disabled: button.disabled };
        }) };
    });
    const [left, right] = geometry.cells;
    assert.equal(geometry.cells.length, 2); assert.equal(geometry.row.gap, '0px'); assert.equal(geometry.row.padding, '0px');
    near(left.left, geometry.left + 1, 'Footer touches inner left frame');
    near(right.right, geometry.right - 1, 'Footer touches inner right frame');
    near(left.right, right.left, 'Footer shared vertical seam'); near(left.width, right.width, 'Equal footer columns');
    near(left.bottom, geometry.bottom - 1, 'Footer touches inner bottom'); near(right.bottom, left.bottom, 'Equal footer bottom');
    near(left.top, right.top, 'Equal footer top');
    assert.deepEqual(left.borders, ['0px', '0px', '0px', '0px']);
    assert.deepEqual(right.borders, ['0px', '0px', '0px', '1px']);
    assert.ok(geometry.cells.every(cell => cell.radius === '0px' && cell.height >= 44 && !cell.overflow));
    return geometry;
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 1024, 390, 320]], ['webkit', webkit, [1440, 390, 320]]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            if (process.env.UI_TEST_WIDTH && !process.env.UI_TEST_WIDTH.split(',').map(Number).includes(width)) continue;
            const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true });
            const context = await browser.newContext({ viewport: { width, height: 960 },
                isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
            const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            try {
                if (liveURL) await page.route('**/api/**', async route => {
                    const url = new URL(route.request().url());
                    await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
                });
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); await ready(page);
                const beta = page.locator('#beta-feedback-link');
                if (width < 760) {
                    assert.equal(await beta.isVisible(), false);
                    assert.equal(await page.locator('#how-it-works-link').isVisible(), false);
                    await page.screenshot({ path: `${output}/${engine}-header-${width}.png` });
                    await page.locator('#taxonomy-toggle').click();
                    await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
                    const drawerBrand = await page.locator('.bp-sidebar > .bp-brand').boundingBox();
                    const drawerGuide = await page.locator('#how-it-works-link').boundingBox();
                    const drawerBeta = await beta.boundingBox();
                    assert.ok(drawerGuide.y >= drawerBrand.y + drawerBrand.height);
                    assert.ok(drawerBeta.y >= drawerGuide.y + drawerGuide.height);
                    near(drawerBeta.x, drawerBrand.x, 'Expanded drawer Beta left alignment');
                    await questionIcons(page);
                    await page.locator('#taxonomy-close').click();
                    await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
                    await page.locator('[data-mobile-panel="models"]').click();
                }
                const publicQuestions = await questionIcons(page);
                if (width < 760) await page.locator('[data-mobile-panel="mix"]').click();
                await page.locator('#pie-mode-personal').click(); await ready(page);
                await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
                await page.locator('#personal-pie-guidance').waitFor();
                const normalGuidance = await guidance(page);
                assert.match(normalGuidance.cells[1].text, /Scores from 6 models/);
                await page.locator('#personal-pie-guidance').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
                await page.screenshot({ path: `${output}/${engine}-personal-${width}.png` });
                await page.locator('#inline-fallback-toggle').click();
                await page.locator('#inline-fallback-settings').waitFor();
                await page.locator('#inline-fallback-chart.is-empty').waitFor();
                await page.locator('.bp-inline-fallback-frame').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
                await footer(page);
                const fallbackQuestions = await questionIcons(page);
                await page.locator('.bp-inline-fallback-frame').screenshot({ path: `${output}/${engine}-fallback-empty-${width}.png` });
                const add = page.locator('#inline-fallback-add-benchmark');
                await page.keyboard.press('Tab'); await add.focus();
                const focused = await add.evaluate(node => { const s = getComputedStyle(node); return [s.outlineWidth, s.outlineOffset]; });
                assert.deepEqual(focused, ['2px', '-3px']);
                await add.press('Enter');
                await ordinary(page, 2).locator('.bp-benchmark-add').click();
                await page.locator('#inline-fallback-chart .bp-family-member').waitFor();
                await footer(page);
                const other = page.locator('#inline-fallback-add-other-versions');
                await other.click();
                await page.waitForFunction(() => document.getElementById('inline-fallback-add-other-versions').disabled);
                const populated = await footer(page); assert.equal(populated.cells[1].disabled, true);
                await other.hover();
                assert.equal(await other.evaluate(node => getComputedStyle(node).backgroundColor), 'rgb(233, 245, 246)');
                await page.locator('.bp-inline-fallback-frame').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
                await page.locator('.bp-inline-fallback-frame').screenshot({ path: `${output}/${engine}-fallback-populated-${width}.png` });

                const original = await page.locator('#personal-pie-guidance p').allTextContents();
                await page.evaluate(() => {
                    document.getElementById('pie-instruction').textContent = 'Swipe to adjust An exceptionally long benchmark name with its full testing condition.';
                    document.getElementById('pie-context-note').textContent = 'Scores from 123,456 models.';
                });
                await guidance(page);
                await page.locator('#personal-pie-guidance').screenshot({ path: `${output}/${engine}-guidance-long-${width}.png` });
                await page.evaluate(texts => {
                    document.getElementById('pie-instruction').textContent = texts[0];
                    document.getElementById('pie-context-note').textContent = texts[1];
                }, original);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true);
                await page.setViewportSize({ width: width < 760 ? 760 : 390, height: 960 });
                await guidance(page);
                await page.setViewportSize({ width, height: 960 });

                await beta.focus(); await beta.press('Enter');
                await page.waitForURL(url => url.pathname === '/contribute/feedback');
                await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('BenchPoll Beta feedback')));
                if (width < 760) await page.locator('#contribution-taxonomy-toggle').click();
                const contributionQuestions = await questionIcons(page);
                await page.locator('#contribution-help').click(); await page.locator('#contribution-guide-dialog').waitFor();
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true, publicQuestions, fallbackQuestions, contributionQuestions });
                console.log(`PASS ${engine} ${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}/${engine}-${width}-failure.png`, fullPage: true });
                results.push({ engine, width, passed: false, error: error.stack, errors });
                console.error(`FAIL ${engine} ${width}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
