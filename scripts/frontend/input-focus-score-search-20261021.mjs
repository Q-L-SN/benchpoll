import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { PRIVACY_CONTENT_SECURITY_POLICY } from '../../privacy-headers.js';

const observe = process.argv.includes('--observe');
const live = process.argv.includes('--live');
const builtRoot = process.env.BUILT_APP_ROOT;
const output = resolve(process.env.FRONTEND_OUTPUT ?? 'D:/Codex-artifacts/website1/sidebar-coverage-20261021/input-focus');
await mkdir(output, { recursive: true });
const reports = [];
const cases = [['chromium', chromium, 1440], ['chromium', chromium, 390], ['webkit', webkit, 1440], ['webkit', webkit, 390]];

async function focusFrame(page, input, label) {
    await input.click();
    const result = await input.evaluate(node => {
        const frame = node.closest('.bp-ui-field, .tag-editor');
        const style = getComputedStyle(node), outer = getComputedStyle(frame);
        const swatch = document.createElement('span');
        swatch.style.cssText = 'position:absolute;background-color:var(--bp-surface-soft)';
        frame.append(swatch);
        const expected = getComputedStyle(swatch).backgroundColor;
        swatch.remove();
        return { frameColor: outer.backgroundColor, inputColor: style.backgroundColor,
            expected,
            outline: style.outlineStyle, shadow: style.boxShadow, focused: document.activeElement === node,
            frameRadius: outer.borderRadius, errorBorder: outer.borderColor };
    });
    result.label = label;
    result.uniform = result.focused && result.frameColor === result.expected
        && (result.inputColor === 'rgba(0, 0, 0, 0)' || result.inputColor === result.frameColor);
    await input.locator('..').screenshot({ path: resolve(output, `${label}.png`) });
    if (!observe) {
        assert.ok(result.uniform, `${label}: input and framed area must have one focus surface`);
        assert.equal(result.outline, 'none');
        assert.equal(result.shadow, 'none');
    }
    return result;
}

