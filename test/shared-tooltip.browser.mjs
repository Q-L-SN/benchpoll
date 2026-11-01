import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const fixture = `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<link rel="stylesheet" href="/css/ui/tooltip.css"><style>
body { margin:0; font:14px Arial,sans-serif; background:#f5f6f8; }
button,a { box-sizing:border-box; min-width:44px; min-height:44px; }
.corner { position:fixed; } #tl { left:12px;top:12px; } #tr { right:12px;top:12px; }
#bl { left:12px;bottom:12px; } #br { right:12px;bottom:12px; }
#action { position:fixed;top:42%;left:40%; } #help { position:fixed;top:52%;left:40%; }
#clip { position:fixed;top:65%;left:12px;width:150px;height:52px;overflow:auto; }
#clip>div { height:180px; } #shadow { position:fixed;right:12px;top:65%; }
dialog { width:200px; } dialog button { display:block;margin:auto; }
</style></head><body>
<span id="desc" hidden>Existing description.</span>
<button class="corner" id="tl" data-tooltip="Top left tooltip with enough words to make the arrow move">TL</button>
<button class="corner" id="tr" title="Top right tooltip with enough words to make the arrow move">TR</button>
<button class="corner" id="bl" data-tooltip="Bottom left tooltip with enough words to make the arrow move">BL</button>
<button class="corner" id="br" data-tooltip="Bottom right tooltip with enough words to make the arrow move">BR</button>
<button id="action" data-tooltip="The original action still works" aria-expanded="true" aria-describedby="desc">Action</button>
<button id="help" data-help-content="help-copy" aria-label="Help" aria-expanded="false">?</button>
<div id="help-copy" hidden><strong>Readable explanation.</strong><p>Extra information.</p><a href="#more">Read more</a></div>
<div id="clip"><div><button id="clipped" data-tooltip="Inside a scroll container">Clip</button></div></div>
<div id="shadow"></div><dialog id="modal"><button id="modal-help" data-tooltip="Above a modal too">Inside modal</button></dialog>
<script type="module">
import '/js/shared/help-popover.js';
import '/js/shared/help-popover.js?v=another-entry';
window.actions=0;document.querySelector('#action').onclick=()=>window.actions++;
document.querySelector('#shadow').attachShadow({mode:'open'}).innerHTML='<button data-tooltip="Shadow header control">Shadow</button>';
window.ready=true;
</script></body></html>`;

async function fixturePage(browser, app, width, touch = false) {
    const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch, reducedMotion: 'reduce' });
    page.setDefaultTimeout(8000);
    await page.route('**/tooltip-fixture', route => route.fulfill({ contentType: 'text/html', body: fixture }));
    await page.goto(app.url + '/tooltip-fixture');
    await page.waitForFunction(() => window.ready);
    return page;
}

const launch = { headless: true, env: { ...process.env, HTTP_PROXY: '', HTTPS_PROXY: '', ALL_PROXY: '',
    http_proxy: '', https_proxy: '', all_proxy: '', NO_PROXY: '127.0.0.1,localhost' } };

