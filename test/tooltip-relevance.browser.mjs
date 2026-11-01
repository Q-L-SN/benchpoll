import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/ui/tooltip.css"><style>
body { margin:0; font:14px Arial,sans-serif; background:#f5f6f8; }
main { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; max-width:620px; padding:80px 20px; margin:auto; }
button, a, .value { box-sizing:border-box; min-width:44px; min-height:44px; padding:10px; }
.clip { display:block; width:90px; overflow:hidden; white-space:nowrap; }
header { grid-column:1/-1; } #topic-summary { display:block; width:300px; overflow:hidden; white-space:nowrap; }
#name-scroll { overflow:auto; width:90px; white-space:nowrap; }
#scrolled-name { display:inline-block; }
.edge { position:fixed; padding:12px; } #top { left:8px;top:8px; } #bottom { right:8px;bottom:8px; }
</style></head><body><main>
<button id="visible" class="action" title="Edit profile" aria-label="Edit profile"><i class="fa-pen-to-square"></i><span>Edit profile</span></button>
<button id="toggle" class="action" aria-label="Switch to score range" data-tooltip="Switch to score range"><i class="fa-arrow-right-arrow-left"></i><span>Estimated score</span></button>
<button id="close" class="action" title="Close search"><i class="fa-xmark"></i></button>
<button id="search" class="action" aria-label="Search topics" data-tooltip="Search topics"><i class="fa-magnifying-glass"></i></button>
<a href="#edited" id="edit" class="action" aria-label="Change source score 9 for ARC-AGI" data-tooltip="Change approved score"><i class="fa-pen-to-square"></i></a>
<button id="unfamiliar" class="action" aria-label="Compare effort separately" data-tooltip="Compare effort separately"><i class="fa-brain"></i></button>
<button id="help" aria-label="How the score is calculated" data-help-text="Recorded scores and supported estimates are combined before the coverage adjustment.">?</button>
<button id="disabled" disabled aria-label="Add" title="Add" data-tooltip="AA results cannot be added to this ranking."><i class="fa-plus"></i></button>
<span id="count" class="value" tabindex="0" role="img" aria-label="38 approved scores from 12 models" data-tooltip="38 approved scores from 12 models">38</span>
<span id="coverage" class="value" tabindex="0" role="img" aria-label="Recorded scores cover 64% of this ranking's weight." data-tooltip="Recorded scores cover 64% of this ranking's weight.">64%</span>
<span id="fallback" class="value" data-tooltip="Fallback used for 2 benchmarks">Fallback</span>
<button id="limit" aria-label="Support proposal" data-tooltip="You can support at most three proposals at once.">Support</button>
<span id="name" class="clip" tabindex="0" data-tooltip="A model name with a long version">A model name with a long version</span>
<div id="name-scroll"><span id="scrolled-name" tabindex="0" data-tooltip="A model name with a long version">A model name with a long version</span></div>
<span id="parameter" class="value" data-tooltip="Harness: Official agent">Official agent</span>
<span id="full-name" class="value" tabindex="0" data-tooltip="Model Alpha">Model Alpha</span>
<div id="parent" data-tooltip="This row combines several independent measurements."><button class="action" id="nested" data-tooltip="Edit profile">Edit profile</button></div>
<button id="labelled" class="action" title="Close" aria-labelledby="close-name"><i class="fa-xmark"></i></button>
<span id="close-name" hidden>Close this dialog</span>
<span id="native-detail" class="value" title="Updated at 10:30 on October 31">Recently updated</span>
<button id="detailed-action" class="action" data-tooltip="Existing scores will remain available after this action.">Continue</button>
<button id="native-limit" title="Add at most 3 benchmarks"><i class="fa-plus"></i></button>
<button id="labelled-limit" aria-label="Add" title="Add at most 3 benchmarks"><i class="fa-plus"></i><span>Add</span></button>
<header><a id="topic" href="#topic" data-tooltip="Build and improve software.">Coding</a><span id="topic-summary" data-tooltip="Build and improve software.">Build and improve software.</span></header>
<span id="top" class="edge" data-tooltip="Scores from 38 models">38</span>
<span id="bottom" class="edge" data-tooltip="Coverage is based on benchmark weights, not the number of benchmarks.">64%</span>
</main><script type="module">
import '/js/shared/help-popover.js';
window.actions=0;
window.events=[];
for (const type of ['pointerdown','pointerup','click']) document.addEventListener(type, event => window.events.push([type,event.target.id,event.pointerType]), true);
for (const node of document.querySelectorAll('.action')) node.addEventListener('click', event => { event.preventDefault(); window.actions++; });
window.ready=true;
</script></body></html>`;

const launch = { headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost' } };

async function openFixture(browser, app, touch = false) {
    const page = await browser.newPage({ viewport:{ width:touch ? 390 : 1280, height:900 },
        hasTouch:touch, isMobile:touch, deviceScaleFactor:touch ? 3 : 1, reducedMotion:'reduce' });
    page.setDefaultTimeout(8000);
    await page.route('**/tooltip-relevance', route => route.fulfill({ contentType:'text/html', body:fixture }));
    await page.goto(app.url + '/tooltip-relevance');
    await page.waitForFunction(() => window.ready);
    return page;
}

async function dismiss(page) {
    await page.keyboard.press('Escape');
    await page.evaluate(() => document.activeElement?.blur());
    await page.mouse.move(1, 450);
}

for (const engine of [chromium, webkit]) {
    test(`${engine.name()}: redundant labels/actions are quiet, explanatory and clipped content remains`, async () => {
        const app = await startPreview(), browser = await engine.launch(launch);
        try {
            const page = await openFixture(browser, app), errors = [];
            page.on('pageerror', error => errors.push(error.message));
            const panel = page.locator('#bp-help-popover');
            for (const id of ['visible', 'toggle', 'close', 'search', 'edit', 'full-name', 'nested', 'labelled', 'topic']) {
                const target = page.locator('#' + id);
                await target.hover();
                await page.waitForTimeout(300);
                assert.equal(await panel.isVisible(), false, `${id}: no redundant hover tooltip`);
                await target.focus();
                assert.equal(await panel.isVisible(), false, `${id}: no redundant focus tooltip`);
                await dismiss(page);
            }
            assert.equal(await page.locator('#close').getAttribute('aria-label'), 'Close search');
            assert.equal(await page.locator('#labelled').getAttribute('aria-labelledby'), 'close-name');
            assert.equal(await page.locator('#labelled').getAttribute('aria-label'), null);
            assert.equal(await page.locator('#edit').getAttribute('aria-label'), 'Change source score 9 for ARC-AGI');
            assert.equal(await page.locator('[title]').count(), 0);

            for (const id of ['unfamiliar', 'help', 'disabled', 'count', 'coverage', 'fallback', 'limit', 'name', 'scrolled-name', 'parameter', 'native-detail', 'detailed-action', 'native-limit', 'labelled-limit']) {
                const target = page.locator('#' + id);
                await target.hover();
                await panel.waitFor({ state:'visible' });
                const expected = await target.evaluate(node => node.dataset.helpText ?? node.dataset.tooltip);
                assert.equal(await panel.textContent(), expected, id);
                await dismiss(page);
                if (await target.evaluate(node => node.matches('button:not(:disabled), [tabindex]'))) {
                    await target.focus();
                    await panel.waitFor({ state:'visible' });
                    assert.equal(await panel.textContent(), expected, `${id}: keyboard description`);
                    await dismiss(page);
                }
            }
            assert.equal(await page.locator('#disabled').getAttribute('data-tooltip'), 'AA results cannot be added to this ranking.');
            await page.locator('#topic-summary').evaluate(node => { node.style.width='90px'; });
            await page.locator('#topic').hover();
            await panel.waitFor({ state:'visible' });
            assert.equal(await panel.textContent(), 'Build and improve software.');
            await dismiss(page);
            await page.locator('#name').hover();
            await panel.waitFor({ state:'visible' });
            await page.locator('#name').evaluate(node => { node.style.width='300px'; });
            await panel.waitFor({ state:'hidden' });
            await dismiss(page);
            await page.locator('#name').hover();
            await page.waitForTimeout(300);
            assert.equal(await panel.isVisible(), false, 'fitting text no longer has a tooltip after resize');
            await page.locator('#name').evaluate(node => { node.style.width='90px'; });
            await dismiss(page);
            await page.locator('#name').hover();
            await panel.waitFor({ state:'visible' });
            await dismiss(page);
            await page.locator('#limit').hover();
            await panel.waitFor({ state:'visible' });
            assert.equal(await panel.getAttribute('data-placement'), 'top', 'middle controls prefer above');
            await page.locator('#limit').evaluate(node => { node.textContent=node.dataset.tooltip; });
            await panel.waitFor({ state:'hidden' });

            await page.locator('#close').evaluate(node => { node.title='Close model search'; });
            await page.waitForFunction(() => document.querySelector('#close').getAttribute('aria-label') === 'Close model search');
            await page.locator('#close').evaluate(node => { node.setAttribute('aria-label', 'Custom accessible close name'); node.title='Close'; });
            await page.waitForFunction(() => !document.querySelector('#close').hasAttribute('title'));
            assert.equal(await page.locator('#close').getAttribute('aria-label'), 'Custom accessible close name');
            assert.deepEqual(errors, []);
            await page.close();
        } finally { await browser.close(); await app.close(); }
    });

    test(`${engine.name()}: mobile actions activate on one tap, passive counts/help remain touch-readable`, async () => {
        const app = await startPreview(), browser = await engine.launch(launch);
        try {
            const page = await openFixture(browser, app, true), panel = page.locator('#bp-help-popover');
            let actions = 0;
            for (const id of ['visible', 'toggle', 'close', 'search', 'edit', 'unfamiliar', 'detailed-action']) {
                await page.locator('#' + id).tap();
                assert.equal(await page.evaluate(() => window.actions), ++actions, `${id}: first tap activates`);
                assert.equal(await panel.isVisible(), false, `${id}: no tap interception`);
            }
            for (const id of ['count', 'coverage', 'help', 'top', 'bottom']) {
                const target = page.locator('#' + id);
                await target.tap();
                await panel.waitFor({ state:'visible' }).catch(async error => {
                    error.message = `${id}: ${error.message}\n${JSON.stringify(await page.evaluate(() => window.events.slice(-15)))}`;
                    throw error;
                });
                const bounds = await panel.evaluate(node => {
                    const rect = node.getBoundingClientRect(), view = window.visualViewport;
                    return { x:rect.x,y:rect.y,right:rect.right,bottom:rect.bottom,placement:node.dataset.placement,
                        arrow:parseFloat(node.style.getPropertyValue('--bp-tooltip-arrow-x')),
                        left:view.offsetLeft,top:view.offsetTop,width:view.width,height:view.height };
                });
                assert.ok(bounds.x >= bounds.left + 11 && bounds.right <= bounds.left + bounds.width - 11, JSON.stringify(bounds));
                assert.ok(bounds.y >= bounds.top + 11 && bounds.bottom <= bounds.top + bounds.height - 11, JSON.stringify(bounds));
                const anchor = await target.boundingBox();
                assert.ok(Math.abs(bounds.x + bounds.arrow - (anchor.x + anchor.width / 2)) < 2, JSON.stringify(bounds));
                if (id === 'top') assert.equal(bounds.placement, 'bottom');
                if (id === 'bottom' || id === 'count') assert.equal(bounds.placement, 'top');
                await target.tap();
                await panel.waitFor({ state:'hidden' });
            }
            // Model a touch engine that emits no synthetic click after a long press.
            const plain = page.locator('#top');
            const anchor = await plain.boundingBox();
            const pointer = { pointerType:'touch',isPrimary:true,pointerId:42,clientX:anchor.x+10,clientY:anchor.y+10 };
            await plain.dispatchEvent('pointerdown', pointer);
            await page.waitForTimeout(550);
            await panel.waitFor({ state:'visible' });
            await plain.dispatchEvent('pointerup', pointer);
            await plain.tap();
            await panel.waitFor({ state:'hidden' });
            await page.locator('#detailed-action').dispatchEvent('pointerdown', pointer);
            await page.waitForTimeout(550);
            await panel.waitFor({ state:'visible' });
            await page.locator('#detailed-action').dispatchEvent('pointerup', pointer);
            await page.locator('#detailed-action').tap();
            assert.equal(await page.evaluate(() => window.actions), ++actions, 'next physical tap after a long press is not consumed');
            assert.equal(await panel.isVisible(), false);
            await page.locator('#count').tap();
            await panel.waitFor({ state:'visible' });
            await mkdir('D:/Codex-artifacts/website1/tooltip-relevance-20261031', { recursive:true });
            await page.screenshot({ path:`D:/Codex-artifacts/website1/tooltip-relevance-20261031/${engine.name()}-mobile.png` });
            await page.close();
        } finally { await browser.close(); await app.close(); }
    });
}
