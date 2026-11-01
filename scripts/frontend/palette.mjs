import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const app = await startPreview();
const browser = await chromium.launch({ headless: true });
const routes = [
    ['home', '/', '.bp-model-row'],
    ['contribute', '/contribute/benchmarks/new', 'h1'],
    ['how-it-works', '/how-it-works', 'h1'],
    ['admin-login', '/adminlogin', '#loginButton'],
    ['review', '/censor', '.censor-header h1'],
    ['error', '/dialogPage?dialogCode=6&side=server&errorCode=530', 'global-dialog:not([hidden])']
];

await mkdir('artifacts/palette', { recursive: true });
try {
    for (const [name, path, readySelector] of routes) {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        if (name === 'admin-login') await page.route('**/js/adminlogin.js', route => route.fulfill({ status: 200, contentType: 'text/javascript', body: '' }));
        await page.addInitScript(() => {
            localStorage.setItem('benchpoll-welcome-seen-v1', '1');
            localStorage.setItem('benchpoll-home-palette', 'berry');
        });
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(app.url + path);
        await page.locator('link[href*="site-palette.css"]').waitFor({ state: 'attached' });
        await page.locator(readySelector).first().waitFor({ state: 'visible' });
        await page.evaluate(() => document.fonts.ready);
        const palette = await page.evaluate(() => {
            const style = getComputedStyle(document.documentElement);
            return {
                accent: style.getPropertyValue('--bp-purple').trim(),
                fill: style.getPropertyValue('--bp-fill').trim(),
                fillText: style.getPropertyValue('--bp-fill-ink').trim(),
                currentPalette: document.documentElement.dataset.homePalette,
                switches: document.querySelectorAll('[data-palette]').length,
                oldScript: document.querySelectorAll('script[src*="home-palette"]').length
            };
        });
        assert.equal(palette.accent, '#b84400', `${name} accent`);
        assert.equal(palette.fill, '#c45105', `${name} button fill`);
        assert.equal(palette.fillText, '#fff', `${name} button text`);
        assert.equal(palette.currentPalette, undefined, `${name} fixed palette`);
        assert.equal(palette.switches, 0, `${name} palette switch`);
        assert.equal(palette.oldScript, 0, `${name} old palette script`);
        const primarySelector = {
            home: '.bp-mode-option.selected',
            contribute: '.primary-button',
            'admin-login': '#loginButton',
            error: 'global-dialog-action.main'
        }[name];
        if (primarySelector) {
            const buttonColors = await page.locator(primarySelector).first().evaluate(node => {
                const target = node.shadowRoot?.querySelector('#button') ?? node;
                const style = getComputedStyle(target);
                return { background: style.backgroundColor, text: style.color };
            });
            assert.equal(buttonColors.text, 'rgb(255, 255, 255)', `${name} orange button text`);
            assert.notEqual(buttonColors.background, 'rgba(0, 0, 0, 0)', `${name} orange button background`);
        }
        await page.screenshot({ path: `artifacts/palette/${name}-desktop.png` });
        if (['home', 'contribute', 'how-it-works'].includes(name)) {
            await page.setViewportSize({ width: 390, height: 844 });
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, `${name} mobile overflow`);
            await page.screenshot({ path: `artifacts/palette/${name}-mobile.png` });
        }
        assert.deepEqual(errors, [], `${name} browser errors`);
        await page.close();
    }
    console.log('PASS: orange palette on all primary page types; berry switch removed; no browser errors');
} finally {
    await browser.close();
    await app.close();
}
