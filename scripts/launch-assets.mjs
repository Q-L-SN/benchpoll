import assert from 'node:assert/strict';
import { mkdir, copyFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium } from 'playwright';

const output = resolve(process.env.LAUNCH_KIT_DIR ?? 'artifacts/launch-20261008');
assert.ok(process.argv.slice(2).every(arg => arg === '--kit-only'), 'Unknown argument');
const kitOnly = process.argv.includes('--kit-only');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.goto(pathToFileURL(join(output, 'social-card.html')).href);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 630);
    await page.screenshot({ path: join(output, '01-launch-card.png') });
    if (!kitOnly) await copyFile(join(output, '01-launch-card.png'), resolve('public/assets/benchpoll-social.png'));
    await page.close();
} finally { await browser.close(); }
await writeFile(join(output, 'asset-notes.txt'), '01-launch-card.png: 1200 x 630. Brand artwork, not a ranking screenshot.\nReal product screenshots are captured from production separately and must retain their capture date and context.\n');
console.log(output);
