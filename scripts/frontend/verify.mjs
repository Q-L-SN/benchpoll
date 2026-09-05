import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = fileURLToPath(new URL('../../artifacts/frontend/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
async function until(condition, message, timeout = 8000) {
    const end = Date.now() + timeout;
    while (!await condition()) { if (Date.now() > end) throw new Error(message); await delay(30); }
}
async function check(name, action, options = {}) {
    const app = await startPreview(options);
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', ...options.browser });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    try {
        await action({ app, page, context });
        assert.deepEqual(pageErrors, [], 'Uncaught browser errors');
        assert.ok(!page.url().includes('/dialogPage'), 'Unexpected global error redirect');
        results.push({ name, passed: true });
        console.log(`PASS ${name}`);
    } catch (error) {
        results.push({ name, passed: false, error: error.message, pageErrors });
        await page.screenshot({ path: output + name.replaceAll(/[^a-z0-9]+/gi, '-') + '-failure.png', fullPage: true }).catch(() => {});
        console.error(`FAIL ${name}: ${error.message}`);
    } finally { await context.close(); await app.close(); }
}
async function home(page, app) {
    await page.goto(app.url);
    await page.locator('.bp-benchmark-row').first().waitFor();
    await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
}
const saves = app => app.state.requests.filter(request => request.path === '/api/save_personal_pie');
async function waitSaved(page, app, count) {
    await until(() => saves(app).length >= count && app.state.revision >= count + 1, 'Save was not persisted in fixture');
    await page.waitForFunction(() => !document.querySelector('#workspace-undo').disabled);
}
async function noOverflow(page) {
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), true, 'Page overflows horizontally');
}

