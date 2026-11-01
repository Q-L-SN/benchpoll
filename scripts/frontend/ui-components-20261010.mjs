import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models, familyEntries, workspace, createFixtureState } from './fixtures.mjs';
import { validateWorkspacePayload } from '../../public/js/workspace/contracts.js';
import { contributionPath } from '../../public/js/shared/contribution-navigation.js';

const output = resolve(process.env.UI_COMPONENT_OUTPUT ?? 'artifacts/ui-components-20261010/browser');
const liveURL = process.env.UI_COMPONENT_URL;
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'private/home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [];
const rule = { familyID: 701, primaryConditionID: 1, mode: 'ordered', entries: familyEntries([{ conditionID: 2 }], 1) };
const comparisonModels = models.slice(0, 2).map((model, index) => ({ ...model, modelName: model.name,
    vendor: model.vendorName, condition: { parameters: {}, scoreFields: [] },
    results: new Map(benchmarks.filter(item => item.conditionID !== 1)
        .map(item => [String(item.conditionID), { normalizedScore: 70 - index * 4 }])) }));
const options = { comparisonModels, comparisonFields: [], fallbackRules: [rule],
    publicFamilyComposition: [{ primaryConditionID: 1, families: [{ ...rule,
        weightBasisPoints: 10000, overallWeightBasisPoints: benchmarks[0].publicWeight * 100 }] }] };
validateWorkspacePayload(workspace(createFixtureState(options), { comparison: { mode: 'best', keys: ['model'], filters: [] }, scoreMode: 'range' }));
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };

