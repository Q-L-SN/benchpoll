import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const built = process.env.BP_TEST_BUILT === '1';
for (const [engine, width] of built ? [[chromium, 390], [webkit, 390]] : [[chromium, 320], [chromium, 390], [webkit, 390]]) {
    test(`mobile weight gesture ${engine.name()} ${width}: drift, reversal, undo and horizontal intent ${built ? 'built' : 'source'}`, async t => {
        const fixture = await startPreview({ communityVersions: true });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width, height: 844 }, hasTouch: true, isMobile: true, reducedMotion: 'reduce' });
        page.setDefaultTimeout(10000);
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        await page.addInitScript(() => localStorage.setItem('benchpoll:config-sidebar-collapsed', 'true'));
        if (built) await page.route(fixture.url + '/', async route => route.fulfill({ contentType: 'text/html', body: await readFile('private/home-built.html', 'utf8') }));
        await page.goto(fixture.url);
        await page.locator('#pie-mode-personal').click();
        const tile = page.locator('#weight-pie [data-object-id="1"]');
        await tile.click();
        const settled = () => page.waitForFunction(() => document.getElementById('model-card').getAttribute('aria-busy') === 'false');
        await settled();
        await page.locator('#weight-pie').evaluate(node => node.scrollIntoView({ block: 'start' }));
        const initial = Number(await tile.getAttribute('data-weight'));
        // Playwright's public WebKit touchscreen API only exposes tap. Its pinned
        // in-process test driver also exposes native touch dispatch through the page proxy.
        const cdp = engine === chromium ? await page.context().newCDPSession(page) : null;
        const webkitInput = cdp ? null : page._connection.toImpl(page).delegate._pageProxySession;
        let lastTouch;
        const dispatch = params => {
            if (cdp) return cdp.send('Input.dispatchTouchEvent', params);
            if (params.touchPoints.length) lastTouch = params.touchPoints;
            // WebKit requires the released/cancelled contact, unlike Chromium's empty list.
            return webkitInput.send('Input.dispatchTouchEvent', { ...params, touchPoints: params.touchPoints.length ? params.touchPoints : lastTouch });
        };
        const box = await page.locator('#weight-pie').boundingBox();
        let x = box.x + box.width * .7, y = box.y + box.height * .6;
        const send = (type, dx = 0, dy = 0) => dispatch({
            type, touchPoints: ['touchEnd', 'touchCancel'].includes(type) ? [] : [{ x: x + dx, y: y + dy, id: 1 }]
        });
        const weight = async () => Number(await tile.getAttribute('data-weight'));
        const saves = () => fixture.state.requests.filter(request => request.path === '/api/save_personal_pie').length;
        const savedWeight = () => fixture.state.personalEntries.find(entry => entry.conditionID === 1).weightBasisPoints;
        const saveCount = saves();
        await page.evaluate(() => {
            document.getElementById('weight-pie').addEventListener('pointerdown', event => {
                if (event.pointerType === 'touch') window.weightTestTouchID = event.pointerId;
            }, { once: true });
        });
        await send('touchStart');
        let previous = initial;
        // A small vertical start followed by sideways drift used to trigger pointercancel.
        for (const [dx, dy] of [[0, -5], [-14, -7], [-24, -12], [-30, -20], [-32, -35], [-34, -50], [-35, -70]]) {
            await send('touchMove', dx, dy);
            await page.waitForTimeout(30);
            const current = await weight();
            assert.ok(current > previous, `Weight must keep following the finger: ${previous} -> ${current}`);
            previous = current;
            if (dy === -5) {
                // WebKit can reuse a pointer ID for mouse and touch events.
                await page.evaluate(() => {
                    const target = document.getElementById('weight-pie');
                    for (const type of ['pointermove', 'pointerup', 'pointercancel']) target.dispatchEvent(new PointerEvent(type, {
                        bubbles: true, pointerId: window.weightTestTouchID, pointerType: 'mouse', clientX: 0, clientY: 0
                    }));
                });
                await page.waitForTimeout(30);
                assert.equal(await weight(), current, 'Mouse events cannot change or finish the touch gesture');
                assert.equal(saves(), saveCount);
            }
        }
        await send('touchMove', -30, -50);
        await page.waitForTimeout(30);
        assert.ok(await weight() < previous, 'Reversing direction keeps the same gesture');
        assert.equal(saves(), saveCount, 'No partial gesture is saved');
        assert.equal(await page.locator('#workspace-scene-panel').evaluate(node => node.scrollLeft), 0);
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie')), send('touchEnd')]);
        await settled();
        const changed = await weight(); assert.equal(savedWeight(), changed);
        assert.equal(saves(), saveCount + 1, 'The whole drag saves once');
        assert.equal(fixture.state.personalEntries.reduce((sum, entry) => sum + entry.weightBasisPoints, 0), 10000);
        await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/save_personal_pie')), page.locator('#workspace-undo').click()]);
        await settled();
        assert.equal(await weight(), initial, 'One undo restores the whole drag');
        assert.equal(savedWeight(), initial);

        // Undo now sits above the chart; clicking it can scroll the mobile viewport.
        await page.locator('#weight-pie').evaluate(node => node.scrollIntoView({ block: 'start' }));
        const restoredBox = await page.locator('#weight-pie').boundingBox();
        x = restoredBox.x + restoredBox.width * .7; y = restoredBox.y + restoredBox.height * .6;

        // An actual system cancellation still rolls back instead of saving a partial edit.
        const beforeCancel = saves();
        await send('touchStart'); await send('touchMove', 0, -20); await page.waitForTimeout(30);
        assert.ok(await weight() > initial);
        await send('touchCancel'); await page.waitForTimeout(50);
        assert.equal(await weight(), initial); assert.equal(saves(), beforeCancel);

        // Horizontal intent remains native, including motion before the finger is lifted.
        await page.evaluate(() => {
            window.horizontalTouches = [];
            document.getElementById('weight-pie').addEventListener('touchmove', event => {
                window.horizontalTouches.push({ trusted: event.isTrusted, prevented: event.defaultPrevented });
            }, { passive: true });
        });
        await send('touchStart');
        for (let step = 1; step <= 7; step++) {
            await send('touchMove', -step * (width - 80) / 7, 0);
            await page.waitForTimeout(35);
            if (step === 4 && engine === chromium) {
                const progress = await page.locator('#workspace-scene-panel').evaluate(node => node.scrollLeft / node.clientWidth);
                assert.ok(progress > .1 && progress < .9, `Native paging follows the finger (${progress})`);
            }
        }
        await send('touchEnd');
        const touches = await page.evaluate(() => window.horizontalTouches);
        assert.ok(touches.length > 0 && touches.every(event => event.trusted && !event.prevented), 'Horizontal touches pass through to the browser');
        // WebKit's Linux protocol dispatches trusted contacts but does not emulate
        // the platform's scrolling recognizer. Chromium above covers compositor paging.
        if (engine === webkit) await page.locator('button[data-mobile-panel="models"]').click();
        await page.waitForFunction(() => document.querySelector('.bp-workspace').dataset.mobilePanel === 'models');
        assert.equal(await weight(), initial); assert.equal(saves(), beforeCancel);
        await cdp?.detach();
    });
}
