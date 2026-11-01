import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const liveURL = process.env.WORKSPACE_UI_URL;
const output = `artifacts/workspace-ui-20261008/browser${liveURL ? '-live' : ''}`;
await mkdir(output, { recursive: true });
const results = [];
const layerSelector = kind => `.bp-pie-transition[data-kind="${kind}"]`;
const ordinary = (page, ID) => page.locator(`.bp-benchmark-row:not(.is-family)[data-condition-id="${ID}"]`);
async function ready(page) {
    await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
    await page.evaluate(() => document.fonts.ready);
}
async function mobilePanel(page, width, panel) {
    if (width < 760) await page.locator(`button[data-mobile-panel="${panel === 'models' ? 'models' : 'mix'}"]`).click();
}
async function pauseTransition(page, kind, time) {
    const layer = page.locator(layerSelector(kind));
    await layer.waitFor({ state: 'attached' });
    return layer.evaluate((node, time) => {
        node.dataset.testIdentity ??= crypto.randomUUID();
        const animations = node.getAnimations({ subtree: true });
        animations.forEach(animation => { animation.pause(); animation.currentTime = time; });
        return { identity: node.dataset.testIdentity, count: animations.length,
            duration: animations[0].effect.getTiming().duration, delay: animations[0].effect.getTiming().delay,
            faces: [...node.querySelectorAll('.bp-pie-transition-face')].map(face => ({
                opacity: Number(getComputedStyle(face).opacity), backface: getComputedStyle(face).backfaceVisibility
            })) };
    }, time);
}
async function resumeTransition(page) {
    await page.locator('.bp-pie-transition').evaluateAll(nodes => nodes.forEach(node => {
        node.getAnimations({ subtree: true }).forEach(animation => animation.play());
    }));
    await page.locator('.bp-pie-transition').waitFor({ state: 'detached' });
}
async function nonblankPie(page) {
    const pixels = await page.locator('.bp-pie-stage').screenshot();
    return page.evaluate(async data => {
        const img = new Image(); img.src = `data:image/png;base64,${data}`;
        await img.decode();
        const canvas = document.createElement('canvas'); canvas.width = img.width; canvas.height = img.height;
        const ctx = canvas.getContext('2d'); ctx.drawImage(img, 0, 0);
        const bytes = ctx.getImageData(0, 0, img.width, img.height).data;
        let colored = 0;
        for (let i = 0; i < bytes.length; i += 4) {
            if (Math.max(bytes[i], bytes[i + 1], bytes[i + 2]) - Math.min(bytes[i], bytes[i + 1], bytes[i + 2]) > 20) colored++;
        }
        return colored / (img.width * img.height);
    }, pixels.toString('base64'));
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 1024, 390, 320]], ['webkit', webkit, [1440, 390, 320]]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            if (process.env.UI_TEST_WIDTH && !process.env.UI_TEST_WIDTH.split(',').map(Number).includes(width)) continue;
            const app = await startPreview({ secondaryBenchmark: true,
                publicWeights: [{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 901, weightBasisPoints: 4000 }] });
            const context = await browser.newContext({ viewport: { width, height: 960 },
                isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference' });
            const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            try {
                const fetchFixture = route => {
                    const url = new URL(route.request().url());
                    return route.fetch({ url: app.url + url.pathname + url.search });
                };
                if (liveURL) await page.route('**/api/**', async route => {
                    await route.fulfill({ response: await fetchFixture(route) });
                });
                await page.route('**/api/get_benchmark_information', async route => {
                    const response = await fetchFixture(route); const data = await response.json();
                    if (Number(route.request().postDataJSON().conditionID) === 901) {
                        data.differenceExplanation = 'Includes the extended task set instead of the standard tasks.';
                    }
                    await route.fulfill({ response, json: data });
                });
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' }); await ready(page);
                assert.deepEqual(await page.locator('#how-it-works-link').evaluate(node => {
                    const style = getComputedStyle(node);
                    return [style.borderWidth, style.backgroundColor, style.textDecorationLine];
                }), ['0px', 'rgba(0, 0, 0, 0)', 'none']);

                await mobilePanel(page, width, 'models');
                const help = page.locator('#quick-comparison-help');
                const harness = page.locator('[data-quick-comparison="harness"]');
                const helpBounds = await help.boundingBox(); const harnessBounds = await harness.boundingBox();
                assert.ok(helpBounds.x >= harnessBounds.x + harnessBounds.width - 1);
                await help.focus();
                await page.locator('#bp-help-popover').waitFor();
                const helpText = await page.locator('#bp-help-popover').textContent();
                assert.match(helpText, /highest normalized/i); assert.match(helpText, /unselected|unchecked/i);
                const tooltip = await page.locator('#bp-help-popover').boundingBox();
                assert.ok(tooltip.x >= 0 && tooltip.x + tooltip.width <= width + 1);
                await page.screenshot({ path: `${output}/${engine}-help-${width}.png` });
                await page.keyboard.press('Escape');
                assert.equal(await page.locator('#bp-help-popover').isVisible(), false);

                await mobilePanel(page, width, 'pie');
                await page.locator('#public-composition-toggle').click();
                const fade = await pauseTransition(page, 'fade', 85);
                assert.equal(fade.count, 2); assert.equal(fade.duration, 170); assert.equal(fade.delay, 0);
                assert.ok(fade.faces.every(face => face.opacity > .2 && face.opacity < .8));
                await page.locator('.bp-pie-stage').screenshot({ path: `${output}/${engine}-composition-fade-${width}.png` });
                await page.locator('#public-composition-toggle').click();
                assert.equal(await page.locator(layerSelector('fade')).getAttribute('data-test-identity'), fade.identity);
                await resumeTransition(page);
                assert.equal(await page.locator('#weight-pie').isVisible(), true);
                assert.equal(await page.locator('#public-composition-pie').isVisible(), false);

                let releasePage;
                const rankingGate = new Promise(resolve => { releasePage = resolve; });
                await page.route('**/api/get_ranking_page', async route => {
                    if (route.request().postDataJSON().list === 'personal') await rankingGate;
                    await route.fulfill({ response: await fetchFixture(route) });
                });
                await page.locator('#pie-mode-personal').click();
                await page.locator('#pie-mode-personal .bp-pie-mode-loading').waitFor();
                const centers = await page.locator('#pie-mode-personal').evaluate(button => {
                    const rect = button.getBoundingClientRect();
                    const icon = button.querySelector('.bp-pie-mode-loading').getBoundingClientRect();
                    return [Math.abs(rect.x + rect.width / 2 - icon.x - icon.width / 2),
                        Math.abs(rect.y + rect.height / 2 - icon.y - icon.height / 2)];
                });
                assert.ok(centers.every(offset => offset < 1), `Spinner offset: ${centers}`);
                releasePage();
                const flip = await pauseTransition(page, 'flip', 130);
                assert.equal(flip.count, 1); assert.equal(flip.duration, 430); assert.equal(flip.delay, 0);
                assert.ok(flip.faces.every(face => face.backface === 'hidden'));
                assert.deepEqual(await page.locator('.bp-pie-stage [id]').evaluateAll(nodes => {
                    const IDs = nodes.map(node => node.id); return IDs.filter((ID, index) => IDs.indexOf(ID) !== index);
                }), []);
                assert.ok(await nonblankPie(page) > .03, '3D transition must render colored Pie pixels');
                await page.locator('.bp-pie-stage').screenshot({ path: `${output}/${engine}-flip-${width}.png` });
                await pauseTransition(page, 'flip', 340);
                assert.ok(await nonblankPie(page) > .03, 'The incoming 3D face must be visible too');
                await page.locator('.bp-pie-stage').screenshot({ path: `${output}/${engine}-flip-back-${width}.png` });
                await page.locator('#pie-mode-public').click();
                await page.waitForFunction(() => document.getElementById('pie-mode-public').getAttribute('aria-selected') === 'true');
                assert.equal(await page.locator(layerSelector('flip')).getAttribute('data-test-identity'), flip.identity);
                await page.waitForFunction(() => document.querySelector('.bp-pie-transition[data-kind="flip"]')
                    ?.getAnimations({ subtree: true })[0].playbackRate === -1);
                await page.locator('.bp-pie-transition').waitFor({ state: 'detached' });
                for (const mode of ['personal', 'public', 'personal', 'public', 'personal']) {
                    await page.locator(`#pie-mode-${mode}`).click(); await page.waitForTimeout(45);
                }
                await page.locator('.bp-pie-transition').waitFor({ state: 'detached' });
                assert.equal(await page.locator('#pie-mode-personal').getAttribute('aria-selected'), 'true');
                assert.equal(await page.locator('.bp-pie-live-in-motion').count(), 0);
                assert.ok(await nonblankPie(page) > .1);

                await mobilePanel(page, width, 'benchmarks');
                await ordinary(page, 1).locator('.bp-benchmark-personal-weight').click();
                await mobilePanel(page, width, 'pie');
                await page.locator('#inline-fallback-toggle').click();
                await page.locator('#inline-fallback-settings').waitFor();
                const footer = await page.locator('.bp-inline-fallback-frame').evaluate(frame => {
                    const box = frame.getBoundingClientRect();
                    const buttons = [...frame.querySelectorAll('.bp-fallback-add-actions button')].map(button => {
                        const rect = button.getBoundingClientRect();
                        return { x: rect.x, right: rect.right, bottom: rect.bottom, top: rect.top };
                    });
                    return { left: box.left, right: box.right, bottom: box.bottom, buttons };
                });
                assert.equal(footer.buttons.length, 2);
                assert.ok(footer.buttons[0].right <= footer.buttons[1].x);
                assert.ok(footer.buttons.every(button => button.x >= footer.left && button.right <= footer.right
                    && button.bottom <= footer.bottom && button.bottom >= footer.bottom - 20));
                await page.screenshot({ path: `${output}/${engine}-fallback-${width}.png`, fullPage: true });
                await page.locator('#inline-fallback-add-benchmark').click();
                await ordinary(page, 2).locator('.bp-benchmark-add').click();
                await page.locator('#inline-fallback-chart .bp-family-member').waitFor();
                assert.equal(await page.locator('.bp-inline-fallback-frame .bp-fallback-add-actions button').count(), 2);

                await mobilePanel(page, width, 'benchmarks');
                await ordinary(page, 1).locator('.bp-benchmark-information-link').click();
                await page.locator('#benchmark-information-differences').waitFor();
                assert.equal(await page.locator('#benchmark-information-differences').getAttribute('open'), null);
                assert.equal(await page.locator('#category-path').isVisible(), false);
                assert.equal(await page.locator('#benchmark-discussion-heading').textContent(), 'Discussion about this benchmark in this category');
                await page.locator('#benchmark-information-differences summary').click();
                await page.waitForTimeout(250);
                assert.equal(await page.locator('#benchmark-information-differences').evaluate(node => node.open), true);
                await page.screenshot({ path: `${output}/${engine}-information-${width}.png`, fullPage: true });
                await page.locator('#discussion-close').click(); await page.waitForTimeout(250);
                await ordinary(page, 901).locator('.bp-benchmark-information-link').click();
                await page.locator('#benchmark-information-differences').waitFor();
                assert.equal(await page.locator('#benchmark-information-differences').evaluate(node => node.open), true);
                await page.locator('#discussion-close').click(); await page.waitForTimeout(250);
                await page.locator('#discussion-entry').click();
                await page.locator('#category-path').waitFor();
                assert.equal(await page.locator('#benchmark-discussion-heading').isVisible(), false);
                await page.locator('#discussion-close').click(); await page.waitForTimeout(250);

                await mobilePanel(page, width, 'pie');
                await page.locator('#pie-mode-public').click();
                await pauseTransition(page, 'flip', 120);
                await page.setViewportSize({ width: width + 20, height: 960 });
                await page.locator('.bp-pie-transition').waitFor({ state: 'detached' });
                assert.equal(await page.locator('.bp-pie-live-in-motion').count(), 0);
                await page.emulateMedia({ reducedMotion: 'reduce' });
                await page.locator('#pie-mode-personal').click(); await ready(page);
                assert.equal(await page.locator('.bp-pie-transition').count(), 0);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

                await page.setViewportSize({ width, height: 960 });
                await page.goto(`${liveURL ? new URL(liveURL).origin : app.url}/contribute/benchmarks/new`);
                await page.locator('[data-evaluation-name]').waitFor();
                assert.equal(await page.locator('#contribution-page-help').count(), 0);
                assert.equal(await page.locator('.contribution-sidebar-actions').evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
                if (width < 760) await page.locator('#contribution-taxonomy-toggle').click();
                await page.locator('#contribution-help').click();
                await page.locator('#contribution-guide-dialog').waitFor();
                await page.screenshot({ path: `${output}/${engine}-contribution-guide-${width}.png`, fullPage: true });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true });
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