async function fits(locator) {
    assert.equal(await locator.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true,
        `Text overflows ${await locator.textContent()}`);
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 1024, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of widths) {
            const app = await startPreview(options);
            const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
                isMobile: width <= 420, hasTouch: width <= 420,
                ignoreHTTPSErrors: Boolean(liveURL && ['localhost', '127.0.0.1'].includes(new URL(liveURL).hostname)) });
            const page = await context.newPage();
            page.setDefaultTimeout(liveURL ? 60000 : 15000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
            try {
                if (builtHTML) {
                    await context.route('**/*', async route => {
                        if (route.request().resourceType() !== 'document') return route.fallback();
                        const path = new URL(route.request().url()).pathname;
                        if (path === '/') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
                        const pageName = path.startsWith('/contribute/') ? 'contribute.html' : path === '/how-it-works' ? 'how-it-works.html' : null;
                        if (!pageName) return route.fallback();
                        return route.fulfill({ body: await readFile(join(builtRoot, 'private', pageName)), contentType: 'text/html' });
                    });
                    await context.route('**/build/home/**', async route => {
                        const path = new URL(route.request().url()).pathname;
                        await route.fulfill({ body: await readFile(join(builtRoot, 'public', path)),
                            contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
                    });
                    for (const prefix of ['css', 'js']) await context.route(`**/${prefix}/**`, async route => {
                        const path = new URL(route.request().url()).pathname;
                        await route.fulfill({ body: await readFile(join(builtRoot, 'public', path)),
                            contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
                    });
                }
                if (liveURL) await context.route('**/api/**', async route => {
                    const url = new URL(route.request().url());
                    await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
                });
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
                await page.evaluate(() => document.fonts.ready);
                assert.equal(await page.locator('.bp-scoring-help').evaluate(node => getComputedStyle(node).position), 'absolute');
                if (width <= 760) await page.locator('#taxonomy-toggle').click();
                const navigation = page.locator('.bp-navigation-views');
                assert.equal(await navigation.getAttribute('data-ui-component'), 'segmented');
                for (const button of await navigation.locator('button').all()) await fits(button);
                await navigation.locator('[data-navigation-view="configured"]').click();
                await page.waitForFunction(() => {
                    const root = document.querySelector('.bp-navigation-views');
                    const selected = root.querySelector('[aria-pressed="true"]');
                    return Number.parseFloat(root.style.getPropertyValue('--ui-segment-x')) === selected.offsetLeft;
                });
                await navigation.screenshot({ path: join(output, `${engine}-${width}-navigation.png`) });
                await navigation.locator('[data-navigation-view="all"]').click();
                if (width <= 760) await page.locator('#taxonomy-close').click();
                if (width <= 760) await page.locator('button[data-mobile-panel="mix"]').click();
                await page.locator('#pie-mode-personal').click();
                await page.locator('#pie-mode-personal[aria-selected="true"][aria-busy="false"]').waitFor();
                assert.equal(await page.locator('.bp-benchmark-weight i, .bp-benchmark-weight svg').count(), 0);
                const settleRanking = async () => {
                    if (width <= 760) await page.locator('button[data-mobile-panel="models"]').click();
                    await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
                    if (width <= 760) await page.locator('button[data-mobile-panel="mix"]').click();
                };
                const contextMenu = node => node.dispatchEvent(new PointerEvent('contextmenu', {
                    button: 2, pointerType: 'mouse', bubbles: true, cancelable: true }));
                const wheelRow = page.locator('.bp-benchmark-row[data-condition-id="2"]');
                assert.equal(await wheelRow.evaluate(contextMenu), true);
                await page.locator('#weight-pie g[data-object-id="1"]').click();
                const hint = page.locator('#pie-adjustment-status');
                const dismissHint = page.getByRole('button', { name: 'Stop adjusting weight', exact: true });
                await hint.waitFor();
                assert.equal(await page.locator('#pie-adjustment-label').textContent(), 'Adjusting weight');
                const instruction = await page.locator('#pie-adjustment-instruction').textContent();
                if (width <= 420) {
                    assert.match(instruction, /Swipe.*Tap this prompt/);
                    assert.doesNotMatch(instruction, /Right-click/i);
                } else assert.match(instruction, /Right-click or click this prompt/);
                assert.equal(await dismissHint.isEnabled(), true);
                const hintStyle = await hint.evaluate(node => {
                    const css = getComputedStyle(node), bounds = node.getBoundingClientRect();
                    return { position: css.position, background: css.backgroundColor, width: bounds.width,
                        left: bounds.left, right: bounds.right, viewport: innerWidth };
                });
                assert.equal(hintStyle.position, 'fixed'); assert.equal(hintStyle.background, 'rgb(40, 45, 53)');
                assert.ok(hintStyle.width <= 400 && hintStyle.left >= 0 && hintStyle.right <= hintStyle.viewport);
                await hint.screenshot({ path: join(output, `${engine}-${width}-adjustment-hint.png`) });
                assert.equal(await page.locator('#benchmark-search').evaluate(contextMenu), true);
                assert.equal(await wheelRow.evaluate(node => node.dispatchEvent(new PointerEvent('contextmenu', {
                    pointerType: 'touch', bubbles: true, cancelable: true }))), true);
                assert.equal(await hint.isVisible(), true);
                let releaseSave;
                const saveGate = new Promise(resolve => { releaseSave = resolve; });
                const saveRoute = async route => { await saveGate; await route.fallback(); };
                await page.route('**/api/save_personal_pie', saveRoute);
                try {
                    const blocked = await wheelRow.evaluate(node => {
                        node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
                        return !node.dispatchEvent(new PointerEvent('contextmenu', {
                            button: 2, pointerType: 'mouse', bubbles: true, cancelable: true }));
                    });
                    assert.equal(blocked, true);
                    assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), 'leaderboard');
                    assert.equal(await hint.getAttribute('aria-hidden'), 'true');
                    assert.equal(await page.locator('.bp-weight-wheel-target').count(), 0);
                    assert.equal(await page.locator('#pie-adjustment-value').textContent(), '37%');
                    assert.equal(app.state.personalEntries[0].weightBasisPoints, 3500);
                    const saved = page.waitForResponse(response => new URL(response.url()).pathname === '/api/save_personal_pie');
                    releaseSave(); await saved;
                } finally {
                    releaseSave(); await page.unroute('**/api/save_personal_pie', saveRoute);
                }
                await settleRanking();
                assert.equal(app.state.personalEntries[0].weightBasisPoints, 3700);
                assert.equal(await wheelRow.evaluate(contextMenu), true);
                assert.equal(await page.locator('#weight-pie').evaluate(node => node.dispatchEvent(new WheelEvent('wheel', {
                    deltaY: -100, bubbles: true, cancelable: true }))), true);
                assert.equal(app.state.personalEntries[0].weightBasisPoints, 3700);
                await page.locator('#workspace-undo').click();
                await settleRanking();
                assert.equal(app.state.personalEntries[0].weightBasisPoints, 3500);
                await page.locator('#workspace-redo').click();
                await settleRanking();
                assert.equal(app.state.personalEntries[0].weightBasisPoints, 3700);
                await page.locator('#weight-pie g[data-object-id="1"]').click();
                await wheelRow.click({ button: 'right', position: { x: 4, y: 20 } });
                assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), 'leaderboard');
                await page.locator('#weight-pie g[data-object-id="1"]').click();
                if (width <= 420) await dismissHint.tap();
                else await dismissHint.click();
                assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), 'leaderboard');
                assert.equal(await hint.getAttribute('aria-hidden'), 'true');
                for (const key of ['Enter', 'Space']) {
                    await page.locator('#weight-pie g[data-object-id="1"]').click();
                    await page.keyboard.press('Tab');
                    await dismissHint.focus();
                    assert.equal(await dismissHint.evaluate(node => getComputedStyle(node).outlineWidth), '2px');
                    await page.keyboard.press(key);
                    assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), 'leaderboard');
                    assert.equal(await hint.getAttribute('aria-hidden'), 'true');
                    assert.equal(await hint.evaluate(node => node.contains(document.activeElement)), false);
                }
                await page.locator('#weight-pie g[data-object-id="1"]').click();
                const savedOnClick = page.waitForResponse(response => new URL(response.url()).pathname === '/api/save_personal_pie');
                await wheelRow.evaluate(node => {
                    node.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, bubbles: true, cancelable: true }));
                    document.getElementById('pie-adjustment-dismiss').click();
                });
                assert.equal(await page.locator('.bp-left-workspace').getAttribute('data-workspace-view'), 'leaderboard');
                assert.equal(await hint.getAttribute('aria-hidden'), 'true');
                assert.equal(await page.locator('#pie-adjustment-value').textContent(), '39%');
                await savedOnClick;
                await settleRanking();
                assert.equal(app.state.personalEntries[0].weightBasisPoints, 3900);
                if (width <= 760) await page.locator('button[data-mobile-panel="models"]').click();
                await page.locator('.bp-model-row').first().click();
                const toggle = page.locator('.bp-model-fallback-toggle').first();
                await toggle.waitFor();
                const style = await toggle.evaluate(node => {
                    const css = getComputedStyle(node), bounds = node.getBoundingClientRect();
                    const identity = node.parentElement.getBoundingClientRect();
                    return { background: css.backgroundColor, border: css.borderTopWidth,
                        align: css.textAlign, justify: css.justifyContent, left: bounds.left, identityLeft: identity.left };
                });
                assert.equal(style.background, 'rgba(0, 0, 0, 0)');
                assert.equal(style.border, '0px');
                assert.ok(style.left > style.identityLeft, 'Only the arrow, not the information link, toggles fallback steps');
                assert.equal(await toggle.locator('i').count(), 1);
                await toggle.click();
                assert.equal(await toggle.getAttribute('aria-expanded'), 'true');
                assert.equal(await page.locator('.bp-model-fallback-path:not([hidden]) > li').count(), 1);
                await toggle.focus(); await page.keyboard.press('Enter');
                assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
                const change = page.locator('.bp-model-change-information').first();
                const action = await change.evaluate(node => {
                    const css = getComputedStyle(node), icon = node.querySelector('i').getBoundingClientRect();
                    const label = node.querySelector('span').getBoundingClientRect();
                    return { font: css.fontSize, gap: label.left - icon.right, align: css.alignItems,
                        border: css.borderTopWidth, background: css.backgroundColor };
                });
                assert.equal(action.font, '13px'); assert.equal(action.align, 'center');
                assert.ok(action.gap >= 7 && action.gap <= 9); assert.equal(action.border, '0px');
                assert.equal(action.background, 'rgba(0, 0, 0, 0)');
                await change.focus();
                assert.equal(await change.evaluate(node => getComputedStyle(node).outlineWidth), '2px');
                await change.evaluate(node => node.blur());
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.locator('#model-scores-dialog').screenshot({ path: join(output, `${engine}-${width}-model-evidence.png`) });
                const identityLink = toggle.locator('..').locator('a').first();
                await identityLink.evaluate(node => {
                    node.querySelector('strong').textContent = 'Agents\' Last Exam with a longer benchmark name';
                    const version = node.querySelector('.bp-benchmark-condition') ?? document.createElement('span');
                    version.className = 'bp-benchmark-condition';
                    version.textContent = 'v2.1 offline binary accuracy with legacy version details';
                    node.append(version);
                });
                await fits(identityLink); await fits(toggle.locator('..'));
                assert.equal(await toggle.evaluate(node => node.getBoundingClientRect().right <= node.parentElement.getBoundingClientRect().right + 1), true);
                await page.locator('#model-scores-dialog').screenshot({ path: join(output, `${engine}-${width}-long-version.png`) });
                await page.goto(`${liveURL ? new URL(liveURL).origin : app.url}${contributionPath('new_benchmark')}`, { waitUntil: 'domcontentloaded' });
                await page.locator('#contribution-step .bp-ui-input').first().waitFor();
                assert.equal(await page.locator('#submit-contribution').getAttribute('data-ui-variant'), 'primary');
                await page.locator('#submit-contribution').focus();
                assert.equal(await page.locator('#submit-contribution').evaluate(node => getComputedStyle(node).outlineWidth), '2px');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.screenshot({ path: join(output, `${engine}-${width}-contribution.png`), fullPage: true });
                await page.goto(`${liveURL ? new URL(liveURL).origin : app.url}/how-it-works`, { waitUntil: 'domcontentloaded' });
                await page.locator('.bp-ui-action').first().waitFor({ state: 'attached' });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.deepEqual(errors, []);
                reports.push({ engine, width, passed: true, action, fallback: style, adjustmentHint: hintStyle,
                    rightClickExit: true, promptClickExit: true, keyboardExit: true,
                    mobileCopy: width <= 420, savedInputPreserved: true, undoRedo: true });
                console.log(`PASS ${engine}-${width}: shared controls, fallback and cross-page layout`);
            } catch (error) {
                await page.screenshot({ path: join(output, `${engine}-${width}-failure.png`), fullPage: true });
                reports.push({ engine, width, passed: false, error: error.stack, errors });
                console.error(`FAIL ${engine}-${width}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
if (reports.some(result => !result.passed)) process.exitCode = 1;
