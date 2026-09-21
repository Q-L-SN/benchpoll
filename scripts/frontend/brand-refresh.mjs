import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { chromium } from 'playwright';
import { startPreview } from './server.mjs';

const preview = await startPreview();
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
    await fs.mkdir('artifacts/brand-refresh', { recursive: true });
    const icon = await browser.newPage({ viewport: { width: 256, height: 256 }, deviceScaleFactor: 2 });
    const svg = await fs.readFile('public/assets/benchpoll-mark.svg', 'utf8');
    await icon.setContent(`<style>html,body{margin:0;width:256px;height:256px;background:transparent}svg{width:256px;height:256px}</style>${svg}`);
    await icon.screenshot({ path: 'public/assets/favicon-512.png', omitBackground: true });
    await icon.close();
    for (const width of [1440, 390]) {
        const page = await browser.newPage({ viewport: { width, height: 960 } });
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(preview.url);
        await page.locator('#welcome-overlay.is-open').waitFor();
        await page.locator('#welcome-overlay').evaluate(async el => { await Promise.all(el.getAnimations({ subtree: true }).map(animation => animation.finished)); });
        assert.equal(await page.locator('.bp-welcome-weight-preview, .bp-welcome-signals').count(), 0);
        await page.screenshot({ path: `artifacts/brand-refresh/welcome-${width}.png` });
        await page.locator('#welcome-primary').click();
        await page.locator('#welcome-overlay').waitFor({ state: 'hidden' });
        const font = await page.locator('#mission-welcome-trigger').evaluate(el => getComputedStyle(el).fontFamily);
        assert.match(font, /Georgia/);
        const logo = page.locator('.bp-sidebar .bp-brand-lockup');
        assert.ok(await logo.evaluate(el => el.complete && el.naturalWidth > 0));
        await page.screenshot({ path: `artifacts/brand-refresh/home-${width}.png` });
        await page.locator('#mission-welcome-trigger').click();
        await page.locator('#welcome-overlay.is-open').waitFor();
        await page.keyboard.press('Escape');
        await page.locator('#welcome-overlay').waitFor({ state: 'hidden' });
        await page.close();
    }
    const discussionPage = await browser.newPage({ viewport: { width: 1440, height: 960 } });
    discussionPage.on('pageerror', error => errors.push(error.message));
    await discussionPage.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
    await discussionPage.goto(`${preview.url}/?discussion=1`);
    await discussionPage.locator('#discussion-compose-toggle').click();
    await discussionPage.locator('#discussion-text').fill('Owner deletion browser regression test.');
    await discussionPage.locator('#post-discussion').click();
    const own = discussionPage.locator('.discussion-post').filter({ hasText: 'Owner deletion browser regression test.' });
    await own.locator('.discussion-delete').click();
    await own.getByRole('button', { name: 'Cancel', exact: true }).click();
    assert.equal(await own.count(), 1);
    await own.locator('.discussion-delete').click();
    await own.getByRole('button', { name: 'Delete', exact: true }).click();
    await own.waitFor({ state: 'detached' });
    assert.equal(await discussionPage.locator('#post-801 .discussion-delete').count(), 0);
    await discussionPage.close();
    assert.deepEqual(errors, []);
    console.log('Desktop/mobile welcome, logo, typography and reopen checks passed.');
} finally { await browser.close(); await preview.close(); }
