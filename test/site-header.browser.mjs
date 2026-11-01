import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const browsers = new Map();
before(async () => {
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const engine of [chromium, webkit]) browsers.set(engine.name(), await engine.launch({ headless: true, env }));
});
after(async () => { for (const browser of browsers.values()) await browser.close(); });

for (const engine of ['chromium', 'webkit']) for (const width of [320, 390, 1440]) {
    for (const path of ['/dialogPage?dialogCode=1', '/account/privacy']) {
        test(`${engine} ${width}px ${path} uses the shared frosted header`, async t => {
            const app = await startPreview();
            const context = await browsers.get(engine).newContext({ viewport: { width, height: 844 }, reducedMotion: 'reduce' });
            const page = await context.newPage();
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            t.after(async () => { await context.close(); await app.close(); assert.deepEqual(errors, []); });
            await page.goto(`${app.url}${path}`);
            const header = path.startsWith('/dialogPage') ? page.locator('global-header').locator('.bp-site-header') : page.locator('.bp-site-header');
            await header.locator('.th-social').waitFor({ state: 'attached' });
            await page.waitForTimeout(100);
            const compact = await header.locator('.bp-site-links').evaluate(node => node.classList.contains('is-compact'));
            assert.equal(compact, width < 640);
            if (compact) await header.getByRole('button', { name: 'More information' }).click();
            for (const name of ['BenchPoll home', 'BenchPoll on X', 'Proposal hall', 'How it works']) {
                assert.equal(await header.getByRole('link', { name }).isVisible(), true);
            }
            assert.equal(await header.getByRole('link', { name: /Sign in|Open account center/i }).count(), 1);
            assert.equal(await header.getByRole('button', { name: 'More information' }).isVisible(), true);
            const layout = await header.evaluate(node => ({ width: document.documentElement.scrollWidth, height: node.getBoundingClientRect().height,
                backdrop: getComputedStyle(node).backdropFilter || getComputedStyle(node).webkitBackdropFilter }));
            assert.ok(layout.width <= width + 1, JSON.stringify(layout));
            assert.ok(layout.height <= 65, JSON.stringify(layout));
            assert.match(layout.backdrop, /blur/);
            if (!compact) await header.getByRole('button', { name: 'More information' }).click();
            assert.equal(await header.getByRole('link', { name: 'Privacy', exact: true }).isVisible(), true);
            await header.getByRole('button', { name: 'More information' }).press('Escape');
            assert.equal(await header.getByRole('link', { name: 'Privacy', exact: true }).isVisible(), false);
            if (path.startsWith('/account')) assert.equal(await page.locator('footer.ap-footer').count(), 0);
        });
    }
}
