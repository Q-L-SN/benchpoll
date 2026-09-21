import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { startPreview } from './frontend/server.mjs';

// Model the previous CDN response, whose markup contract required a strong label.
const staleEntry = `
export function categoryDiscussionURL() { return '/discussion'; }
export function createDiscussionEntry(element) {
    return async () => {
        const title = element.querySelector('strong');
        title.textContent = 'Discuss this category';
    };
}`;
const app = await startPreview();
const browser = await chromium.launch({ headless: true });
const errors = [];
try {
    for (let attempt = 1; attempt <= 2; attempt++) {
        const context = await browser.newContext();
        const page = await context.newPage();
        page.on('pageerror', error => errors.push(error.message));
        await page.addInitScript(() => localStorage.setItem('benchpoll-welcome-seen-v1', '1'));
        await page.route('**/js/workspace/discussion-entry.js', route => route.fulfill({
            contentType: 'text/javascript', body: staleEntry
        }));
        await page.goto(app.url);
        await page.waitForFunction(() => document.title.includes('error') ||
            document.querySelector('[data-discussion-count]')?.textContent.includes('1 discussion'));
        console.log(`Attempt ${attempt}: ${errors.at(-1) || 'current discussion count loaded'}`);
        await context.close();
    }
    assert.deepEqual(errors, [], 'The current homepage must not load the old unversioned discussion module');
} finally {
    await browser.close();
    await app.close();
}
