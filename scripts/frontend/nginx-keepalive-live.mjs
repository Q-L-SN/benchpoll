import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';

const output = 'artifacts/nginx-keepalive-20261006/live';
await mkdir(output, { recursive: true });
const checks = [];
const browser = await chromium.launch({ headless: true,
    args: ['--host-resolver-rules=MAP benchpoll.com 18.226.222.18'],
    env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' }
});
try {
    for (let round = 0; round < 8; round++) {
        const width = round % 2 ? 390 : 1440;
        const context = await browser.newContext({ viewport: { width, height: 940 },
            isMobile: width < 500, hasTouch: width < 500 });
        const page = await context.newPage(); page.setDefaultTimeout(60000);
        const errors = [], statuses = [], blockedWrites = [], discardedEmptyResponses = [];
        const responseStatuses = new WeakMap();
        page.on('pageerror', error => errors.push(error.message));
        page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
        page.on('requestfailed', request => {
            const status = responseStatuses.get(request);
            const failure = request.failure()?.errorText;
            // Chromium reports a discarded, already successful 204 as aborted.
            if (status === 204 && failure === 'net::ERR_ABORTED'
                && new URL(request.url()).pathname === '/api/get_user_profile') {
                discardedEmptyResponses.push({ status, failure });
            } else errors.push(`${request.url()}: ${failure}`);
        });
        page.on('response', response => {
            responseStatuses.set(response.request(), response.status());
            if (response.status() >= 400) errors.push(`${response.url()}: ${response.status()}`);
        });
        await page.route('**/api/**', route => {
            const path = new URL(route.request().url()).pathname;
            if (/^\/api\/(?:get_|load_benchmarks)/.test(path)) return route.continue();
            blockedWrites.push(path); return route.abort();
        });
        try {
            const profile = page.waitForResponse(response => new URL(response.url()).pathname === '/api/get_user_profile');
            const main = await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded', timeout: 90000 });
            assert.equal(main.status(), 200);
            statuses.push((await profile).status());
            await page.waitForFunction(() => document.querySelector('#benchmark-card')?.getAttribute('aria-busy') === 'false');
            for (const idleMs of [0, 3200, 6200]) {
                await new Promise(resolve => setTimeout(resolve, idleMs));
                const result = await page.evaluate(async () => {
                    const response = await fetch('/api/get_user_profile', { method: 'POST',
                        headers: { 'Content-Type': 'application/json' }, body: '{}', signal: AbortSignal.timeout(30000) });
                    return { status: response.status, body: await response.text() };
                });
                assert.equal(result.body, '');
                statuses.push(result.status);
            }
            assert.ok(statuses.every(status => status === 204));
            assert.deepEqual(errors, []); assert.deepEqual(blockedWrites, []);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            if (round < 2) await page.screenshot({ path: `${output}/home-${width}.png`, animations: 'disabled' });
            checks.push({ round, width, passed: true, statuses, errors, blockedWrites, discardedEmptyResponses });
            console.log(`PASS cold load ${round + 1}/8 at ${width}px, ${statuses.length} profile responses`);
        } catch (error) {
            checks.push({ round, width, passed: false, statuses, errors, blockedWrites, discardedEmptyResponses, error: error.stack });
            throw error;
        } finally { await context.close(); }
    }
} finally {
    await browser.close();
    await writeFile(`${output}/results.json`, JSON.stringify({ readOnly: true, automaticRetries: false,
        passed: checks.length === 8 && checks.every(check => check.passed), checks }, null, 2) + '\n');
}
