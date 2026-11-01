import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { resolve, join, sep } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const sourceRoot = resolve(process.argv.find(value => value.startsWith('--source-root='))?.slice(14) ?? '.');
const output = resolve('artifacts/review-20261008/personal-pie-commit-20261008/browser-' + Date.now());
await mkdir(output);
const hashes = async () => {
    const values = {};
    async function visit(directory) {
        for (const entry of await readdir(join(sourceRoot, directory), { withFileTypes: true })) {
            const path = directory + '/' + entry.name;
            if (entry.isDirectory()) await visit(path);
            else if (/\.(js|css|html)$/.test(path)) values[path] = createHash('sha256').update(await readFile(join(sourceRoot, path))).digest('hex');
        }
    }
    await visit('public/js'); await visit('public/css'); await visit('private'); return values;
};
const before = await hashes(), results = [];
async function until(action, message) {
    for (let turn = 0; turn < 200; turn++) { if (await action()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error(message);
}
for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await driver.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [1440, 390]) for (const failure of ['lost-receipt', 'ranking-read', 'revision-conflict']) {
            const app = await startPreview();
            const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
                isMobile: width < 760, hasTouch: width < 760 });
            const page = await context.newPage(), errors = [], identities = [];
            page.setDefaultTimeout(8000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => { if (request.url().endsWith('/api/save_personal_pie')) identities.push(request.headers()['idempotency-key']); });
            try {
                await page.route('**/*', async route => {
                    const path = new URL(route.request().url()).pathname;
                    if (['/', '/Language-models', '/Intelligence'].includes(path)) return route.fulfill({
                        body: await readFile(join(sourceRoot, 'private/home.html')), contentType: 'text/html' });
                    if (!/^\/(js|css)\//.test(path)) return route.continue();
                    const file = resolve(sourceRoot, 'public', '.' + path);
                    assert.ok(file.startsWith(join(sourceRoot, 'public') + sep));
                    await route.fulfill({ body: await readFile(file), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
                });
                let lose = failure === 'lost-receipt';
                await page.route('**/api/save_personal_pie', async route => {
                    if (!lose) return route.continue();
                    lose = false; const response = await route.fetch();
                    if (response.status() !== 200) {
                        errors.push(`Fixture save rejected: ${response.status()} ${await response.text()}; identity ${route.request().headers()['idempotency-key'] ?? 'absent'}`);
                        return route.fulfill({ response });
                    }
                    await route.fulfill({ response, json: null });
                });
                await page.goto(app.url);
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                await page.locator('#pie-mode-personal').click();
                await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).waitFor();
                const original = structuredClone(app.state.personalEntries), count = original.length;
                if (failure === 'ranking-read') app.state.workspaceFailure = 503;
                if (failure === 'revision-conflict') app.state.revision += 1;
                await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
                if (width < 760) await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
                const action = failure === 'revision-conflict' ? 'Review saved pie' : failure === 'ranking-read' ? 'Retry calculation' : 'Retry save';
                const retry = page.getByRole('button', { name: action, exact: true });
                await retry.waitFor(); await until(() => retry.isEnabled(), 'Recovery button never became enabled');
                assert.equal(await page.locator('.bp-personal-weight-remove').count(), count - 1, 'No visual rollback');
                assert.equal(await page.locator('#model-rows .bp-model-row').count() > 0, true, 'Last calculation stays visible');
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                const banner = await page.locator('.bp-pie-save-error').boundingBox();
                assert.ok(banner.height < 130, 'Recovery does not replace the ranking with a large empty area');
                assert.equal(app.state.requests.filter(item => item.path === '/api/save_personal_pie').length, 1);
                if (failure === 'revision-conflict') {
                    assert.deepEqual(app.state.personalEntries, original);
                    await retry.click();
                    await page.locator('#guest-draft-notice').waitFor({ state: 'visible' });
                    assert.equal(await page.locator('.bp-personal-weight-remove').count(), count - 1, 'Reload preserves the draft for explicit review');
                    assert.equal(identities.length, 1, 'Conflict review never automatically resubmits');
                } else {
                    assert.equal(app.state.personalEntries.some(entry => entry.conditionID === 1), false);
                    const revision = app.state.revision;
                    app.state.workspaceFailure = null;
                    await retry.click();
                    await page.locator('.bp-pie-save-error').waitFor({ state: 'hidden' });
                    await until(async () => !await page.locator('#workspace-refresh').isDisabled(), 'Ranking retry did not settle');
                    assert.equal(app.state.revision, revision, 'Recovery cannot repeat a committed mutation');
                    assert.equal(identities.length, failure === 'lost-receipt' ? 2 : 1);
                    if (failure === 'lost-receipt') { assert.ok(identities[0]); assert.equal(identities[0], identities[1]); }
                }
                assert.deepEqual(errors, []);
                await page.screenshot({ path: join(output, `${engine}-${width}-${failure}.png`), fullPage: true });
                results.push({ engine, width, failure, passed: true });
                console.log(`PASS ${engine} ${width} ${failure}`);
            } catch (error) {
                results.push({ engine, width, failure, passed: false, error: error.message, errors });
                await page.screenshot({ path: join(output, `${engine}-${width}-${failure}-failure.png`), fullPage: true }).catch(() => {});
                console.error(`FAIL ${engine} ${width} ${failure}: ${error.message}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
const after = await hashes(), sourceDrift = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(path => before[path] !== after[path]);
await writeFile(join(output, 'report.json'), JSON.stringify({ sourceRoot, hashes: before, sourceDrift, results,
    productionDataWritten: false, realOAuth: false, transport: 'Actual browser HTTP to isolated fixture, staged production frontend assets' }, null, 2), { flag: 'wx' });
console.log(join(output, 'report.json'));
assert.ok(results.length === 12 && results.every(result => result.passed) && sourceDrift.length === 0);
