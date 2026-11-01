import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';

const manifest = JSON.parse(await readFile(process.argv[2], 'utf8'));
const output = `D:/Codex-artifacts/website1/${manifest.release}/live`;
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const report = [];
try {
    for (const width of [393, 1440]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce' });
        try {
            const page = await context.newPage(), errors = [], writes = [], assets = [], captures = [];
            page.setDefaultTimeout(90000);
            page.on('pageerror', error => errors.push(error.message));
            page.on('response', response => {
                const path = new URL(response.url()).pathname;
                const file = manifest.files.find(file => file.path === `public${path}`);
                if (file && path.startsWith('/build/')) captures.push(response.body().then(bytes => {
                    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.after, path);
                    assets.push(path);
                }));
            });
            await page.route('**/api/**', route => {
                const path = new URL(route.request().url()).pathname;
                if (/\/(?:save|create|delete|update|submit|cast|withdraw|accept)_/.test(path)) {
                    writes.push(path); return route.abort();
                }
                return route.continue();
            });
            await page.goto('https://benchpoll.com/', { waitUntil: 'domcontentloaded' });
            const topic = page.locator('.th-card-title a').first();
            await topic.waitFor();
            const topicURL = await topic.getAttribute('href');
            await page.goto(new URL(topicURL, page.url()).href, { waitUntil: 'domcontentloaded' });
            if (width < 700) {
                const rankingTab = page.getByRole('button', { name: /(?:Public|Personal) AI Index/, exact: true });
                if (await rankingTab.isVisible()) await rankingTab.click();
            }
            const row = page.locator('.bp-model-row').first();
            await row.waitFor();
            await row.locator('.bp-model-score').click();
            const dialog = page.locator('#model-scores-dialog');
            await dialog.waitFor();
            await dialog.getByRole('button', { name: 'All scores', exact: true }).click();
            const notice = dialog.locator('[data-display-restriction="artificial_analysis"]');
            await notice.waitFor();
            assert.match(await notice.textContent(), /Artificial Analysis.*hidden/);
            const before = await dialog.locator('.bp-model-score-configuration').count();
            assert.ok(before > 0);
            await dialog.locator('#model-scores-search').fill('Artificial Analysis');
            await page.waitForFunction(() => !document.querySelector('#model-scores-list[aria-busy="true"]'));
            assert.equal(await notice.isVisible(), true);
            for (const configuration of await dialog.locator('.bp-model-score-configuration:not([hidden])').all()) {
                await configuration.locator('summary').first().click();
            }
            await page.screenshot({ path: `${output}/model-aa-search-${width}.png` });
            assert.equal(await dialog.locator('.bp-model-score-configuration:not([hidden])').count(), 0,
                JSON.stringify(await dialog.locator('.bp-model-score-configuration:not([hidden])').allTextContents()));
            assert.equal(await notice.evaluate(node => node === node.parentElement.lastElementChild), true);
            await dialog.locator('#model-scores-search').fill('');
            assert.ok(await dialog.locator('.bp-model-score-configuration:not([hidden])').count() > 0);
            assert.deepEqual(errors, []);
            assert.deepEqual(writes, []);
            await Promise.all(captures);
            assert.ok(assets.length > 0);
            report.push({ width, topicURL, configurations: before, omittedNotice: true, aaSearchVisibleConfigurations: 0, assets });
        } finally { await context.close(); }
    }
} finally { await browser.close(); }
await writeFile(`${output}/ui-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
