import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const observe = process.argv.includes('--observe');
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/ranking-page-race';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const results = [];
await mkdir(output, { recursive: true });

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const list of ['benchmarks', 'public']) {
                for (const outcome of ['failed-reload', 'pending-reload'].filter(value => !only || value === only)) {
                    for (let repetition = 1; repetition <= 2; repetition++) {
                        const app = await startPreview({ rankingStress: true });
                        const page = await browser.newPage({ viewport: { width, height: 960 } });
                        page.setDefaultTimeout(10000);
                        const record = { engine, width, list, outcome, repetition, passed: false, errors: [] };
                        results.push(record);
                        let releasePage, releaseWorkspace;
                        const pageGate = new Promise(resolve => { releasePage = resolve; });
                        const workspaceGate = new Promise(resolve => { releaseWorkspace = resolve; });
                        let heldPage = null, refreshing = false, reloadRequests = 0;
                        const pageRequests = [];
                        try {
                            page.on('pageerror', error => record.errors.push(error.message));
                            await page.route('**/api/get_ranking_page', async route => {
                                const body = route.request().postDataJSON();
                                pageRequests.push(body);
                                if (body.list !== list || heldPage) return route.continue();
                                const response = await route.fetch();
                                const payload = await response.json();
                                payload.items.forEach(item => { item.name += ' [stale-page fixture]'; });
                                heldPage = { body, payload };
                                await pageGate;
                                await route.fulfill({ response, json: payload });
                            });
                            await page.route('**/api/get_weighted_workspace', async route => {
                                if (!refreshing) return route.continue();
                                reloadRequests++;
                                if (outcome === 'failed-reload') return route.fulfill({ status: 503, json: { error: 'fixture_reload_failure' } });
                                await workspaceGate;
                                return route.continue();
                            });
                            await page.goto(app.url);
                            await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                            if (width < 768) await page.locator(`button[data-mobile-panel="${list === 'public' ? 'models' : 'mix'}"]`).click();
                            const container = list === 'public' ? '#model-rows' : '#benchmark-rows';
                            const rows = `${container} ${list === 'public' ? '.bp-model-row' : '.bp-benchmark-row'}`;
                            await page.locator(rows).first().waitFor();
                            record.initialRows = await page.locator(rows).count();
                            if (width < 768) await page.locator(`${container} .bp-ranking-page-footer`).scrollIntoViewIfNeeded();
                            else await page.locator(container).evaluate(node => { node.scrollTop = node.scrollHeight; });
                            for (let attempt = 0; !heldPage && attempt < 50; attempt++) await page.waitForTimeout(100);
                            assert.ok(heldPage, 'A genuine next-page request must be paused');
                            record.heldRequest = heldPage.body;
                            refreshing = true;
                            await page.locator('#workspace-refresh').click();
                            if (outcome === 'failed-reload') await page.locator(`${container} .bp-error-state`).waitFor();
                            else await page.locator('#benchmark-card[aria-busy="true"]').waitFor({ state: 'attached' });
                            record.beforeRelease = { rows: await page.locator(rows).count(),
                                errorStates: await page.locator(`${container} .bp-error-state`).count() };
                            const staleResponse = page.waitForResponse(response => response.url().endsWith('/api/get_ranking_page')
                                && response.request().postDataJSON().snapshotID === heldPage.body.snapshotID
                                && response.request().postDataJSON().list === list);
                            releasePage();
                            await staleResponse;
                            await page.waitForTimeout(400);
                            record.afterRelease = { rows: await page.locator(rows).count(),
                                errorStates: await page.locator(`${container} .bp-error-state`).count(),
                                staleRows: await page.locator(rows).filter({ hasText: '[stale-page fixture]' }).count() };
                            record.reloadRequests = reloadRequests;
                            record.passed = record.afterRelease.staleRows === 0
                                && (outcome !== 'failed-reload' || record.afterRelease.errorStates === 1);
                            if (!observe) {
                                assert.deepEqual(record.errors, []);
                                assert.equal(record.afterRelease.staleRows, 0, 'The previous snapshot must not append during a reload');
                                if (outcome === 'failed-reload') {
                                    assert.equal(record.afterRelease.errorStates, 1, 'A stale page must not erase the reload error');
                                    const count = pageRequests.length;
                                    await page.locator(container).dispatchEvent('scroll');
                                    await page.waitForTimeout(250);
                                    assert.equal(pageRequests.length, count, 'Failed contexts must not resume the old snapshot on scroll');
                                    refreshing = false;
                                    await page.locator(`${container} .bp-error-state button`).click();
                                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                                    await page.locator(rows).first().waitFor();
                                    record.recovered = await page.locator(`${container} .bp-error-state`).count() === 0;
                                    assert.equal(record.recovered, true, 'A full retry must restore the workspace');
                                }
                                else {
                                    assert.equal(record.afterRelease.rows, record.beforeRelease.rows);
                                    releaseWorkspace();
                                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                                    await page.locator(rows).first().waitFor();
                                    assert.equal(await page.locator(rows).filter({ hasText: '[stale-page fixture]' }).count(), 0);
                                }
                                const currentRows = await page.locator(rows).count();
                                if (await page.locator(`${container} .bp-ranking-page-footer`).count()) {
                                    const more = page.waitForResponse(response => response.url().endsWith('/api/get_ranking_page')
                                        && response.request().postDataJSON().list === list);
                                    if (width < 768) await page.locator(`${container} .bp-ranking-page-footer`).scrollIntoViewIfNeeded();
                                    else await page.locator(container).evaluate(node => { node.scrollTop = node.scrollHeight; });
                                    const response = await more;
                                    assert.equal(response.status(), 200);
                                    assert.notEqual(response.request().postDataJSON().snapshotID, heldPage.body.snapshotID);
                                    await page.waitForFunction(({ rows, count }) => document.querySelectorAll(rows).length > count,
                                        { rows, count: currentRows });
                                    record.freshPagination = true;
                                }
                                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                            }
                            if (repetition === 1) await page.screenshot({ path: `${output}/${engine}-${width}-${list}-${outcome}.png`, fullPage: true });
                        } catch (error) { record.passed = false; record.error = error.message; }
                        finally {
                            releasePage(); releaseWorkspace();
                            console.log(JSON.stringify(record));
                            await page.close(); await app.close();
                        }
                    }
                }
            }
        }
    } finally { await browser.close(); }
}
const passed = results.filter(result => result.passed).length;
await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Synthetic delayed pagination. No production mutations.', passed,
    total: results.length, results }, null, 2));
console.log(JSON.stringify({ passed, total: results.length, output }));
if (!observe && passed !== results.length) process.exitCode = 1;
