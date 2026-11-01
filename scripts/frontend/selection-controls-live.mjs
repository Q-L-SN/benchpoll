import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const origin = 'https://benchpoll.com';
const output = new URL('../../artifacts/selection-controls-20261003/', import.meta.url);
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];

async function keyboardFocus(page, locator, label) {
    await locator.waitFor({ state: 'visible' });
    await page.keyboard.press('Tab');
    await locator.focus();
    await page.waitForFunction(() => document.activeElement?.matches(':focus-visible'));
    const style = await locator.evaluate(async node => {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const style = getComputedStyle(node);
        return { focused: document.activeElement === node, width: Number.parseFloat(style.outlineWidth),
            offset: Number.parseFloat(style.outlineOffset), outline: style.outlineStyle, shadow: style.boxShadow };
    });
    assert.equal(style.focused, true, `${label}: expected keyboard focus`);
    assert.equal(style.outline, 'solid');
    assert.equal(style.width, 2);
    assert.ok(style.width + style.offset <= 0, `${label}: outer outline`);
    assert.equal(style.shadow, 'none', `${label}: outer shadow`);
}

try {
    for (const width of [1440, 390]) {
        const context = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: 'reduce' });
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        const errors = [];
        const blockedWrites = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.route('**/api/**', route => {
            const pathname = new URL(route.request().url()).pathname;
            if (pathname.startsWith('/api/get_') || pathname === '/api/load_benchmarks_and_subcategories') return route.continue();
            blockedWrites.push(pathname);
            return route.abort('blockedbyclient');
        });
        try {
            await page.goto(`${origin}/Intelligence/Professional-Work/Software`, { waitUntil: 'networkidle' });
            assert.equal(await page.locator('link[href="/css/site-palette.css?v=selection-controls-20261003"]').count(), 1);
            const template = page.locator('.bp-template-control:not([disabled])').first();
            await keyboardFocus(page, template, 'Live context picker');
            await page.screenshot({ path: fileURLToPath(new URL(`live-context-${width}.png`, output)), fullPage: true });

            await page.goto(`${origin}/contribute?mode=new_benchmark`, { waitUntil: 'networkidle' });
            await page.locator('#auth-missing:not([hidden])').waitFor();
            assert.equal(await page.locator('#form-surface').isVisible(), false);
            // Reveal only the client display state; no backend session or credentials are created.
            await page.route('**/api/get_user_profile', route => route.fulfill({ json: {
                userID: 123456789, userName: 'UI smoke test', hasVerifiedEmail: true
            } }));
            await page.reload({ waitUntil: 'networkidle' });
            await keyboardFocus(page, page.locator('[data-evaluation-name]'), 'Live benchmark name');
            await keyboardFocus(page, page.getByRole('combobox', { name: 'Score ranking rule' }), 'Live score ranking rule');
            await page.screenshot({ path: fileURLToPath(new URL(`live-form-${width}.png`, output)), fullPage: true });

            await page.goto(`${origin}/contribute?mode=new_model`, { waitUntil: 'networkidle' });
            const vendor = page.locator('.vendor-picker > summary');
            await vendor.click();
            await page.locator('.vendor-picker[open]').waitFor();
            await page.waitForLoadState('networkidle');
            const vendorShadow = await vendor.evaluate(async node => {
                await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
                return getComputedStyle(node).boxShadow;
            });
            assert.ok(vendorShadow === 'none' || vendorShadow.split(/,(?![^()]*\))/).every(shadow => {
                if (shadow.includes('inset')) return true;
                const lengths = [...shadow.matchAll(/(-?\d+(?:\.\d+)?)px/g)].map(match => Number(match[1]));
                return lengths[0] !== 0 || lengths[1] !== 0 || lengths[2] <= 0 && lengths[3] <= 0;
            }), `Live vendor picker: outer focus shadow: ${vendorShadow}`);
            await keyboardFocus(page, page.locator('.vendor-picker .picker-search input'), 'Live vendor search');
            await page.screenshot({ path: fileURLToPath(new URL(`live-vendor-${width}.png`, output)), fullPage: true });

            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            assert.deepEqual(blockedWrites, []);
            checks.push({ width, passed: true, writes: 0, guestGatePreserved: true,
                formDisplayProfile: 'synthetic', backendAuthenticated: false });
            console.log(`Live selection controls passed at ${width}px.`);
        } finally { await context.close(); }
    }
    await writeFile(new URL('live-checks.json', output), JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
