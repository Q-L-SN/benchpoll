import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { openOverview } from './showcase-interactions.mjs';

const output = process.env.SHOWCASE_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/live';
await mkdir(output, { recursive: true });
const results = [];
for (const [engine, launcher, width, height] of [
    ['chromium', chromium, 1440, 900], ['chromium', chromium, 390, 844], ['webkit', webkit, 390, 844]
]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760 });
    const page = await context.newPage();
    page.setDefaultTimeout(45000);
    const errors = [], writes = [], modelPages = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => {
        if (new URL(request.url()).pathname === '/api/get_ranking_page') {
            const body = request.postDataJSON();
            if (['public', 'personal'].includes(body?.list)) modelPages.push(body);
        }
    });
    const buffered = engine === 'webkit' && process.env.SHOWCASE_BUFFER_NETWORK === '1';
    await page.route('https://benchpoll.com/**', async route => {
        const path = new URL(route.request().url()).pathname;
        if (/^\/api\/(?:save_|create_|delete_|submit_|update_)/.test(path)) {
            writes.push(path); return route.abort();
        }
        if (buffered) {
            const response = await route.fetch({ maxRetries: 2, timeout: 60000,
                headers: { ...route.request().headers(), 'accept-encoding': 'identity' } });
            return route.fulfill({ response, body: await response.body() });
        }
        return route.continue();
    });
    await context.addInitScript(() => {
        window.noticeAppearances = [];
        new MutationObserver(() => {
            const node = document.getElementById('model-ranking-status');
            if (node && !node.hidden) window.noticeAppearances.push(node.dataset.phase);
        }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-phase'] });
    });
    const label = `${engine}-${width}`;
    try {
        const entryURL = width === 1440 ? 'https://benchpoll.com/' : 'https://benchpoll.com/Intelligence';
        const response = await page.goto(entryURL, { waitUntil: 'domcontentloaded' });
        assert.equal(response.status(), 200);
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('html').getAttribute('data-fallback-appearance'), null);
        assert.equal(await page.locator('.bp-fallback-style-control, .bp-score-colors-toggle').count(), 0);
        const initialPages = modelPages.length;
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), true);
        assert.equal(await page.locator('#workspace-display-toggle').count(), 0);
        assert.equal(new URL(page.url()).searchParams.has('view'), false);
        assert.equal(await page.locator('#showcase-intro').textContent(), 'AI labs choose what they report. Help the community decide what counts, and how much.');
        const copyBounds = await page.evaluate(() => {
            const intro = document.getElementById('showcase-intro').getBoundingClientRect();
            return { left: intro.left, right: intro.right, top: intro.top, bottom: intro.bottom, width: innerWidth,
                questionBottom: document.getElementById('showcase-question').getBoundingClientRect().bottom,
                chartTop: document.querySelector('.bp-workspace-grid').getBoundingClientRect().top };
        });
        assert.ok(copyBounds.left >= 0 && copyBounds.right <= copyBounds.width
            && copyBounds.top >= copyBounds.questionBottom && copyBounds.bottom <= copyBounds.chartTop, JSON.stringify(copyBounds));
        await page.screenshot({ path: join(output, `${label}-hero.png`) });
        async function scrollToProgress(progress) {
            await page.evaluate(p => {
                const section = document.getElementById('showcase');
                const hold = section.querySelector('.bp-showcase-stage').offsetHeight;
                scrollTo({ top: (section.offsetHeight - document.documentElement.clientHeight - hold) * p, behavior: 'instant' });
            }, progress);
            await page.waitForTimeout(180);
        }
        await scrollToProgress(.55);
        const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            columns: document.querySelectorAll('.bp-model-column').length,
            plotHeight: Math.max(0, ...[...document.querySelectorAll('.bp-model-column-plot')].map(node => node.getBoundingClientRect().height)),
            barWidth: Math.max(0, ...[...document.querySelectorAll('.bp-column-known')].map(node => node.getBoundingClientRect().width)),
            white: [...document.querySelectorAll('.bp-model-column-value')].every(node => getComputedStyle(node).color === 'rgb(255, 255, 255)'),
            scoresFit: [...document.querySelectorAll('.bp-column-known:not(.is-empty)')].every(node =>
                node.querySelector('.bp-model-column-value').getBoundingClientRect().width <= node.getBoundingClientRect().width + 1)
        }));
        assert.equal(layout.overflow, false);
        assert.equal(layout.white, true); assert.equal(layout.scoresFit, true);
        assert.ok(layout.columns > 0, 'The initial model batch is visible');
        assert.equal(modelPages.length, initialPages, 'Vertical scrolling does not request more models');
        assert.equal(await page.locator('.bp-weight-bar-row').first().evaluate(node => parseFloat(node.style.getPropertyValue('--weight-width'))), 100);
        assert.equal(await page.locator('.bp-model-column-plot').evaluateAll(plots => plots.every(plot => {
            const known = plot.querySelector('.bp-column-known').getBoundingClientRect();
            const gray = plot.querySelector('.bp-column-uncertain').getBoundingClientRect();
            return gray.top <= known.top + 1 && gray.bottom >= known.bottom - 1;
        })), true);
        assert.ok(layout.plotHeight <= (width > 760 ? 240 : 140) + 1, JSON.stringify(layout));
        assert.ok(layout.barWidth <= (width > 760 ? 36 : 30) + 1, JSON.stringify(layout));
        await page.screenshot({ path: join(output, `${label}-charts.png`) });
        const weights = page.locator('#weight-bars');
        const weightPresentation = await weights.locator('.bp-weight-bar-row').first().evaluate(row => {
            const label = row.querySelector('.bp-weight-bar-value').getBoundingClientRect();
            const fill = row.querySelector('.bp-weight-bar-fill').getBoundingClientRect();
            return { color: getComputedStyle(row.querySelector('.bp-weight-bar-value')).color, height: fill.height,
                inside: label.top >= fill.top && label.bottom <= fill.bottom && label.right <= fill.right + 1 };
        });
        assert.equal(weightPresentation.color, 'rgb(255, 255, 255)');
        assert.ok(weightPresentation.inside && weightPresentation.height >= 22, JSON.stringify(weightPresentation));
        if (await page.evaluate(() => CSS.supports('overscroll-behavior-y', 'auto'))) {
            assert.equal(await page.locator('#model-rows').evaluate(node => getComputedStyle(node).getPropertyValue('overscroll-behavior-y')), 'auto');
            assert.equal(await weights.evaluate(node => getComputedStyle(node).getPropertyValue('overscroll-behavior-y')), 'auto');
        }
        await page.locator('#showcase-categories').click();
        await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
        assert.equal(await page.locator('#showcase').evaluate(node => node.inert), true);
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        assert.equal(await page.locator('#showcase').evaluate(node => node.inert), false);
        await scrollToProgress(1);
        const hold = await page.evaluate(() => {
            const section = document.getElementById('showcase');
            return { screen: section.querySelector('.bp-showcase-stage').offsetHeight,
                remaining: section.offsetHeight - document.documentElement.clientHeight - scrollY,
                opacity: Number(getComputedStyle(section.querySelector('.bp-showcase-outro')).opacity) };
        });
        assert.equal(hold.opacity, 1); assert.ok(hold.remaining >= hold.screen - 2, JSON.stringify(hold));
        await page.screenshot({ path: join(output, `${label}-outro.png`) });
        await page.evaluate(distance => scrollBy({ top: distance, behavior: 'instant' }), hold.screen * .85);
        await page.waitForTimeout(180);
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), true);
        await page.evaluate(() => {
            const section = document.getElementById('showcase');
            scrollTo({ top: section.offsetHeight - document.documentElement.clientHeight, behavior: 'instant' });
        });
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(900);
        await page.locator('#benchmark-search').focus();
        const focus = await page.locator('#benchmark-search').evaluate(node => ({
            outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow
        }));
        assert.deepEqual(focus, { outline: 'none', shadow: 'none' });
        assert.deepEqual(await page.evaluate(() => window.noticeAppearances), []);
        if (width > 760) {
            const title = page.locator('#showcase-trigger > span:visible');
            const before = await title.boundingBox();
            await title.hover(); await page.waitForTimeout(300);
            const after = await title.boundingBox();
            assert.ok(Math.abs(before.y - after.y) < .5, JSON.stringify({ before, after }));
            assert.equal(await title.evaluate(node => getComputedStyle(node).transform), 'none');
        }
        await openOverview(page, width < 760, { checkPrompt: true, native: engine === 'chromium' && width < 760 });
        await page.waitForTimeout(900);
        assert.deepEqual(await page.evaluate(() => window.noticeAppearances), []);
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), false);
        assert.deepEqual(await page.evaluate(() => window.noticeAppearances), []);
        assert.deepEqual(writes, []); assert.deepEqual(errors, []);
        results.push({ label, entryURL, copyBounds, layout, focus, hold, errors, writes, rememberedStandard: true, buffered });
        console.log(JSON.stringify({ label, passed: true, layout }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {});
        throw error;
    } finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); }
}
await writeFile(join(output, 'verification.json'), JSON.stringify(results, null, 2));
