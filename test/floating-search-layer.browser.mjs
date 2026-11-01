import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { chromium, webkit } from 'playwright';
import { startTopicsPreview } from '../scripts/frontend/topics-home-fixtures.mjs';
import { startPreview } from '../scripts/frontend/server.mjs';

const browsers = new Map();
const output = join(tmpdir(), 'benchpoll-floating-search-layer');
let fixture;
before(async () => {
    await mkdir(output, { recursive: true });
    fixture = await startTopicsPreview();
    const env = { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '', http_proxy: '', https_proxy: '', all_proxy: '',
        NO_PROXY: '127.0.0.1,localhost', no_proxy: '127.0.0.1,localhost' };
    for (const launcher of [chromium, webkit]) browsers.set(launcher.name(), await launcher.launch({ headless: true, env }));
});
after(async () => {
    for (const browser of browsers.values()) await browser.close();
    await fixture?.close();
});

async function newPage(t, engine, width, fallback) {
    const context = await browsers.get(engine).newContext({ viewport: { width, height: 844 },
        hasTouch: width < 500, reducedMotion: 'reduce', serviceWorkers: 'block' });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(7000);
    t.after(async () => { await context.close(); assert.deepEqual(errors, [], 'No browser exceptions'); });
    if (fallback) await page.addInitScript(() => {
        Object.defineProperty(HTMLElement.prototype, 'showPopover', { configurable: true, value: undefined });
        Object.defineProperty(HTMLElement.prototype, 'hidePopover', { configurable: true, value: undefined });
    });
    return page;
}

