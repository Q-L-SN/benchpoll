import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const output = fileURLToPath(new URL('../../artifacts/dynamic-families-20261005/ui/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.FAMILY_TEST_URL;
const results = [];
const automatic = { kind: 'other_versions' };
for (const [engineName, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of engineName === 'chromium' ? [1440, 390, 320] : [390]) {
            const group = { primaryConditionID: 1, families: [
                { primaryConditionID: 1, familyID: 18, mode: 'ordered', entries: familyEntries([automatic], 1), weightBasisPoints: 6000, overallWeightBasisPoints: 6000 },
                { primaryConditionID: 1, familyID: null, mode: 'ordered', entries: [], weightBasisPoints: 4000, overallWeightBasisPoints: 4000 }
            ] };
            const app = await startPreview({ saveDelay: 550, publicWeights: [{ conditionID: 1, weightBasisPoints: 10000 }], publicFamilyComposition: [group] });
            const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage(); page.setDefaultTimeout(15000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            let stage = 'load';
            await page.addInitScript(() => {
                window.historyEvents = [];
                window.testPressCount = 0;
                for (const type of ['pointerdown', 'pointerup', 'touchstart', 'touchend', 'click']) document.addEventListener(type, event => {
                    const button = event.target.closest('#workspace-undo, #workspace-redo');
                    if (button) window.historyEvents.push({ id: button.id, type, time: performance.now(), disabled: button.disabled,
                        touchAction: getComputedStyle(button).touchAction, bounds: button.getBoundingClientRect().toJSON(), scale: visualViewport.scale });
                });
            });
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            const press = async locator => {
                await locator.scrollIntoViewIfNeeded();
                await page.evaluate(() => new Promise(resolve => {
                    let previous = window.scrollY, stable = 0;
                    const tick = () => {
                        stable = window.scrollY === previous ? stable + 1 : 0;
                        previous = window.scrollY;
                        if (stable >= 3) resolve(); else requestAnimationFrame(tick);
                    };
                    requestAnimationFrame(tick);
                }));
                const before = await page.evaluate(() => window.testPressCount);
                await locator.evaluate(element => element.addEventListener(element.matches('#workspace-undo, #workspace-redo') && matchMedia('(pointer: coarse)').matches
                    ? 'pointerup' : 'click', () => { window.testPressCount++; }, { once: true, capture: true }));
                if (width < 500) await locator.tap(); else await locator.click();
                await page.waitForFunction(count => window.testPressCount > count, before);
            };
            const chart = page.locator('#inline-fallback-chart');
            const keys = () => chart.locator('.bp-family-member').evaluateAll(rows => rows.map(row => row.dataset.conditionId.replace(/^other:\d+$/, 'other_versions')));
            const expectedSaved = async expected => {
                const end = Date.now() + 18000;
                while (JSON.stringify(app.state.fallbackRules[0]?.entries.map(entry => entry.kind ?? String(entry.conditionID)) ?? []) !== JSON.stringify(expected)
                    || !await page.locator('#workspace-refresh').isEnabled()) {
                    if (Date.now() > end) throw new Error('Save did not reach the latest intended state: ' + JSON.stringify(expected)
                        + '; actual=' + JSON.stringify(app.state.fallbackRules) + '; shown=' + JSON.stringify(await keys()));
                    await delay(35);
                }
                await page.waitForFunction(() => !document.querySelector('#inline-fallback-save-retry').disabled);
                assert.deepEqual(await keys(), expected);
            };
            async function drag(from, to, cancelled = false) {
                await chart.evaluate(async element => {
                    await Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished));
                });
                await from.evaluate(element => element.scrollIntoView({ block: 'center', behavior: 'instant' }));
                const a = await from.boundingBox(); const b = await to.boundingBox();
                const start = { x: a.x + a.width / 2, y: a.y + a.height / 2 };
                const finish = { x: start.x, y: b.y + b.height / 2 };
                if (engineName === 'chromium' && width < 500) {
                    const session = await context.newCDPSession(page);
                    try {
                        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
                        for (let step = 1; step <= 12; step++) {
                            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y + (finish.y - start.y) * step / 12 }] });
                            await delay(12);
                        }
                        await session.send('Input.dispatchTouchEvent', { type: cancelled ? 'touchCancel' : 'touchEnd', touchPoints: [] });
                    } finally { await session.detach(); }
                } else {
                    await page.mouse.move(start.x, start.y); await page.mouse.down();
                    await page.mouse.move(finish.x, finish.y, { steps: 12 }); await page.mouse.up();
                }
            }
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                await page.evaluate(() => document.fonts.ready);
                assert.equal(await page.locator('#workspace-redo').isVisible(), false);
                await press(page.locator('#pie-mode-personal'));
                await press(page.locator('#inline-fallback-toggle'));
                await press(page.locator('#inline-fallback-add-other-versions'));
                await expectedSaved(['other_versions']);
                assert.match(await chart.textContent(), /All other versions[\s\S]*General knowledge/);
                assert.equal(await page.locator('#inline-fallback-add-other-versions').isDisabled(), true);
                await press(chart.locator('.bp-auto-version-button'));
                await page.locator('#version-group-dialog .bp-version-priority-list').waitFor();
                assert.match(await page.locator('#version-group-dialog').textContent(), /Experimental/);
                assert.match(await page.locator('#version-group-dialog').textContent(), /Extended/);
                await press(page.locator('#version-group-dialog .dialog-close-button'));
                await press(page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="2"] .bp-benchmark-add'));
                await press(page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="3"] .bp-benchmark-add'));
                await expectedSaved(['other_versions', '2', '3']);
                stage = 'drag explicit version';
                await drag(chart.locator('[data-condition-id="2"] .bp-family-drag'), chart.locator('[data-condition-id="3"]'));
                await expectedSaved(['other_versions', '3', '2']);
                stage = 'rapid undo';
                await press(page.locator('#workspace-undo'));
                await press(page.locator('#workspace-undo'));
                assert.deepEqual(await keys(), ['other_versions', '2']);
                assert.equal(await page.locator('#workspace-redo').isVisible(), true);
                await expectedSaved(['other_versions', '2']);
                stage = 'rapid redo';
                await press(page.locator('#workspace-redo'));
                await press(page.locator('#workspace-redo'));
                await expectedSaved(['other_versions', '3', '2']);
                assert.equal(await page.locator('#workspace-redo').isVisible(), false);
                stage = 'rebind automatic group';
                if (engineName === 'chromium' && width < 500) {
                    const saves = app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
                    await drag(chart.locator('[data-condition-id="other:0"] .bp-family-drag'), chart.locator('[data-condition-id="2"]'), true);
                    assert.deepEqual(await keys(), ['other_versions', '3', '2']);
                    assert.equal(await chart.locator('.is-dragging').count(), 0);
                    assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, saves);
                }
                await drag(chart.locator('[data-condition-id="other:0"] .bp-family-drag'), chart.locator('[data-condition-id="2"]'));
                await expectedSaved(['3', '2', 'other_versions']);
                assert.match(await chart.textContent(), /All other versions[\s\S]*Advanced reasoning/);
                await press(page.locator('#workspace-undo'));
                await press(chart.getByRole('button', { name: 'Remove Code generation from fallback', exact: true }));
                await expectedSaved(['other_versions', '2']);
                assert.equal(await page.locator('#workspace-redo').isVisible(), false, 'New edit clears redo');
                stage = 'public expansion';
                await press(page.locator('#pie-mode-public'));
                await press(page.locator('#public-fallback-toggle'));
                assert.equal(await chart.locator('.bp-family-summary').count(), 2);
                assert.equal(await chart.locator('.bp-family-expanded-chain:visible').count(), 0);
                await press(chart.locator('.bp-family-summary').first());
                await chart.locator('.bp-family-expanded-chain').first().waitFor({ state: 'visible' });
                assert.equal(await chart.locator('.bp-family-expanded-chain:visible').count(), 1);
                await press(chart.locator('.bp-family-summary').last());
                await chart.locator('.bp-family-expanded-chain').last().waitFor({ state: 'visible' });
                assert.equal(await chart.locator('.bp-family-expanded-chain:visible').count(), 2);
                await press(chart.locator('.bp-family-summary').first());
                await page.waitForFunction(() => document.querySelector('.bp-family-expanded-chain').hidden);
                assert.equal(await chart.locator('.bp-family-expanded-chain:visible').count(), 1);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.deepEqual(errors, []);
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-${width}.png`, fullPage: true });
                results.push({ engine: engineName, width, passed: true }); console.log('PASS ' + engineName + '-' + width);
            } catch (error) {
                results.push({ engine: engineName, width, passed: false, stage, error: error.stack, errors,
                    historyEvents: await page.evaluate(() => window.historyEvents) });
                console.error('FAIL ' + engineName + '-' + width + ' at ' + stage + ': ' + error.stack);
                await page.screenshot({ path: output + `${liveURL ? 'live-' : ''}${engineName}-${width}-failure.png`, fullPage: true });
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(output + `${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(item => !item.passed)) process.exitCode = 1;
