import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.HANDOFF_TEST_OUTPUT ?? 'D:/Codex-artifacts/website1/showcase-view-20261012/workspace-ui-20261013/handoff';
await mkdir(output, { recursive: true });
const reports = [];
for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 390], ['webkit', webkit, 390]]) {
    const app = await startPreview({ rankingStress: true });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'no-preference' });
    const page = await context.newPage(); page.setDefaultTimeout(20000);
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    const label = `${engine}-${width}`;
    try {
        if (engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const response = await route.fetch(); await route.fulfill({ response, body: await response.body() });
        });
        await page.goto(app.url); await page.waitForFunction(() => document.getElementById('model-ranking-status')?.dataset.phase === 'ready');
        await page.evaluate(() => {
            const scene = document.getElementById('showcase');
            scrollTo({ top: scene.offsetHeight - document.documentElement.clientHeight - 12, behavior: 'instant' });
        });
        await page.waitForTimeout(120);
        if (width > 760) { await page.mouse.move(width / 2, 700); await page.mouse.wheel(0, 500); }
        else await page.evaluate(() => {
            const target = document.getElementById('showcase');
            const event = new Event('touchstart', { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: 120, clientY: 650 }] }); target.dispatchEvent(event);
            scrollTo({ top: target.offsetHeight - document.documentElement.clientHeight, behavior: 'instant' });
        });
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase'));
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase-handoff')), true);
        for (let index = 0; index < 4; index++) {
            const prevented = await page.evaluate(mobile => {
                const target = document.querySelector('.bp-workspace');
                const event = mobile ? new Event('touchmove', { bubbles: true, cancelable: true }) : new WheelEvent('wheel', { deltaY: 120, bubbles: true, cancelable: true });
                if (mobile) Object.defineProperty(event, 'touches', { value: [{ identifier: 1, clientX: 120, clientY: 450 }] });
                target.dispatchEvent(event); return event.defaultPrevented;
            }, width < 760);
            assert.equal(prevented, true, 'The old input burst must not continue into the formal page');
            await page.waitForTimeout(130);
        }
        await page.evaluate(() => scrollTo(0, 200)); await page.waitForTimeout(50);
        assert.equal(await page.evaluate(() => scrollY), 0);
        if (width < 760) {
            await page.waitForTimeout(900);
            assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase-handoff')), true, 'A held finger cannot unlock the page');
            await page.evaluate(() => {
                const event = new Event('touchend', { bubbles: true }); Object.defineProperty(event, 'touches', { value: [] }); window.dispatchEvent(event);
            });
        }
        await page.waitForFunction(() => !document.body.classList.contains('is-showcase-handoff'));
        if (width < 760) await page.locator('button[data-mobile-panel="models"]').click();
        const rows = page.locator('#model-rows');
        if (engine === 'webkit') {
            const allowed = await rows.evaluate(node => {
                const event = new WheelEvent('wheel', { deltaY: 180, bubbles: true, cancelable: true });
                node.dispatchEvent(event);
                if (!event.defaultPrevented) scrollBy(0, 180);
                return !event.defaultPrevented;
            });
            assert.equal(allowed, true);
        } else if (width < 760) {
            const session = await context.newCDPSession(page);
            try {
                const start = { x: 200, y: 650, id: 8 };
                await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [start] });
                for (const distance of [24, 60, 100, 140, 180]) {
                    await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...start, y: start.y - distance }] });
                    await page.waitForTimeout(35);
                }
                await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
            } finally { await session.detach(); }
        } else { await rows.hover(); await page.mouse.wheel(0, 180); }
        await page.waitForFunction(() => document.getElementById('model-rows').scrollTop > 0 || scrollY > 0);
        await page.screenshot({ path: join(output, `${label}-new-gesture.png`) });
        assert.deepEqual(errors, []);
        reports.push({ label, heldTouch: width < 760, oldBurstPrevented: true, newGestureAllowed: true, errors });
        console.log(JSON.stringify({ label, passed: true }));
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await page.unrouteAll({ behavior: 'ignoreErrors' }); await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
