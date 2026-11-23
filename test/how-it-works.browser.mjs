import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { expect } from 'playwright/test';
import { startPreview } from '../scripts/frontend/server.mjs';

const output = process.env.BP_GUIDE_ARTIFACTS ?? '/tmp/benchpoll-guide';
await mkdir(output, { recursive: true });

async function assertFragmentVisible(page, id) {
    await expect.poll(() => page.evaluate(id => {
        const heading = document.getElementById(id);
        const header = document.querySelector('.hi-topbar');
        const rect = heading?.getBoundingClientRect();
        const visible = Boolean(rect && rect.top >= header.getBoundingClientRect().bottom && rect.bottom <= innerHeight);
        return { hash: location.hash, visible };
    }, id), { timeout: 8000 }).toEqual({ hash: '#' + id, visible: true });
}

async function assertCurrentLink(page, url, id) {
    await page.waitForURL(url + (id ? '#' + id : ''));
    await page.locator(`.hi-toc a[href="#${id || 'overview'}"][aria-current="location"]`).waitFor({ state: 'attached' });
    assert.equal(await page.locator('.hi-toc a[aria-current]').count(), 1);
}

for (const engine of [chromium, webkit]) {
    for (const width of [1440, 390, 320]) {
        test(`${engine.name()} ${width}: document outline, keyboard navigation and fragment history`, async t => {
            const fixture = await startPreview();
            const browser = await engine.launch({ headless: true });
            const narrow = width < 760;
            const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: narrow,
                isMobile: narrow, reducedMotion: narrow ? 'reduce' : 'no-preference' });
            page.setDefaultTimeout(8000);
            const errors = [], documentRequests = [];
            page.on('pageerror', error => errors.push(error.message));
            page.on('request', request => {
                if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documentRequests.push(request.url());
            });
            t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });

            const url = fixture.url + '/how-it-works?source=help';
            assert.equal((await page.goto(url)).status(), 200);
            await page.evaluate(() => document.fonts.ready);
            const toc = page.getByRole('navigation', { name: 'Contents' });
            const disclosure = toc.locator('details');
            const toggle = toc.locator('summary');
            const title = page.getByRole('heading', { name: 'How BenchPoll works', level: 1 });
            assert.equal(await title.count(), 1);
            assert.equal(await page.locator('.hi-document :is(details, button, figure, canvas, [hidden])').count(), 0);
            assert.equal(await disclosure.evaluate(node => node.open), !narrow);
            assert.equal(await toggle.isVisible(), narrow);
            assert.equal(await page.evaluate(() => document.getAnimations().length), 0);
            assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

            const headingStyles = await page.locator('#overview, #weights, #public, #calculation-details')
                .evaluateAll(nodes => nodes.map(node => {
                    const style = getComputedStyle(node);
                    return [parseFloat(style.fontSize), Number(style.fontWeight)];
                }));
            for (const [index, [size, weight]] of headingStyles.entries()) {
                if (!index) continue;
                assert.ok(size < headingStyles[index - 1][0] && weight < headingStyles[index - 1][1], JSON.stringify(headingStyles));
            }
            const navigationBounds = await toc.boundingBox();
            const stickyTop = await toc.evaluate(node => parseFloat(getComputedStyle(node).top));
            const titleBounds = await title.boundingBox();
            const firstSection = await page.locator('#topics').boundingBox();
            if (narrow) {
                assert.ok(navigationBounds.y > titleBounds.y + titleBounds.height);
                assert.ok(firstSection.y > navigationBounds.y + navigationBounds.height && firstSection.y < 440);
                assert.ok((await toggle.boundingBox()).height >= 44);
            } else {
                assert.ok(navigationBounds.x + navigationBounds.width < titleBounds.x);
                assert.ok(Math.abs(navigationBounds.y - titleBounds.y) < 2);
            }
            await page.screenshot({ path: `${output}/${engine.name()}-${width}-guide.png` });

            await assertCurrentLink(page, url);
            await page.keyboard.press('Tab');
            const skip = page.getByRole('link', { name: 'Skip to guide' });
            assert.equal(await skip.evaluate(node => node === document.activeElement && getComputedStyle(node).outlineStyle === 'solid'), true);
            await page.keyboard.press('Enter');
            await assertCurrentLink(page, url, 'overview');
            assert.equal(await title.evaluate(node => node === document.activeElement), true);

            for (const id of ['calculation-details', 'rankings', 'fallback']) {
                if (narrow) {
                    await toggle.focus();
                    await page.keyboard.press('Space');
                    assert.equal(await disclosure.evaluate(node => node.open), true);
                }
                const links = await toc.locator('a[href="#weights"], a[href="#public"], a[href="#calculation-details"]')
                    .evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().left));
                assert.ok(links[0] < links[1] && links[1] < links[2]);
                const link = toc.locator(`a[href="#${id}"]`);
                if (narrow) assert.ok((await link.boundingBox()).height >= 44);
                if (id === 'calculation-details') {
                    if (narrow) await page.screenshot({ path: `${output}/${engine.name()}-${width}-contents.png` });
                    await link.focus();
                    await page.keyboard.press('Enter');
                } else {
                    await link.click();
                }
                await assertCurrentLink(page, url, id);
                await assertFragmentVisible(page, id);
                assert.equal(await page.evaluate(() => document.activeElement.id), id);
                assert.equal(await disclosure.evaluate(node => node.open), !narrow);
                if (!narrow) assert.ok(Math.abs((await toc.boundingBox()).y - stickyTop) < 2);
                assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            }
            await page.screenshot({ path: `${output}/${engine.name()}-${width}-estimation.png` });

            await page.goBack();
            await assertCurrentLink(page, url, 'rankings');
            await page.goBack();
            await assertCurrentLink(page, url, 'calculation-details');
            await page.goForward();
            await assertCurrentLink(page, url, 'rankings');
            await page.goForward();
            await assertCurrentLink(page, url, 'fallback');
            assert.deepEqual(documentRequests, [url]);
            await page.reload();
            await assertCurrentLink(page, url, 'fallback');
        });
    }

    test(`${engine.name()}: direct fragments and the native contents work with scripts disabled`, async t => {
        const fixture = await startPreview();
        const browser = await engine.launch({ headless: true });
        t.after(async () => { await browser.close(); await fixture.close(); });
        const page = await browser.newPage({ javaScriptEnabled: false, viewport: { width: 390, height: 800 } });
        page.setDefaultTimeout(8000);
        const url = fixture.url + '/how-it-works';
        assert.equal((await page.goto(url + '#calculation-details')).status(), 200);
        await page.evaluate(() => document.fonts.ready);
        await assertFragmentVisible(page, 'calculation-details');
        await page.reload();
        await page.evaluate(() => document.fonts.ready);
        await assertFragmentVisible(page, 'calculation-details');
        assert.match(await page.locator('#calculation-details + p').textContent(), /past 72 hours/);
        const toc = page.getByRole('navigation', { name: 'Contents' });
        await toc.locator('summary').click();
        await toc.getByRole('link', { name: 'Estimation votes' }).click();
        await assertFragmentVisible(page, 'fallback');
        assert.match(await page.locator('#fallback + p').textContent(), /choose an explicit target version/);
    });
}
