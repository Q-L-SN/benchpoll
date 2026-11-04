import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import { startPreview } from '../scripts/frontend/server.mjs';

const built = process.env.BP_TEST_BUILT === '1';
const output = 'artifacts/discussion-tooltip-20261104';
for (const engine of built ? [chromium] : [chromium, webkit]) {
    test(`${engine.name()} discussion close restores focus without a stray mouse tooltip ${built ? 'built' : 'source'}`, async t => {
        const fixture = await startPreview({ communityVersions: true });
        const browser = await engine.launch({ headless: true });
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: 'no-preference' });
        page.setDefaultTimeout(10000);
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        t.after(async () => { await browser.close(); await fixture.close(); assert.deepEqual(errors, []); });
        if (built) await page.route(fixture.url + '/', async route => route.fulfill({ contentType: 'text/html',
            body: await readFile('private/home-built.html', 'utf8') }));
        await page.goto(fixture.url);
        await page.locator('#benchmark-rows .bp-benchmark-row').first().waitFor();
        const entry = page.locator('#discussion-entry');
        const tooltip = page.locator('#bp-help-popover');
        await entry.click();
        await page.waitForFunction(() => document.body.classList.contains('discussion-open'));
        await page.locator('#discussion-close').click();
        await page.waitForTimeout(500);
        assert.equal(await page.evaluate(() => document.activeElement.id), 'discussion-entry');
        assert.equal(await tooltip.isVisible(), false, 'mouse focus restoration must not open a tooltip');
        await entry.hover();
        await tooltip.waitFor({ state: 'visible' });
        await page.mouse.move(600, 850);
        await tooltip.waitFor({ state: 'hidden' });

        // Keyboard focus still explains the control, and its tooltip follows the
        // closing rail as the workspace changes width.
        await entry.focus();
        await page.keyboard.press('Tab');
        await page.keyboard.press('Shift+Tab');
        await tooltip.waitFor({ state: 'visible' });
        await page.keyboard.press('Enter');
        await page.waitForFunction(() => document.activeElement.id === 'discussion-close');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => !document.body.classList.contains('discussion-open'));
        await tooltip.waitFor({ state: 'visible' });
        await page.waitForTimeout(400);
        const placement = await tooltip.evaluate(node => {
            const anchor = document.getElementById('discussion-entry').getBoundingClientRect();
            const bounds = node.getBoundingClientRect();
            return { arrowX: bounds.left + Number.parseFloat(node.style.getPropertyValue('--bp-tooltip-arrow-x')),
                centerX: anchor.left + anchor.width / 2, top: bounds.top, bottom: bounds.bottom,
                anchorTop: anchor.top, anchorBottom: anchor.bottom };
        });
        assert.ok(Math.abs(placement.arrowX - placement.centerX) < 2, JSON.stringify(placement));
        assert.ok(Math.min(Math.abs(placement.bottom + 8 - placement.anchorTop),
            Math.abs(placement.top - 8 - placement.anchorBottom)) < 2, JSON.stringify(placement));
        await page.keyboard.press('Escape');
        await page.locator('#benchmark-rows .bp-benchmark-information-link').first().click({ position: { x: 8, y: 8 } });
        await page.locator('#benchmark-information-name:not(:empty)').waitFor();
        await page.waitForTimeout(400);
        await mkdir(output, { recursive: true });
        await page.screenshot({ path: `${output}/${engine.name()}-${built ? 'built' : 'source'}-light-tabs.png` });
    });
}
