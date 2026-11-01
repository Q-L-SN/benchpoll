import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { benchmarks, models, familyEntries, weightedEntries } from './fixtures.mjs';

const output = resolve(process.env.BENCHMARK_DISCOVERY_OUTPUT ?? 'artifacts/benchmark-discovery-links-20261011/browser');
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'private/home-built.html'), 'utf8') : null;
await mkdir(output, { recursive: true });
const reports = [];
const rule = { familyID: 701, primaryConditionID: 1, mode: 'ordered',
    entries: familyEntries([{ conditionID: 901 }, { kind: 'other_versions' }, { conditionID: 3 }], 1) };
const comparisonModels = models.slice(0, 2).map((model, index) => ({ ...model, modelName: model.name,
    vendor: model.vendorName, condition: { parameters: {}, scoreFields: [] },
    results: new Map(benchmarks.filter(item => item.conditionID !== 1)
        .map(item => [String(item.conditionID), { normalizedScore: 70 - index * 4 }])) }));
const options = { secondaryBenchmark: true, sparseBenchmark: true, comparisonModels,
    personalEntries: weightedEntries([{ conditionID: 1, weightBasisPoints: 6000 }, { conditionID: 6, weightBasisPoints: 4000 }]),
    fallbackRules: [rule], families: [rule], publicFamilyComposition: [{ primaryConditionID: 1,
        families: [{ ...rule, weightBasisPoints: 10000, overallWeightBasisPoints: 2600 }] }] };
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
    && document.querySelectorAll('.bp-model-row').length);

async function closeInformation(page) {
    await page.locator('#discussion-close').click();
    await page.locator('body:not(.discussion-open)').waitFor();
}
async function inspect(page, link, app) {
    const url = new URL(await link.getAttribute('href'), app.url);
    const expected = Number(url.searchParams.get('conditionID'));
    await link.click();
    await page.locator('body.discussion-open').waitFor();
    await page.waitForFunction(() => document.querySelector('#benchmark-information')?.getAttribute('aria-busy') === 'false');
    assert.equal(app.state.requests.filter(request => request.path === '/api/get_benchmark_information').at(-1).body.conditionID, expected);
    assert.equal(await page.locator('#benchmark-information-status').innerText(), '');
    assert.equal(await page.locator('#fallback-picker').isVisible(), false);
    assert.equal(await page.locator('#model-scores-dialog').isVisible(), false);
    assert.equal(await page.locator('#version-group-dialog').isVisible(), false);
}
async function selectPrimary(page) {
    if (await page.locator('button[data-mobile-panel="mix"]').isVisible()) await page.locator('button[data-mobile-panel="mix"]').click();
    await page.locator('#weight-pie g[data-object-id="1"]').click();
    await page.locator('#inline-fallback-preview').waitFor();
}

