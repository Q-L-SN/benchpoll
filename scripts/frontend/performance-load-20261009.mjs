import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from 'playwright';

const after = process.argv.includes('--after');
const output = resolve(`artifacts/performance-20261009/${after ? 'after' : 'before'}-browser`);
const origin = process.env.PERFORMANCE_ORIGIN ?? 'https://benchpoll.com';
const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' };
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true, env });
const cases = [];
try {
    for (const width of [1440, 390]) for (const repeat of [1, 2, 3]) {
        const context = await browser.newContext({ viewport: { width, height: 960 },
            isMobile: width < 500, hasTouch: width < 500 });
        try {
            const page = await context.newPage();
            page.setDefaultTimeout(90000);
            const errors = [], requests = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('response', response => requests.push({ url: response.url(), status: response.status() }));
            await page.addInitScript(() => {
                globalThis.__performanceMarks = {};
                const inspect = () => {
                    const marks = globalThis.__performanceMarks;
                    if (!marks.workspace && document.querySelector('#benchmark-card[aria-busy="false"] .bp-benchmark-row')) {
                        marks.workspace = performance.now();
                    }
                    if (!marks.ranking && document.querySelector('#model-card[aria-busy="false"] .bp-model-row')) {
                        marks.ranking = performance.now();
                    }
                };
                document.addEventListener('DOMContentLoaded', () => {
                    inspect(); new MutationObserver(inspect).observe(document.body,
                        { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-busy'] });
                }, { once: true });
            });
            for (const phase of ['fresh', 'reload']) {
                const start = performance.now();
                const response = phase === 'fresh' ? await page.goto(`${origin}/Intelligence`, { waitUntil: 'domcontentloaded' })
                    : await page.reload({ waitUntil: 'domcontentloaded' });
                assert.equal(response.status(), 200);
                await page.waitForFunction(() => globalThis.__performanceMarks.workspace && globalThis.__performanceMarks.ranking);
                const readyMs = Math.round(performance.now() - start);
                await page.evaluate(() => document.fonts.ready);
                const document = await page.evaluate(() => ({ marks: globalThis.__performanceMarks,
                    navigation: performance.getEntriesByType('navigation').map(entry => entry.toJSON()),
                    paints: performance.getEntriesByType('paint').map(entry => entry.toJSON()),
                    resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()),
                    benchmarkRows: window.document.querySelectorAll('.bp-benchmark-row').length,
                    modelRows: window.document.querySelectorAll('.bp-model-row').length }));
                const result = { width, repeat, phase, readyMs, document, errors: [...errors], requests: [...requests] };
                cases.push(result);
                await writeFile(`${output}/report.json`, JSON.stringify({ origin, cases }, null, 2));
                console.log(JSON.stringify({ width, repeat, phase, readyMs, marks: document.marks, errors }));
                assert.deepEqual(errors, []);
                if (repeat === 1) await page.screenshot({ path: `${output}/${width}-${phase}.png` });
            }
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
