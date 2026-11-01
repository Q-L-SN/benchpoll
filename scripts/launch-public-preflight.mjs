import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';

const origin = 'https://benchpoll.com';
assert.ok(process.argv.slice(2).every(arg => arg === '--mobile-only'), 'Unknown argument');
const mobileOnly = process.argv.includes('--mobile-only');
const output = resolve(`artifacts/launch-20261009/preflight-${Date.now()}`);
await mkdir(output, { recursive: true });
const checks = [];
const report = {
    checkedAt: new Date().toISOString(),
    scope: 'Anonymous live public entry, data and rendering. No account access, saved weights or social publishing.',
    checks
};

async function check(name, action) {
    const started = performance.now();
    try {
        const detail = await action();
        checks.push({ name, passed: true, milliseconds: Math.round(performance.now() - started), ...detail });
        console.log(`PASS ${name}`);
    } catch (error) {
        checks.push({ name, passed: false, milliseconds: Math.round(performance.now() - started), error: error.message });
        console.log(`FAIL ${name}: ${error.message}`);
    }
}

if (!mobileOnly) await check('Public workspace data', async () => {
    const response = await fetch(`${origin}/api/get_weighted_workspace`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contextValues: {}, scoreMode: 'range', initialMode: 'public', comparison: { mode: 'best', keys: ['model'], filters: [] } }),
        signal: AbortSignal.timeout(45000)
    });
    assert.equal(response.status, 200);
    const data = await response.json();
    assert.equal(data.authenticated, false);
    assert.ok(data.benchmarks?.length > 0, 'No benchmarks returned');
    assert.ok(data.modelLeaderboards?.public?.length > 0, 'No public model ranking returned');
    return { status: response.status, category: data.context.categoryPath,
        loadedBenchmarks: data.benchmarks.length, loadedPublicModels: data.modelLeaderboards.public.length };
});

const browser = await chromium.launch({ headless: true });
try {
    for (const width of mobileOnly ? [390] : [1440, 390]) {
        await check(`Public browser ${width}px`, async () => {
            const context = await browser.newContext({ viewport: { width, height: 960 } });
            const page = await context.newPage();
            const pageErrors = [];
            const blockedWrites = [];
            page.on('pageerror', error => pageErrors.push(error.message));
            await context.route('**/*', route => {
                const request = route.request();
                const url = new URL(request.url());
                if (['GET', 'HEAD', 'OPTIONS'].includes(request.method())
                    || (url.origin === origin && request.method() === 'POST' && url.pathname.startsWith('/api/get_'))) {
                    return route.continue();
                }
                blockedWrites.push({ method: request.method(), path: url.pathname });
                return route.abort();
            });
            try {
                const response = await page.goto(`${origin}/Intelligence`, { waitUntil: 'domcontentloaded', timeout: 45000 });
                assert.equal(response.status(), 200);
                await page.locator('.bp-benchmark-row').first().waitFor({ timeout: 45000 });
                if (width < 600) {
                    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Weights panel overflows horizontally');
                    await page.screenshot({ path: join(output, `public-${width}-weights.png`) });
                    await page.getByRole('button', { name: 'Model ranking', exact: true }).click();
                }
                await page.locator('.bp-model-row').first().waitFor({ timeout: 45000 });
                assert.equal(await page.locator('#pie-mode-public').getAttribute('aria-selected'), 'true');
                assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Page overflows horizontally');
                assert.deepEqual(pageErrors, [], 'Uncaught page errors');
                await page.screenshot({ path: join(output, `public-${width}.png`) });
                return { url: page.url(), modelRows: await page.locator('.bp-model-row').count(),
                    benchmarkRows: await page.locator('.bp-benchmark-row').count(), pageErrors, blockedWrites };
            } catch (error) {
                await page.screenshot({ path: join(output, `public-${width}-failure.png`) }).catch(() => {});
                throw error;
            } finally {
                await context.close();
            }
        });
    }
} finally {
    await browser.close();
    report.passed = checks.every(result => result.passed);
    await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), { flag: 'wx' });
    console.log(output);
}
if (!report.passed) process.exitCode = 1;
