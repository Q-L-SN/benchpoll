import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { weightedEntries } from '../scripts/frontend/fixtures.mjs';

const output = resolve(process.env.EVIDENCE_COUNT_OUTPUT ?? 'D:/Codex-artifacts/website1/evidence-count-fallback-20261031');
const launch = { headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' } };

async function workspacePage(browser, app, width, zero = false) {
    const page = await browser.newPage({ viewport: { width, height: 1000 }, hasTouch: width <= 760, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    await page.addInitScript(() => sessionStorage.setItem('benchpoll-workspace-preferences-v1',
        JSON.stringify({ mode: 'personal', personalFallbackExpanded: true })));
    if (zero) await page.route('**/api/get_weighted_workspace', async route => {
        const response = await route.fetch(), payload = await response.json();
        for (const entries of [payload.benchmarks, payload.personalPie.entries]) {
            for (const entry of entries) if (Number(entry.conditionID) === 1) {
                entry.scoreCount = 0;
                entry.scoredModelCount = 0;
            }
        }
        await route.fulfill({ response, json: payload });
    });
    return page;
}

async function waitForTooltip(page, description) {
    await page.waitForFunction(text => {
        const panel = document.querySelector('#bp-help-popover');
        return panel && !panel.hidden && panel.textContent === text;
    }, description);
}

async function assertCount(page, target, count, description, touch) {
    assert.equal((await target.textContent()).trim(), String(count));
    assert.equal(await target.getAttribute('data-tooltip'), description);
    assert.equal(await target.getAttribute('aria-label'), description);
    assert.equal(await target.getAttribute('role'), 'img');
    assert.equal(await target.getAttribute('tabindex'), '0');
    assert.match(await target.ariaSnapshot(), new RegExp(description.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.equal(await target.locator('i.fa-chart-simple[aria-hidden="true"]').count(), 1);
    await target.scrollIntoViewIfNeeded();
    const metrics = await target.evaluate(node => {
        const bounds = node.getBoundingClientRect(), style = getComputedStyle(node);
        const icon = node.querySelector('i');
        return { width: bounds.width, height: bounds.height, fontSize: style.fontSize,
            display: style.display, icon: getComputedStyle(icon, '::before').content,
            iconFont: getComputedStyle(icon).fontFamily, overflow: node.scrollWidth > node.clientWidth + 1 };
    });
    assert.equal(metrics.fontSize, '11px');
    assert.match(metrics.display, /^(inline-)?flex$/);
    assert.ok(metrics.width >= (touch ? 44 : 24) && metrics.height >= (touch ? 44 : 24), JSON.stringify(metrics));
    assert.notEqual(metrics.icon, 'none');
    assert.match(metrics.iconFont, /Font Awesome/);
    assert.equal(metrics.overflow, false);
    const panel = page.locator('#bp-help-popover');
    await target.hover();
    await waitForTooltip(page, description);
    assert.equal(await panel.textContent(), description);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    await target.focus();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Shift+Tab');
    await waitForTooltip(page, description);
    assert.equal(await target.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true);
    assert.equal(await target.evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    assert.equal(await panel.textContent(), description);
    assert.match(await target.getAttribute('aria-describedby'), /bp-help-popover/);
    await page.keyboard.press('Escape');
    await panel.waitFor({ state: 'hidden' });
    assert.equal(await target.getAttribute('aria-describedby'), null);
}

async function longPress(page, target, description) {
    await target.scrollIntoViewIfNeeded();
    await page.mouse.move(1, 1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement.blur());
    const box = await target.boundingBox(), point = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    const client = await page.context().newCDPSession(page);
    const send = (type, position = point) => client.send('Input.dispatchTouchEvent', {
        type, touchPoints: type === 'touchEnd' ? [] : [position]
    });
    const panel = page.locator('#bp-help-popover');
    try {
        await send('touchStart');
        await waitForTooltip(page, description);
        await send('touchEnd');
        assert.equal(await panel.textContent(), description);
        const bounds = await panel.boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= page.viewportSize().width, JSON.stringify(bounds));
        await page.keyboard.press('Escape');
        await send('touchStart');
        await send('touchMove', { x: point.x, y: point.y - 35 });
        await page.waitForTimeout(600);
        await send('touchEnd');
        assert.equal(await panel.isVisible(), false, 'Moving a finger must cancel count long-press');
    } finally { await client.detach(); }
}

for (const engine of [chromium, webkit]) for (const width of [1440, 768, 390, 320]) {
    test(`${engine.name()} ${width}px: compact counts, shared tooltips and full-width fallback`, async () => {
        const app = await startPreview(), browser = await engine.launch(launch);
        const page = await workspacePage(browser, app, width, true), errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            await page.goto(app.url + '/Intelligence');
            await page.locator('#last-updated').waitFor({ state: 'hidden' });
            const modelCount = page.locator('#pie-context-note .bp-evidence-count');
            const rowCount = page.locator('.bp-benchmark-row[data-condition-id="1"] .bp-benchmark-score-count');
            await modelCount.waitFor();
            await assertCount(page, modelCount, 0, 'Scores from 0 models.', width <= 760);
            await assertCount(page, rowCount, 0, '0 approved scores from 0 models.', width <= 760);
            const rowWithEvidence = page.locator('.bp-benchmark-row[data-condition-id="2"] .bp-benchmark-score-count');
            await assertCount(page, rowWithEvidence, 9, '9 approved scores from 7 models.', width <= 760);
            const gap = await rowWithEvidence.evaluate(count => {
                const name = count.parentElement.querySelector('.bp-benchmark-name');
                const range = document.createRange(); range.selectNodeContents(name);
                return count.querySelector('i').getBoundingClientRect().left - range.getBoundingClientRect().right;
            });
            assert.ok(gap >= 0 && gap <= 6.1, `Count glyph gap: ${gap}`);
            if (engine === chromium && width <= 760) {
                await longPress(page, modelCount, 'Scores from 0 models.');
                await longPress(page, rowCount, '0 approved scores from 0 models.');
                assert.equal(await modelCount.textContent(), '0', 'Long-press must not select another benchmark');
            }
            const originalCount = await modelCount.elementHandle();
            await page.locator('#weight-pie g[data-object-id="2"]').focus();
            await page.keyboard.press('Enter');
            await page.waitForFunction(() => document.querySelector('#pie-context-note .bp-evidence-count')?.textContent === '7');
            assert.equal(await modelCount.evaluate((node, original) => node === original, originalCount), true);
            await assertCount(page, modelCount, 7, 'Scores from 7 models.', width <= 760);
            await originalCount.dispose();
            await page.locator('#inline-fallback-toggle').click();
            await page.locator('.bp-fallback-picker-customize').click();
            const add = page.locator('#inline-fallback-add-benchmark');
            await add.waitFor();
            await add.scrollIntoViewIfNeeded();
            const layout = await add.evaluate(node => ({ button: node.getBoundingClientRect().toJSON(),
                footer: node.parentElement.getBoundingClientRect().toJSON(), visibleActions: [...node.parentElement.children].filter(child => !child.hidden).length,
                pageOverflow: document.documentElement.scrollWidth > innerWidth + 1, labelOverflow: node.scrollWidth > node.clientWidth + 1 }));
            assert.equal(layout.visibleActions, 1);
            assert.ok(Math.abs(layout.button.width - layout.footer.width) < 1, JSON.stringify(layout));
            assert.ok(Math.abs(layout.button.x - layout.footer.x) < 1, JSON.stringify(layout));
            assert.ok(layout.button.height >= 44);
            assert.ok(layout.button.x >= 0 && layout.button.right <= width, JSON.stringify(layout));
            assert.equal(layout.pageOverflow, false);
            assert.equal(layout.labelOverflow, false);
            await add.focus();
            await page.keyboard.press('Tab');
            await page.keyboard.press('Shift+Tab');
            assert.equal(await add.evaluate(node => node === document.activeElement && node.matches(':focus-visible')), true);
            await page.keyboard.press('Escape');
            await mkdir(output, { recursive: true });
            await page.screenshot({ path: resolve(output, `${engine.name()}-${width}-fallback.png`), fullPage: true });
            if (width <= 760) await add.tap();
            else await page.keyboard.press('Enter');
            assert.equal(await add.getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#benchmark-card').evaluate(node => node.classList.contains('is-fallback-target-active')), true);
            await page.locator('#pie-mode-public').click();
            await page.waitForFunction(() => !document.querySelector('#public-pie-summary').hidden);
            assert.equal(await page.locator('#public-pie-count').textContent(), '128 saved weight sets');
            assert.ok((await page.locator('#pie-instruction').innerText()).length > 0);
            assert.deepEqual(errors, []);
            console.log(JSON.stringify({ engine: engine.name(), width, fullWidth: layout.button.width,
                zeroAndNonzero: true, keyboard: true, touch: engine === chromium && width <= 760 }));
        } catch (error) {
            await mkdir(output, { recursive: true });
            await page.screenshot({ path: resolve(output, `${engine.name()}-${width}-failure.png`), fullPage: true });
            throw error;
        } finally { await page.close(); await browser.close(); await app.close(); }
    });
}

test('a single benchmark shows its name and evidence count instead of adjustment instructions', async () => {
    const app = await startPreview({ personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 10000 }]) });
    const browser = await chromium.launch(launch), page = await workspacePage(browser, app, 390);
    try {
        await page.goto(app.url + '/Intelligence');
        await page.waitForFunction(() => document.querySelector('#pie-instruction')?.textContent === 'General knowledge');
        assert.equal(await page.locator('#pie-context-note .bp-evidence-count').count(), 1);
        assert.equal(await page.locator('#pie-context-note .bp-evidence-count').textContent(), '6');
        await assertCount(page, page.locator('.bp-benchmark-row[data-condition-id="1"] .bp-benchmark-score-count'),
            8, '8 approved scores from 6 models.', true);
    } finally { await page.close(); await browser.close(); await app.close(); }
});

test('refresh acknowledges beside the topic name, then fades without visible status text', async t => {
    const app = await startPreview(), browser = await chromium.launch(launch);
    const page = await workspacePage(browser, app, 390);
    t.after(async () => { await browser.close(); await app.close(); });
    await page.goto(app.url + '/Intelligence');
    const status = page.locator('#workspace-update-indicator');
    await page.waitForFunction(() => document.getElementById('workspace-update-indicator')?.dataset.phase === 'complete');
    assert.equal(await status.evaluate(node => node.previousElementSibling.classList.contains('bp-breadcrumb-current')), true);
    await page.waitForFunction(() => document.getElementById('workspace-update-indicator').dataset.phase === 'idle');
    await page.locator('#workspace-refresh').click();
    await page.waitForFunction(() => document.getElementById('workspace-update-indicator').dataset.phase === 'complete');
    await page.waitForFunction(() => document.getElementById('workspace-update-indicator').dataset.phase === 'idle');
    assert.equal(await page.locator('#last-updated').isVisible(), false);
    assert.equal(await status.textContent(), '');
    assert.equal(await page.getByText('Last updated just now', { exact: true }).count(), 0);
});

for (const engine of [chromium, webkit]) for (const width of [390, 1440]) test(`${engine.name()}: long version descriptions do not push evidence counts away from short benchmark names at ${width}`, async t => {
    const app = await startPreview(), browser = await engine.launch(launch);
    const page = await workspacePage(browser, app, width);
    t.after(async () => { await browser.close(); await app.close(); });
    await page.route('**/api/get_weighted_workspace', async route => {
        const response = await route.fetch(), payload = await response.json();
        const entry = payload.benchmarks.find(item => item.conditionID === 1);
        Object.assign(entry, { name: 'Short', conditionKey: 'long-description',
            conditionName: 'A long benchmark version description with several words', isDefaultCondition: false });
        await route.fulfill({ json: payload });
    });
    await page.goto(app.url + '/Intelligence');
    const row = page.locator('.bp-benchmark-row[data-condition-id="1"]');
    await row.waitFor();
    const gap = await row.evaluate(node => {
        const range = document.createRange(); range.selectNodeContents(node.querySelector('.bp-benchmark-link-name'));
        return node.querySelector('.bp-evidence-count i').getBoundingClientRect().left - range.getBoundingClientRect().right;
    });
    assert.ok(gap >= 0 && gap <= 6.1, `Actual gap: ${gap}`);
    await page.keyboard.press('Tab');
    await row.locator('.bp-benchmark-information-link').focus();
    assert.equal(await row.locator('.bp-benchmark-information-link').evaluate(node => getComputedStyle(node).outlineStyle), 'solid');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await mkdir(output, { recursive: true });
    await row.screenshot({ path: resolve(output, `${engine.name()}-${width}-long-version.png`) });
});
