import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const sourceRoot = resolve(process.argv.find(arg => arg.startsWith('--source-root='))?.slice(14) ?? '.');
const output = resolve('artifacts/review-20261008/authenticated-pie-recovery-20261008/browser-' + Date.now());
await mkdir(output, { recursive: true });
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function hashes() {
    const result = {};
    async function visit(dir) {
        for (const entry of await readdir(join(sourceRoot, dir), { withFileTypes: true })) {
            const path = dir + '/' + entry.name;
            if (entry.isDirectory()) await visit(path);
            else result[path] = sha(await readFile(join(sourceRoot, path)));
        }
    }
    for (const dir of ['public/js', 'public/css', 'private']) await visit(dir);
    return result;
}
const before = await hashes(), results = [];
async function until(callback, message) {
    for (let step = 0; step < 240; step++) { if (await callback()) return; await new Promise(resolve => setTimeout(resolve, 25)); }
    throw Error(message);
}
const owned = page => page.evaluate(() => Object.keys(sessionStorage).filter(key => key.startsWith('benchpoll:owned-pie:v1:'))
    .map(key => ({ key, ...JSON.parse(sessionStorage.getItem(key)) })));
for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await driver.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [1440, 390]) for (const scenario of ['account-isolation', 'reload-pending', 'guest-adoption', 'legacy-claim', 'gesture-checkpoint']) {
            const app = await startPreview({ userID: '7', authenticated: scenario !== 'guest-adoption' });
            const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce',
                isMobile: width < 760, hasTouch: width < 760 });
            const page = await context.newPage(), errors = [], writes = [];
            page.setDefaultTimeout(10000); page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => {
                if (new URL(request.url()).pathname === '/api/save_personal_pie') writes.push({ key: request.headers()['idempotency-key'], body: request.postDataJSON() });
            });
            let failed = false, loseReceipt = scenario === 'reload-pending';
            try {
                await page.route('**/*', async route => {
                    const path = new URL(route.request().url()).pathname;
                    if (/^\/(js|css)\//.test(path)) {
                        const file = resolve(sourceRoot, 'public', '.' + path); assert.ok(file.startsWith(join(sourceRoot, 'public') + sep));
                        return route.fulfill({ body: await readFile(file), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
                    }
                    if (['/', '/Language-models', '/Intelligence'].includes(path)) return route.fulfill({
                        body: await readFile(join(sourceRoot, 'private/home.html')), contentType: 'text/html' });
                    return route.continue();
                });
                if (loseReceipt) await page.route('**/api/save_personal_pie', async route => {
                    if (!loseReceipt) return route.continue();
                    const response = await route.fetch(); assert.equal(response.status(), 200);
                    return route.fulfill({ response, json: null });
                });
                await page.goto(app.url);
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                if (scenario === 'legacy-claim') {
                    const draft = { entries: [{ conditionID: 2, weightBasisPoints: 10000 }], fallbackRules: [] };
                    await page.evaluate(draft => sessionStorage.setItem('benchpoll-guest-weights-v2-ordered',
                        JSON.stringify([['1:[["budget","standard"]]', draft]])), draft);
                    await page.reload(); await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                    await page.getByRole('button', { name: 'Recover my draft', exact: true }).waitFor();
                    assert.equal(writes.length, 0);
                    assert.equal(app.state.requests.some(item => item.body.previewPersonalPie), false);
                    await page.getByRole('button', { name: 'Recover my draft', exact: true }).click();
                    await page.getByRole('button', { name: 'Confirm and save', exact: true }).waitFor();
                    assert.equal(writes.length, 0); assert.deepEqual((await owned(page))[0].value.draft, draft);
                    assert.equal(await page.evaluate(() => JSON.parse(sessionStorage.getItem('benchpoll-guest-weights-v2-ordered')).length), 0);
                } else if (scenario === 'guest-adoption') {
                    await page.locator('#personal-pie-create').click();
                    await page.getByRole('button', { name: 'Add General knowledge to Personal Weights', exact: true }).click();
                    await page.getByRole('button', { name: 'Sign in to save', exact: true }).waitFor();
                    assert.equal(writes.length, 0);
                    app.state.authenticated = true; app.state.saveFailure = 503;
                    await page.reload(); await page.getByRole('button', { name: 'Save this mix', exact: true }).waitFor();
                    await page.getByRole('button', { name: 'Save this mix', exact: true }).click();
                    await until(() => owned(page).then(records => records.length === 1 && Boolean(records[0].value.pending)), 'Guest adoption never became account-scoped');
                    await until(() => writes.length === 1, 'No adopted save was sent');
                    app.state.authenticated = false;
                    await page.reload(); await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                    assert.equal(await page.locator('#guest-draft-notice').isVisible(), false);
                    assert.equal((await owned(page)).length, 1);
                } else {
                    await page.locator('#pie-mode-personal').click();
                    await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).waitFor();
                    if (scenario === 'gesture-checkpoint') {
                        const initial = app.state.personalEntries.find(row => row.conditionID === 1).weightBasisPoints;
                        await page.locator('#weight-pie > g[data-object-id="1"]').evaluate(element => {
                            element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        });
                        await page.locator('#weight-pie').evaluate(element => {
                            element.dispatchEvent(new WheelEvent('wheel', { deltaY: 100, bubbles: true, cancelable: true }));
                            window.dispatchEvent(new PageTransitionEvent('pagehide'));
                        });
                        const record = (await owned(page))[0]; assert.ok(record);
                        assert.notEqual(record.value.draft.entries.find(row => row.conditionID === 1).weightBasisPoints, initial);
                        assert.equal(record.value.pending, null); assert.equal(writes.length, 0);
                        await page.reload(); await page.getByRole('button', { name: 'Confirm and save', exact: true }).waitFor();
                        assert.equal(writes.length, 0); assert.deepEqual((await owned(page))[0].value.draft, record.value.draft);
                    } else {
                        if (scenario === 'account-isolation') app.state.saveFailure = 503;
                        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
                        await until(() => owned(page).then(records => Boolean(records[0]?.value.pending)), 'Pending save is not durable');
                        await until(() => page.locator('#workspace-refresh').isEnabled(), 'Save did not settle');
                        if (scenario === 'account-isolation') {
                            const aDraft = (await owned(page))[0].value.draft;
                            for (const user of ['8', null, '7']) {
                                app.state.userID = user; app.state.authenticated = user !== null;
                                app.state.requests.length = 0; const beforeWrites = writes.length;
                                await page.reload(); await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                                assert.equal(writes.length, beforeWrites, 'Reload is read-only');
                                assert.equal(app.state.requests.some(item => item.body.previewPersonalPie), user === '7');
                                assert.equal(await page.locator('#guest-draft-notice').isVisible(), user === '7');
                            }
                            assert.deepEqual((await owned(page))[0].value.draft, aDraft);
                        } else {
                            const first = writes[0]; assert.ok(first.key);
                            await page.getByRole('button', { name: 'Remove Advanced reasoning from Personal Weights', exact: true }).click();
                            const latest = (await owned(page))[0].value.draft;
                            const beforeReload = writes.length;
                            await page.reload(); await page.getByRole('button', { name: 'Confirm and save', exact: true }).waitFor();
                            assert.equal(writes.length, beforeReload); assert.deepEqual((await owned(page))[0].value.draft, latest);
                            loseReceipt = false;
                            await page.getByRole('button', { name: 'Confirm and save', exact: true }).click();
                            await until(() => owned(page).then(records => records.length === 0), 'Confirmed recovery was not retired');
                            await until(() => page.locator('#workspace-refresh').isEnabled(), 'Ranking read did not settle');
                            const replay = writes[beforeReload]; assert.equal(replay.key, first.key); assert.deepEqual(replay.body, first.body);
                            const newer = writes.at(-1); assert.notEqual(newer.key, first.key); assert.deepEqual(newer.body.entries, latest.entries);
                            assert.equal(app.state.revision, 3);
                        }
                    }
                }
                assert.deepEqual(errors, []);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.screenshot({ path: join(output, `${engine}-${width}-${scenario}.png`), fullPage: true });
                results.push({ engine, width, scenario, passed: true }); console.log(`PASS ${engine} ${width} ${scenario}`);
            } catch (error) {
                failed = true; results.push({ engine, width, scenario, passed: false, error: error.message, errors });
                await page.screenshot({ path: join(output, `${engine}-${width}-${scenario}-failure.png`), fullPage: true }).catch(() => {});
                console.error(`FAIL ${engine} ${width} ${scenario}: ${error.message}`);
            } finally { await context.close(); await app.close(); }
            if (failed && process.argv.includes('--fail-fast')) break;
        }
    } finally { await browser.close(); }
}
const after = await hashes(), sourceDrift = Object.keys(before).filter(key => before[key] !== after[key]);
const report = { sourceRoot, hashes: before, sourceDrift, results, realOAuth: false, productionBusinessDataWritten: false,
    scope: 'Actual Chromium/WebKit page reload, sessionStorage and HTTP to an isolated authenticated fixture. Desktop and touch-mobile.' };
await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
console.log(join(output, 'report.json'));
assert.equal(sourceDrift.length, 0); assert.equal(results.length, 20); assert.ok(results.every(result => result.passed));