for (const [engine, launcher, width] of cases) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const label = `${engine}-${width}`;
    const app = live ? { url: 'https://benchpoll.com', close: async () => {} } : await startPreview();
    const path = live ? '/Intelligence' : '/Language-models';
    const browser = await launcher.launch({ headless: true, env: { ...process.env,
        HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760,
        hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(25000);
    const errors = [], fields = [], scopes = [];
    let formCheck = 'authenticated fixture';
    page.on('pageerror', error => errors.push(error.message));
    try {
        if (live) {
            const agent = await page.evaluate(() => navigator.userAgent);
            await context.setExtraHTTPHeaders({ 'User-Agent': `${agent} BenchPoll-QA/sidebar-coverage-20261021` });
        }
        if (builtRoot) await page.route(`${app.url}/**`, async route => {
            const pathname = new URL(route.request().url()).pathname;
            if (route.request().resourceType() === 'document' && [path, '/'].includes(pathname)) return route.fulfill({
                contentType: 'text/html', headers: { 'Content-Security-Policy': PRIVACY_CONTENT_SECURITY_POLICY },
                body: await readFile(resolve(builtRoot, 'private/home-built.html')) });
            if (pathname.startsWith('/build/home/')) return route.fulfill({ contentType: pathname.endsWith('.css') ? 'text/css' : 'text/javascript',
                body: await readFile(resolve(builtRoot, 'public', '.' + pathname)) });
            if (pathname === '/css/ui/control-policy.css') return route.fulfill({ contentType: 'text/css',
                body: await readFile(resolve(builtRoot, 'public/css/ui/control-policy.css')) });
            return route.fallback();
        });
        if (!live) await page.route('**/api/get_model_score_configurations', async route => {
            const [modelID] = route.request().postDataJSON().modelIDs;
            await route.fulfill({ json: { configurations: [1, 2].map(index => ({ modelID, modelName: 'Aster Pro',
                configurationName: `Test configuration ${index}`, scoreFields: [], scoreCount: 10 })) } });
        });
        await page.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
        await page.goto(app.url + path, { waitUntil: 'domcontentloaded' });
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        fields.push(await focusFrame(page, page.locator('#benchmark-search'), `${label}-benchmark-search`));
        if (width < 760) await page.locator('#taxonomy-toggle').click();
        await page.locator('#navigation-search-toggle').click();
        fields.push(await focusFrame(page, page.locator('#configured-search'), `${label}-category-search`));
        if (width < 760) await page.locator('#taxonomy-close').click();
        else await page.locator('#navigation-search-close').click();
        if (width < 760) await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('.bp-model-row').first().click();
        await page.locator('#model-scores-dialog').waitFor();
        const search = page.locator('#model-scores-search');
        fields.push(await focusFrame(page, search, `${label}-score-search`));
        const checkScope = async expected => {
            const placeholder = await search.getAttribute('placeholder');
            scopes.push(placeholder);
            assert.equal(await search.getAttribute('aria-label'), placeholder);
            if (!observe) assert.equal(placeholder, expected);
        };
        if (observe) scopes.push(await search.getAttribute('placeholder'));
        else {
            await checkScope('Search scores in this ranking');
            if (!live) {
                const sourceLink = page.locator('.bp-model-score-configurations .bp-model-configuration-link').first();
                if (!await sourceLink.isVisible()) await page.locator('.bp-model-score-detail-heading').first().click();
                await sourceLink.click();
                await page.locator('.bp-model-score-sample').first().waitFor();
                await checkScope('Find a source or score');
                const sampleValue = await page.locator('.bp-model-score-sample-value').first().innerText();
                await search.fill(sampleValue);
                assert.equal(await page.locator('.bp-model-score-sample:not([hidden])').count(), 1);
                await search.fill('no-such-source-zzzz');
                assert.equal(await page.locator('.bp-model-score-sample:not([hidden])').count(), 0);
                assert.equal(await page.locator('#model-scores-list .bp-model-scores-empty').innerText(), 'No matching source scores.');
                await search.clear();
                assert.equal(await page.locator('.bp-model-score-sample:not([hidden])').count(), 2);
                await page.getByRole('button', { name: 'Back to ranking calculation' }).click();
                await checkScope('Search scores in this ranking');
                await page.getByRole('button', { name: 'All scores', exact: true }).click();
                await page.locator('.bp-model-configuration-link').first().waitFor();
                await checkScope('Search model configurations');
                await search.fill('no-such-configuration-zzzz');
                assert.equal(await page.locator('#model-scores-list .bp-model-scores-empty').innerText(), 'No matching configurations.');
                await search.clear();
                await page.locator('.bp-model-configuration-link').first().click();
                await page.locator('.bp-model-score-sample').first().waitFor();
                await checkScope('Find a benchmark or version');
                await search.fill('Mathematics');
                assert.equal(await page.locator('.bp-model-score-detail-row:not([hidden])').count(), 1);
                await search.clear();
                assert.equal(await page.locator('.bp-model-score-detail-row:not([hidden])').count(), 5);
            }
        }
        await page.goto(app.url + '/contribute/benchmarks/new', { waitUntil: 'domcontentloaded' });
        await page.locator('#form-surface:not([hidden]), #auth-missing:not([hidden])').first().waitFor();
        if (live && await page.locator('#auth-missing').isVisible()) formCheck = 'sign-in required; authorized form tested in candidate';
        else {
            await page.locator('[data-evaluation-name]').waitFor();
            await page.locator('[data-evaluation-name]').fill('Focus QA Benchmark');
            const tag = page.locator('[data-tag-input]').first();
            await tag.waitFor();
            fields.push(await focusFrame(page, tag, `${label}-tag-editor`));
            await page.locator('[data-evaluation-name]').focus();
            assert.notEqual(await page.locator('[data-evaluation-name]').evaluate(node => getComputedStyle(node).backgroundColor), 'rgba(0, 0, 0, 0)');
        }
        if (!observe) {
            assert.deepEqual(errors, []);
        }
        reports.push({ label, fields, scopes, formCheck, errors });
        console.log(JSON.stringify({ label, fields, scopes, formCheck, errors }));
    } catch (error) {
        await page.screenshot({ path: resolve(output, `${label}-error.png`) }).catch(() => {});
        throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
assert.ok(reports.length);
await writeFile(resolve(output, 'results.json'), JSON.stringify(reports, null, 2));