for (const engine of [chromium, webkit]) test(`${engine.name()}: tooltip edges, actions, focus, shadow roots and modal layering`, async () => {
    const app = await startPreview(), browser = await engine.launch(launch);
    try {
        for (const width of [390, 1280]) {
            const page = await fixturePage(browser, app, width);
            const errors = []; page.on('pageerror', error => errors.push(error.message));
            const panel = page.locator('#bp-help-popover');
            for (const id of ['tl', 'tr', 'bl', 'br']) {
                await page.locator('#' + id).hover();
                await panel.waitFor({ state: 'visible' });
                const metrics = await panel.evaluate(node => {
                    const r = node.getBoundingClientRect();
                    return { x:r.x,y:r.y,width:r.width,height:r.height,placement:node.dataset.placement,
                        arrow:parseFloat(node.style.getPropertyValue('--bp-tooltip-arrow-x')) };
                });
                assert.ok(metrics.x >= 11 && metrics.x + metrics.width <= width - 11, JSON.stringify(metrics));
                assert.ok(metrics.y >= 11 && metrics.y + metrics.height <= 789, JSON.stringify(metrics));
                assert.equal(metrics.placement, id.startsWith('t') ? 'bottom' : 'top');
                const anchor = await page.locator('#' + id).boundingBox();
                assert.ok(Math.abs(metrics.x + metrics.arrow - (anchor.x + anchor.width / 2)) < 2);
                await page.keyboard.press('Escape');
                assert.equal(await panel.isVisible(), false);
            }
            assert.equal(await page.locator('[title]').count(), 0);
            await page.locator('#action').click();
            assert.equal(await page.evaluate(() => window.actions), 1);
            assert.equal(await page.locator('#action').getAttribute('aria-expanded'), 'true');
            await page.locator('#action').focus();
            await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
            await panel.waitFor({ state: 'visible' });
            assert.equal(await page.locator('#action').getAttribute('aria-describedby'), 'desc bp-help-popover');
            await page.keyboard.press('Escape');
            assert.equal(await page.locator('#action').getAttribute('aria-describedby'), 'desc');
            await page.locator('#help').click();
            await panel.waitFor({ state: 'visible' });
            assert.equal(await panel.getAttribute('role'), 'dialog');
            await page.keyboard.press('Tab');
            assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Read more');
            await page.keyboard.press('Escape');
            assert.equal(await panel.isVisible(), false);
            assert.equal(await page.locator('#help').getAttribute('aria-expanded'), 'false');
            await page.locator('#shadow button').hover();
            await panel.waitFor({ state: 'visible' });
            assert.equal(await panel.textContent(), 'Shadow header control');
            await page.keyboard.press('Escape');
            await page.locator('#clipped').hover();
            await panel.waitFor({ state: 'visible' });
            await page.locator('#clip').evaluate(node => { node.scrollTop=110; });
            await panel.waitFor({ state: 'hidden' });
            await page.evaluate(() => { document.activeElement.blur(); document.querySelector('#modal').showModal(); });
            await page.locator('#modal-help').hover();
            await panel.waitFor({ state: 'visible' });
            assert.equal(await panel.textContent(), 'Above a modal too');
            assert.equal(await panel.evaluate(node => node.matches(':popover-open')), true);
            const topmost = await panel.evaluate(node => { const r=node.getBoundingClientRect(); return node.contains(document.elementFromPoint(r.x+10,r.y+10)); });
            assert.equal(topmost, true);
            await page.evaluate(() => document.querySelector('#modal').close());
            await panel.waitFor({ state: 'hidden' });
            await page.locator('#tr').hover(); await panel.waitFor({ state: 'visible' });
            await page.locator('#tr').evaluate(node => { node.dataset.tooltip='Updated tooltip'; });
            await page.waitForFunction(() => document.querySelector('#bp-help-popover')?.textContent==='Updated tooltip');
            await mkdir('D:/Codex-artifacts/website1/shared-tooltip-20261030', { recursive:true });
            await page.screenshot({ path:`D:/Codex-artifacts/website1/shared-tooltip-20261030/${engine.name()}-${width}.png` });
            assert.equal(await page.locator('#bp-help-popover').count(), 1);
            assert.deepEqual(errors, []);
            await page.close();
        }
    } finally { await browser.close(); await app.close(); }
});

test('touch tap keeps actions, long press reveals without clicking, and scrolling cancels a press', async () => {
    const app = await startPreview(), browser = await chromium.launch(launch);
    try {
        const page = await fixturePage(browser, app, 390, true);
        const client = await page.context().newCDPSession(page);
        const action = await page.locator('#action').boundingBox();
        const point = { x:action.x+20,y:action.y+20 };
        const send = (type, p = point) => client.send('Input.dispatchTouchEvent', { type, touchPoints:type==='touchEnd'?[]:[p] });
        await page.touchscreen.tap(point.x, point.y);
        assert.equal(await page.evaluate(() => window.actions), 1);
        await send('touchStart'); await page.waitForTimeout(600);
        await page.locator('#bp-help-popover').waitFor({ state:'visible' });
        await send('touchEnd');
        assert.equal(await page.evaluate(() => window.actions), 1);
        await page.touchscreen.tap(10, 240);
        assert.equal(await page.locator('#bp-help-popover').isVisible(), false);
        await send('touchStart'); await send('touchMove', {x:point.x,y:point.y+35}); await page.waitForTimeout(600); await send('touchEnd');
        assert.equal(await page.locator('#bp-help-popover').isVisible(), false);
        await page.locator('#help').tap();
        await page.locator('#bp-help-popover').waitFor({state:'visible'});
        await page.locator('#help').tap();
        assert.equal(await page.locator('#bp-help-popover').isVisible(), false);
        await page.close();
    } finally { await browser.close(); await app.close(); }
});
