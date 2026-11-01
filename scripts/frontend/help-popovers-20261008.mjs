import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const liveURL = process.env.HELP_POPOVERS_URL;
const output = `artifacts/help-popovers-20261008/browser${liveURL ? '-live' : ''}`;
await mkdir(output, { recursive: true });
const results = [];
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
const panel = page => page.locator('#bp-help-popover');
async function ready(page) {
    await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
    await page.evaluate(() => document.fonts.ready);
}
async function openHelp(page, trigger, mobile) {
    await trigger.evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
    if (mobile) await trigger.tap();
    else { await page.mouse.move(1, 1); await trigger.hover(); }
    await panel(page).waitFor();
    await page.waitForFunction(() => !document.getElementById('bp-help-popover').getAnimations().some(animation => animation.playState === 'running'));
    assert.equal(await trigger.getAttribute('title'), null);
    const size = await trigger.locator('.fa-circle-question').evaluate(node => {
        const style = getComputedStyle(node); const rect = node.getBoundingClientRect();
        return [style.fontSize, rect.width, rect.height];
    });
    assert.equal(size[0], '14px'); assert.ok(size.slice(1).every(value => Math.abs(value - 14) < .1));
    const layer = await panel(page).evaluate(node => {
        const rect = node.getBoundingClientRect(); const style = getComputedStyle(node);
        const view = window.visualViewport;
        return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom,
            viewport: { x: view?.offsetLeft ?? 0, y: view?.offsetTop ?? 0,
                width: view?.width ?? innerWidth, height: view?.height ?? innerHeight },
            font: style.fontSize, padding: style.padding, radius: style.borderRadius,
            overflow: style.overflowY, text: node.textContent, native: node.hasAttribute('popover') };
    });
    assert.ok(layer.text.trim().length > 10);
    assert.ok(layer.x >= layer.viewport.x + 11 && layer.y >= layer.viewport.y + 11);
    assert.ok(layer.right <= layer.viewport.x + layer.viewport.width - 11);
    assert.ok(layer.bottom <= layer.viewport.y + layer.viewport.height - 11);
    assert.equal(layer.font, '12px'); assert.equal(layer.padding, '14px 16px'); assert.equal(layer.radius, '6px');
    assert.equal(layer.overflow, 'auto');
    return layer;
}
async function dismiss(page, trigger, mobile) {
    if (mobile) await trigger.tap(); else await page.keyboard.press('Escape');
    await panel(page).waitFor({ state: 'hidden' });
}
async function iconsHaveSharedHelp(page) {
    const missing = await page.locator('.fa-circle-question').evaluateAll(nodes => nodes
        .filter(node => !node.closest('[data-help-text], [data-help-content]'))
        .map(node => node.outerHTML));
    assert.deepEqual(missing, []);
}
async function searchFrame(page) {
    const input = page.locator('#benchmark-search');
    await page.keyboard.press('Tab');
    await input.focus();
    const style = await input.evaluate(node => {
        const input = getComputedStyle(node), frame = getComputedStyle(node.closest('label'));
        return { inputShadow: input.boxShadow, inputOutline: input.outlineStyle,
            inputBorders: [input.borderTopWidth, input.borderRightWidth, input.borderBottomWidth, input.borderLeftWidth],
            frameShadow: frame.boxShadow, frameOutline: frame.outlineStyle, frameBorder: frame.borderTopWidth,
            frameColor: frame.borderTopColor, focusVisible: node.matches(':focus-visible'),
            accent: getComputedStyle(document.body).getPropertyValue('--bp-accent').trim() };
    });
    assert.equal(style.inputShadow, 'none'); assert.equal(style.inputOutline, 'none', JSON.stringify(style));
    assert.ok(style.inputBorders.every(border => border === '0px'));
    assert.equal(style.frameShadow, 'none'); assert.equal(style.frameOutline, 'none'); assert.equal(style.frameBorder, '1px');
    assert.equal(style.focusVisible, true);
    const accent = await input.evaluate(() => {
        const probe = document.createElement('span'); probe.style.color = 'var(--bp-accent)'; document.body.append(probe);
        const color = getComputedStyle(probe).color; probe.remove(); return color;
    });
    assert.equal(style.frameColor, accent, 'Keyboard focus changes only the existing search frame');
    return style;
}

const cases = [['chromium', chromium, 1440, false], ['chromium', chromium, 1024, false],
    ['chromium', chromium, 390, false], ['chromium', chromium, 320, false],
    ['webkit', webkit, 1440, false], ['webkit', webkit, 390, false], ['webkit', webkit, 320, false],
    ['chromium', chromium, 390, true], ['webkit', webkit, 320, true]];
