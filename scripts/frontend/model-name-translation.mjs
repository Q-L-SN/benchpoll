import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = fileURLToPath(new URL('../../artifacts/fallback-chain-polish-20261006/model-names/', import.meta.url));
await mkdir(output, { recursive: true });
const liveURL = process.env.MODEL_NAME_TRANSLATION_URL;
const results = [];
async function protectedNames(locator) {
    await locator.first().waitFor({ state: 'attached' });
    const values = await locator.evaluateAll(nodes => nodes.map(node => ({ text: node.textContent,
        translate: node.getAttribute('translate'), excluded: node.classList.contains('notranslate') })));
    assert.ok(values.length);
    for (const value of values) assert.deepEqual([value.translate, value.excluded], ['no', true], value.text);
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            const app = await startPreview({ logs: [{ ID: 901, status: 'pending', created_at: '2026-10-06T00:00:00Z',
                userName: 'Test contributor', content: { type: 'new_model', models: [{ name: 'Cedar Sonnet', vendor: { name: 'Cedar' } }] } }],
                syncConflicts: [{ modelName: 'Aster Pro', benchmarkName: 'General knowledge', conditionName: 'default',
                    status: 'accept_source', incoming_row: { score: 88 }, currentScore: 87, currentStatus: 'approved',
                    manualOverride: 'correction', currentFields: [], currentNotes: '' }] });
            const context = await browser.newContext({ viewport: { width, height: 940 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage(); page.setDefaultTimeout(18000);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            const base = liveURL ? new URL(liveURL).origin : app.url;
            await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                const body = route.request().postDataJSON();
                if (url.pathname === '/api/admin_data_explorer') {
                    const entity = body.entity === 'models' ? 'models' : 'benchmarks';
                    return route.fulfill({ json: { entity, label: entity, entities: [{ key: 'models', label: 'Models' }, { key: 'benchmarks', label: 'Benchmarks' }],
                        page: 1, pageSize: 25, totalPages: 1, total: 1, columns: [{ key: 'id', label: 'ID' }, { key: 'name', label: 'Name' }],
                        rows: [{ id: entity === 'models' ? 301 : 101, name: entity === 'models' ? 'Aster Pro' : 'General knowledge' }] } });
                }
                if (url.pathname === '/api/admin_data_record') return route.fulfill({ json: { row: body.entity === 'models'
                    ? { id: 301, name: 'Aster Pro', notes: 'Ordinary note' } : { id: 101, name: 'General knowledge', notes: 'Ordinary note' } } });
                const response = await route.fetch(liveURL ? { url: app.url + url.pathname + url.search } : {});
                await route.fulfill({ response });
            });
            if (liveURL) await page.route('**/censor', async route => {
                await route.fulfill({ response: await route.fetch({ url: app.url + '/censor' }) });
            });
            try {
                await page.goto(liveURL ?? base, { waitUntil: 'domcontentloaded', timeout: liveURL ? 45000 : 20000 });
                await protectedNames(page.locator('.bp-model-name'));
                if (width < 500) await page.locator('[data-mobile-panel="models"]').click();
                await page.locator('#model-comparison-toggle').click();
                await page.getByRole('button', { name: 'Add Model filter', exact: true }).click();
                await protectedNames(page.locator('.bp-filter-value-input'));
                await protectedNames(page.locator('.bp-value-filter datalist option'));
                assert.equal(await page.locator('.bp-value-filter-name').evaluate(node => node.translate), true);
                await page.locator('#model-comparison-close').click();
                await page.locator('.bp-model-row').first().click();
                await protectedNames(page.locator('#model-scores-title'));
                const sourceLinks = page.locator('.bp-model-configuration-link > span');
                if (await sourceLinks.count()) await protectedNames(sourceLinks);
                await page.getByRole('button', { name: 'All scores', exact: true }).click();
                await page.waitForFunction(() => document.querySelector('.bp-model-configuration-link, .bp-model-score-sample'));
                if (await sourceLinks.count()) { await protectedNames(sourceLinks); await sourceLinks.first().click(); }
                await page.locator('.bp-model-score-sample').first().waitFor();
                await protectedNames(page.locator('#model-scores-title'));
                await page.locator('#model-scores-dialog .dialog-close-button').click();
                if (width < 500) await page.locator('[data-mobile-panel="mix"]').click();
                await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="8"] .bp-benchmark-name').click();
                await page.locator('#benchmark-scores-open').click();
                await protectedNames(page.locator('.benchmark-score-identity > strong'));
                assert.equal(await page.locator('#benchmark-scores-count').evaluate(node => node.translate), true);

                await page.goto(base + '/contribute/scores/new', { waitUntil: 'domcontentloaded' });
                const modelInput = page.locator('[data-result-model-query]').first();
                await modelInput.fill('Aster');
                await protectedNames(modelInput);
                await protectedNames(page.locator('[data-select-result-model] .notranslate'));
                await page.locator('[data-select-result-model="301"]').first().click();
                await protectedNames(page.locator('[data-result-model-query]').first());
                await page.goto(base + '/contribute/models/new', { waitUntil: 'domcontentloaded' });
                await page.locator('.vendor-picker summary').click();
                await page.locator('[data-select-vendor="1"]').click();
                await page.locator('[data-subject-model-name]').fill('Aster');
                await protectedNames(page.locator('[data-subject-model-name]'));
                await protectedNames(page.locator('[data-select-subject-model] .notranslate'));
                await page.goto(base + '/contribute/models/301/edit', { waitUntil: 'domcontentloaded' });
                await protectedNames(page.locator('[data-bind="subject"][data-field="name"]'));

                await page.goto(base + '/censor', { waitUntil: 'domcontentloaded' });
                await protectedNames(page.locator('#log-list .log-heading .notranslate'));
                assert.equal(await page.locator('#log-list .log-heading').evaluate(node => node.translate), true);
                await page.locator('#sync-tab').click();
                await protectedNames(page.locator('#sync-list .log-heading .notranslate'));
                await page.locator('#explorer-tab').click();
                await page.locator('#explorer-entity').selectOption('models');
                await page.locator('#explorer-filter').evaluate(node => node.requestSubmit());
                await protectedNames(page.locator('#explorer-body td.notranslate'));
                await page.getByRole('button', { name: 'Inspect full record', exact: true }).click();
                await page.locator('#record-overlay').waitFor({ state: 'visible' });
                await protectedNames(page.locator('#record-title'));
                await protectedNames(page.locator('#record-details .record-value.notranslate'));
                assert.equal(await page.locator('#record-details .record-value').last().evaluate(node => node.translate), true);
                assert.equal(await page.evaluate(() => document.body.translate && document.documentElement.translate), true);
                assert.deepEqual(errors, []);
                await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}.png`, fullPage: true, animations: 'disabled' });
                results.push({ engine, width, passed: true }); console.log(`PASS ${engine}-${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}${liveURL ? 'live-' : ''}${engine}-${width}-failure.png`, fullPage: true });
                results.push({ engine, width, passed: false, error: error.stack, errors }); console.error(`FAIL ${engine}-${width}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}${liveURL ? 'live-' : ''}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
