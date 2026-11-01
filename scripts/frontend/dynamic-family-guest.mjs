import assert from 'node:assert/strict';
import { chromium, webkit } from 'playwright';
import { mkdir, writeFile } from 'node:fs/promises';
import { startPreview } from './server.mjs';
const output = 'artifacts/dynamic-families-20261005/ui';
await mkdir(output, { recursive: true });
const results = [];
for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const app = await startPreview({ authenticated: false });
    const browser = await engine.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(20000);
    if (process.env.FAMILY_TEST_URL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    const keys = () => page.locator('.bp-family-member').evaluateAll(rows => rows.map(row => row.dataset.conditionId.replace(/^other:\d+$/, 'other_versions')));
    const settled = () => page.waitForFunction(() => !document.querySelector('#inline-fallback-save-retry').disabled);
    try {
        await page.goto(process.env.FAMILY_TEST_URL ?? app.url);
        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
        await page.locator('#personal-pie-create').tap();
        await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-add').tap(); await settled();
        await page.locator('#inline-fallback-toggle').tap();
        await page.locator('#inline-fallback-add-other-versions').tap(); await settled();
        assert.deepEqual(await keys(), ['other_versions']);
        await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="2"] .bp-benchmark-add').tap(); await settled();
        await page.getByRole('button', { name: 'Move Advanced reasoning earlier', exact: true }).focus();
        await page.keyboard.press('Enter'); await settled();
        assert.deepEqual(await keys(), ['2', 'other_versions']);
        await page.locator('#workspace-undo').tap(); await settled();
        assert.deepEqual(await keys(), ['other_versions', '2']);
        assert.equal(await page.locator('#workspace-redo').isVisible(), true);
        await page.locator('#workspace-redo').tap(); await settled();
        assert.deepEqual(await keys(), ['2', 'other_versions']);
        assert.equal(await page.locator('#workspace-redo').isVisible(), false);
        await page.reload(); await settled();
        await page.locator('.bp-family-member').first().waitFor();
        assert.deepEqual(await keys(), ['2', 'other_versions']);
        assert.equal(await page.locator('#guest-draft-notice').isVisible(), true);
        assert.equal(app.state.requests.some(request => request.path === '/api/save_personal_pie'), false);
        app.state.authenticated = true;
        await page.goto((process.env.FAMILY_TEST_URL ?? app.url).replace(/\/$/, '') + '/contribute/benchmarks/new');
        await page.locator('[data-evaluation-name]').waitFor();
        const sizes = await page.locator('.evaluation-name-field > span, .condition-section-heading h3').evaluateAll(elements =>
            elements.map(element => ({ size: getComputedStyle(element).fontSize, weight: getComputedStyle(element).fontWeight })));
        assert.equal(sizes.length, 2); assert.deepEqual(sizes[1], sizes[0]);
        assert.equal(await page.locator('.condition-section-heading h3').textContent(), 'Versions');
        assert.deepEqual(errors, []);
        results.push({ engine: name, guestReload: true, keyboardOrder: true, undoRedo: true, uniformFieldTitles: true });
        console.log('PASS guest-' + name);
    } finally { await browser.close(); await app.close(); }
}
await writeFile(output + '/guest-checks.json', JSON.stringify({ passed: true, results }, null, 2));
