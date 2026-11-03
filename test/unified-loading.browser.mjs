import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startCloudPreview } from '../scripts/cloud/preview.mjs';
import { serveHarness } from './model-scores-all.browser.mjs';
import { AA_DISPLAY_RESTRICTION } from '../public/js/shared/aa-ranking-policy.js';
import { startSignInFixture } from './fixtures/sign-in-server.mjs';

const output = 'artifacts/unified-loading-20261103';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
await mkdir(output, { recursive: true });

for (const [engine, width, built] of [[chromium, 1440, false], [webkit, 390, false], [chromium, 390, true]]) {
    test(`unified loading ${engine.name()} ${width} ${built ? 'built' : 'source'}`, { timeout: 60000 }, async t => {
        const app = await startCloudPreview({ port: 0, host: '127.0.0.1', built });
        const browser = await engine.launch({ headless: true });
        const gate = deferred(), errors = [];
        t.after(async () => { gate.resolve(); await browser.close(); await app.close(); });
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/get_topics', async route => { await gate.promise; await route.continue(); });
        await page.goto(app.url, { waitUntil: 'commit' });
        const pending = page.locator('#topics-status .bp-spinner');
        await pending.waitFor();
        await page.waitForFunction(() => getComputedStyle(document.querySelector('#topics-status .bp-loading-label')).clipPath === 'inset(50%)');
        assert.equal(await page.locator('#topics-status .bp-loading-label').evaluate(node => getComputedStyle(node).clipPath), 'inset(50%)');
        assert.match(await page.locator('#topics-status .bp-loading-label').textContent(), /Loading topics/);
        assert.equal(await pending.evaluate(node => getComputedStyle(node).animationName), 'bp-spinner-turn');
        const size = await pending.boundingBox();
        assert.ok(size.width >= 16 && Math.abs(size.width - size.height) < 1);
        await page.screenshot({ path: `${output}/topics-${engine.name()}-${width}-${built}.png` });
        gate.resolve();
        await page.locator('#topics-grid[aria-busy="false"]').waitFor();
        await page.locator('.th-card[data-preview-state="loaded"]').first().waitFor();
        assert.equal(await page.locator('#topics-status').isVisible(), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

        // Busy actions keep their width, original nodes and focus through success or failure.
        const buttonResult = await page.evaluate(async () => {
            const { setButtonLoading } = await import('/js/shared/loading.js');
            const button = document.createElement('button'); button.className = 'bp-ui-action';
            const label = document.createElement('span'); label.textContent = 'Save changes'; button.append(label);
            document.body.append(button); button.focus();
            const before = button.getBoundingClientRect().width;
            setButtonLoading(button, true, 'Saving changes');
            setButtonLoading(button, true, 'Confirming changes');
            const during = button.getBoundingClientRect().width;
            const result = { before, during, rings: button.querySelectorAll('.bp-spinner').length,
                text: button.innerText, label: button.querySelector('.bp-loading-label').textContent };
            setButtonLoading(button, false);
            Object.assign(result, { restored: button.firstChild === label, busy: button.hasAttribute('aria-busy'),
                focused: document.activeElement === button, after: button.getBoundingClientRect().width });
            button.remove(); return result;
        });
        assert.equal(buttonResult.rings, 1);
        assert.equal(buttonResult.text.includes('Save changes'), false);
        assert.equal(buttonResult.label, 'Confirming changes');
        assert.ok(Math.abs(buttonResult.before - buttonResult.during) < 1);
        assert.equal(buttonResult.before, buttonResult.after);
        assert.equal(buttonResult.restored, true); assert.equal(buttonResult.focused, true); assert.equal(buttonResult.busy, false);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        assert.equal(await page.evaluate(async () => {
            const { createLoadingIndicator } = await import('/js/shared/loading.js');
            const indicator = createLoadingIndicator(); document.body.append(indicator);
            const animation = getComputedStyle(indicator.querySelector('.bp-spinner')).animationName; indicator.remove(); return animation;
        }), 'none');
        assert.deepEqual(errors, []);
    });
}

for (const [engine, width] of [[chromium, 1440], [webkit, 390]]) {
    test(`All scores loading, retry and empty parameters ${engine.name()} ${width}`, { timeout: 60000 }, async t => {
        const app = await serveHarness(), browser = await engine.launch({ headless: true });
        const gate = deferred(), errors = [];
        t.after(async () => { gate.resolve(); await browser.close(); await app.close(); });
        const page = await browser.newPage({ viewport: { width, height: 900 } });
        page.setDefaultTimeout(10000);
        page.on('pageerror', error => errors.push(error.message));
        const group = { benchmarkID: 1, benchmarkName: 'Mathematics', benchmarkConditionID: 101,
            benchmarkConditionName: 'v2', benchmarkConditionIsDefault: false, usesPercentageScale: true,
            medianRawScore: 70, medianNormalizedScore: 70, sampleCount: 1, distinctScoreCount: 1 };
        const configurations = [[], [{ fieldID: 20, value: 1 }]].map(scoreFields => ({ modelID: 71,
            modelName: 'Evidence Model', configurationName: scoreFields.length ? 'Reasoning effort=High' : '',
            scoreFields, scoreCount: 1, scoreGroups: [group] }));
        let failing = false;
        await page.route('**/api/**', async route => {
            if (route.request().url().endsWith('/get_model_score_configurations')) {
                await gate.promise;
                return route.fulfill({ status: failing ? 503 : 200, contentType: 'application/json',
                    body: JSON.stringify(failing ? { error: 'temporarily_unavailable' }
                        : { displayPolicy: AA_DISPLAY_RESTRICTION, omittedConfigurations: [], configurations }) });
            }
            return route.fulfill({ contentType: 'application/json', body: '{}' });
        });
        await page.goto(app.url, { waitUntil: 'commit' });
        await page.getByRole('button', { name: 'All scores', exact: true }).click();
        await page.locator('#model-scores-summary .bp-spinner').waitFor();
        assert.equal(await page.locator('#model-scores-summary .bp-loading-label').evaluate(node => getComputedStyle(node).clipPath), 'inset(50%)');
        gate.resolve();
        const empty = page.locator('.bp-model-empty-fields'); await empty.waitFor();
        assert.equal(await empty.textContent(), 'No fields recorded');
        const layout = await empty.evaluate(node => {
            const parent = node.parentElement, name = parent.querySelector('.bp-model-display-name');
            const parameter = document.querySelector('.bp-model-parameters .bp-model-display-parameter');
            const style = getComputedStyle(node), other = getComputedStyle(parameter);
            const a = name.getBoundingClientRect(), b = node.getBoundingClientRect();
            return { font: style.fontSize, parameterFont: other.fontSize, color: style.color, parameterColor: other.color,
                gap: b.left - a.right, wrapped: b.top >= a.bottom, overflow: parent.scrollWidth > parent.clientWidth + 1 };
        });
        assert.equal(layout.font, layout.parameterFont); assert.equal(layout.color, layout.parameterColor);
        assert.ok(layout.wrapped || layout.gap >= 6); assert.equal(layout.overflow, false);
        const heading = empty.locator('..').locator('..');
        await heading.click();
        await page.locator('.bp-model-configuration-evidence .bp-model-score-detail-row').first().waitFor();
        await page.screenshot({ path: `${output}/all-scores-${engine.name()}-${width}.png` });
        await page.getByRole('button', { name: 'Used in this ranking', exact: true }).click();
        failing = true;
        await page.getByRole('button', { name: 'All scores', exact: true }).click();
        await page.getByText('All scores could not be loaded.', { exact: true }).waitFor();
        assert.equal(await page.locator('#model-scores-summary .bp-spinner').count(), 0);
        failing = false;
        await page.getByRole('button', { name: 'Retry', exact: true }).click();
        await empty.waitFor();
        assert.deepEqual(errors, []);
    });
}

test('sign-in progress clears into an actionable error and can retry', { timeout: 30000 }, async t => {
    const app = await startSignInFixture(), browser = await chromium.launch({ headless: true });
    const releaseStatus = app.state.hold('/api/get_privacy_status');
    const releaseLogin = app.state.hold('/api/prepare_github_login');
    t.after(async () => { releaseStatus(); releaseLogin(); await browser.close(); await app.close(); });
    const page = await browser.newPage({ viewport: { width: 390, height: 900 } });
    page.setDefaultTimeout(10000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await page.goto(new URL('/github_login', app.url).href, { waitUntil: 'commit' });
    const indicator = page.locator('#sign-in-status .bp-spinner'); await indicator.waitFor();
    assert.equal(await page.locator('#sign-in-submit').isDisabled(), true);
    releaseStatus();
    await page.waitForFunction(() => !document.querySelector('#sign-in-submit').disabled);
    assert.equal(await indicator.count(), 0);
    app.state.responses.set('/api/prepare_github_login', [{ code: 503, body: { error: 'temporarily_unavailable' } }]);
    await page.locator('#sign-in-submit').click();
    await indicator.waitFor();
    await page.screenshot({ path: `${output}/sign-in-390.png` });
    releaseLogin();
    await page.getByText('GitHub sign-in could not be opened. Please try again.', { exact: true }).waitFor();
    assert.equal(await indicator.count(), 0);
    assert.equal(await page.locator('#sign-in-submit').isDisabled(), false);
    assert.deepEqual(errors, []);
});
