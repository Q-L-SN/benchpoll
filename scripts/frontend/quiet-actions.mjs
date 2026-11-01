import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = 'artifacts/quiet-actions-20261007';
const liveURL = process.env.QUIET_ACTIONS_URL;
const prefix = liveURL ? 'live-' : '';
const results = [];
const color = 'rgb(57, 65, 78)', accent = 'rgb(184, 68, 0)';
await mkdir(output, { recursive: true });

async function appearance(locator) {
    return locator.evaluate(node => {
        const style = getComputedStyle(node);
        return { color: style.color, background: style.backgroundColor, border: style.borderTopWidth,
            shadow: style.boxShadow, decoration: style.textDecorationLine,
            outline: style.outlineStyle, outlineWidth: style.outlineWidth,
            children: [...node.querySelectorAll('i, span, svg')].map(child => ({
                color: getComputedStyle(child).color, decoration: getComputedStyle(child).textDecorationLine
            })) };
    });
}
function quiet(style) {
    assert.equal(style.background, 'rgba(0, 0, 0, 0)');
    assert.equal(style.border, '0px');
    assert.equal(style.shadow, 'none');
    assert.equal(style.decoration, 'none');
    for (const child of style.children) {
        assert.equal(child.color, style.color);
        assert.equal(child.decoration, 'none');
    }
}
async function waitColor(page, selector, value) {
    await page.waitForFunction(({ selector, value }) => getComputedStyle(document.querySelector(selector)).color === value,
        { selector, value });
}

for (const [engine, launcher, widths] of [['chromium', chromium, [1440, 390, 320]], ['webkit', webkit, [1440, 390]]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of widths) {
            const app = await startPreview();
            const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width < 500, hasTouch: width < 500 });
            const page = await context.newPage(); page.setDefaultTimeout(liveURL ? 60000 : 15000);
            const errors = [];
            page.on('pageerror', error => errors.push(error.message));
            if (liveURL) await page.route('**/api/**', async route => {
                const url = new URL(route.request().url());
                await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
            });
            try {
                await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
                await page.locator('#benchmark-card[aria-busy="false"]').waitFor();
                for (const selector of ['#beta-feedback-link', '#public-composition-toggle', '#discussion-entry']) {
                    if (width < 500 && selector === '#beta-feedback-link') await page.locator('#taxonomy-toggle').click();
                    const control = page.locator(selector);
                    await page.mouse.move(0, 0); await control.evaluate(node => node.blur());
                    await waitColor(page, selector, color);
                    quiet(await appearance(control));
                    if (width < 500) assert.ok(await control.evaluate(node => node.getBoundingClientRect().height >= 44));
                    await control.hover(); await waitColor(page, selector, accent);
                    quiet(await appearance(control));
                    await page.mouse.move(0, 0);
                    await page.keyboard.press('Tab'); await control.focus();
                    await waitColor(page, selector, accent);
                    const focused = await appearance(control);
                    quiet(focused); assert.equal(focused.outline, 'solid'); assert.equal(focused.outlineWidth, '2px');
                    await control.evaluate(node => node.blur());
                    if (width < 500 && selector === '#beta-feedback-link') {
                        await page.locator('#taxonomy-close').click();
                        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
                    }
                }
                await page.mouse.move(0, 0);
                await page.screenshot({ path: `${output}/${prefix}${engine}-${width}-idle.png`, fullPage: true, animations: 'disabled' });
                const composition = page.locator('#public-composition-toggle');
                await composition.click();
                await page.locator('#public-composition-pie').waitFor({ state: 'visible' });
                assert.equal(await composition.getAttribute('aria-expanded'), 'true');
                quiet(await appearance(composition));
                assert.equal(await page.locator('#public-composition-pie g[data-category-id]').count(), 3);
                await composition.click(); await page.locator('#weight-pie').waitFor({ state: 'visible' });
                await composition.evaluate(node => { node.disabled = true; node.blur(); });
                await composition.hover(); await waitColor(page, '#public-composition-toggle', color);
                quiet(await appearance(composition));
                await composition.evaluate(node => node.click());
                assert.equal(await composition.getAttribute('aria-expanded'), 'false');
                await composition.evaluate(node => { node.disabled = false; });
                const discussion = page.locator('#discussion-entry');
                await discussion.click();
                await page.locator('#discussion-panel').waitFor({ state: 'visible' });
                assert.equal(await discussion.getAttribute('aria-expanded'), 'true');
                quiet(await appearance(discussion));
                await page.locator('#discussion-close').click();
                await page.waitForFunction(() => !document.body.classList.contains('discussion-open'));
                await discussion.evaluate(node => { node.hidden = true; });
                assert.equal(await discussion.isVisible(), false);
                await discussion.evaluate(node => { node.hidden = false; });
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
                assert.equal(app.state.requests.some(request => ['/api/save_personal_pie', '/api/submit_contribution'].includes(request.path)), false);
                if (width < 500) await page.locator('#taxonomy-toggle').click();
                await page.locator('#beta-feedback-link').focus();
                await page.locator('#beta-feedback-link').press('Enter');
                await page.waitForURL(url => url.pathname === '/contribute/feedback');
                await page.waitForFunction(() => [...document.querySelectorAll('textarea')].some(node => node.value.includes('BenchPoll Beta feedback')));
                assert.deepEqual(errors, []);
                results.push({ engine, width, passed: true }); console.log(`PASS ${prefix}${engine}-${width}`);
            } catch (error) {
                await page.screenshot({ path: `${output}/${prefix}${engine}-${width}-failure.png`, fullPage: true });
                results.push({ engine, width, passed: false, error: error.stack, browserErrors: errors });
                console.error(`FAIL ${prefix}${engine}-${width}: ${error.stack}`);
            } finally { await context.close(); await app.close(); }
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/${prefix}checks.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