async function syntheticPage(page) {
    await page.route('**/__floating-search-test', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html>
        <html><head><meta name="viewport" content="width=device-width,initial-scale=1">
        <link rel="stylesheet" href="/css/ui/model-search.css"><style>
        body { margin:0; height:1800px; transform:translateZ(0); font:14px Arial; --bp-ink:rgb(18, 34, 56); }
        .clip { position:absolute; top:150px; left:32px; width:80px; height:48px; overflow:hidden; contain:paint; transform:translateZ(0); }
        #second { left:240px; } #after { position:absolute; top:440px; left:24px; }
        #outside { position:fixed; top:24px; right:24px; }
        #sticky { position:fixed; z-index:9000; top:215px; left:0; width:100%; height:200px; background:#526779; }
        #behind { width:100%; height:100%; } button { min-height:32px; }
        </style></head><body><button id="outside">Outside action</button>
        <div id="first" class="clip bp-model-search"></div><button id="after">After search</button>
        <div id="second" class="clip bp-model-search"></div><div id="sticky"><button id="behind">Underlying sticky action</button></div>
        <script type="module">
        import { createModelSearch } from '/js/shared/model-search.js';
        window.selected = []; window.outsideClicks = 0; window.behindClicks = 0; window.requests = []; window.parentClicks = 0;
        document.getElementById('outside').onclick = () => { window.outsideClicks++; window.outsideFocus = document.activeElement; };
        document.getElementById('behind').onclick = () => window.behindClicks++;
        document.getElementById('first').onclick = () => window.parentClicks++;
        window.searches = ['first', 'second'].map(id => createModelSearch({ container: document.getElementById(id),
            async search(query, { signal }) {
                window.requests.push({ query, signal });
                if (query === 'slow') await new Promise(resolve => setTimeout(resolve, 450));
                if (query === 'error') throw new Error('Fixture failure');
                if (query === 'empty') return [];
                return Array.from({ length: 10 }, (_, index) => ({ targetModel: query + index,
                    parts: [{ text: query + ' model ' + index, kind: 'name' }] }));
            }, onSelect: item => window.selected.push(item.targetModel) }));
        window.ready = true;
        </script></body></html>` }));
    await page.goto(`${fixture.url}/__floating-search-test`);
    await page.waitForFunction(() => window.ready);
}

async function assertOnTop(page, selector) {
    const state = await page.locator(selector).evaluate(panel => {
        const box = panel.getBoundingClientRect(), viewport = visualViewport;
        const points = [[box.left + 4, box.top + 4], [box.right - 4, box.bottom - 4],
            [box.left + box.width / 2, box.top + box.height / 2]];
        return { box: box.toJSON(), viewport: { left: viewport.offsetLeft, top: viewport.offsetTop, width: viewport.width, height: viewport.height },
            top: points.every(([x, y]) => panel.contains(document.elementFromPoint(x, y))), position: getComputedStyle(panel).position };
    });
    assert.equal(state.position, 'fixed');
    assert.equal(state.top, true, JSON.stringify(state));
    assert.ok(state.box.left >= state.viewport.left - 1 && state.box.right <= state.viewport.left + state.viewport.width + 1, JSON.stringify(state));
    assert.ok(state.box.top >= state.viewport.top - 1 && state.box.bottom <= state.viewport.top + state.viewport.height + 1, JSON.stringify(state));
}

async function assertClosed(page) {
    await page.waitForFunction(() => !document.querySelector('[data-floating-search-layer], [data-floating-search-portal]'));
    assert.equal(await page.locator('.bp-model-search-panel:visible, #topic-search-panel:visible').count(), 0);
    assert.equal(await page.locator('.bp-model-search-panel:popover-open, #topic-search-panel:popover-open').count(), 0);
}

for (const engine of ['chromium', 'webkit']) for (const fallback of [false, true]) {
    const mode = fallback ? 'portal' : 'popover';
    for (const width of [390, 1440]) test(`${engine} ${mode} ${width}px search escapes clip/transform and overlays sticky controls without click leaks`, async t => {
        const page = await newPage(t, engine, width, fallback);
        await syntheticPage(page);
        await page.locator('#first .bp-model-search-toggle').click();
        const panel = page.locator('.bp-model-search-panel:visible');
        const input = panel.getByRole('combobox');
        assert.equal(await panel.getAttribute('data-floating-search-layer'), mode);
        assert.equal(await panel.evaluate(node => node.parentElement.id === 'first'), !fallback);
        await input.fill('Found');
        await page.getByRole('option', { name: 'Found model 9', exact: true }).waitFor();
        await assertOnTop(page, '.bp-model-search-panel:visible');
        assert.equal(await input.evaluate(node => getComputedStyle(node).color), 'rgb(18, 34, 56)');
        await page.screenshot({ path: join(output, `${engine}-${mode}-${width}.png`) });
        const clicks = await page.evaluate(() => window.parentClicks);
        await page.getByRole('option', { name: 'Found model 0', exact: true }).click();
        assert.deepEqual(await page.evaluate(() => window.selected), ['Found0']);
        assert.equal(await page.evaluate(() => window.behindClicks), 0);
        assert.equal(await page.evaluate(() => window.parentClicks), clicks);
        await assertClosed(page);
        assert.equal(await page.locator('#first .bp-model-search-toggle').evaluate(node => node === document.activeElement), true);
        await page.locator('#first .bp-model-search-toggle').click();
        await page.locator('#outside').click();
        assert.equal(await page.evaluate(() => window.outsideClicks), 1, 'No modal scrim intercepts outside controls');
        await assertClosed(page);
        assert.equal(await page.evaluate(() => window.outsideFocus === document.activeElement), true, 'Dismissal preserves the native click focus');
        assert.equal(await page.locator('#first .bp-model-search-panel').count(), 1, 'Portal restores original ancestry');
    });

    test(`${engine} ${mode} keyboard, replacement, stale async, removal and history cleanup`, async t => {
        const page = await newPage(t, engine, 390, fallback);
        await syntheticPage(page);
        const toggle = page.locator('#first .bp-model-search-toggle');
        await toggle.click();
        const input = page.locator('.bp-model-search-panel:visible input');
        await input.fill('Key');
        await page.getByRole('option', { name: 'Key model 9', exact: true }).waitFor();
        await input.press('ArrowUp');
        const scroll = await page.evaluate(() => ({ page: scrollY, results: document.querySelector('.bp-model-search-panel:popover-open .bp-model-search-results, [data-floating-search-layer] .bp-model-search-results').scrollTop }));
        assert.equal(scroll.page, 0, 'Arrow navigation must not scroll the page');
        assert.ok(scroll.results > 0);
        await input.press('Enter');
        assert.deepEqual(await page.evaluate(() => window.selected), ['Key9']);
        await toggle.click();
        await input.press('Shift+Tab');
        assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
        await page.keyboard.press('Tab');
        assert.equal(await input.evaluate(node => node === document.activeElement), true, 'Tab from trigger returns to input');
        await input.press('Tab');
        assert.equal(await page.locator('#after').evaluate(node => node === document.activeElement), true, 'Tab leaves at the original DOM location');
        await assertClosed(page);
        await toggle.click();
        await input.fill('slow');
        await page.waitForFunction(() => window.requests.some(item => item.query === 'slow'));
        await page.locator('#second .bp-model-search-toggle').click();
        assert.equal(await toggle.getAttribute('aria-expanded'), 'false');
        assert.equal(await page.evaluate(() => window.requests.find(item => item.query === 'slow').signal.aborted), true);
        assert.equal(await page.locator('[data-floating-search-layer]').count(), 1);
        await page.keyboard.press('Escape');
        await assertClosed(page);
        await page.waitForTimeout(500);
        assert.equal(await page.locator('.bp-model-search-option').count(), 0, 'Late results cannot reopen or repopulate a closed panel');
        await toggle.click();
        await input.fill('empty');
        await page.getByText('No matching models.', { exact: true }).waitFor();
        await input.fill('error');
        await page.getByText('Could not search models. Try again.', { exact: true }).waitFor();
        await page.evaluate(() => document.getElementById('first').hidden = true);
        await assertClosed(page);
        await page.evaluate(() => document.getElementById('first').hidden = false);
        await toggle.click();
        await page.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
        await assertClosed(page);
        await toggle.click();
        await page.evaluate(() => document.getElementById('first').remove());
        await assertClosed(page);
        await page.evaluate(() => window.searches.forEach(search => search.destroy()));
        assert.equal(await page.locator('.bp-model-search-panel').count(), 0);
    });

    test(`${engine} ${mode} phone visual viewport, window resize and ancestor scroll track the anchor`, async t => {
        const page = await newPage(t, engine, 390, fallback);
        await page.addInitScript(() => {
            window.testViewport = Object.assign(new EventTarget(), { offsetLeft: 0, offsetTop: 0, width: innerWidth, height: innerHeight });
            Object.defineProperty(window, 'visualViewport', { configurable: true, value: window.testViewport });
        });
        await syntheticPage(page);
        await page.locator('#first .bp-model-search-toggle').click();
        await page.locator('.bp-model-search-panel:visible input').fill('Viewport');
        await page.getByRole('option', { name: 'Viewport model 9', exact: true }).waitFor();
        await page.evaluate(() => {
            Object.assign(window.testViewport, { offsetLeft: 20, offsetTop: 100, width: 340, height: 280 });
            window.testViewport.dispatchEvent(new Event('resize'));
            window.testViewport.dispatchEvent(new Event('scroll'));
        });
        await page.waitForFunction(() => document.querySelector('[data-floating-search-layer]').getBoundingClientRect().bottom <= 364);
        await assertOnTop(page, '.bp-model-search-panel:visible');
        const before = await page.locator('.bp-model-search-panel:visible').boundingBox();
        await page.evaluate(() => {
            document.getElementById('first').style.top = '120px';
            document.getElementById('first').dispatchEvent(new Event('scroll'));
        });
        await page.waitForFunction(top => document.querySelector('[data-floating-search-layer]').getBoundingClientRect().top !== top, before.y);
        await assertOnTop(page, '.bp-model-search-panel:visible');
        await page.setViewportSize({ width: 320, height: 500 });
        await page.evaluate(() => { Object.assign(window.testViewport, { offsetLeft: 0, offsetTop: 0, width: 320, height: 500 }); dispatchEvent(new Event('resize')); });
        await page.waitForFunction(() => document.querySelector('[data-floating-search-layer]').getBoundingClientRect().width === 288);
        await assertOnTop(page, '.bp-model-search-panel:visible');
    });

    for (const width of [390, 1440]) test(`${engine} ${mode} ${width}px topic search closes above the hero and only deliberately reopens`, async t => {
        const page = await newPage(t, engine, width, fallback);
        await page.goto(fixture.url);
        await page.waitForSelector('.th-card .th-model');
        const reveal = async () => {
            await page.evaluate(() => scrollTo(0, document.getElementById('home-hero').getBoundingClientRect().bottom + scrollY + 24));
            await page.waitForFunction(() => document.body.classList.contains('is-scrolled'));
        };
        await reveal();
        const toggle = page.getByRole('tab', { name: 'Search topics' });
        await toggle.click();
        const input = page.getByRole('searchbox', { name: 'Search topics' });
        await input.fill('Coding');
        await assertOnTop(page, '#topic-search-panel');
        await page.screenshot({ path: join(output, `${engine}-${mode}-${width}-topics-open.png`) });
        assert.equal(await page.locator('.th-card:visible').count(), 1);
        await page.evaluate(() => scrollTo(0, 0));
        await page.waitForFunction(() => !document.body.classList.contains('is-scrolled'));
        await assertClosed(page);
        assert.equal(await page.locator('#topic-search-toggle').getAttribute('aria-expanded'), 'false');
        await page.screenshot({ path: join(output, `${engine}-${mode}-${width}-hero-closed.png`) });
        assert.equal(await page.locator('#topic-search').inputValue(), 'Coding');
        assert.equal(await page.locator('.th-card:visible').count(), 1, 'Closing at the hero preserves filtering');
        await reveal();
        await assertClosed(page);
        assert.equal(await page.locator('#topic-search').count(), 1, 'No duplicate searchbox');
        await toggle.click();
        assert.equal(await input.inputValue(), 'Coding');
        assert.equal(await input.evaluate(node => node === document.activeElement), true);
        await page.locator('#home-model-search .bp-model-search-toggle').click();
        assert.equal(await page.locator('#topic-search-panel').isVisible(), false);
        assert.equal(await page.locator('[data-floating-search-layer]').count(), 1);
        await page.keyboard.press('Escape');
        await assertClosed(page);
        await toggle.click();
        await input.press('Escape');
        assert.equal(await page.locator('#topics-popular').getAttribute('aria-selected'), 'true');
        assert.equal(await toggle.evaluate(node => node === document.activeElement), true);
        await assertClosed(page);
    });
}

for (const fallback of [false, true]) for (const width of [320, 1440]) test(`ranking ${fallback ? 'portal' : 'popover'} ${width}px search is above a sticky scores header in the real workspace`, async t => {
    const app = await startPreview({ rankingStress: true });
    t.after(() => app.close());
    const page = await newPage(t, 'chromium', width, fallback);
    await page.goto(`${app.url}/Intelligence`);
    if (width < 500) await page.locator('button[data-mobile-panel="models"]').click();
    await page.waitForSelector('#model-rows .bp-model-row');
    await page.locator('#ranking-model-search .bp-model-search-toggle').click();
    await page.getByRole('combobox', { name: 'Search models' }).fill('Additional model');
    await page.getByRole('option').first().waitFor();
    await assertOnTop(page, '.bp-model-search-panel:visible');
    const input = page.getByRole('combobox', { name: 'Search models' });
    const clear = page.locator('.bp-model-search-panel:visible .bp-ui-field-clear');
    await clear.click();
    assert.equal(await input.inputValue(), '');
    assert.equal(await input.evaluate(node => node === document.activeElement), true);
    await input.fill('Additional model');
    await page.getByRole('option').first().waitFor();
    await page.screenshot({ path: join(output, `ranking-${fallback ? 'portal' : 'popover'}-${width}.png`) });
    await page.keyboard.press('ArrowDown');
    await page.keyboard.press('Enter');
    await page.waitForSelector('#model-rows .is-model-jump-focus');
    await assertClosed(page);
});

test('a failing native popover falls back and restores inline positioning after closure', async t => {
    const page = await newPage(t, 'chromium', 390, false);
    await page.addInitScript(() => { HTMLElement.prototype.showPopover = () => { throw new Error('Popover unavailable'); }; });
    await syntheticPage(page);
    await page.locator('#first .bp-model-search-panel').evaluate(panel => { panel.style.left = '12px'; panel.style.marginLeft = '3px'; });
    await page.locator('#first .bp-model-search-toggle').click();
    assert.equal(await page.locator('.bp-model-search-panel:visible').getAttribute('data-floating-search-layer'), 'portal');
    await page.keyboard.press('Escape');
    await assertClosed(page);
    assert.deepEqual(await page.locator('#first .bp-model-search-panel').evaluate(panel => [panel.style.left, panel.style.marginLeft]), ['12px', '3px']);
});
