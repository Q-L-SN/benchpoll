import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.argv.find(value => value.startsWith('--output='))?.slice(9)
    ?? 'artifacts/review-20261008/remaining-account-errors';
const results = [];
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
await mkdir(output, { recursive: true });
for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env });
    try {
        for (const width of [1440, 390]) {
            for (const kind of ['email', 'session', 'inline-failure', 'home-logout-failure']) {
                const app = await startPreview();
                const page = await browser.newPage({ viewport: { width, height: 960 } });
                page.setDefaultTimeout(7000);
                const errors = [];
                page.on('pageerror', error => errors.push(error.message));
                try {
                    let attempts = 0;
                    await page.route(kind === 'home-logout-failure' ? '**/api/logout' : '**/api/submit_contribution', route => {
                        attempts++;
                        const code = kind === 'email' ? 'verified_email_required' : kind === 'session' ? 'authentication_required' : 'synthetic_failure';
                        return attempts > 1 && kind === 'inline-failure' ? route.continue()
                            : route.fulfill({ status: kind === 'session' ? 401 : kind === 'email' ? 409 : 503, json: { error: code } });
                    });
                    if (kind === 'home-logout-failure') {
                        await page.goto(app.url);
                        await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                        if (width < 500) await page.locator('#taxonomy-toggle').click();
                        await page.locator('#user-profile').click();
                        await page.locator('#logout-button').click();
                        await page.locator('.dialog-logout-this-device-button').click();
                        await page.locator('#logout-dialog [data-account-action-error]').waitFor();
                        assert.match(await page.locator('#logout-dialog [data-account-action-error]').textContent(), /Could not complete/);
                        assert.equal(new URL(page.url()).pathname, '/');
                        assert.equal(await page.locator('#logout-dialog:not([hidden])').count(), 1);
                    } else if (kind === 'inline-failure') {
                        await page.goto(`${app.url}/contribute/scores/new`);
                        await page.locator('#form-surface:not([hidden])').waitFor();
                        await page.getByRole('searchbox', { name: 'Search score fields' }).fill('Harness');
                        await page.getByRole('button', { name: 'Harness', exact: true }).click();
                        await page.locator('.score-field-value summary').click();
                        await page.getByRole('searchbox', { name: 'Harness options' }).fill('Retry harness');
                        const proposal = page.getByRole('button', { name: /Propose.*Retry harness/ });
                        await proposal.click();
                        await page.waitForFunction(() => document.querySelector('.score-field-editor > .score-field-error')?.textContent.length > 0);
                        assert.equal(await page.locator('.score-field-editor > .score-field-error').textContent(), 'Could not submit this new value for review.');
                        await proposal.click();
                        await page.getByText('Retry harness, Pending review', { exact: true }).waitFor();
                        assert.equal(attempts, 2);
                    } else {
                        await page.goto(`${app.url}/contribute/feedback`);
                        await page.locator('#form-surface:not([hidden])').waitFor();
                        const input = page.locator('[data-bind="feedback"][data-field="details"]');
                        await input.fill('Keep this feedback draft after a failed submission.');
                        await page.locator('#submit-contribution').click();
                        await page.locator('#submit-error-dialog:not([hidden])').waitFor();
                        assert.match(await page.locator('#submit-error-copy').textContent(), kind === 'email' ? /verified email address/ : /session ended.*Refresh/);
                        assert.equal(await input.inputValue(), 'Keep this feedback draft after a failed submission.');
                        await page.locator('#submit-error-dialog .dialog-close-button').click();
                        await page.locator('#submit-contribution').click();
                        assert.equal(attempts, 1, 'The known blocked state must not submit the same failing request again');
                        assert.equal(page.url(), `${app.url}/contribute/feedback`);
                    }
                    assert.deepEqual(errors, []);
                    results.push({ engine, width, kind, passed: true });
                    console.log(`PASS ${engine} ${width} ${kind}`);
                } catch (error) {
                    results.push({ engine, width, kind, passed: false, error: error.message, errors });
                    console.error(`FAIL ${engine} ${width} ${kind}: ${error.message}`);
                } finally { await page.close(); await app.close(); }
            }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
