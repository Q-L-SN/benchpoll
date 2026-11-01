import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/privacy-mobile-20261002';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const closed = page => page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1);
const settle = page => page.evaluate(async () => {
    for (const animation of document.getAnimations()) {
        if (animation.effect.getTiming().iterations !== Infinity) await animation.finished.catch(() => {});
    }
});

try {
    for (const width of [1440, 390, 320]) {
        const app = await startPreview({ authenticated: false });
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        const page = await context.newPage();
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            for (const name of ['privacy', 'terms']) {
                const response = await page.goto(`${app.url}/${name}`);
                assert.equal(response.status(), 200);
                await page.locator('.bp-legal-content h1').waitFor();
                await page.evaluate(() => document.fonts.ready);
                await page.screenshot({ path: `${output}/${name}-intro-${width}.png` });
                assert.ok(await noOverflow(page));
                const index = page.locator('[data-legal-link][href="#private-categories"]');
                if (width < 760) await page.locator('#taxonomy-toggle').click();
                await index.click();
                await closed(page);
                await page.waitForFunction(() => {
                    const rect = document.getElementById('private-categories').getBoundingClientRect();
                    const limit = matchMedia('(max-width: 760px)').matches ? 100 : 42;
                    return rect.top >= 0 && rect.top < limit;
                });
                await page.waitForFunction(() => document.querySelector('[data-legal-link][href="#private-categories"]').getAttribute('aria-current') === 'location');
                assert.equal(await index.getAttribute('aria-current'), 'location');
                await page.screenshot({ path: `${output}/${name}-${width}.png`, fullPage: true });
                assert.ok(await noOverflow(page));
                const ids = await page.locator('[id]').evaluateAll(nodes => nodes.map(node => node.id));
                assert.equal(new Set(ids).size, ids.length);
                if (name === 'privacy') {
                    assert.equal(await page.locator('.bp-legal-content section').count(), 12);
                    await page.locator('[data-privacy-request]').last().click();
                    await page.locator('#auth-missing').waitFor();
                    assert.match(await page.locator('#contribution-step textarea').inputValue(), /^Privacy request/,
                        'The contact draft should survive the sign-in requirement');
                    assert.equal(app.state.requests.filter(item => item.path === '/api/submit_contribution').length, 0);
                }
            }
            await page.route('**/api/get_page/Language-models/Reasoning', async route => {
                const response = await route.fetch();
                const data = await response.json();
                data.currentCategoryID = 2;
                await route.fulfill({ response, json: data });
            });
            await page.goto(`${app.url}/Language-models/Reasoning`);
            await page.locator('.bp-breadcrumb-current').waitFor();
            assert.match(await page.locator('#bp-breadcrumb').innerText(), /Language models/);
            assert.equal(await page.locator('.bp-breadcrumb-current').innerText(), 'Reasoning');
            assert.equal(await page.locator('#bp-breadcrumb > a').getAttribute('href'), '/Language-models');
            const current = page.locator('.bp-breadcrumb-current');
            if (width < 760) {
                assert.equal(await current.evaluate(node => node.tagName), 'BUTTON');
                await current.click();
                assert.equal(await current.getAttribute('aria-expanded'), 'true');
                assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'true');
                await page.locator('#taxonomy-close').click();
                await closed(page);
                assert.equal(await current.getAttribute('aria-expanded'), 'false');
                await current.focus();
                await page.keyboard.press('Enter');
                assert.equal(await current.getAttribute('aria-expanded'), 'true');
                await page.keyboard.press('Escape');
                await closed(page);
                await current.click();
                await page.locator('#taxonomy-scrim').click({ position: { x: width - 8, y: 400 } });
                await closed(page);
                await current.click();
                await settle(page);
                await page.screenshot({ path: `${output}/category-drawer-${width}.png` });
                await page.setViewportSize({ width: 1440, height: 900 });
                await closed(page);
                await page.locator('span.bp-breadcrumb-current').waitFor();
                assert.equal(await page.locator('.bp-breadcrumb-current').evaluate(node => node.tagName), 'SPAN');
                await page.setViewportSize({ width, height: 900 });
                await page.locator('button.bp-breadcrumb-current').waitFor();
                assert.equal(await page.locator('.bp-breadcrumb-current').getAttribute('aria-expanded'), 'false');
            } else {
                assert.equal(await current.evaluate(node => node.tagName), 'SPAN');
                await current.click();
                assert.equal(await page.locator('body.taxonomy-open').count(), 0);
            }
            assert.ok(await noOverflow(page));
            assert.deepEqual(errors, []);
            checks.push({ width, legal: true, categoryTrigger: true, errors });
        } catch (error) {
            await page.screenshot({ path: `${output}/failed-${width}.png` });
            console.log(JSON.stringify({ width, url: page.url(), errors, navigation: await page.evaluate(() => ({
                top: document.getElementById('private-categories')?.getBoundingClientRect().top,
                current: document.querySelector('[data-legal-link][aria-current="location"]')?.hash,
                body: document.body.className
            })) }));
            throw error;
        } finally { await context.close(); await app.close(); }
    }

    const app = await startPreview();
    const context = await browser.newContext({ viewport: { width: 390, height: 900 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
    const page = await context.newPage();
    try {
        const home = await readFile(new URL('../../private/home.html', import.meta.url), 'utf8');
        await page.route('**/personal/123', route => route.fulfill({ contentType: 'text/html', body: home }));
        await page.route('**/api/get_private_category', route => route.fulfill({ json: { categoryID: 123, categoryName: 'My private mix',
            categoryPath: 'My private mix', lineage: [{ ID: 123, name: 'My private mix' }], contextValues: {}, isPrivate: true, available: true } }));
        await page.route('**/api/get_weighted_workspace', async route => {
            const response = await route.fetch();
            const data = await response.json();
            data.context = { categoryID: 123, categoryName: 'My private mix', categoryPath: 'My private mix',
                lineage: [{ ID: 123, name: 'My private mix' }], contextValues: {}, dimensions: [], isPrivate: true };
            await route.fulfill({ response, json: data });
        });
        await page.goto(`${app.url}/personal/123`);
        await page.getByRole('button', { name: 'Open categories: My private mix', exact: true }).waitFor();
        assert.equal(await page.locator('.bp-private-context-label').innerText(), 'Private');
        await page.locator('.bp-breadcrumb-current').click();
        assert.equal(await page.locator('#taxonomy-close').isVisible(), true);
        await page.locator('#taxonomy-close').click();
        assert.equal(await page.locator('body.taxonomy-open').count(), 0);
        await page.goto(`${app.url}/privacy`);
        await page.locator('#taxonomy-toggle').click();
        await page.locator('#taxonomy-close').click();
        assert.equal(await page.locator('body.taxonomy-open').count(), 0);
        checks.push({ privateCategory: true, reducedMotion: true });
    } finally { await context.close(); await app.close(); }

    const authenticated = await startPreview();
    const signedIn = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    try {
        await signedIn.goto(`${authenticated.url}/privacy#rights`);
        await signedIn.locator('[data-privacy-request]').last().click();
        await signedIn.locator('#form-surface').waitFor();
        assert.match(await signedIn.locator('[data-bind="feedback"]').inputValue(), /^Privacy request/);
        assert.equal(authenticated.state.requests.filter(item => item.path === '/api/submit_contribution').length, 0);
        checks.push({ privateFeedbackPrefill: true, noAutomaticSubmission: true });
    } finally { await signedIn.close(); await authenticated.close(); }
    await writeFile(`${output}/frontend-checks.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
