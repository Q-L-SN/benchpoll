import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = process.argv.find(value => /^https?:/.test(value)) ?? 'https://benchpoll.com';
const iterationFlags = process.argv.filter(value => value.startsWith('--iterations'));
assert.ok(iterationFlags.length <= 1 && iterationFlags.every(value => /^--iterations=[12]$/.test(value)),
    'Use --iterations=1 or --iterations=2 exactly once');
const iterations = iterationFlags.length ? Number(iterationFlags[0].slice('--iterations='.length)) : 2;
const responseMetadataHeaders = ['date', 'request-id', 'x-request-id', 'cf-ray', 'server-timing'];
const releasePath = process.argv.find(value => value.startsWith('--release-manifest='))?.slice(19);
const releaseBytes = releasePath ? await readFile(releasePath) : null;
const release = releaseBytes ? JSON.parse(releaseBytes.toString('utf8')) : null;
const expectedHomeHash = release?.files.find(file => file.path === 'public/js/home-workspace.js')?.after;
const runID = `${new Date().toISOString().replaceAll(':', '-')}-${process.pid}`;
const output = resolve(process.env.GUEST_RELOAD_OUTPUT ?? `artifacts/review-20261008/guest-reload-${runID}`);
await mkdir(output, { recursive: true });
const inputs = [];
for (const file of ['scripts/frontend/review-guest-reload-20261008.mjs', 'scripts/frontend/launch-check.mjs', 'private/home.html', 'public/js/home-workspace.js', 'public/js/workspace/guest-drafts.js',
    'public/js/workspace/preferences.js', 'public/js/workspace/contracts.js']) {
    const bytes = await readFile(file);
    inputs.push({ file, sha256: createHash('sha256').update(bytes).digest('hex') });
}
await writeFile(join(output, 'inputs.json'), JSON.stringify({ origin, runID, iterations, inputs, responseMetadataHeaders,
    releaseManifestSHA256: releaseBytes ? createHash('sha256').update(releaseBytes).digest('hex') : null, expectedRelease: release?.release,
    expectedServedHomeHash: expectedHomeHash, note: 'Inputs fingerprint the local tree; public served module hashes are recorded independently.' }, null, 2));
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const browser = await chromium.launch({ headless: true, env });
const results = [];
try {
    for (let iteration = 1; iteration <= iterations; iteration++) {
        const directory = join(output, `iteration-${iteration}`);
        await mkdir(directory, { recursive: true });
        const page = await browser.newPage({ viewport: { width: 390, height: 960 }, isMobile: true, hasTouch: true });
        page.setDefaultTimeout(90000);
        const started = Date.now();
        const events = [];
        const responseTasks = new Set();
        const requests = new WeakMap();
        const resources = new Map();
        let requestID = 0;
        const record = event => events.push({ milliseconds: Date.now() - started, ...event });
        page.on('pageerror', error => record({ type: 'pageerror', message: error.message, url: page.url() }));
        page.on('framenavigated', frame => { if (frame === page.mainFrame()) record({ type: 'navigation', url: frame.url() }); });
        page.on('request', request => {
            const url = new URL(request.url());
            const resource = { path: url.pathname, host: url.host, type: request.resourceType(), start: Date.now() - started };
            resources.set(request, resource);
            if (!url.pathname.startsWith('/api/')) return;
            let body;
            try { body = request.postDataJSON(); } catch { body = null; }
            assert.ok(!body?.expectedUserID, 'The probe must not perform account writes');
            assert.ok(!/save|create|delete|submit|update/.test(url.pathname), `Read-only probe: ${url.pathname}`);
            const id = ++requestID;
            requests.set(request, id);
            record({ type: 'request', id, path: url.pathname, body });
        });
        page.on('requestfailed', request => {
            const resource = resources.get(request);
            const timing = request.timing();
            if (resource) {
                resource.failed = Date.now() - started; resource.error = request.failure()?.errorText;
                resource.timing = timing; resource.timingSource = 'requestfailed';
            }
            record({ type: 'requestfailed', id: requests.get(request), path: new URL(request.url()).pathname,
                message: request.failure()?.errorText, timing });
        });
        page.on('requestfinished', request => {
            const resource = resources.get(request);
            if (resource) {
                resource.end = Date.now() - started; resource.timing = request.timing(); resource.timingSource = 'requestfinished';
            }
        });
        page.on('response', response => {
            const resource = resources.get(response.request());
            if (resource) { resource.headersAt = Date.now() - started; resource.status = response.status(); }
            // Cached response headers avoid waiting for a separate raw-header protocol event.
            const headers = response.headers();
            const metadata = {};
            for (const name of responseMetadataHeaders) {
                if (Object.hasOwn(headers, name)) metadata[name] = headers[name];
            }
            if (resource) resource.responseMetadata = metadata;
            record({ type: 'response-metadata', id: requests.get(response.request()),
                path: new URL(response.url()).pathname, metadata });
            if (new URL(response.url()).pathname === '/js/home-workspace.js') {
                const task = (async () => {
                    try {
                        const hash = createHash('sha256').update(await response.body()).digest('hex');
                        record({ type: 'served-home-module', hash, expected: expectedHomeHash, matches: !expectedHomeHash || hash === expectedHomeHash });
                    } catch (error) { record({ type: 'served-module-error', message: error.message }); }
                })();
                responseTasks.add(task);
                void task.finally(() => responseTasks.delete(task));
            }
            if (!new URL(response.url()).pathname.startsWith('/api/')) return;
            const id = requests.get(response.request());
            record({ type: 'response', id, status: response.status() });
            const task = (async () => {
                if (!response.url().endsWith('/api/get_weighted_workspace')) return;
                try {
                    const payload = await response.json();
                    assert.equal(payload.userID ?? null, null, 'Only anonymous public responses may be captured');
                    await writeFile(join(directory, `workspace-response-${id}.json`), JSON.stringify(payload, null, 2));
                    record({ type: 'workspace-body', id, userID: payload.userID, context: payload.context,
                        personalEntries: payload.personalPie?.entries, scoreMode: payload.scoreMode,
                        snapshotID: payload.rankingPagination?.snapshotID });
                } catch (error) { record({ type: 'body-error', id, message: error.message }); }
            })();
            responseTasks.add(task);
            void task.finally(() => responseTasks.delete(task));
        });
        async function checkpoint(stage) {
            const state = await page.evaluate(() => {
                const drafts = sessionStorage.getItem('benchpoll-guest-weights-v2-ordered');
                const notice = document.getElementById('guest-draft-notice');
                return {
                    url: location.href, drafts: drafts === null ? null : JSON.parse(drafts),
                    preferences: sessionStorage.getItem('benchpoll-workspace-preferences-v1'),
                    noticeHidden: notice?.hidden, noticeRendered: !!notice?.getClientRects().length, noticeText: notice?.innerText,
                    benchmarkBusy: document.getElementById('benchmark-card')?.getAttribute('aria-busy'),
                    modelBusy: document.getElementById('model-card')?.getAttribute('aria-busy'),
                    benchmarkText: document.getElementById('benchmark-rows')?.innerText,
                    rankingStatus: document.getElementById('model-ranking-status')?.innerText,
                    personalMode: document.getElementById('pie-mode-personal')?.getAttribute('aria-selected'),
                    mobilePanel: document.querySelector('.bp-workspace')?.dataset.mobilePanel,
                    pie: document.getElementById('weight-pie')?.outerHTML
                };
            });
            record({ type: 'checkpoint', stage, state });
            await writeFile(join(directory, `checkpoint-${stage}.json`), JSON.stringify(state, null, 2));
            console.log(`iteration ${iteration}: ${stage}; notice=${state.noticeHidden ? 'hidden' : 'shown'}; busy=${state.benchmarkBusy}`);
            return state;
        }
        try {
            assert.equal((await page.goto(origin, { waitUntil: 'domcontentloaded' })).status(), 200);
            await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
            await page.locator('.bp-benchmark-row').first().waitFor();
            await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
            await page.locator('#model-ranking-status').waitFor({ state: 'hidden' });
            const create = page.locator('#personal-pie-create');
            if (await create.isVisible()) await create.click();
            else await page.locator('#pie-mode-personal').click();
            await page.waitForFunction(() => document.getElementById('pie-mode-personal')?.getAttribute('aria-selected') === 'true');
            await page.locator('.bp-pie-flip-face').waitFor({ state: 'detached' });
            for (let i = 0; i < 3; i++) {
                const response = page.waitForResponse(value => value.url().endsWith('/api/get_weighted_workspace')
                    && value.request().postDataJSON()?.previewPersonalPie?.entries.length === i + 1);
                await page.locator('.bp-benchmark-row:not(.is-family) .bp-benchmark-add:not([disabled])').first().click();
                assert.equal((await response).status(), 200);
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
            }
            await page.locator('#guest-draft-notice').waitFor();
            await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
            await page.locator('#model-ranking-status').waitFor({ state: 'hidden' });
            await checkpoint('added');
            await page.locator('[data-mobile-panel="models"]').click();
            await page.locator('.bp-model-row').first().waitFor();
            for (const field of ['reasoning', 'harness']) {
                const control = page.locator(`[data-quick-comparison="${field}"]`);
                if (await control.isEnabled()) {
                    const response = page.waitForResponse(value => value.url().endsWith('/api/get_weighted_workspace'));
                    await control.click();
                    assert.equal((await response).status(), 200);
                    await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
                }
            }
            await page.locator('#model-card[aria-busy="false"]').waitFor({ state: 'attached' });
            await page.locator('#model-ranking-status').waitFor({ state: 'hidden' });
            await checkpoint('compared');
            await page.locator('.bp-model-row').first().click();
            await page.locator('#model-scores-dialog .bp-model-score-detail-row').first().waitFor();
            await page.locator('#model-scores-dialog .dialog-close-button').click();
            const before = await checkpoint('before-reload');
            await page.reload({ waitUntil: 'domcontentloaded' });
            await checkpoint('reloading');
            await page.locator('#guest-draft-notice').waitFor();
            await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ state: 'attached' });
            const after = await checkpoint('restored');
            assert.deepEqual(after.drafts, before.drafts);
            assert.equal(after.noticeHidden, false);
            const modules = events.filter(event => event.type === 'served-home-module');
            assert.ok(modules.length >= 2, 'Initial and reload module bytes must be observed');
            assert.ok(modules.every(event => event.matches), 'The public module must match the named release');
            await page.screenshot({ path: join(directory, 'restored.png'), fullPage: true });
            results.push({ iteration, passed: true, milliseconds: Date.now() - started });
            console.log(`PASS iteration ${iteration}`);
        } catch (error) {
            const state = await checkpoint('failure');
            await page.screenshot({ path: join(directory, 'failure.png'), fullPage: true });
            results.push({ iteration, passed: false, milliseconds: Date.now() - started, error: error.stack, state });
            console.error(`FAIL iteration ${iteration}: ${error.message}`);
        } finally {
            // Closing first cancels unfinished bodies instead of blocking diagnostic persistence.
            await page.close();
            for (const task of responseTasks) await task;
            await writeFile(join(directory, 'events.json'), JSON.stringify(events, null, 2));
            await writeFile(join(directory, 'resources.json'), JSON.stringify([...resources.values()], null, 2));
        }
    }
} finally {
    await browser.close();
    await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
}
console.log(output);
if (results.some(result => !result.passed)) process.exitCode = 1;
