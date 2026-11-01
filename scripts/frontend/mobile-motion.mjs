import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { familyEntries } from './fixtures.mjs';

const output = process.env.MOBILE_MOTION_OUTPUT ?? 'artifacts/completion-audit-20261007/mobile-motion';
const liveURL = process.env.MOBILE_MOTION_URL;
const results = [];
await mkdir(output, { recursive: true });

async function observe(page, trigger, scope) {
    return page.evaluate(async ({ trigger, scope }) => {
        document.querySelector(trigger).click();
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const element = document.querySelector(scope);
        const animations = element.getAnimations({ subtree: true })
            .filter(animation => ['running', 'pending'].includes(animation.playState)
                && Number(animation.effect.getTiming().duration) >= 80);
        return {
            count: animations.length,
            animations: animations.map(animation => ({
                duration: animation.effect.getTiming().duration,
                frames: animation.effect.getKeyframes()
            })),
            hidden: element.hidden,
            visible: getComputedStyle(element).visibility,
            systemReducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches
        };
    }, { trigger, scope });
}

async function ready(page) {
    await page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready'
        && document.querySelectorAll('.bp-model-row').length > 0);
}

async function runCase(browser, engine, width, reducedMotion) {
    const rule = { primaryConditionID: 1, familyID: 20, mode: 'ordered', entries: familyEntries([{ conditionID: 3 }]) };
    const app = await startPreview({ fallbackRules: [rule], families: [rule] });
    const context = await browser.newContext({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, reducedMotion });
    const page = await context.newPage();
    page.setDefaultTimeout(liveURL ? 60000 : 15000);
    const errors = [];
    const checks = [];
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    async function motion(name, trigger, scope) {
        const observed = await observe(page, trigger, scope);
        checks.push({ name, ...observed });
        assert.equal(observed.systemReducedMotion, reducedMotion === 'reduce');
        if (reducedMotion === 'reduce') assert.equal(observed.count, 0, name + ' respects reduced motion');
        else assert.ok(observed.count > 0, name + ' animates on mobile');
    }
    try {
        await page.goto(liveURL ?? app.url, { waitUntil: 'domcontentloaded' });
        await ready(page);
        await motion('sidebar-open', '#taxonomy-toggle', '.bp-sidebar');
        assert.equal(await page.locator('#taxonomy-toggle').getAttribute('aria-expanded'), 'true');
        await page.waitForFunction(() => document.querySelector('.bp-sidebar').getAnimations().every(animation => animation.playState === 'finished'));
        await motion('sidebar-close', '#taxonomy-close', '.bp-sidebar');
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));

        await motion('personal-pie-flip', '#pie-mode-personal', '.bp-pie-stage');
        await page.locator('.bp-pie-flip-face').waitFor({ state: 'detached' });
        await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-personal-weight').click();
        await motion('fallback-open', '#inline-fallback-toggle', '#inline-fallback-settings');
        assert.equal(await page.locator('#benchmark-card').evaluate(node => node.classList.contains('is-fallback-target-active')), false);
        await page.waitForFunction(() => document.querySelector('#inline-fallback-settings').getAnimations().every(animation => animation.playState === 'finished'));
        await motion('fallback-close', '#inline-fallback-toggle', '#inline-fallback-settings');
        await page.locator('#inline-fallback-settings').waitFor({ state: 'hidden' });

        await motion('models-panel', '[data-mobile-panel="models"]', '.bp-right-workspace');
        await motion('advanced-open', '#model-comparison-toggle', '#model-comparison-panel');
        await page.waitForFunction(() => document.querySelector('#model-comparison-panel').getAnimations().every(animation => animation.playState === 'finished'));
        await motion('advanced-close', '#model-comparison-close', '#model-comparison-panel');
        await page.locator('#model-comparison-panel').waitFor({ state: 'hidden' });
        await motion('mix-panel', '[data-mobile-panel="mix"]', '.bp-left-workspace');

        await motion('discussion-open', '#discussion-entry', '.discussion-main');
        assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), true);
        await page.waitForFunction(() => document.querySelector('.discussion-main').getAnimations().every(animation => animation.playState === 'finished'));
        await motion('discussion-close', '#discussion-close', '.discussion-main');
        assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), false);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${width}-${reducedMotion}.png`, fullPage: true, animations: 'disabled' });
        results.push({ engine, width, reducedMotion, checks, passed: true });
        console.log(`PASS ${engine} ${width}px ${reducedMotion}: ${checks.length} transitions`);
    } catch (error) {
        results.push({ engine, width, reducedMotion, checks, errors, passed: false, error: error.stack });
        await page.screenshot({ path: `${output}/${liveURL ? 'live-' : ''}${engine}-${width}-${reducedMotion}-failure.png`, fullPage: true });
        console.error(`FAIL ${engine} ${width}px ${reducedMotion}: ${error.stack}`);
    } finally {
        await context.close();
        await app.close();
    }
}

for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await launcher.launch({ headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
        http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '*', no_proxy: '*' } });
    try {
        for (const width of [390, 320]) for (const reducedMotion of ['no-preference', 'reduce']) {
            await runCase(browser, engine, width, reducedMotion);
        }
    } finally { await browser.close(); }
}
await writeFile(`${output}/${liveURL ? 'live-' : ''}results.json`, JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