for (const [name, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== name) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const browser = await launcher.launch({ headless: true, env });
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width, height: 1000 },
        isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${name}-${width}`;
    try {
        await context.addInitScript(() => {
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal', personalFallbackExpanded: true }));
            localStorage.setItem('benchpoll-benchmark-add-layout-v1', 'rail');
            localStorage.setItem('benchpoll-contribution-layout-v1', 'footer');
        });
        if (builtHTML) {
            await context.route('**/*', async route => {
                if (route.request().resourceType() !== 'document') return route.fallback();
                const path = new URL(route.request().url()).pathname;
                if (path === '/') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
                if (path.startsWith('/contribute/')) return route.fulfill({
                    body: await readFile(join(builtRoot, 'private/contribute.html')), contentType: 'text/html' });
                return route.fallback();
            });
            for (const prefix of ['build/home', 'css', 'js']) await context.route(`**/${prefix}/**`, async route => {
                const path = new URL(route.request().url()).pathname;
                await route.fulfill({ body: await readFile(join(builtRoot, 'public', path)),
                    contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            });
        }
        await page.goto(app.url, { waitUntil: 'domcontentloaded' }); await ready(page);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('#workspace-style-toggle, #workspace-style-menu').count(), 0);
        assert.equal(await page.locator('body').getAttribute('data-contribution-layout'), 'heading');
        assert.equal(await page.locator('#benchmark-card').getAttribute('data-add-layout'), 'label');
        assert.equal(await page.locator('#contribute-button').evaluate(node => node.parentElement.className), 'bp-benchmark-toolbar');
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        await page.locator('#user-profile').click();
        const account = page.locator('#user-account-dialog'); await account.waitFor();
        const accountFit = await account.evaluate(node => {
            const box = node.shadowRoot.querySelector('.dialog-content').getBoundingClientRect();
            return { left: box.left, right: box.right, width: innerWidth, height: box.height,
                overflow: [...node.querySelectorAll('button, strong')].filter(item => item.scrollWidth > item.clientWidth + 1).map(item => item.id) };
        });
        assert.ok(accountFit.left >= 0 && accountFit.right <= accountFit.width + 1, JSON.stringify(accountFit));
        assert.ok(accountFit.height < 420); assert.deepEqual(accountFit.overflow, []);
        await account.locator('#experimental-comparison').check();
        await page.waitForFunction(() => document.getElementById('experimental-comparison').disabled === false);
        await account.locator('#experimental-comparison').uncheck();
        await account.screenshot({ path: join(output, `${label}-account.png`) });
        await account.getByRole('button', { name: 'Close your account', exact: true }).click();
        if (width < 760) await page.locator('#taxonomy-close').click();
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        const version = page.locator('.bp-benchmark-row[data-condition-id="901"] .bp-benchmark-condition');
        await version.waitFor();
        await inspect(page, version.locator('..'), app); await closeInformation(page);
        await selectPrimary(page);
        assert.equal(await page.locator('#inline-fallback-settings').evaluate(node => getComputedStyle(node).cursor), 'pointer');
        const weights = structuredClone(app.state.personalEntries);
        const writes = app.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
        const step = page.locator('#inline-fallback-preview-sequence .bp-family-member').first();
        if (width > 760) {
            await step.hover();
            assert.equal(await step.locator('a').evaluate(node => getComputedStyle(node).textDecorationLine), 'underline');
        }
        await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-preview.png`) });
        await inspect(page, step.locator('a'), app); await closeInformation(page);
        assert.deepEqual(app.state.personalEntries, weights);
        assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, writes);
        await selectPrimary(page);
        await page.locator('#inline-fallback-edit').click();
        const finish = page.locator('#inline-fallback-done');
        assert.equal((await finish.innerText()).trim(), 'Finish editing');
        assert.equal(await finish.locator('i').count(), 0);
        assert.notEqual(await finish.evaluate(node => getComputedStyle(node).borderTopWidth), '0px');
        await page.locator('#inline-fallback-settings').screenshot({ path: join(output, `${label}-editing.png`) });
        await finish.click();
        await page.locator('#inline-fallback-preview').press('Enter');
        await page.locator('#fallback-picker').waitFor();
        await inspect(page, page.locator('.bp-fallback-picker-steps > li:nth-child(2) a').first(), app);
        await closeInformation(page); await selectPrimary(page);
        await page.locator('#inline-fallback-preview').press('Enter');
        await page.locator('.bp-fallback-picker-steps .bp-auto-version-button').first().click();
        await page.locator('#version-group-dialog').waitFor();
        await inspect(page, page.locator('.bp-version-priority-list a').first(), app);
        await closeInformation(page);
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        await page.locator('.bp-model-row').first().click();
        await page.locator('#model-scores-dialog').waitFor();
        const toggle = page.locator('.bp-model-fallback-toggle').first();
        await toggle.click();
        await page.locator('.bp-model-fallback-path:not([hidden])').first().waitFor();
        await inspect(page, page.locator('.bp-model-fallback-path:not([hidden]) a').first(), app);
        await closeInformation(page);
        await page.locator('.bp-model-row').first().click();
        await page.locator('.bp-model-evidence-tabs button').last().click();
        await page.locator('.bp-model-score-detail-benchmark a').first().waitFor();
        const scoreRow = page.locator('.bp-model-score-detail-row').first();
        if (width > 760) {
            await scoreRow.hover();
            assert.equal(await scoreRow.locator('.bp-model-score-detail-benchmark a').evaluate(node => getComputedStyle(node).textDecorationLine), 'underline');
        }
        await page.locator('#model-scores-dialog').screenshot({ path: join(output, `${label}-scores.png`) });
        await inspect(page, scoreRow.locator('.bp-model-score-detail-benchmark a'), app);
        await closeInformation(page);
        if (width < 760) await page.locator('button[data-mobile-panel="mix"]').click();
        await page.locator('#benchmark-search').fill('Nonexistent benchmark 123xyz');
        const actions = page.locator('.bp-benchmark-discovery-actions'); await actions.waitFor();
        assert.equal(await actions.locator('a').count(), 2);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.equal(await page.locator('a a, button a, button button').count(), 0);
        await page.locator('#benchmark-card').screenshot({ path: join(output, `${label}-empty.png`) });
        const manual = await actions.locator('a').first().getAttribute('href');
        const bulk = await actions.locator('a').last().getAttribute('href');
        await page.goto(new URL(manual, app.url).href, { waitUntil: 'domcontentloaded' });
        await page.locator('[data-evaluation-name]').waitFor();
        assert.equal(await page.locator('[data-evaluation-name]').inputValue(), 'Nonexistent benchmark 123xyz');
        await page.goto(new URL(bulk, app.url).href, { waitUntil: 'domcontentloaded' });
        const details = page.locator('textarea[data-field="details"]'); await details.waitFor();
        assert.match(await details.inputValue(), /Bulk import request/);
        assert.match(await details.inputValue(), /Nonexistent benchmark 123xyz/);
        assert.match(await details.inputValue(), /Category:/);
        await details.fill('Please import these benchmarks and their official scores.');
        assert.equal(await details.inputValue(), 'Please import these benchmarks and their official scores.');
        await page.goto(app.url); await ready(page);
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        await page.locator('#beta-feedback-link').click();
        await details.waitFor(); assert.match(await details.inputValue(), /Suggested change:\n\[/);
        assert.doesNotMatch(await details.inputValue(), /Steps to reproduce|What I expected/);
        await page.goto(new URL('/privacy', app.url).href);
        await page.locator('[data-privacy-request]').first().click();
        await details.waitFor(); assert.match(await details.inputValue(), /Privacy request/);
        assert.match(await details.inputValue(), /Account or record:\n\[/);
        await page.goto(new URL('/contribute/benchmarks/101/edit', app.url).href);
        await page.locator('[data-change-operation="merge"]').click();
        await details.waitFor(); assert.match(await details.inputValue(), /Merge this object:/);
        assert.match(await details.inputValue(), /Into the object to keep:\n\[/);
        assert.deepEqual(errors, []);
        reports.push({ name: label, passed: true, compiled: Boolean(builtRoot),
            assertions: 'Fixed choices, no selector, preview pointer, version hover, all modal inspection, no unintended writes, explicit Finish editing, all request templates, account panel and switch, responsive layout' });
        console.log(JSON.stringify({ name: label, passed: true }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`) });
        reports.push({ name: label, passed: false, compiled: Boolean(builtRoot), error: error.stack, errors }); throw error;
    } finally {
        await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
        await context.close(); await browser.close(); await app.close();
    }
}