for (const [engine, launcher, width, fallback] of cases) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && !process.env.UI_TEST_WIDTH.split(',').map(Number).includes(width)) continue;
    const name = `${engine}-${width}-${fallback ? 'fallback' : 'native'}`;
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true });
    const mobile = width < 760;
    const context = await browser.newContext({ viewport: { width, height: 900 },
        isMobile: mobile, hasTouch: mobile, reducedMotion: fallback ? 'reduce' : 'no-preference' });
    if (fallback) await context.addInitScript(() => {
        window.HTMLElement.prototype.showPopover = undefined;
        window.HTMLElement.prototype.hidePopover = undefined;
    });
    const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        await context.route('**/api/**', async route => {
            const url = new URL(route.request().url());
            const response = await route.fetch({ url: app.url + url.pathname + url.search });
            if (url.pathname === '/api/get_approved_benchmark_results') {
                const data = await response.json(); const group = data.scoreGroups[0];
                group.samples.push({ ...group.samples[0], ID: 99001, excludedAsDuplicate: true });
                group.sampleCount++;
                await route.fulfill({ response, json: data });
            } else await route.fulfill({ response });
        });
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); await ready(page);
        await iconsHaveSharedHelp(page);
        const publicHelp = page.locator('.bp-public-pie-info');
        const publicLayer = await openHelp(page, publicHelp, mobile);
        assert.match(publicLayer.text, /72 hours/); assert.match(publicLayer.text, /14 days/);
        assert.equal(publicLayer.native, !fallback);
        await page.screenshot({ path: `${output}/${name}-public.png` });
        await dismiss(page, publicHelp, mobile);
        if (!mobile) {
            await page.mouse.move(1, 1);
            await publicHelp.hover(); await panel(page).waitFor();
            await page.mouse.move(1, 1); await panel(page).waitFor({ state: 'hidden' });
            await publicHelp.click(); await panel(page).waitFor();
            await page.mouse.move(1, 1); assert.equal(await panel(page).isVisible(), true);
            await publicHelp.click(); await panel(page).waitFor({ state: 'hidden' });
        }
        const search = await searchFrame(page);
        await page.locator('.bp-benchmark-search').screenshot({ path: `${output}/${name}-search.png` });

        if (mobile) await page.locator('[data-mobile-panel="models"]').click();
        const quick = page.locator('#quick-comparison-help');
        const quickLayer = await openHelp(page, quick, mobile);
        assert.match(quickLayer.text, /use their best result on each test/);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1), false, 'Help controls must not widen the page');
        await page.screenshot({ path: `${output}/${name}-comparison.png` });
        if (mobile) {
            await page.touchscreen.tap(2, 898);
            await panel(page).waitFor({ state: 'hidden' });
            if (!await page.locator('#model-scores-dialog').isVisible()) await page.locator('.bp-model-row').first().tap();
        } else {
            await dismiss(page, quick, false);
            await quick.focus(); await panel(page).waitFor();
            await page.keyboard.press('Escape'); await panel(page).waitFor({ state: 'hidden' });
            await page.locator('.bp-model-row').first().click();
        }
        const dialog = page.locator('#model-scores-dialog'); await dialog.waitFor();
        await dialog.locator('.bp-model-evidence-tabs button').filter({ hasText: 'All scores' }).click();
        const duplicate = dialog.locator('.bp-model-score-source-cell > .bp-help-trigger').first();
        const duplicateLayer = await openHelp(page, duplicate, mobile);
        assert.match(duplicateLayer.text, /median/);
        assert.equal(await duplicate.evaluate(node => Boolean(node.closest('a'))), false);
        const hit = await panel(page).evaluate(node => {
            const rect = node.getBoundingClientRect();
            return node.contains(document.elementFromPoint(rect.x + 12, rect.y + 12));
        });
        assert.equal(hit, true, 'Help is above the score dialog, not behind it');
        await page.screenshot({ path: `${output}/${name}-score-detail.png` });
        await dismiss(page, duplicate, mobile);
        assert.equal(await dialog.isVisible(), true, 'Dismissing help must not close the score dialog');
        await openHelp(page, duplicate, mobile);
        await dialog.locator('#model-scores-list').evaluate(node => { node.scrollTop = node.scrollHeight; });
        await panel(page).waitFor({ state: 'hidden' });
        await dialog.locator('.dialog-close-button').click();
        if (mobile) await page.locator('[data-mobile-panel="mix"]').click();
        await page.locator('#pie-mode-personal').click(); await ready(page);
        await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
        await page.locator('#inline-fallback-toggle').click();
        await page.locator('#inline-fallback-settings').waitFor();
        const fallbackHelp = page.locator('.bp-inline-fallback-info');
        const fallbackLayer = await openHelp(page, fallbackHelp, mobile);
        assert.match(fallbackLayer.text, /first available/);
        await dismiss(page, fallbackHelp, mobile);
        const labels = await page.locator('.bp-fallback-add-actions button > span').evaluateAll(nodes => nodes.map(node => {
            const range = document.createRange(); range.selectNodeContents(node);
            const rects = [...range.getClientRects()]; const button = node.parentElement;
            return { text: node.textContent, lines: rects.length, overflow: button.scrollWidth > button.clientWidth + 1 };
        }));
        assert.deepEqual(labels.map(label => label.text), ['Add benchmark', 'Other versions']);
        assert.ok(labels.every(label => label.lines === 1 && !label.overflow));
        await page.locator('.bp-inline-fallback-frame').evaluate(node => node.scrollIntoView({ block: 'center', behavior: 'instant' }));
        await page.locator('.bp-inline-fallback-frame').screenshot({ path: `${output}/${name}-fallback-footer.png` });
        const add = page.locator('#inline-fallback-add-benchmark');
        await add.click();
        assert.equal(await add.locator('span').textContent(), 'Add benchmark');
        await ordinary(page, 2).locator('.bp-benchmark-add').click();
        await page.locator('#inline-fallback-chart .bp-family-member').waitFor();
        const other = page.locator('#inline-fallback-add-other-versions');
        await other.click();
        assert.equal(await other.isDisabled(), true);
        assert.equal(await other.locator('span').textContent(), 'Other versions');
        await iconsHaveSharedHelp(page);

        await page.evaluate(() => {
            const trigger = document.createElement('button'); trigger.id = 'help-edge-test';
            trigger.className = 'bp-help-trigger'; trigger.type = 'button';
            trigger.dataset.helpText = 'A deliberately long explanation tests the viewport and scrolling behavior. '.repeat(120);
            trigger.style.cssText = 'position:fixed;right:14px;bottom:14px;z-index:20000';
            trigger.innerHTML = '<i class="fa-regular fa-circle-question" aria-hidden="true"></i>';
            document.body.append(trigger);
        });
        await page.setViewportSize({ width, height: 380 });
        const edge = page.locator('#help-edge-test');
        await openHelp(page, edge, mobile);
        const long = await panel(page).evaluate(node => ({ height: node.clientHeight, scroll: node.scrollHeight }));
        assert.ok(long.scroll > long.height + 40, 'Long help scrolls within the viewport');
        const endScroll = await panel(page).evaluate(node => {
            node.scrollTop = node.scrollHeight - node.clientHeight - 16;
            return node.scrollTop;
        });
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        assert.ok(Math.abs(await panel(page).evaluate(node => node.scrollTop) - endScroll) < 2, 'Positioning must not reset help scrolling');
        if (!mobile) {
            await panel(page).evaluate(node => { node.scrollTop = 0; });
            await edge.focus(); await edge.press('PageDown');
            assert.ok(await panel(page).evaluate(node => node.scrollTop > 0));
        }
        await page.setViewportSize({ width: Math.max(320, width - 20), height: 450 });
        await page.waitForFunction(() => {
            const rect = document.getElementById('bp-help-popover').getBoundingClientRect();
            return rect.right <= window.innerWidth - 11 && rect.bottom <= window.innerHeight - 11;
        });
        await edge.evaluate(node => node.remove());
        await panel(page).waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#bp-help-popover').count(), 1);
        await page.setViewportSize({ width, height: 900 });
        if (width === 1440 || width === 320) {
            const formPage = await context.newPage(); formPage.setDefaultTimeout(liveURL ? 60000 : 15000);
            formPage.on('pageerror', error => errors.push(error.message));
            await formPage.goto((liveURL ? new URL('/contribute', liveURL).href : app.url + '/contribute'), { waitUntil: 'domcontentloaded' });
            const guide = formPage.locator('#contribution-help');
            await formPage.waitForFunction(() => !document.getElementById('contribution-help').disabled);
            await iconsHaveSharedHelp(formPage);
            if (!mobile) {
                await guide.hover(); await panel(formPage).waitFor();
                assert.match(await panel(formPage).textContent(), /which source to include/);
                await guide.click(); await panel(formPage).waitFor({ state: 'hidden' });
            } else { await formPage.locator('#contribution-taxonomy-toggle').click(); await guide.tap(); }
            assert.ok(await formPage.locator('#contribution-guide-dialog').isVisible());
            await formPage.screenshot({ path: `${output}/${name}-contribution-guide.png` });
        }
        assert.deepEqual(errors, []);
        results.push({ name, passed: true, publicLayer, quickLayer, duplicateLayer, fallbackLayer, labels, search });
        console.log(JSON.stringify({ name, passed: true }));
    } catch (error) {
        await page.screenshot({ path: `${output}/${name}-FAILED.png`, fullPage: true }).catch(() => {});
        results.push({ name, passed: false, error: String(error), pageErrors: errors }); throw error;
    } finally {
        await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
        await context.close(); await app.close(); await browser.close();
    }
}
