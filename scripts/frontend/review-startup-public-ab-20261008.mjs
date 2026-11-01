import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { chromium } from 'playwright';

const before = await readFile('D:/BenchPoll-artifacts/review-20261008/startup-production-before/private/home.html', 'utf8');
const after = await readFile('private/home.html', 'utf8');
const output = 'artifacts/review-20261008/startup-public-ab';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
const results = [];
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, env });
try {
    for (let repetition = 1; repetition <= 2; repetition++) {
        const variants = repetition === 1 ? [['before', before], ['after', after]] : [['after', after], ['before', before]];
        for (const [variant, html] of variants) {
            const context = await browser.newContext({ viewport: { width: 1440, height: 960 } });
            const page = await context.newPage();
            page.setDefaultTimeout(75000);
            const item = { repetition, variant, htmlHash: createHash('sha256').update(html).digest('hex'),
                errors: [], failedResponses: [], passed: false };
            results.push(item);
            page.on('pageerror', error => item.errors.push({ message: error.message, stack: error.stack }));
            page.on('response', response => {
                if (response.status() >= 400) item.failedResponses.push({ path: new URL(response.url()).pathname, status: response.status() });
            });
            try {
                // Only the document is replaced. Both variants use the same live public APIs/assets/backend.
                await page.route('https://benchpoll.com/Intelligence', route => route.fulfill({ contentType: 'text/html', body: html }));
                const started = performance.now();
                assert.equal((await page.goto('https://benchpoll.com/Intelligence', { waitUntil: 'domcontentloaded' })).status(), 200);
                item.domMs = performance.now() - started;
                await page.waitForFunction(() => document.querySelector('#benchmark-card[aria-busy="false"] .bp-benchmark-row')
                    && document.querySelector('#model-card[aria-busy="false"] .bp-model-row'));
                item.readyMs = performance.now() - started;
                await page.evaluate(() => document.fonts.ready);
                item.resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => ({
                    path: new URL(entry.name).pathname + new URL(entry.name).search, type: entry.initiatorType,
                    start: entry.startTime, duration: entry.duration, encodedBytes: entry.encodedBodySize })));
                assert.deepEqual(item.errors, []); assert.deepEqual(item.failedResponses, []);
                assert.equal(item.resources.filter(entry => entry.path === '/api/get_weighted_workspace').length, 1);
                await page.screenshot({ path: `${output}/${repetition}-${variant}.png` });
                item.passed = true;
            } catch (error) { item.error = error.stack; }
            finally {
                await context.close();
                await writeFile(`${output}/results.json`, JSON.stringify({ scope: 'Four fresh desktop guest contexts, alternated old/current local HTML with identical live public APIs and assets. Documents are fulfilled locally: no root redirect, HTML transfer or Cloudflare document injection. This isolates public resource discovery; it is not a full production startup measurement. No forms, authentication or database writes.',
                    results }, null, 2));
                console.log(JSON.stringify({ repetition, variant, passed: item.passed, domMs: item.domMs, readyMs: item.readyMs, error: item.error }));
            }
        }
    }
} finally { await browser.close(); }
if (results.some(item => !item.passed)) process.exitCode = 1;
