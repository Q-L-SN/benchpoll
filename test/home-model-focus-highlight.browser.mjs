import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';
import { buildHomeAssets } from '../scripts/build-home-assets.mjs';
import { createHomeAssetRenderer } from '../home-assets.js';

const root = fileURLToPath(new URL('../', import.meta.url));
const observe = process.argv.includes('--observe');
const output = resolve(process.env.HOME_MODEL_FOCUS_ARTIFACTS
    ?? 'D:/Codex-artifacts/website1/topics-refinement-20261024/model-focus', observe ? 'before' : 'after');
await mkdir(output, { recursive: true });
const builtRoot = observe ? null : await mkdtemp(resolve(output, 'build-'));
let builtHTML;
if (builtRoot) {
    for (const path of ['public/js', 'public/css', 'public/vendor/fontawesome/css', 'private/home.html']) {
        await cp(resolve(root, path), resolve(builtRoot, path), { recursive: true });
    }
    await buildHomeAssets(builtRoot);
    await createHomeAssetRenderer(builtRoot)({ set() {}, type() { return this; },
        send(value) { builtHTML = value.toString(); },
        sendFile() { throw new Error('The actual bundle must not fall back to source'); } });
    assert.match(builtHTML, /\/build\/home\/entry-/);
}

async function snapshot(page, phase) {
    return page.locator('[data-model-focus-id="2040"]').evaluate((row, phase) => {
        const css = getComputedStyle(row);
        return { phase, elapsed: Math.round(performance.now() - window.__focusStarted),
            active: row === document.activeElement, focusVisible: row.matches(':focus-visible'),
            classes: row.className, outline: css.outline, outlineStyle: css.outlineStyle,
            outlineWidth: css.outlineWidth, outlineColor: css.outlineColor, outlineOffset: css.outlineOffset,
            background: css.backgroundColor, radius: css.borderRadius, animation: css.animationName, transition: css.transitionDuration };
    }, phase);
}

