import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const record = process.argv.includes('--record');
const output = resolve(process.env.SEGMENTED_OUTPUT ?? 'artifacts/segmented-geometry-20261011/browser');
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'private/home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };

async function geometry(control) {
    return control.evaluate(root => {
        const box = root.getBoundingClientRect();
        const selected = root.querySelector(':scope > button[aria-pressed="true"], :scope > button[aria-selected="true"]');
        return { width: box.width, height: box.height, left: box.left, right: box.right,
            sliderWidth: parseFloat(root.style.getPropertyValue('--ui-segment-width')), selectedWidth: selected.offsetWidth,
            sliderX: parseFloat(root.style.getPropertyValue('--ui-segment-x')), selectedX: selected.offsetLeft,
            buttons: [...root.querySelectorAll(':scope > button[aria-pressed], :scope > button[aria-selected]')].map(button => {
                const range = document.createRange(); range.selectNodeContents(button);
                const rectangles = [...range.getClientRects()].filter(rect => rect.width && rect.height);
                const bounds = button.getBoundingClientRect();
                return { text: button.textContent.trim(), lines: new Set(rectangles.map(rect => Math.round(rect.top))).size,
                    width: bounds.width, height: bounds.height, textHeight: Math.max(...rectangles.map(rect => rect.height)),
                    textWidth: Math.max(...rectangles.map(rect => rect.width)),
                    availableWidth: bounds.width - parseFloat(getComputedStyle(button).paddingLeft) - parseFloat(getComputedStyle(button).paddingRight),
                    fontWeight: getComputedStyle(button).fontWeight, overflow: button.scrollWidth - button.clientWidth };
            }) };
    });
}

for (const [name, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const browser = await launcher.launch({ headless: true, env });
    const app = await startPreview();
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'no-preference',
        isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage(); const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
        if (builtHTML) {
            await context.route('**/*', async route => {
                if (route.request().resourceType() !== 'document' || new URL(route.request().url()).pathname !== '/') return route.fallback();
                await route.fulfill({ body: builtHTML, contentType: 'text/html' });
            });
            for (const prefix of ['build/home', 'css', 'js']) await context.route(`**/${prefix}/**`, async route => {
                const path = new URL(route.request().url()).pathname;
                await route.fulfill({ body: await readFile(join(builtRoot, 'public', path)),
                    contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            });
        }
        await page.goto(app.url, { waitUntil: 'domcontentloaded' });
        await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
        await page.evaluate(() => document.fonts.ready);
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        const controls = [];
        const navigation = page.locator('.bp-navigation-views');
        for (const view of ['all', 'configured']) {
            await navigation.locator(`[data-navigation-view="${view}"]`).click();
            await page.waitForTimeout(260);
            controls.push({ control: `navigation-${view}`, ...await geometry(navigation) });
        }
        await navigation.screenshot({ path: join(output, `${name}-${width}-navigation.png`) });
        if (width < 760) {
            await page.locator('#taxonomy-close').click();
            await page.locator('button[data-mobile-panel="models"]').click();
        }
        const scoring = page.locator('.bp-scoring-switch');
        for (const mode of ['range', 'available', 'range', 'available']) {
            await scoring.locator(`[data-score-mode="${mode}"]`).click();
            await page.waitForTimeout(260);
            controls.push({ control: `scoring-${mode}`, ...await geometry(scoring) });
        }
        await page.locator('.bp-scoring-toolbar').screenshot({ path: join(output, `${name}-${width}-scoring.png`) });
        await page.locator('#model-card').screenshot({ path: join(output, `${name}-${width}-models.png`) });
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        const source = page.locator('.bp-mode-switch');
        for (const mode of ['personal', 'public']) {
            await page.locator(`#pie-mode-${mode}`).click();
            await page.locator(`#pie-mode-${mode}[aria-selected="true"][aria-busy="false"]`).waitFor();
            await page.waitForTimeout(260);
            controls.push({ control: `source-${mode}`, ...await geometry(source) });
        }
        await source.screenshot({ path: join(output, `${name}-${width}-source.png`) });
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        await page.locator('#user-profile').click();
        await page.locator('#experimental-comparison:not([disabled])').setChecked(true);
        await page.locator('#user-account-dialog .dialog-close-button').click();
        if (width < 760) {
            await page.locator('#taxonomy-close').click();
            await page.locator('button[data-mobile-panel="models"]').click();
        }
        await page.locator('#model-comparison-toggle').click();
        const comparison = page.locator('#model-comparison-mode');
        for (const mode of ['matched', 'best']) {
            await comparison.locator(`[data-mode="${mode}"]`).click();
            await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
            await page.waitForTimeout(260);
            controls.push({ control: `comparison-${mode}`, ...await geometry(comparison) });
        }
        await comparison.screenshot({ path: join(output, `${name}-${width}-comparison.png`) });
        await page.locator('#model-comparison-toggle').click();
        await page.locator('.bp-model-row').first().click();
        const evidence = page.locator('.bp-model-evidence-tabs');
        for (const label of ['All scores', 'Used in this ranking']) {
            await evidence.getByRole('button', { name: label, exact: true }).click();
            await page.waitForTimeout(260);
            controls.push({ control: `evidence-${label}`, ...await geometry(evidence) });
        }
        await evidence.screenshot({ path: join(output, `${name}-${width}-evidence.png`) });
        if (!record) {
            for (const control of controls) {
                assert.ok(control.buttons.every(button => button.lines === 1 && button.overflow <= 1
                    && button.textWidth <= button.availableWidth + 1), JSON.stringify(control));
                assert.ok(control.height <= (width < 760 ? 40 : 36), JSON.stringify(control));
                assert.equal(control.sliderX, control.selectedX);
                assert.equal(control.sliderWidth, control.selectedWidth);
                assert.ok(control.left >= 0 && control.right <= width, JSON.stringify(control));
            }
            for (const prefix of ['navigation', 'scoring', 'source', 'comparison', 'evidence']) {
                const values = controls.filter(control => control.control.startsWith(prefix));
                assert.ok(Math.max(...values.map(value => value.height)) - Math.min(...values.map(value => value.height)) < 1);
                assert.ok(Math.max(...values.map(value => value.width)) - Math.min(...values.map(value => value.width)) < 1);
            }
            assert.ok(controls.filter(control => control.control.startsWith('scoring'))
                .every(control => control.buttons[1].width > control.buttons[0].width + 10));
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
        }
        results.push({ name: `${name}-${width}`, passed: !record, compiled: Boolean(builtRoot), controls, pageErrors: errors });
        console.log(JSON.stringify({ name: `${name}-${width}`, recorded: record, passed: !record,
            controls: controls.map(control => ({ control: control.control, width: control.width, height: control.height,
                lines: control.buttons.map(button => button.lines) })) }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${name}-${width}-failure.png`) });
        results.push({ name: `${name}-${width}`, passed: false, error: error.stack, pageErrors: errors }); throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
