import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, weightedEntries } from './fixtures.mjs';

const output = process.env.UI_DISCUSSION_OUTPUT ?? 'D:/Codex-artifacts/website1/ui-discussion-20261012/browser';
await mkdir(output, { recursive: true });
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const results = [];
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
const rule = { primaryConditionID: 1, familyID: 100, mode: 'ordered',
    entries: familyEntries([{ conditionID: 2 }, { kind: 'other_versions' }, { conditionID: 3 }]) };
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const app = await startPreview({ secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]),
        fallbackRules: [structuredClone(rule)], families: [structuredClone(rule)] });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760,
        hasTouch: width < 760, reducedMotion: 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${engine}-${width}${builtHTML ? '-built' : ''}`;
    try {
        if (engine === 'webkit' || builtHTML) await page.route(`${app.url}/**`, async route => {
            const url = new URL(route.request().url());
            if (builtHTML && route.request().resourceType() === 'document' && url.pathname === '/') {
                await route.fulfill({ body: builtHTML, contentType: 'text/html' }); return;
            }
            if (builtHTML && url.pathname.startsWith('/build/home/')) {
                await route.fulfill({ body: await readFile(join(builtRoot, url.pathname.slice(1))),
                    contentType: url.pathname.endsWith('.css') ? 'text/css' : 'text/javascript' }); return;
            }
            if (engine !== 'webkit') return route.fallback();
            const response = await route.fetch(); await route.fulfill({ response, body: await response.body() });
        });
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', personalFallbackExpanded: true }));
        });
        await page.goto(app.url); await ready(page); await page.evaluate(() => document.fonts.ready);
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        const preview = page.locator('#inline-fallback-preview'); await preview.waitFor();
        assert.equal(await preview.locator('.bp-family-order').count(), 0);
        assert.equal(await preview.locator('.bp-fallback-chain-step').count(), 3);
        assert.equal(await preview.locator('.fa-chevron-right').count(), 0);
        assert.equal(await preview.locator('.bp-family-actions, .bp-family-drag').count(), 0);
        assert.equal(await page.locator('#inline-fallback-configurations').count(), 0);
        assert.equal(await preview.locator('li.bp-family-connection .fa-link').count(), 1);
        await preview.screenshot({ path: join(output, `${label}-chain-preview.png`) });
        await page.locator('#inline-fallback-edit').click();
        const editor = page.locator('#inline-fallback-chart'); await editor.waitFor();
        assert.equal(await editor.locator('a').count(), 0);
        assert.equal(await page.locator('#inline-fallback-entrance a').count(), 0);
        assert.equal(await editor.locator('.fa-trash-can').count(), 3);
        assert.equal(await editor.locator('.fa-xmark').count(), 0);
        assert.equal(await editor.locator('.is-automatic-group').evaluate(node => getComputedStyle(node).borderBottomLeftRadius), '0px');
        const firstName = editor.locator('.bp-family-member-name').first();
        await firstName.click(); assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'true');
        await editor.locator('[data-family-focus="up-3"]').click();
        const movement = await editor.locator('.bp-family-member').evaluateAll(rows => rows.flatMap(row => row.getAnimations()
            .map(animation => ({ duration: animation.effect.getTiming().duration, frames: animation.effect.getKeyframes().map(frame => frame.transform) }))));
        assert.ok(movement.some(animation => animation.duration === 160 && animation.frames[0] !== 'translateY(0px)'), JSON.stringify(movement));
        await page.waitForFunction(() => !document.querySelector('#inline-fallback-chart').getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
        await editor.locator('[data-family-focus="down-3"]').click();
        await page.waitForFunction(() => !document.querySelector('#inline-fallback-chart').getAnimations({ subtree: true }).some(animation => animation.playState === 'running'));
        const handle = editor.locator('.bp-family-drag').first(); await handle.hover();
        const bounds = await handle.boundingBox();
        await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
        await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2 + 8);
        assert.equal(await editor.locator('.bp-family-chain').evaluate(node => node.classList.contains('is-reordering')), true);
        assert.deepEqual(await editor.locator('.bp-family-connection').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).display)), ['none']);
        await page.mouse.up();
        await page.waitForFunction(() => [...document.querySelectorAll('#inline-fallback-chart .bp-family-connection')]
            .every(node => getComputedStyle(node).display === 'flex'));
        await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-editing.png`) });
        await page.locator('#inline-fallback-done').click(); await preview.waitFor();
        await preview.press('Enter'); await page.locator('#fallback-picker').waitFor();
        await page.locator('#fallback-picker .dialog-close-button').click();
        assert.equal(await preview.locator('a').count(), 0);
        await preview.locator('.bp-benchmark-link-name').first().click(); await page.locator('#fallback-picker').waitFor();
        await page.locator('#fallback-picker .bp-benchmark-information-link').first().click();
        await page.locator('#benchmark-information-name').waitFor();
        assert.equal(await page.locator('#discussion-brand-slot .bp-brand').isVisible(), true);
        assert.equal(await page.locator('#workspace-brand-slot .bp-brand').count(), 0);
        await page.locator('#discussion-compose-toggle').click();
        await page.locator('#discussion-text').fill('The fallback version has a different evaluation protocol.');
        await page.locator('#post-discussion').click();
        await page.waitForFunction(() => document.querySelector('#composer-status').textContent.includes('Posted'));
        assert.equal(app.state.requests.filter(request => request.path === '/api/create_discussion_post').length, 1);
        await page.locator('#discussion-close').click();
        assert.equal(await page.locator('.bp-sidebar > .bp-brand').isVisible(), true);
        const typography = await page.locator('#last-updated').evaluate(node => ({ font: getComputedStyle(node).fontFamily,
            inherited: getComputedStyle(node.parentElement).fontFamily, size: getComputedStyle(node).fontSize }));
        assert.equal(typography.font, typography.inherited); assert.equal(typography.size, '12px');
        await page.goto(`${app.url}/how-it-works`);
        await page.goto(`${app.url}/contribute/feedback`); await page.locator('.feedback-editor textarea').waitFor();
        assert.equal(await page.locator('.contribution-breadcrumb').count(), 0);
        const form = await page.locator('.feedback-editor textarea').evaluate(node => ({ height: node.getBoundingClientRect().height,
            overflow: document.documentElement.scrollWidth - innerWidth, resize: getComputedStyle(node).resize }));
        assert.ok(form.height >= 340, JSON.stringify(form)); assert.ok(form.overflow <= 1, JSON.stringify(form));
        assert.equal(form.resize, 'vertical');
        await page.locator('.feedback-editor textarea').focus();
        assert.deepEqual(await page.locator('.feedback-editor textarea').evaluate(node => ({
            outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow
        })), { outline: 'none', shadow: 'none' });
        const sidebarAlignment = await page.locator('.contribution-sidebar-actions .bp-sidebar-action').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).justifyContent));
        assert.ok(sidebarAlignment.every(value => value === 'flex-start'), JSON.stringify(sidebarAlignment));
        await page.screenshot({ path: join(output, `${label}-plaintext-form.png`), fullPage: true });
        if (width < 760) await page.locator('#contribution-taxonomy-toggle').click();
        await page.locator('#contribution-back').click(); await page.waitForURL(`${app.url}/how-it-works`);
        assert.deepEqual(errors, []);
        results.push({ label, passed: true, movement, form, typography, webkitBufferedLocalhost: engine === 'webkit' });
        console.log(JSON.stringify({ label, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {}); throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, builtHTML ? 'verification-built.json' : 'verification.json'), JSON.stringify(results, null, 2));
