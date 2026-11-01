import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/review-concurrency-20261004';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
try {
    for (const width of [1440, 390, 320]) {
        const preview = await startPreview({ secondaryBenchmark: true });
        const page = await browser.newPage({ viewport: { width, height: 950 } });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        page.setDefaultTimeout(12000);
        const openDiscussion = async () => {
            await page.goto(preview.url);
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            await page.locator('#benchmark-scores-open:not([hidden])').waitFor();
            await page.locator('#post-discussion').filter({ hasText: 'Post message' }).waitFor({ state: 'attached' });
            await page.locator('#discussion-compose-toggle').click();
        };
        try {
            await page.goto(preview.url);
            await page.locator('.bp-model-row').first().waitFor({ state: 'attached' });
            await page.waitForTimeout(1100);
            const initialURL = page.url();
            await page.evaluate(() => {
                window.reviewHistorySentinel = 'preserved';
                history.pushState({}, '', '/?history-probe=1');
            });
            await page.goBack();
            await page.waitForURL(initialURL);
            await page.waitForTimeout(250);
            assert.equal(await page.evaluate(() => window.reviewHistorySentinel), 'preserved',
                'Workspace history must not reload the document and discard pending edits');

            await openDiscussion();
            await page.route('**/api/create_discussion_post', async route => {
                await delay(600); await route.continue();
            });
            await page.locator('#discussion-text').fill('Message being submitted');
            let posted = page.waitForResponse('**/api/create_discussion_post');
            await page.locator('#post-discussion').click();
            await page.locator('#discussion-text').fill('Keep this new draft');
            await posted;
            await page.waitForFunction(() => document.getElementById('composer-status').textContent.includes('new draft'));
            assert.equal(await page.locator('#discussion-text').inputValue(), 'Keep this new draft');
            assert.equal(await page.locator('#discussion-compose-fields').isVisible(), true);
            await page.screenshot({ path: `${output}/draft-preserved-${width}.png` });

            await page.locator('#discussion-text').fill('Another submitted message');
            posted = page.waitForResponse('**/api/create_discussion_post');
            await page.locator('#post-discussion').click();
            await page.locator('#discussion-text').fill('Keep this after closing');
            await page.locator('#discussion-close').click();
            await posted; await page.waitForTimeout(120);
            assert.equal(await page.evaluate(() => document.body.classList.contains('discussion-open')), false);
            assert.equal(await page.evaluate(() => document.activeElement.closest('#discussion-panel') !== null), false);
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            await page.locator('#discussion-text').waitFor();
            assert.equal(await page.locator('#discussion-text').inputValue(), 'Keep this after closing');
            await page.unroute('**/api/create_discussion_post');

            await page.locator('#discussion-text').click();
            await page.locator('#discussion-text').fill('@General');
            await page.locator('#mention-suggestions button').first().waitFor();
            await page.route('**/api/search_discussion_benchmarks', async route => {
                await delay(500); await route.continue();
            });
            await page.locator('#discussion-text').fill('@Unrelated');
            await page.locator('#discussion-text').press('Tab');
            assert.equal(await page.locator('#discussion-text').inputValue(), '@Unrelated');
            assert.equal(await page.locator('#composer-mentions button').count(), 0);
            await page.locator('#discussion-text').fill('@General');
            await page.locator('#mention-suggestions button').first().waitFor();
            await page.locator('#discussion-text').press('Tab');
            assert.equal(await page.locator('#composer-mentions button').count(), 1);
            await page.unroute('**/api/search_discussion_benchmarks');

            await page.route('**/api/get_discussion', async route => {
                await delay(500); await route.continue();
            });
            const context = page.locator('#posting-context select').first();
            const loaded = page.waitForResponse('**/api/get_discussion');
            await page.locator('[data-sort="hot"]').click();
            await context.selectOption('extended');
            await loaded; await page.waitForTimeout(80);
            assert.equal(await context.inputValue(), 'extended');
            await page.unroute('**/api/get_discussion');

            await page.locator('#discussion-close').click();
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            await page.locator('#benchmark-scores-open:not([hidden])').waitFor();
            if (!await page.locator('#discussion-text').isVisible()) await page.locator('#discussion-compose-toggle').click();
            await page.locator('#discussion-text').fill('Keep this when posting fails after closing');
            await page.route('**/api/create_discussion_post', async route => {
                await delay(400);
                await route.fulfill({ status: 503, contentType: 'application/json', body: '{"error":"fixture_post_failure"}' });
            });
            const failedPost = page.waitForResponse('**/api/create_discussion_post');
            await page.locator('#post-discussion').click();
            await page.locator('#discussion-close').click();
            await failedPost; await page.waitForTimeout(80);
            await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click();
            await page.waitForFunction(() => document.getElementById('composer-status').textContent.includes('draft has been kept'));
            assert.equal(await page.locator('#discussion-text').inputValue(), 'Keep this when posting fails after closing');
            await page.unroute('**/api/create_discussion_post');

            await page.goto(`${preview.url}/contribute/feedback`);
            const field = page.locator('textarea');
            await field.waitFor();
            await field.fill('x');
            await page.locator('#contribution-form').evaluate(form => form.dispatchEvent(new Event('submit', { cancelable: true })));
            await page.waitForFunction(() => !document.getElementById('submit-contribution').disabled);
            assert.equal(await page.locator('#contribution-form').evaluate(form => form.checkValidity()), false);
            await field.fill('Feedback to test concurrent submission events.');
            const before = preview.state.requests.filter(request => request.path === '/api/submit_contribution').length;
            await page.route('**/api/submit_contribution', async route => {
                await delay(400); await route.continue();
            });
            await page.locator('#contribution-form').evaluate(form => {
                form.dispatchEvent(new Event('submit', { cancelable: true }));
                form.dispatchEvent(new Event('submit', { cancelable: true }));
            });
            await page.locator('#submit-success-dialog:not([hidden])').waitFor();
            assert.equal(preview.state.requests.filter(request => request.path === '/api/submit_contribution').length - before, 1);

            await page.goto(`${preview.url}/contribute/benchmarks/new`);
            await page.locator('#contribution-page-help:not([disabled])').waitFor();
            await page.locator('#contribution-page-help').focus();
            await page.evaluate(async () => {
                const { showDialog } = await import('/js/global.js');
                window.reviewDialogs = [];
                showDialog({ title: 'First dialog', confirmLabel: 'Continue', cancelLabel: 'Cancel' })
                    .then(value => window.reviewDialogs.push({ dialog: 1, value }));
                showDialog({ title: 'Second dialog', confirmLabel: 'Continue', cancelLabel: 'Cancel' })
                    .then(value => window.reviewDialogs.push({ dialog: 2, value }));
            });
            const dialogs = page.locator('global-dialog.global-system-dialog:not([hidden])');
            await dialogs.nth(1).waitFor(); await page.waitForTimeout(60);
            for (let step = 0; step < 4; step++) {
                await page.keyboard.press(step % 2 ? 'Shift+Tab' : 'Tab');
                assert.equal(await dialogs.nth(1).evaluate(host => host.contains(document.activeElement)), true);
            }
            await page.keyboard.press('Escape');
            assert.deepEqual(await page.evaluate(() => window.reviewDialogs), [{ dialog: 2, value: false }]);
            assert.equal(await dialogs.count(), 1);
            await page.waitForFunction(() => document.querySelector('global-dialog.global-system-dialog:not([hidden])')?.contains(document.activeElement));
            assert.equal(await dialogs.first().evaluate(host => host.contains(document.activeElement)), true);
            await page.keyboard.press('Escape');
            await page.waitForTimeout(60);
            assert.deepEqual(await page.evaluate(() => window.reviewDialogs), [{ dialog: 2, value: false }, { dialog: 1, value: false }]);
            assert.equal(await page.locator('#contribution-page-help').evaluate(host => host === document.activeElement), true);

            await page.evaluate(async () => {
                const { showDialog } = await import('/js/global.js');
                void showDialog({ title: 'Underlying dialog removed while a child is open', confirmLabel: 'Continue' });
            });
            await dialogs.first().waitFor(); await page.waitForTimeout(60);
            await page.evaluate(async () => {
                const { showDialog } = await import('/js/global.js');
                void showDialog({ title: 'Surviving child', confirmLabel: 'Continue' });
            });
            await dialogs.nth(1).waitFor(); await page.waitForTimeout(60);
            await dialogs.first().evaluate(host => host.remove());
            await page.keyboard.press('Escape');
            await page.waitForFunction(() => document.activeElement.id === 'contribution-page-help');
            assert.equal(await page.locator('#contribution-page-help').evaluate(host => host === document.activeElement), true,
                'Closing a surviving dialog must restore the original trigger, not a removed parent');

            await page.locator('#contribution-page-help').click();
            const guide = page.locator('#contribution-guide-dialog');
            await guide.waitFor();
            await page.evaluate(async () => {
                const { showDialog } = await import('/js/global.js');
                void showDialog({ title: 'Above the contribution guide', confirmLabel: 'Close' });
            });
            await dialogs.first().waitFor(); await page.waitForTimeout(60);
            assert.ok(Number(await dialogs.first().evaluate(host => getComputedStyle(host).zIndex))
                > Number(await guide.evaluate(host => getComputedStyle(host).zIndex)));
            await page.keyboard.press('Escape');
            assert.equal(await guide.isVisible(), true);
            await page.keyboard.press('Escape');
            assert.equal(await guide.isVisible(), false);
            await page.waitForTimeout(60);
            assert.equal(await page.locator('#contribution-page-help').evaluate(host => host === document.activeElement), true);
            assert.deepEqual(errors, []);
            checks.push({ width, draftEditsPreserved: true, closedPostDoesNotStealFocus: true,
                staleMentionsIgnored: true, postingContextPreserved: true, singleSubmission: true,
                nestedEscape: true, modalFocusContainment: true, removedParentFocus: true,
                failedPostDraftPreserved: true, historyPreservesDocument: true, browserErrors: errors });
        } finally { await page.close(); await preview.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify({ passed: true, checks }, null, 2));
console.log(JSON.stringify({ passed: true, checks }));
