import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { distributeToTarget } from '../../public/js/workspace/weights.js';

const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/account-writes';
const observe = process.argv.includes('--observe');
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const configuration = { mode: 'best', keys: ['model'], filters: [] };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};

async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
}

async function enableComparison(page, width) {
    if (width < 768) await page.locator('#taxonomy-toggle').click();
    await page.locator('#user-profile').click();
    await page.locator('#experimental-comparison:not([disabled])').setChecked(true);
    await page.locator('#user-account-dialog .dialog-close-button').click();
    if (width < 768) {
        await page.locator('#taxonomy-close').click();
        await page.locator('[data-mobile-panel="models"]').click();
    }
    await page.locator('#model-comparison-toggle:not([disabled])').click();
}

await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const kind of ['pie', 'comparison-queue', 'workspace-owner-change']) {
                if (process.argv.includes('--workspace-only') && kind !== 'workspace-owner-change') continue;
                for (let repetition = 1; repetition <= 2; repetition += 1) {
                    const app = await startPreview({ userID: '1' });
                    const page = await browser.newPage({ viewport: { width, height: 950 } });
                    page.setDefaultTimeout(12000);
                    const errors = [];
                    const writes = [];
                    const detectionGate = deferred();
                    const firstSaved = deferred();
                    const responseGate = deferred();
                    let accountSwitched = false;
                    let firstSaveResponse;
                    let initialPieIDs;
                    page.on('pageerror', error => errors.push(error.message));
                    try {
                        await page.route('**/api/get_user_profile', async route => {
                            if (accountSwitched) await detectionGate.promise;
                            await route.continue().catch(() => {});
                        });
                        const endpoint = kind === 'comparison-queue' ? '/api/save_comparison_profile' : '/api/save_personal_pie';
                        await page.route(`**${endpoint}`, async route => {
                            const owner = String(app.state.userID);
                            const body = route.request().postDataJSON();
                            const response = await route.fetch();
                            writes.push({ owner, body, status: response.status() });
                            if (kind === 'comparison-queue' && writes.length === 1) {
                                firstSaveResponse = response;
                                firstSaved.resolve();
                                await responseGate.promise;
                            }
                            await route.fulfill({ response });
                        });
                        await page.goto(app.url);
                        await ready(page);
                        await page.locator('#user-profile').waitFor({ state: 'attached' });
                        if (kind !== 'comparison-queue') {
                            await page.locator('#pie-mode-personal').click();
                            await page.waitForFunction(() => document.querySelector('#pie-mode-personal')?.getAttribute('aria-selected') === 'true');
                            initialPieIDs = await page.locator('#weight-pie > g[data-object-id]').evaluateAll(nodes => nodes.map(node => node.dataset.objectId));
                            if (kind === 'pie') await page.locator('.bp-benchmark-row:not(.is-family) .bp-personal-weight-remove').first().click();
                            app.state.userID = '2';
                            app.state.personalEntries = distributeToTarget(structuredClone(app.state.personalEntries.slice(2)), 10000);
                        } else {
                            await enableComparison(page, width);
                            await page.locator('#model-comparison-keys input[value="field:1"]').setChecked(true);
                            await firstSaved.promise;
                            assert.equal(firstSaveResponse.status(), 200);
                            await page.locator('#model-comparison-keys input[value="field:1"]').setChecked(false);
                            app.state.userID = '2';
                            app.state.comparisonLast = { ...configuration, keys: ['model', 'field:3'] };
                        }
                        accountSwitched = true;
                        const accountB = structuredClone(kind === 'comparison-queue' ? app.state.comparisonLast : app.state.personalEntries);
                        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
                        responseGate.resolve();
                        if (kind === 'workspace-owner-change') {
                            const loaded = page.waitForResponse('**/api/get_weighted_workspace');
                            await page.locator('#workspace-refresh').click();
                            await loaded;
                            await ready(page);
                            const remove = page.locator('.bp-benchmark-row:not(.is-family) .bp-personal-weight-remove').first();
                            if (await remove.count()) await remove.click();
                        }
                        await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
                        await page.waitForTimeout(900);
                        const after = structuredClone(kind === 'comparison-queue' ? app.state.comparisonLast : app.state.personalEntries);
                        const finalPieIDs = await page.locator('#weight-pie > g[data-object-id]').evaluateAll(nodes => nodes.map(node => node.dataset.objectId));
                        const status = await page.locator('#last-updated').textContent();
                        const guestCache = await page.evaluate(() => sessionStorage.getItem('benchpoll-guest-weights-v2-ordered'));
                        const acceptedOtherAccountWrites = writes.filter(write => write.owner === '2' && write.status === 200).length;
                        const protectedAccount = JSON.stringify(after) === JSON.stringify(accountB) && acceptedOtherAccountWrites === 0
                            && (kind !== 'workspace-owner-change' || JSON.stringify(initialPieIDs) === JSON.stringify(finalPieIDs));
                        const record = { engine, width, kind, repetition, protectedAccount, acceptedOtherAccountWrites,
                            accountBBefore: accountB, accountBAfter: after, writes, status, guestCache, initialPieIDs, finalPieIDs, errors };
                        if (kind === 'workspace-owner-change' && !observe && repetition === 1) {
                            assert.equal(await page.locator('#benchmark-rows').getByRole('button', { name: 'Refresh page', exact: true }).count(), 1);
                            await page.locator('#model-ranking-status[hidden]').waitFor({ state: 'attached' });
                            assert.notEqual(await page.locator('#model-ranking-status').getAttribute('data-phase'), 'updating');
                            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                            await page.screenshot({ path: `${output}/${engine}-${width}-account-changed.png`, fullPage: true });
                        }
                        results.push(record);
                        console.log(JSON.stringify({ engine, width, kind, repetition, protectedAccount, acceptedOtherAccountWrites }));
                        if (!observe) {
                            assert.equal(protectedAccount, true, 'The old account must never write to the replacement session');
                            assert.ok(writes.filter(write => write.owner === '2').every(write => write.body.expectedUserID === '1'));
                            assert.match(status, /account changed.*refresh/i);
                            assert.equal(guestCache, null, 'Private account edits must not become shared guest drafts');
                            assert.deepEqual(errors, []);
                        }
                    } catch (error) {
                        results.push({ engine, width, kind, repetition, harnessError: error.message, writes, errors });
                        console.log(JSON.stringify({ engine, width, kind, repetition, harnessError: error.message }));
                    } finally {
                        responseGate.resolve();
                        detectionGate.resolve();
                        await page.close();
                        await app.close();
                    }
                }
            }
        }
    } finally { await browser.close(); }
}
const passed = results.filter(result => result.protectedAccount && !result.harnessError).length;
await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Local synthetic sessions only; no production writes.',
    passed, total: results.length, results }, null, 2));
console.log(JSON.stringify({ passed, total: results.length, output }));
if (!observe && passed !== results.length) process.exitCode = 1;
