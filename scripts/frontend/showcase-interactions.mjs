import assert from 'node:assert/strict';

export async function pullOverview(page, { x = 0, y = 100, cancel = false } = {}) {
    await page.evaluate(({ x, y, cancel }) => {
        window.scrollTo({ top: 0, behavior: 'instant' });
        const target = document.querySelector('.bp-page-heading');
        const touch = { identifier: 17, clientX: 24, clientY: 120 };
        const dispatch = (type, touches) => {
            const event = new Event(type, { bubbles: true, cancelable: true });
            Object.defineProperty(event, 'touches', { value: touches });
            target.dispatchEvent(event);
        };
        dispatch('touchstart', [touch]);
        dispatch('touchmove', [{ ...touch, clientX: touch.clientX + x, clientY: touch.clientY + y }]);
        dispatch(cancel ? 'touchcancel' : 'touchend', []);
    }, { x, y, cancel });
}

async function nativePull(page) {
    await page.evaluate(() => {
        window.overviewTouchLog = [];
        for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) window.addEventListener(type, event => {
            window.overviewTouchLog.push({ type, target: event.target.tagName + '.' + event.target.className,
                touches: [...event.touches].map(touch => [touch.identifier, touch.clientX, touch.clientY]),
                scroll: scrollY, prevented: event.defaultPrevented, prompt: document.querySelector('.bp-showcase-pull-prompt').textContent,
                body: document.body.className, dialogs: document.querySelectorAll('global-dialog:not([hidden]), dialog[open]').length,
                parents: (() => { const values = []; for (let node = event.target; node; node = node.parentElement) values.push([node.tagName, node.className, node.scrollTop]); return values; })() });
        }, { passive: true });
    });
    const start = await page.evaluate(() => {
        for (let y = 80; y < Math.min(innerHeight - 160, 330); y += 8) for (let x = 12; x < innerWidth - 12; x += 12) {
            const node = document.elementFromPoint(x, y);
            if (node?.closest('.bp-page-heading') && !node.closest('button:not(.bp-showcase-trigger), a, input, textarea, select, .bp-pie-stage')) return { x, y };
        }
        return null;
    });
    assert.ok(start, 'The formal heading is visible for the pull gesture');
    const session = await page.context().newCDPSession(page);
    try {
        await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 8 }] });
        for (const distance of [16, 40, 65, 95]) {
            await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: start.x, y: start.y + distance, id: 8 }] });
            await page.waitForTimeout(35);
        }
        await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await session.detach(); }
}

export async function openOverview(page, mobile, { checkPrompt = false, native = false } = {}) {
    if (!mobile) await page.locator('#showcase-trigger').click();
    else {
        await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
        await page.locator('#showcase-trigger').tap();
        await page.locator('.bp-showcase-pull-prompt.is-visible').waitFor();
        assert.equal(await page.locator('.bp-showcase-pull-prompt').innerText(), 'Pull down to open the overview');
        assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), false);
        if (checkPrompt) {
            await page.waitForFunction(() => !document.querySelector('.bp-showcase-pull-prompt').classList.contains('is-visible'));
            await pullOverview(page, { y: 35 });
            await pullOverview(page, { x: 100, y: 20 });
            await pullOverview(page, { y: 100, cancel: true });
            assert.equal(await page.locator('body').evaluate(node => node.classList.contains('is-showcase')), false);
        }
        if (native) await nativePull(page);
        else await pullOverview(page);
    }
    try { await page.waitForFunction(() => document.body.classList.contains('is-showcase')); }
    catch (error) { console.error(JSON.stringify(await page.evaluate(() => window.overviewTouchLog ?? []))); throw error; }
}
