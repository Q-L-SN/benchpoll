import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries, weightedEntries } from './fixtures.mjs';

const output = resolve(process.env.PUBLIC_FALLBACK_OUTPUT ?? 'artifacts/public-fallback-modal-20261011/browser');
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'private/home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const orders = [[2], [3], [4], [5], [6], [7], [8], [{ kind: 'other_versions' }, 2],
    [3, 2], [4, 2], [5, 2], [6, 2], [7, 2], [8, 2], [2, 3]];
const rules = orders.map((values, index) => ({ primaryConditionID: 1, familyID: 100 + index, mode: 'ordered',
    entries: familyEntries(values.map(value => typeof value === 'number' ? { conditionID: value } : value)) }));
const publicFamilyComposition = [{ primaryConditionID: 1, families: [
    ...rules.slice(0, 8).map(rule => ({ ...rule, weightBasisPoints: 1000, overallWeightBasisPoints: 260 })),
    { primaryConditionID: 1, familyID: null, entries: [], weightBasisPoints: 2000, overallWeightBasisPoints: 520 }
] }];
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
    && document.querySelectorAll('.bp-model-row').length);

for (const [name, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const browser = await launcher.launch({ headless: true, env });
    const app = await startPreview({ authenticated: width !== 1024, secondaryBenchmark: true, sparseBenchmark: true,
        personalEntries: weightedEntries([{ conditionID: 2, weightBasisPoints: 5000 }, { conditionID: 3, weightBasisPoints: 5000 }]),
        families: structuredClone(rules), publicFamilyComposition: structuredClone(publicFamilyComposition) });
    const context = await browser.newContext({ viewport: { width, height: width < 760 ? 844 : 900 },
        isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const picker = page.locator('#fallback-picker');
    let failFirstPage = width === 1440;
    try {
        await context.addInitScript(() => sessionStorage.setItem('benchpoll-workspace-preferences-v1',
            JSON.stringify({ mode: 'public', publicFallbackVisible: true })));
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
        await context.route('**/api/get_ranking_page', async route => {
            if (failFirstPage && route.request().postDataJSON().list === 'fallbacks') {
                failFirstPage = false;
                await route.fulfill({ status: 503, json: { error: 'fixture_failure' } });
            } else await route.fallback();
        });
        await page.goto(app.url, { waitUntil: 'domcontentloaded' }); await ready(page);
        await page.evaluate(() => document.fonts.ready);
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        const trigger = page.locator('#public-fallback-toggle');
        await trigger.waitFor();
        assert.equal(await trigger.getAttribute('aria-expanded'), null);
        assert.equal(await trigger.getAttribute('aria-haspopup'), 'dialog');
        assert.equal(await page.locator('#inline-fallback-settings').isVisible(), false);
        assert.equal(await picker.isVisible(), false, 'Old expansion preferences must not open a dialog');
        const before = JSON.stringify([app.state.personalEntries, app.state.fallbackRules]);
        await trigger.click(); await picker.waitFor();
        assert.equal(await picker.getAttribute('data-action'), 'view');
        assert.equal(await picker.locator('.bp-fallback-picker-heading > span').innerText(), 'Public fallback configurations');
        assert.equal(await picker.locator('input, [role="radiogroup"], .is-selected').count(), 0);
        assert.equal(await picker.getByText('Custom', { exact: true }).count(), 0);
        assert.equal(await picker.locator('.bp-fallback-picker-confirm').isVisible(), false);
        assert.equal(await picker.locator('.bp-fallback-picker-custom-add').isVisible(), false);
        const more = picker.locator('.bp-fallback-picker-more');
        if (width === 1440) {
            await more.filter({ hasText: 'Retry' }).waitFor();
            assert.match(await picker.locator('.bp-fallback-picker-status').innerText(), /Could not load/);
            await more.click();
        }
        await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-more').disabled);
        for (let count = 0; count < 4 && await more.isVisible(); count++) {
            await more.click();
            await page.waitForFunction(() => !document.querySelector('.bp-fallback-picker-more').disabled);
        }
        assert.equal(await more.isVisible(), false);
        const columns = picker.locator('.bp-fallback-picker-column');
        assert.equal(await columns.count(), 16, 'All fifteen configurations and the entrance-only share are shown');
        const keys = await columns.evaluateAll(nodes => nodes.map(node => node.dataset.familyKey));
        assert.equal(new Set(keys).size, keys.length);
        assert.equal(keys[0], '[1]', 'The highest public share is first');
        assert.equal(await columns.first().locator('.bp-fallback-picker-share').innerText(), '20%\nPublic share');
        assert.equal(await picker.locator('[data-family-key="[1,2,3]"] .bp-fallback-picker-share').innerText(), 'Not in Public');
        await picker.locator('.bp-auto-version-button').click();
        await page.locator('#version-group-dialog').waitFor();
        await page.locator('#version-group-dialog .bp-version-group-close').click();
        assert.equal(await picker.isVisible(), true);
        await page.waitForFunction(() => !document.getElementById('fallback-picker').shadowRoot.querySelector('.dialog-content')
            .getAnimations().some(animation => animation.playState === 'running'));
        const bounds = await picker.evaluate(dialog => {
            const rect = dialog.shadowRoot.querySelector('.dialog-content').getBoundingClientRect();
            const actions = dialog.querySelector('[slot="actions"]').getBoundingClientRect();
            return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
                actionBottom: actions.bottom, width: innerWidth, height: innerHeight,
                overflow: document.documentElement.scrollWidth - innerWidth };
        });
        assert.ok(bounds.left >= 15 && bounds.right <= bounds.width - 15, JSON.stringify(bounds));
        assert.ok(bounds.top >= 15 && bounds.bottom <= bounds.height - 15, JSON.stringify(bounds));
        assert.ok(bounds.actionBottom <= bounds.bottom && bounds.overflow <= 1, JSON.stringify(bounds));
        await page.screenshot({ path: join(output, `${name}-${width}-public.png`) });
        await picker.locator('.bp-fallback-picker-cancel').click(); await picker.waitFor({ state: 'hidden' });
        await page.waitForFunction(() => document.activeElement?.id === 'public-fallback-toggle');
        await trigger.click(); await picker.waitFor();
        await page.keyboard.press('Escape'); await picker.waitFor({ state: 'hidden' });
        assert.equal(await page.locator('#inline-fallback-settings').isVisible(), false);
        assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 0);
        assert.equal(JSON.stringify([app.state.personalEntries, app.state.fallbackRules]), before);

        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        app.state.workspaceDelay = 1200;
        await page.locator('#workspace-refresh').click();
        await page.waitForFunction(() => document.getElementById('model-ranking-status').dataset.phase === 'updating'
            && !document.getElementById('model-ranking-status').hidden);
        const notice = page.locator('#model-ranking-status');
        const shadowBefore = await notice.evaluate(node => getComputedStyle(node).boxShadow);
        await notice.hover({ force: true });
        const shadowAfter = await notice.evaluate(node => getComputedStyle(node).boxShadow);
        assert.equal(shadowBefore, 'none'); assert.equal(shadowAfter, shadowBefore);
        await ready(page);
        await page.locator('.bp-model-row').first().click();
        const scores = page.locator('#model-scores-dialog .dialog-content');
        await scores.waitFor();
        await page.waitForFunction(() => !document.getElementById('model-scores-dialog').shadowRoot.querySelector('.dialog-content')
            .getAnimations().some(animation => animation.playState === 'running'));
        await page.mouse.move(1, 1);
        const popupShadow = await scores.evaluate(node => getComputedStyle(node).boxShadow);
        await scores.hover({ force: true });
        assert.equal(await scores.evaluate(node => getComputedStyle(node).boxShadow), popupShadow);
        assert.deepEqual(errors, []);
        results.push({ name: `${name}-${width}`, passed: true, compiled: Boolean(builtRoot), authenticated: app.state.authenticated,
            configurations: keys.length, databaseWrites: 0, noticeShadow: shadowAfter, bounds });
        console.log(JSON.stringify(results.at(-1)));
    } catch (error) {
        await page.screenshot({ path: join(output, `${name}-${width}-failure.png`) });
        results.push({ name: `${name}-${width}`, passed: false, error: error.stack, pageErrors: errors }); throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
