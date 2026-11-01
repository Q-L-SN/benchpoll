import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { openOverview } from './showcase-interactions.mjs';

const output = process.env.SHOWCASE_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/browser';
await mkdir(output, { recursive: true });
const ready = page => page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready'
    && document.querySelectorAll('#model-rows [data-model-key]').length > 0);
const builtRoot = process.env.HOME_BUILT_ROOT;
const builtHTML = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const results = [];
for (const [engine, launcher, width, height, reduced] of [
    ['chromium', chromium, 1440, 900, false], ['chromium', chromium, 900, 760, false],
    ['chromium', chromium, 390, 844, false], ['chromium', chromium, 320, 640, false],
    ['webkit', webkit, 390, 844, false], ['chromium', chromium, 390, 844, true]
]) {
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    const label = `${engine}-${width}${reduced ? '-reduced' : ''}${builtRoot ? '-built' : ''}`;
    const app = await startPreview({ rankingStress: true });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height }, isMobile: width < 760, hasTouch: width < 760,
        reducedMotion: reduced ? 'reduce' : 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    try {
        if (builtHTML || engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const path = new URL(route.request().url()).pathname;
            if (builtHTML && route.request().resourceType() === 'document') return route.fulfill({ body: builtHTML, contentType: 'text/html' });
            if (builtHTML && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))),
                contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
            if (engine === 'webkit') {
                const response = await route.fetch({ maxRetries: 2 });
                return route.fulfill({ response, body: await response.body() });
            }
            return route.fallback();
        });
        await context.addInitScript(() => {
            window.rankingNoticeAppearances = [];
            new MutationObserver(() => {
                const notice = document.getElementById('model-ranking-status');
                if (notice && !notice.hidden) window.rankingNoticeAppearances.push(notice.dataset.phase);
            }).observe(document, { subtree: true, attributes: true, attributeFilter: ['hidden', 'data-phase'] });
        });
        const initialPath = width === 900 || width === 320 ? '/Language-models/Reasoning' : '/Language-models';
        await page.goto(`${app.url}${initialPath}`); await ready(page);
        await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.evaluate(() => localStorage.getItem('benchpoll-workspace-display-v1')), null);
        assert.equal(new URL(page.url()).searchParams.has('view'), false);
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), true);
        assert.equal(await page.locator('#showcase-intro').textContent(), 'AI labs choose what they report. Help the community decide what counts, and how much.');
        if (!reduced) {
            const copyBounds = await page.evaluate(() => {
                const question = document.getElementById('showcase-question').getBoundingClientRect();
                const intro = document.getElementById('showcase-intro').getBoundingClientRect();
                const charts = document.querySelector('.bp-workspace-grid').getBoundingClientRect();
                const footer = document.querySelector('.bp-showcase-footer').getBoundingClientRect();
                return { question: question.toJSON(), intro: intro.toJSON(), charts: charts.toJSON(), footer: footer.toJSON(), width: innerWidth };
            });
            assert.ok(copyBounds.intro.top >= copyBounds.question.bottom, JSON.stringify(copyBounds));
            assert.ok(copyBounds.intro.left >= 0 && copyBounds.intro.right <= copyBounds.width, JSON.stringify(copyBounds));
            assert.ok(copyBounds.intro.bottom <= Math.min(copyBounds.charts.top, copyBounds.footer.top), JSON.stringify(copyBounds));
        }
        assert.deepEqual(await page.evaluate(() => window.rankingNoticeAppearances), []);
        assert.equal(await page.locator('.bp-sidebar').isVisible(), false);
        const beforeWeights = structuredClone(app.state.personalEntries);
        const before = await page.locator('#model-rows [data-model-key]').evaluateAll(nodes => nodes.map(node => node.dataset.modelKey));
        const calculationsBefore = app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').length;
        await page.screenshot({ path: join(output, `${label}-hero.png`) });
        async function scrollToProgress(progress) {
            await page.evaluate(p => {
                const scene = document.getElementById('showcase');
                const start = scene.getBoundingClientRect().top + scrollY;
                const hold = scene.querySelector('.bp-showcase-stage').offsetHeight;
                scrollTo({ top: start + (scene.offsetHeight - document.documentElement.clientHeight - hold) * p, behavior: 'instant' });
            }, progress);
            await page.waitForTimeout(120);
        }
        if (!reduced) {
            await scrollToProgress(.17); await page.screenshot({ path: join(output, `${label}-motion.png`) });
        }
        await scrollToProgress(.55); await page.screenshot({ path: join(output, `${label}-charts.png`) });
        const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > innerWidth + 1,
            heroOpacity: Number(getComputedStyle(document.querySelector('.bp-showcase-hero')).opacity),
            columns: document.querySelectorAll('.bp-model-column').length,
            white: [...document.querySelectorAll('.bp-model-column-value')].every(node => getComputedStyle(node).color === 'rgb(255, 255, 255)'),
            maxColumnHeight: Math.max(...[...document.querySelectorAll('.bp-model-column-plot')].map(node => node.getBoundingClientRect().height)),
            maxColumnWidth: Math.max(...[...document.querySelectorAll('.bp-column-known')].map(node => node.getBoundingClientRect().width)),
            grid: document.querySelector('.bp-workspace-grid').getBoundingClientRect().toJSON(),
            viewportHeight: innerHeight
        }));
        assert.equal(layout.overflow, false, JSON.stringify(layout));
        assert.equal(layout.heroOpacity, 0); assert.equal(layout.white, true); assert.ok(layout.columns > 0);
        assert.ok(layout.maxColumnHeight <= (width > 760 ? 240 : 140) + 1, JSON.stringify(layout));
        assert.ok(layout.maxColumnWidth <= (width > 760 ? 36 : 30) + 1, JSON.stringify(layout));
        assert.equal(await page.locator('#inline-fallback').isVisible(), false);
        assert.equal(await page.locator('#weight-bars input').count(), 0);
        assert.equal(await page.locator('.bp-quick-comparison button:visible').count(), 2);
        const initialColumns = await page.locator('.bp-model-column').count();
        const pageCount = () => app.state.requests.filter(request => request.path === '/api/get_ranking_page' && request.body.list === 'public').length;
        assert.equal(pageCount(), 0, 'Opening or vertically scrolling the presentation must not load more models');
        const scaledWeights = await page.locator('.bp-weight-bar-row').evaluateAll(rows => rows.map(row => ({
            width: parseFloat(row.style.getPropertyValue('--weight-width')), value: row.querySelector('.bp-weight-bar-value').textContent
        })));
        assert.equal(scaledWeights[0].width, 100);
        assert.notEqual(scaledWeights[0].value, '100%', 'The percentage label remains the true weight');
        const backgrounds = await page.locator('.bp-model-column-plot').evaluateAll(plots => plots.every(plot => {
            const known = plot.querySelector('.bp-column-known').getBoundingClientRect();
            const gray = plot.querySelector('.bp-column-uncertain').getBoundingClientRect();
            return gray.top <= known.top + 1 && gray.bottom >= known.bottom - 1;
        }));
        assert.equal(backgrounds, true);
        await page.locator('.bp-model-chart-scroll').evaluate(node => { node.scrollLeft = (node.scrollWidth - node.clientWidth) / 2; });
        await page.waitForTimeout(200); assert.equal(pageCount(), 0, 'A middle-of-chart swipe must not fetch');
        const offset = await page.locator('.bp-model-chart-scroll').evaluate(node => {
            node.scrollLeft = node.scrollWidth - node.clientWidth - 3; return node.scrollLeft;
        });
        await page.waitForFunction(count => document.querySelectorAll('.bp-model-column').length > count, initialColumns);
        await page.waitForTimeout(200);
        assert.equal(pageCount(), 1, 'Appended models do not trigger another page');
        assert.ok(Math.abs(await page.locator('.bp-model-chart-scroll').evaluate(node => node.scrollLeft) - offset) <= 1);
        await page.locator('.bp-model-chart-scroll').evaluate(node => { node.scrollLeft = 0; });
        await page.locator('#showcase-categories').click();
        await page.waitForFunction(() => document.body.classList.contains('taxonomy-open'));
        assert.equal(await page.locator('.bp-sidebar').isVisible(), true);
        await page.screenshot({ path: join(output, `${label}-categories.png`) });
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('taxonomy-open'));
        await page.waitForTimeout(350);
        assert.equal(await page.locator('.bp-sidebar').isVisible(), false);
        await scrollToProgress(1);
        const hold = await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            const screen = scene.querySelector('.bp-showcase-stage').offsetHeight;
            const outro = scene.querySelector('.bp-showcase-outro');
            return { screen, remaining: scene.offsetHeight - document.documentElement.clientHeight - scrollY,
                opacity: Number(getComputedStyle(outro).opacity), active: document.body.classList.contains('is-showcase') };
        });
        assert.equal(hold.active, true); assert.equal(hold.opacity, 1);
        assert.ok(hold.remaining >= hold.screen - 2, JSON.stringify(hold));
        await page.screenshot({ path: join(output, `${label}-outro.png`) });
        await page.evaluate(distance => scrollBy({ top: distance, behavior: 'instant' }), hold.screen * .85);
        await page.waitForTimeout(120);
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), true, 'Scrolling most of a viewport must still hold the third screen');
        assert.equal(await page.locator('.bp-showcase-outro').evaluate(node => Number(getComputedStyle(node).opacity)), 1);
        await scrollToProgress(.55);
        assert.equal(await page.locator('.bp-showcase-outro').evaluate(node => Number(getComputedStyle(node).opacity)), 0, 'Scrolling backwards returns to the data scene');
        await scrollToProgress(1);
        await page.locator('#showcase-next').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(reduced ? 50 : 800);
        assert.equal(await page.locator('#weight-pie').isVisible(), true);
        assert.deepEqual((await page.locator('#model-rows [data-model-key]').evaluateAll(nodes => nodes.map(node => node.dataset.modelKey))).slice(0, before.length), before);
        assert.deepEqual(await page.evaluate(() => window.rankingNoticeAppearances), []);
        assert.equal(app.state.requests.filter(request => request.path === '/api/get_weighted_workspace').length, calculationsBefore);
        assert.deepEqual(app.state.personalEntries, beforeWeights);
        assert.equal(app.state.requests.some(request => request.path === '/api/save_personal_pie'), false);
        await page.screenshot({ path: join(output, `${label}-formal.png`) });
        await page.locator('#benchmark-search').focus();
        const focus = await page.locator('#benchmark-search').evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, shadow: getComputedStyle(node).boxShadow }));
        assert.deepEqual(focus, { outline: 'none', shadow: 'none' });
        await openOverview(page, width < 760, { checkPrompt: true, native: engine === 'chromium' && width < 760 });
        await page.waitForFunction(() => document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(reduced ? 50 : 800);
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(reduced ? 50 : 800);
        assert.deepEqual(await page.evaluate(() => window.rankingNoticeAppearances), []);
        assert.equal(await page.evaluate(() => localStorage.getItem('benchpoll-workspace-display-v1')), 'standard');
        await page.reload(); await ready(page);
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), false);
        await page.goto(`${app.url}/Language-models/Reasoning`); await ready(page);
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), false);
        await page.goto(`${app.url}/Language-models?view=showcase`); await ready(page);
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), true);
        await page.locator('#showcase-enter').click();
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        await page.waitForTimeout(reduced ? 50 : 800);
        assert.deepEqual(await page.evaluate(() => window.rankingNoticeAppearances), []);
        if (width === 1440 && !reduced) {
            await openOverview(page, false);
            await page.waitForFunction(() => document.body.classList.contains('is-showcase'));
            await page.waitForTimeout(800);
            await scrollToProgress(.55);
            await page.locator('#weight-bars .bp-benchmark-information-link').first().click();
            await page.locator('#benchmark-information-name').waitFor();
            await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
            await page.locator('#discussion-close').click();
            await page.locator('#pie-mode-personal').click(); await ready(page);
            await page.waitForFunction(() => document.querySelector('#pie-mode-personal').getAttribute('aria-selected') === 'true');
            await page.locator('.bp-pie-transition').waitFor({ state: 'detached' });
            await openOverview(page, false);
            await page.waitForFunction(() => document.body.classList.contains('is-showcase'));
            await page.waitForTimeout(800);
            assert.equal(await page.locator('#showcase-question').textContent(), 'How would you rank AI for this task?');
            assert.equal(await page.locator('#showcase-intro').textContent(), 'The community chooses the weights.\nThe results speak for themselves.');
            await page.locator('#showcase-enter').click();
            await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
            await page.waitForTimeout(800);
            await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-personal-weight').click();
            app.state.saveDelay = 600;
            await page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-personal-weight').evaluate(node =>
                node.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true, cancelable: true })));
            await page.waitForFunction(() => {
                const node = document.getElementById('model-ranking-status');
                return node.dataset.phase === 'updating' && !node.hidden;
            });
            await page.waitForFunction(() => {
                const node = document.getElementById('model-ranking-status');
                return node.dataset.phase === 'ready' && !node.hidden && node.textContent.includes('Ranking updated');
            });
            assert.equal(app.state.requests.filter(request => request.path === '/api/save_personal_pie').length, 1);
        }
        assert.deepEqual(errors, []);
        results.push({ label, layout, focus, hold, errors });
        console.log(JSON.stringify({ label, passed: true, columns: layout.columns }));
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {});
        throw error;
    } finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(results, null, 2));
