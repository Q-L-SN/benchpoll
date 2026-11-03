import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { SITE_TAGLINE, SITE_SOCIAL_IMAGE } from '../public/js/shared/search-metadata.js';
import { escapeHTML } from '../search-presentation.js';

// Render brand copy from source, with local artwork/fonts and no network requests.
const root = new URL('../', import.meta.url);
const dataURL = async (path, mime) => `data:${mime};base64,${(await readFile(new URL(path, root))).toString('base64')}`;
const [logo, regular, bold] = await Promise.all([
    dataURL('public/assets/benchpoll-logo.svg', 'image/svg+xml'),
    dataURL('public/assets/fonts/manrope-400.woff2', 'font/woff2'),
    dataURL('public/assets/fonts/manrope-800.woff2', 'font/woff2')
]);
const separator = SITE_TAGLINE.indexOf(',') + 1;
const browser = await chromium.launch({ headless: true });
try {
    const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
    await page.route('**/*', route => route.abort());
    await page.setContent(`<!doctype html><html lang="en"><meta charset="utf-8"><title>BenchPoll social card</title>
<style>
@font-face { font-family: Manrope; src: url('${regular}') format('woff2'); font-weight: 400; }
@font-face { font-family: Manrope; src: url('${bold}') format('woff2'); font-weight: 800; }
* { box-sizing: border-box; } body { margin: 0; width: 1200px; height: 630px; padding: 50px 64px 42px; background: #fff; color: #242a31; font-family: Manrope, sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; } img { width: 240px; height: auto; }
header span { color: #596579; font-size: 18px; } h1 { margin: 62px 0 24px; font-size: 72px; font-weight: 800; line-height: 1.15; letter-spacing: -1px; }
h1 span { display: block; white-space: nowrap; } h1 span:last-child { color: #c75000; }
p { margin: 0; color: #4e5969; font-size: 27px; line-height: 1.5; }
footer { position: absolute; left: 64px; right: 64px; bottom: 42px; padding-top: 25px; border-top: 1px solid #dce1e6; display: flex; justify-content: space-between; font-size: 20px; }
footer strong { color: #c75000; }
</style><header><img src="${logo}" alt="BenchPoll"><span>Community-weighted AI rankings</span></header>
<main><h1><span>${escapeHTML(SITE_TAGLINE.slice(0, separator))}</span> <span>${escapeHTML(SITE_TAGLINE.slice(separator).trim())}</span></h1>
<p>Benchmark evidence. Community-chosen weights.<br>Compare AI on what matters to you.</p></main>
<footer><span>Explore public rankings. Build your own index.</span><strong>benchpoll.com</strong></footer></html>`);
    await page.evaluate(() => document.fonts.ready);
    assert.equal(await page.locator('img').evaluate(img => img.complete && img.naturalWidth > 0), true);
    assert.equal(await page.locator('h1').textContent(), SITE_TAGLINE);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth === 1200 && document.documentElement.scrollHeight === 630), true);
    assert.equal(await page.locator('h1').evaluate(node => [...node.children].every(child => child.scrollWidth <= node.clientWidth)), true);
    const path = fileURLToPath(new URL(`public${SITE_SOCIAL_IMAGE}`, root));
    await page.screenshot({ path });
    console.log(`Built ${SITE_SOCIAL_IMAGE} (1200 x 630)`);
} finally { await browser.close(); }
