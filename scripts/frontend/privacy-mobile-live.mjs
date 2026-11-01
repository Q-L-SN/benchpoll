import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { categorySegment } from '../../public/js/shared/category-route.js';

const origin = 'https://benchpoll.com';
const output = 'artifacts/privacy-mobile-20261002';
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [];
const closed = page => page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
try {
    for (const width of [1440, 390, 320]) {
        const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760 });
        const page = await context.newPage();
        page.setDefaultTimeout(30000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        try {
            for (const name of ['privacy', 'terms']) {
                const response = await page.goto(`${origin}/${name}`);
                assert.equal(response.status(), 200);
                await page.locator('.bp-legal-content h1').waitFor();
                await page.evaluate(() => document.fonts.ready);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                await page.screenshot({ path: `${output}/live-${name}-${width}.png` });
                if (width < 760) await page.locator('#taxonomy-toggle').click();
                await page.locator('[data-legal-link][href="#private-categories"]').click();
                await closed(page);
                await page.waitForFunction(() => {
                    const top = document.getElementById('private-categories').getBoundingClientRect().top;
                    return top >= 0 && top < (matchMedia('(max-width: 760px)').matches ? 100 : 42);
                });
                await page.waitForFunction(() => document.querySelector('[data-legal-link][href="#private-categories"]').getAttribute('aria-current') === 'location');
                assert.match(await page.locator('#private-categories').innerText(), /consent wherever required/);
                await page.emulateMedia({ media: 'print' });
                assert.equal(await page.locator('.bp-legal-main').evaluate(node => getComputedStyle(node).overflowY), 'visible');
                assert.equal(await page.locator('.bp-legal-content section').last().isVisible(), true);
                await page.emulateMedia({ media: 'screen' });
            }
            const response = await context.request.post(`${origin}/api/get_category_navigation`, { data: {}, headers: { Origin: origin } });
            assert.equal(response.status(), 200);
            const navigation = await response.json();
            const category = navigation.items.find(item => item.lineage.length >= 3 && item.lineage[0].name === 'Intelligence');
            assert.ok(category);
            const path = '/' + category.lineage.map(item => categorySegment(item.name)).join('/');
            await page.goto(origin + path);
            await page.locator('#benchmark-card[aria-busy="false"]').waitFor({ timeout: 90000 });
            assert.equal(await page.locator('.bp-breadcrumb-current').innerText(), category.categoryName);
            assert.match(await page.locator('#bp-breadcrumb').innerText(), /Intelligence/);
            if (width < 760) {
                await page.locator('.bp-breadcrumb-current').click();
                assert.equal(await page.locator('.bp-breadcrumb-current').getAttribute('aria-expanded'), 'true');
                await page.evaluate(async () => {
                    for (const animation of document.getAnimations()) {
                        if (animation.effect.getTiming().iterations !== Infinity) await animation.finished.catch(() => {});
                    }
                });
                await page.screenshot({ path: `${output}/live-category-drawer-${width}.png` });
                await page.locator('#taxonomy-close').click();
                await closed(page);
                assert.equal(await page.locator('.bp-breadcrumb-current').getAttribute('aria-expanded'), 'false');
            } else assert.equal(await page.locator('.bp-breadcrumb-current').evaluate(node => node.tagName), 'SPAN');
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
            assert.deepEqual(errors, []);
            checks.push({ width, path, policies: true, mobileCategory: width < 760, print: true, errors });
        } catch (error) {
            await page.screenshot({ path: `${output}/live-failed-${width}.png` });
            console.log(JSON.stringify({ width, url: page.url(), errors }));
            throw error;
        } finally { await context.close(); }
    }
    await writeFile(`${output}/live-checks.json`, JSON.stringify(checks, null, 2));
    console.log(JSON.stringify(checks));
} finally { await browser.close(); }