const results = [];
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const app = await startPreview({ authenticated: true, rankingStress: true });
    try {
        for (const build of observe ? ['source'] : ['source', 'built']) {
            for (const [name, width, reducedMotion] of observe ? [['repeat-1', 1440, false], ['repeat-2', 1440, false]]
                : [['repeat-1', 1440, false], ['repeat-2', 1440, false], ['mobile', 390, false], ['reduced', 390, true]]) {
                const folder = resolve(output, engine, build, name);
                await mkdir(folder, { recursive: true });
                const context = await browser.newContext({ viewport: { width, height: width < 500 ? 844 : 960 },
                    reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
                const page = await context.newPage(), errors = [];
                page.on('pageerror', error => errors.push(error.message));
                if (build === 'built') await context.route('**/*', async route => {
                    const request = route.request(), url = new URL(request.url());
                    if (request.resourceType() === 'document' && url.pathname === '/Intelligence') {
                        return route.fulfill({ contentType: 'text/html', body: builtHTML });
                    }
                    if (url.pathname.startsWith('/build/')) {
                        const path = resolve(builtRoot, 'public', '.' + url.pathname);
                        return route.fulfill({ contentType: extname(path) === '.css' ? 'text/css' : 'text/javascript', body: await readFile(path) });
                    }
                    return route.continue();
                });
                await page.addInitScript(() => {
                    new MutationObserver(() => {
                        const row = document.querySelector('.is-model-jump-focus');
                        if (row && !window.__focusStarted) window.__focusStarted = performance.now();
                    }).observe(document, { childList: true, subtree: true, attributes: true, attributeFilter: ['class'] });
                });
                const record = { engine, version: browser.version(), build, name, reducedMotion, snapshots: [], passed: false };
                try {
                    await page.mouse.move(0, 0);
                    await page.goto(app.url + '/Intelligence?focusModel=2040&scoreMode=range&compareReasoning=0&compareHarness=0&mode=public');
                    await page.waitForFunction(() => window.__focusStarted);
                    for (const [phase, elapsed] of [['start', 0], ['middle', 950], ['end', 2150]]) {
                        await page.waitForFunction(elapsed => performance.now() - window.__focusStarted >= elapsed, elapsed);
                        record.snapshots.push(await snapshot(page, phase));
                        await page.screenshot({ path: resolve(folder, `${phase}.png`), fullPage: true });
                    }
                    if (!observe) {
                        const [start, middle, end] = record.snapshots;
                        assert.equal(start.radius, '4px');
                        assert.equal(middle.radius, '4px');
                        assert.equal(start.outlineWidth, '2px');
                        assert.equal(start.outlineStyle, 'solid');
                        assert.equal(start.transition, '0s', 'The highlight animation must not compete with the ordinary row background transition');
                        assert.notEqual(start.background, 'rgba(0, 0, 0, 0)');
                        assert.equal(end.classes.includes('is-model-jump-focus'), false);
                        assert.equal(end.outlineStyle, 'none', 'The automatic jump must not leave a native focus rectangle');
                        assert.equal(end.background, 'rgba(0, 0, 0, 0)', 'The automatic jump must not leave a focus background');
                        assert.equal(end.active, true, 'Keyboard continuation must retain its logical target');
                        assert.equal(start.animation, reducedMotion ? 'none' : 'bp-model-jump-focus');
                        if (!reducedMotion) assert.notEqual(middle.background, start.background, 'The same emphasis should fade');
                        await page.keyboard.press('ArrowRight');
                        const keyboard = await snapshot(page, 'keyboard');
                        record.snapshots.push(keyboard);
                        assert.equal(keyboard.active, true);
                        assert.equal(keyboard.focusVisible, true);
                        assert.equal(keyboard.outlineStyle, 'solid', 'Genuine keyboard interaction restores a visible focus indicator');
                        assert.equal(keyboard.outlineWidth, '2px');
                        assert.equal(keyboard.radius, '4px');
                        assert.equal(keyboard.outlineOffset, '-2px', 'Keyboard focus stays inside the scroll container rather than being clipped');
                        await page.screenshot({ path: resolve(folder, 'keyboard.png'), fullPage: true });
                        await page.keyboard.press('Tab');
                        assert.equal(await page.evaluate(() => document.activeElement.matches(':focus-visible')), true);
                        await page.keyboard.press('Shift+Tab');
                        const returned = await snapshot(page, 'keyboard-return');
                        record.snapshots.push(returned);
                        assert.equal(returned.active, true);
                        assert.equal(returned.outlineStyle, 'solid');
                        assert.equal(returned.classes.includes('is-model-jump-auto-focus'), false);
                        if (name === 'repeat-2') {
                            await page.goto(app.url + '/Intelligence?focusModel=2040&scoreMode=range');
                            await page.waitForFunction(() => window.__focusStarted);
                            await page.mouse.wheel(0, 100);
                            await page.waitForFunction(() => !document.querySelector('.is-model-jump-focus'));
                            const cancelled = await snapshot(page, 'wheel-cancel');
                            record.snapshots.push(cancelled);
                            assert.equal(cancelled.outlineStyle, 'none', 'Wheel cancellation must not reveal native automatic focus');
                            assert.equal(cancelled.background, 'rgba(0, 0, 0, 0)');
                            assert.equal(cancelled.classes.includes('is-model-jump-auto-focus'), true);
                        }
                    }
                    assert.deepEqual(errors, []);
                    record.passed = true;
                    console.log(`${observe ? 'OBSERVED' : 'PASS'} ${engine} ${build} ${name}: ${JSON.stringify(record.snapshots)}`);
                } catch (error) {
                    record.error = error.stack;
                    console.error(`FAIL ${engine} ${build} ${name}: ${error.message}`);
                    await page.screenshot({ path: resolve(folder, 'failure.png'), fullPage: true });
                } finally {
                    results.push(record);
                    await writeFile(resolve(output, 'results.json'), JSON.stringify({ observe, builtRoot, results }, null, 2));
                    await context.close();
                }
            }
        }
    } finally { await browser.close(); await app.close(); }
}
assert.equal(results.filter(result => !result.passed).length, 0, 'Every focus-style browser case must pass');
