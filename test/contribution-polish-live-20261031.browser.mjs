import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const output = 'D:/Codex-artifacts/website1/mobile-workspace-20261031/forms-live';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
const verified = [];
try {
    for (const width of [393, 1280]) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        try {
            const page = await context.newPage(), errors = [], writes = [];
            page.setDefaultTimeout(45000);
            page.on('pageerror', error => errors.push(error.message));
            await page.route('**/api/**', route => {
                const path = new URL(route.request().url()).pathname;
                if (/\/(?:save|create|delete|update|submit|cast|withdraw|accept)_/.test(path)) {
                    writes.push(path);
                    return route.abort();
                }
                return route.continue();
            });
            for (const path of ['js/contribute.js', 'css/contribute.css', 'js/home-workspace.js'].filter(path => !verified.includes(path))) {
                const response = await page.goto(`https://benchpoll.com/${path}?verify=${Date.now()}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
                assert.equal(response.status(), 200);
                const hash = value => createHash('sha256').update(value).digest('hex');
                assert.equal(hash(await response.body()), hash(await readFile(`public/${path}`)), path);
                verified.push(path);
                console.log(JSON.stringify({ verifiedAsset: path }));
            }
            await page.goto('https://benchpoll.com/contribute/feedback', { waitUntil: 'domcontentloaded' });
            await page.waitForFunction(() => !document.querySelector('.contribution-sidebar-actions a[href="/contribute/feedback"]'));
            assert.equal(await page.locator('#contribution-bulk-import').count(), 1);
            if (width < 760) await page.locator('#contribution-taxonomy-toggle').click();
            await page.locator('#contribution-bulk-import').click();
            await page.waitForFunction(() => !document.querySelector('#contribution-bulk-import'));
            assert.equal(await page.locator('.contribution-sidebar-actions a[href="/contribute/feedback"]').count(), 1);
            await page.reload();
            await page.waitForFunction(() => !document.querySelector('#contribution-bulk-import'));
            assert.equal(await page.locator('.contribution-sidebar-actions a[href="/contribute/feedback"]').count(), 1);
            await page.screenshot({ path: `${output}/anonymous-bulk-${width}.png` });
            assert.deepEqual(errors, []);
            assert.deepEqual(writes, []);
            results.push({ width, verifiedAssets: verified, anonymousNavigation: true, pageErrors: 0, attemptedMutations: 0 });
            console.log(JSON.stringify(results.at(-1)));
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/results.json`, JSON.stringify(results, null, 2));
