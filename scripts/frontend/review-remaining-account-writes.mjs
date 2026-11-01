import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { discussionFixture } from './discussions.mjs';

const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/remaining-account-writes';
const observe = process.argv.includes('--observe');
const normal = process.argv.includes('--normal');
const only = process.argv.find(value => value.startsWith('--only='))?.slice(7);
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const deferred = () => {
    let resolve;
    const promise = new Promise(done => { resolve = done; });
    return { promise, resolve };
};
const endpoints = {
    contribution: '/api/submit_contribution', 'inline-option': '/api/submit_contribution',
    'contribution-delete': '/api/delete_account', 'home-delete': '/api/delete_account',
    'contribution-logout': '/api/logout', 'home-logout': '/api/logout',
    'discussion-post': '/api/create_discussion_post', 'discussion-vote': '/api/vote_discussion',
    'discussion-delete': '/api/delete_discussion_post',
    'discussion-read-rebind': '/api/create_discussion_post', 'private-category': '/api/create_private_category'
};

await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const kind of Object.keys(endpoints).filter(value => !only || value === only)) {
                for (let repetition = 1; repetition <= 2; repetition++) {
                    const app = await startPreview({ userID: '1' });
                    if (kind === 'discussion-delete') {
                        discussionFixture('/api/get_discussion_summary', {}, app.state);
                        app.state.discussionPosts[0].isOwn = true;
                    }
                    const page = await browser.newPage({ viewport: { width, height: 960 } });
                    page.setDefaultTimeout(7000);
                    const errors = [], writes = [];
                    const detectionGate = deferred();
                    let switched = false;
                    let draft;
                    try {
                        await page.route('**/api/get_user_profile', async route => {
                            if (switched) await detectionGate.promise;
                            await route.continue().catch(() => {});
                        });
                        await page.route(`**${endpoints[kind]}`, async route => {
                            const owner = String(app.state.userID);
                            const body = route.request().postDataJSON();
                            const response = await route.fetch();
                            writes.push({ owner, body, status: response.status(), result: await response.json().catch(() => null) });
                            await route.fulfill({ response });
                        });
                        page.on('pageerror', error => errors.push(error.message));
                        let trigger;
                        if (kind.startsWith('contribution')) {
                            await page.goto(`${app.url}/contribute/feedback`);
                            await page.locator('#form-surface:not([hidden])').waitFor();
                            draft = page.locator('[data-bind="feedback"][data-field="details"]');
                            await draft.fill('Keep this account A feedback draft intact.');
                            if (kind === 'contribution') trigger = page.locator('#submit-contribution');
                            else {
                                if (width < 500) await page.locator('#contribution-taxonomy-toggle').click();
                                await page.locator('#contribution-user').click();
                                await page.locator(kind === 'contribution-delete' ? '#contribution-account-delete' : '#contribution-account-logout').click();
                                trigger = page.locator(kind === 'contribution-delete' ? '#contribution-delete-confirm' : '#contribution-logout-confirm');
                            }
                        } else if (kind === 'inline-option') {
                            await page.goto(`${app.url}/contribute/scores/new`);
                            await page.locator('#form-surface:not([hidden])').waitFor();
                            await page.getByRole('searchbox', { name: 'Search score fields' }).fill('Harness');
                            await page.getByRole('button', { name: 'Harness', exact: true }).click();
                            await page.locator('.score-field-value summary').click();
                            await page.getByRole('searchbox', { name: 'Harness options' }).fill('Account A new harness');
                            trigger = page.getByRole('button', { name: /Propose.*Account A new harness/ });
                        } else {
                            await page.goto(app.url);
                            await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                            await page.locator('#user-profile:not([hidden])').waitFor({ state: 'attached' });
                            if (kind === 'home-delete' || kind === 'home-logout') {
                                if (width < 500) await page.locator('#taxonomy-toggle').click();
                                await page.locator('#user-profile').click();
                                await page.locator(kind === 'home-delete' ? '#delete-account-button' : '#logout-button').click();
                                trigger = page.locator(kind === 'home-delete' ? '.dialog-delete-account-button' : '.dialog-logout-this-device-button');
                            } else if (kind === 'private-category') {
                                if (width < 500) await page.locator('#taxonomy-toggle').click();
                                await page.locator('[data-navigation-view="configured"]').click();
                                await page.locator('#private-category-create-toggle').click();
                                draft = page.locator('#private-category-name');
                                await draft.fill('Account A private draft');
                                trigger = page.locator('#private-category-create-form [type="submit"]');
                            } else {
                                await page.locator('#discussion-entry').click();
                                await page.locator('#discussion-feed[aria-busy="false"]').waitFor();
                                if (kind === 'discussion-vote') trigger = page.getByRole('button', { name: 'Like post 801: 8', exact: true });
                                else if (kind === 'discussion-delete') {
                                    await page.getByRole('button', { name: 'Delete your message', exact: true }).click();
                                    trigger = page.getByRole('group', { name: 'Confirm deletion' }).getByRole('button', { name: 'Delete', exact: true });
                                }
                                else {
                                    await page.locator('#discussion-compose-toggle').click();
                                    draft = page.locator('#discussion-text');
                                    await draft.fill('Keep this account A discussion draft intact.');
                                    trigger = page.locator('#post-discussion');
                                }
                            }
                        }
                        const beforeDraft = draft ? await draft.inputValue() : null;
                        if (!normal) { app.state.userID = '2'; switched = true; }
                        if (kind === 'discussion-read-rebind') {
                            const refreshed = page.waitForResponse('**/api/get_discussion');
                            await page.locator('[data-sort="new"]').click();
                            await refreshed;
                            await page.locator('#discussion-feed[aria-busy="false"]').waitFor();
                        }
                        await trigger.click();
                        await page.waitForTimeout(650);
                        const accepted = writes.filter(write => write.status < 300).length;
                        const wrongAccount = writes.filter(write => write.owner === '2' && write.status < 300).length;
                        const afterDraft = draft && await draft.count() ? await draft.inputValue() : null;
                        const visibleText = await page.locator('body').innerText();
                        const record = { engine, width, kind, repetition, normal, writes, accepted, wrongAccount,
                            protectedAccount: normal ? accepted === 1 : wrongAccount === 0,
                            beforeDraft, afterDraft, refreshGuidance: /account changed.*refresh/i.test(visibleText), errors };
                        results.push(record);
                        console.log(JSON.stringify({ engine, width, kind, repetition, normal, protectedAccount: record.protectedAccount }));
                        if (!observe) {
                            assert.equal(record.protectedAccount, true);
                            assert.deepEqual(errors, []);
                            if (!normal) {
                                assert.equal(record.refreshGuidance, true, 'A blocked old page must explain that it needs refreshing');
                                if (draft) assert.equal(afterDraft, beforeDraft, 'Blocking must not erase the draft');
                                assert.ok(writes.every(write => write.body.expectedUserID === '1'));
                            }
                            if (repetition === 1 && (kind === 'contribution' || kind === 'discussion-post')) {
                                await page.screenshot({ path: `${output}/${engine}-${width}-${kind}.png`, fullPage: true });
                            }
                        }
                    } catch (error) {
                        results.push({ engine, width, kind, repetition, normal, harnessError: error.message, writes, errors });
                        console.log(JSON.stringify({ engine, width, kind, repetition, harnessError: error.message }));
                    } finally {
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
await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Local synthetic sessions, not production mutations.',
    passed, total: results.length, results }, null, 2));
console.log(JSON.stringify({ passed, total: results.length, output }));
if (!observe && passed !== results.length) process.exitCode = 1;