try {
    await check('desktop home and evidence', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('.bp-benchmark-row').count(), 8);
        assert.equal(await page.locator('.bp-model-row').count(), 8);
        await noOverflow(page);
        const cards = await Promise.all(['#pie-card', '#benchmark-card', '#model-card'].map(selector => page.locator(selector).boundingBox()));
        assert.ok(cards[0].x + cards[0].width <= cards[1].x && cards[1].x + cards[1].width <= cards[2].x, 'Desktop panels overlap');
        await page.screenshot({ path: output + 'home-desktop.png', fullPage: true });
        await page.locator('.bp-model-row').first().focus();
        await page.keyboard.press('Enter');
        await page.locator('.bp-model-score-sample').first().waitFor();
        assert.equal(await page.locator('.bp-model-score-sample').count(), 10);
        assert.equal(await page.locator('.bp-model-score-source').first().getAttribute('href'), 'https://example.com/evidence');
        assert.ok((await page.locator('.bp-model-score-sample .bp-row-edit-action').first().getAttribute('href')).includes('targetResultID=501'));
        const list = page.locator('#model-scores-list');
        assert.ok(await list.evaluate(node => node.scrollHeight > node.clientHeight));
        await list.evaluate(node => { node.scrollTop = node.scrollHeight; });
        await page.locator('.bp-model-score-sample').last().scrollIntoViewIfNeeded();
        await page.screenshot({ path: output + 'model-evidence.png', fullPage: true });
        await page.locator('#model-scores-dialog .dialog-close-button').click();
        await page.locator('#model-scores-dialog').waitFor({ state: 'hidden' });
        await page.locator('#benchmark-search').fill('no-such-benchmark');
        assert.equal(await page.locator('#benchmark-rows').innerText(), 'No benchmarks found');
        await page.locator('#benchmark-search').fill('Reasoning');
        assert.ok(await page.locator('.bp-benchmark-row').count() >= 1);
    });

    await check('personal adjustment save undo and fallback', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        const before = structuredClone(app.state.personalEntries);
        await page.locator('#weight-pie g[data-object-id="1"]').click();
        await page.locator('#weight-pie').hover();
        await page.mouse.wheel(0, -100);
        await waitSaved(page, app, 1);
        assert.notEqual(app.state.personalEntries[0].weightBasisPoints, before[0].weightBasisPoints);
        assert.equal(saves(app)[0].body.entries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        await page.locator('#workspace-undo').click();
        await waitSaved(page, app, 2);
        assert.deepEqual(app.state.personalEntries.map(item => item.weightBasisPoints), before.map(item => item.weightBasisPoints));
        await page.locator('.bp-fallback-switch').click();
        await page.locator('#inline-fallback-chart').click();
        await page.getByRole('button', { name: 'Add Advanced reasoning to Fallback', exact: true }).click();
        await waitSaved(page, app, 3);
        assert.equal(app.state.fallbackRules[0].primaryConditionID, 1);
        assert.equal(app.state.fallbackRules[0].entries[0].conditionID, 2);
        assert.equal(app.state.fallbackRules[0].entries[0].weightBasisPoints, 10000);
        await page.screenshot({ path: output + 'personal-fallback.png', fullPage: true });
        await page.locator('.bp-fallback-switch').click();
        await waitSaved(page, app, 4);
        assert.deepEqual(app.state.fallbackRules, []);
        await page.locator('#benchmark-personal-pin').click();
        assert.equal(await page.locator('#benchmark-personal-pin').getAttribute('aria-pressed'), 'true');
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await waitSaved(page, app, 5);
        assert.ok(!app.state.personalEntries.some(item => item.conditionID === 1));
        assert.equal(app.state.personalEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
    });

    await check('save failure and revision conflict recover', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        const original = structuredClone(app.state.personalEntries);
        app.state.saveFailure = 500;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await page.getByText('Your change was not saved', { exact: true }).waitFor();
        assert.deepEqual(app.state.personalEntries, original);
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 4);
        app.state.saveFailure = 409;
        const initialLoads = app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').length;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await until(() => app.state.requests.filter(item => item.path === '/api/get_weighted_workspace').length > initialLoads, 'Conflict did not refresh workspace');
        await page.locator('.bp-benchmark-row').first().waitFor();
        assert.equal(await page.locator('.bp-personal-weight-remove').count(), 4);
    });

    await check('category switch flushes queued save and templates remain usable', async ({ app, page }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        app.state.saveDelay = 250;
        await page.getByRole('button', { name: 'Remove General knowledge from Personal Weights', exact: true }).click();
        await page.locator('[data-category-id="2"]').click();
        await until(() => app.state.requests.some(item => item.path === '/api/get_weighted_workspace' && item.body.categoryID === 2), 'Category did not load');
        const saveIndex = app.state.requests.findIndex(item => item.path === '/api/save_personal_pie');
        const nextIndex = app.state.requests.findIndex(item => item.path === '/api/get_weighted_workspace' && item.body.categoryID === 2);
        assert.ok(saveIndex >= 0 && saveIndex < nextIndex);
        assert.equal(saves(app)[0].body.categoryID, 1);
        await page.locator('.bp-template-control').click();
        await page.getByRole('option', { name: 'Extended', exact: true }).click();
        await until(() => app.state.requests.some(item => item.body.contextValues?.budget === 'extended'), 'Context choice did not load');
        await page.waitForFunction(() => document.querySelector('.bp-template-value')?.textContent === 'Extended');
    });

    await check('guest login entry and welcome keyboard', async ({ app, page }) => {
        await home(page, app);
        assert.equal(await page.locator('#login-button').isVisible(), true);
        assert.equal(await page.locator('#contribute-button').isVisible(), false);
        assert.equal(await page.locator('#personal-pie-create').isVisible(), true);
        await page.locator('#mission-welcome-trigger').click();
        await page.locator('#welcome-dialog').waitFor();
        await page.screenshot({ path: output + 'welcome.png', fullPage: true });
        await page.keyboard.press('Escape');
        await page.locator('#welcome-overlay').waitFor({ state: 'hidden' });
        assert.equal(await page.evaluate(() => localStorage.getItem('benchpoll-welcome-seen-v1')), '1');
        await page.locator('#personal-pie-create').click();
        assert.equal(saves(app).length, 0);
    }, { authenticated: false });

    await check('empty workspace', async ({ app, page }) => {
        await page.goto(app.url);
        await page.getByText('No benchmarks found', { exact: true }).waitFor();
        await page.getByText('No public model ranking is available in this context yet.', { exact: true }).waitFor();
        await page.screenshot({ path: output + 'empty-state.png', fullPage: true });
    }, { empty: true });

    await check('load failure retry and loading state', async ({ app, page }) => {
        await page.goto(app.url);
        await page.locator('.bp-error-state').first().waitFor();
        await page.screenshot({ path: output + 'error-state.png', fullPage: true });
        app.state.workspaceFailure = null;
        app.state.workspaceDelay = 500;
        await page.getByRole('button', { name: 'Retry', exact: true }).first().click();
        await page.locator('.bp-loading-state').first().waitFor();
        await page.locator('.bp-model-row').first().waitFor();
    }, { workspaceFailure: 503 });

    for (const width of [1920, 1024, 768, 390, 320]) {
        await check(`responsive ${width}`, async ({ app, page }) => {
            await home(page, app);
            await noOverflow(page);
            if (width <= 760) {
                assert.equal(await page.locator('#model-card').isVisible(), false);
                await page.locator('[data-mobile-panel="models"]').click();
                assert.equal(await page.locator('#model-card').isVisible(), true);
                await page.locator('.bp-model-row').first().click();
                await page.locator('.bp-model-score-sample').first().waitFor();
                await noOverflow(page);
                await page.screenshot({ path: output + `evidence-${width}.png`, fullPage: true });
                await page.locator('#model-scores-dialog .dialog-close-button').click();
                await page.locator('#taxonomy-toggle').click();
                await page.locator('[data-category-id="3"]').click();
                assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'false');
                await page.locator('[data-mobile-panel="mix"]').click();
            }
            await page.screenshot({ path: output + `home-${width}.png`, fullPage: true });
        }, { browser: { viewport: { width, height: width <= 760 ? 844 : 1000 }, isMobile: width <= 760, hasTouch: width <= 760 } });
    }

    const modes = ['new_benchmark', 'new_model', 'benchmark_result', 'new_category', 'correct_or_add_info', 'delete_or_migrate_category', 'feedback', 'edit_benchmark', 'edit_model', 'edit_result'];
    await check('all contribution forms and submission', async ({ app, page }) => {
        for (const mode of modes) {
            await page.goto(`${app.url}/contribute?mode=${mode}&targetBenchmarkID=101&targetModelID=301&targetResultID=501&targetName=Reasoning&parentPath=Language-models`);
            await page.locator('#form-surface').waitFor();
            assert.equal(await page.locator('#submit-error-dialog').isVisible(), false, `${mode} failed to initialize`);
            assert.ok((await page.locator('#contribution-step').innerText()).length > 20, `${mode} is empty`);
            await noOverflow(page);
            if (mode === 'new_benchmark') await page.screenshot({ path: output + 'contribution.png', fullPage: true });
        }
        await page.goto(`${app.url}/contribute?mode=feedback`);
        await page.locator('#form-surface').waitFor();
        await page.locator('textarea').first().fill('Please improve the readability of the benchmark sources.');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog').waitFor();
        const submission = app.state.requests.find(item => item.path === '/api/submit_contribution');
        assert.ok(submission, 'No contribution submitted');
        assert.ok(JSON.stringify(submission.body).includes('improve the readability'));
    });

    await check('mobile contribution and methodology', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=new_benchmark`);
        await page.locator('#form-surface').waitFor();
        await noOverflow(page);
        await page.locator('#contribution-taxonomy-toggle').click();
        await page.locator('#contribution-user').waitFor();
        assert.equal(await page.locator('#contribution-tree').getAttribute('aria-disabled'), 'true');
        await page.locator('#contribution-taxonomy-close').click();
        await page.screenshot({ path: output + 'contribution-mobile.png', fullPage: true });
        await page.goto(`${app.url}/how-it-works`);
        await noOverflow(page);
        await page.screenshot({ path: output + 'methodology-mobile.png', fullPage: true });
    }, { browser: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });

    await check('new benchmark validation and submission', async ({ app, page }) => {
        await page.goto(`${app.url}/contribute?mode=new_benchmark`);
        await page.locator('#form-surface').waitFor();
        await page.locator('[data-evaluation-name]').fill('Independent test benchmark');
        await page.locator('[data-action="add-profile"]').click();
        await page.locator('[data-condition-input]').last().fill('default');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-error-dialog').waitFor();
        assert.equal(app.state.requests.filter(item => item.path === '/api/submit_contribution').length, 0);
        await page.locator('#submit-error-dialog .dialog-close-button').click();
        await page.locator('[data-condition-input]').last().fill('pass@1');
        await page.locator('#submit-contribution').click();
        await page.locator('#submit-success-dialog').waitFor();
        assert.equal(app.state.requests.filter(item => item.path === '/api/submit_contribution').length, 1);
    });

    await check('touch weight adjustment and mobile panel state', async ({ app, page, context }) => {
        await home(page, app);
        await page.locator('#pie-mode-personal').click();
        await page.locator('#weight-pie').scrollIntoViewIfNeeded();
        const original = app.state.personalEntries[0].weightBasisPoints;
        const rect = await page.locator('#weight-pie').boundingBox();
        const x = rect.x + rect.width * .65, y = rect.y + rect.height * .6;
        const session = await context.newCDPSession(page);
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y - 45 }] });
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
        await waitSaved(page, app, 1);
        assert.notEqual(app.state.personalEntries[0].weightBasisPoints, original);
        assert.equal(app.state.personalEntries.reduce((sum, item) => sum + item.weightBasisPoints, 0), 10000);
        await page.locator('[data-mobile-panel="models"]').click();
        await page.locator('[data-mobile-panel="mix"]').click();
        assert.equal(await page.locator('#pie-mode-personal').getAttribute('aria-selected'), 'true');
    }, { browser: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } });

    await check('reviewer role and account controls', async ({ app, page }) => {
        await page.goto(`${app.url}/censor`);
        await page.locator('.log-item').waitFor();
        assert.equal(await page.locator('#messages-tab').isVisible(), false);
        await page.locator('[data-workspace-view="explorer"]').click();
        await page.getByText('No matching records.', { exact: true }).waitFor();
        assert.equal(await page.locator('#explorer-add').isVisible(), false);
        await home(page, app);
        await page.locator('#user-profile').click();
        await page.locator('#logout-button').click();
        await page.locator('.dialog-logout-this-device-button').waitFor();
        await page.locator('.dialog-logout-this-device-button').click();
        await page.locator('#logout-success-dialog').waitFor();
        assert.equal(app.state.authenticated, false);
    }, { isSenior: false });

    await check('moderation queue preview editor tabs and approval', async ({ app, page }) => {
        await page.goto(`${app.url}/censor`);
        await page.locator('.log-item').waitFor();
        await noOverflow(page);
        await page.screenshot({ path: output + 'moderation.png', fullPage: true });
        await page.locator('.log-item .action-button.preview').click();
        await page.locator('#sql-overlay').waitFor();
        await page.waitForFunction(() => document.querySelector('#sql-overlay').contains(document.activeElement));
        await page.keyboard.press('Escape');
        await page.locator('#sql-overlay').waitFor({ state: 'hidden' });
        await page.locator('.log-item .action-button.edit').click();
        await page.locator('#editor-overlay').waitFor();
        await page.keyboard.press('Escape');
        for (const view of ['explorer', 'audit', 'messages', 'queue']) {
            await page.locator(`[data-workspace-view="${view}"]`).click();
            await page.locator(`#${view}-view`).waitFor();
            if (view === 'explorer') await page.getByText('No matching records.', { exact: true }).waitFor();
            if (view === 'audit') await page.getByText('No matching audit records.', { exact: true }).waitFor();
            if (view === 'messages') await page.getByText('No messages have been sent to senior reviewers.', { exact: true }).waitFor();
        }
        await page.locator('.log-item .action-button.approve').click();
        await page.locator('global-dialog:not([hidden]) global-dialog-action.main').click();
        await until(() => app.state.logs[0].status === 'approved', 'Moderation approval not sent');
    });
} finally {
    await browser.close();
    await writeFile(output + 'results.json', JSON.stringify(results, null, 2) + '\n');
}
console.log(`${results.filter(item => item.passed).length}/${results.length} frontend checks passed`);
if (results.some(item => !item.passed)) process.exitCode = 1;
