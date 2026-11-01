import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';

const output = process.env.DISCUSSION_REPLIES_OUTPUT ?? 'D:/Codex-artifacts/website1/discussion-replies-20261016/source';
const liveURL = process.argv.find(value => /^https?:\/\//.test(value));
const builtRoot = process.env.HOME_BUILT_ROOT;
const html = builtRoot ? await readFile(join(builtRoot, 'home-built.html'), 'utf8') : null;
const reports = [];
await mkdir(output, { recursive: true });

function messages() {
    const common = { categoryID: 1, categoryName: 'Language models', contextID: 1, contextValues: { budget: 'standard' },
        createdAt: '2026-10-15T01:00:00Z', isOwn: false, isDeleted: false, downvotes: 0, replyCount: 0, myVote: 0, mentions: [] };
    return [
        { ...common, ID: 801, parentID: null, authorName: 'Jamie Chen', upvotes: 18, replyCount: 2,
            text: 'Which tests should carry more weight for software engineering, and why?',
            mentions: [{ benchmarkID: 101, conditionID: 1, label: 'General knowledge' }] },
        { ...common, ID: 802, parentID: 801, authorName: 'Morgan Lee', upvotes: 7,
            text: 'I would give more weight to tests that publish a reproducible harness. It is easier to understand what changed between two runs.' },
        { ...common, ID: 803, parentID: 801, authorName: 'Taylor', isOwn: true, upvotes: 3,
            text: 'Agreed. We should also check coverage before making a strong claim about a model.' }
    ];
}

for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    const app = await startPreview();
    app.state.discussionPosts = messages();
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 960 }, isMobile: width < 760, hasTouch: width < 760, reducedMotion: 'reduce' });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    const errors = [], label = `${engine}-${width}`;
    page.on('pageerror', error => errors.push(error.message));
    if (liveURL) await page.route('**/api/**', async route => {
        const url = new URL(route.request().url());
        await route.fulfill({ response: await route.fetch({ url: app.url + url.pathname + url.search }) });
    });
    if (html || engine === 'webkit' && !liveURL) await page.route(`${app.url}/**`, async route => {
        const path = new URL(route.request().url()).pathname;
        if (html && route.request().resourceType() === 'document') return route.fulfill({ body: html, contentType: 'text/html' });
        if (html && path.startsWith('/build/home/')) return route.fulfill({ body: await readFile(join(builtRoot, path.slice(1))), contentType: path.endsWith('.css') ? 'text/css' : 'text/javascript' });
        if (engine === 'webkit') { const response = await route.fetch(); return route.fulfill({ response, body: await response.body() }); }
        return route.fallback();
    });
    await context.addInitScript(() => localStorage.setItem('benchpoll-workspace-display-v1', 'standard'));
    const threadURL = new URL('/?discussion=1&categoryID=1&threadID=801&context_budget=standard', liveURL ?? app.url).href;
    const ready = () => page.waitForFunction(() => document.querySelector('#discussion-panel')?.dataset.view === 'thread'
        && document.querySelector('#discussion-feed')?.getAttribute('aria-busy') === 'false');
    async function measure() {
        const geometry = await page.locator('.discussion-main').evaluate(panel => {
            const rect = panel.getBoundingClientRect(), root = panel.querySelector('#thread-root .discussion-post-body');
            return { pageOverflow: document.documentElement.scrollWidth - innerWidth, panelOverflow: panel.scrollWidth - panel.clientWidth,
                bodySize: getComputedStyle(root).fontSize, panelWidth: rect.width,
                outside: [...panel.querySelectorAll('button, a, textarea, h3')].filter(node => node.getClientRects().length)
                    .map(node => ({ id: node.id, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }))
                    .filter(node => node.left < rect.left - 1 || node.right > rect.right + 1),
                actions: [...panel.querySelectorAll('.discussion-post-actions .bp-ui-action')].map(node => ({
                    height: node.getBoundingClientRect().height, gap: parseFloat(getComputedStyle(node).columnGap)
                })) };
        });
        assert.ok(geometry.pageOverflow <= 1 && geometry.panelOverflow <= 1, JSON.stringify(geometry));
        assert.deepEqual(geometry.outside, []);
        assert.equal(geometry.bodySize, '15px');
        assert.ok(geometry.actions.length >= 8);
        assert.ok(geometry.actions.every(action => action.gap >= 6 && action.height >= (width < 760 ? 44 : 32)));
        return geometry;
    }
    try {
        await page.goto(threadURL); await ready(); await page.evaluate(() => document.fonts.ready);
        assert.equal(await page.locator('.discussion-thread-label').textContent(), 'Original message');
        assert.equal(await page.locator('.discussion-replies-heading').textContent(), 'Replies');
        assert.equal(await page.locator('.discussion-filterbar').isVisible(), false);
        assert.equal(await page.locator('#discussion-feed .discussion-context-badge:visible').count(), 0);
        const geometry = await measure();
        await page.locator('.discussion-main').screenshot({ path: join(output, `${label}-thread.png`) });

        await page.getByRole('button', { name: 'Like post 802: 7', exact: true }).click(); await ready();
        assert.equal(await page.getByRole('button', { name: 'Like post 802: 8', exact: true }).getAttribute('aria-pressed'), 'true');
        const owned = page.locator('#post-803');
        await owned.getByRole('button', { name: 'Delete your message', exact: true }).click();
        await owned.getByRole('button', { name: 'Cancel', exact: true }).click();
        assert.equal(await owned.locator('.discussion-delete-confirm').count(), 0);
        assert.match(await page.getByRole('link', { name: 'Report post 802', exact: true }).getAttribute('href'), /contribute\/discussions\/802\/report/);
        assert.equal(await page.locator('#post-802 a[title="Link to this message"] i.fa-link').count(), 1);

        await page.locator('#discussion-text').fill('Reproducibility and coverage should both inform the weights.');
        await page.getByRole('button', { name: 'Post reply', exact: true }).click();
        await page.locator('#post-804').waitFor(); await ready();
        assert.equal(app.state.requests.filter(request => request.path === '/api/create_discussion_post').length, 1);
        assert.equal(app.state.discussionPosts.find(post => post.ID === 804).parentID, 801);
        await page.locator('#all-threads').click();
        await page.waitForFunction(() => document.querySelector('#discussion-panel').dataset.view === 'feed');
        assert.equal(await page.locator('.discussion-thread-origin').isVisible(), false);
        await page.locator('#post-801 a').filter({ hasText: /replies/ }).click(); await ready();
        assert.equal(await page.locator('#thread-root #post-801').count(), 1);

        app.state.discussionPosts = [messages()[0]];
        await page.goto(threadURL); await ready();
        assert.match(await page.locator('.discussion-empty').textContent(), /No replies yet/);
        await page.locator('.discussion-main').screenshot({ path: join(output, `${label}-empty.png`) });
        app.state.authenticated = false;
        await page.goto(threadURL); await ready();
        assert.equal(await page.getByRole('button', { name: 'Sign in to participate', exact: true }).count(), 1);
        await page.locator('#discussion-close').click();
        assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'true');
        assert.deepEqual(errors, []);
        reports.push({ label, geometry, replyPosted: true, navigation: true, vote: true, deleteConfirmation: true, emptyAndGuest: true });
        console.log(`PASS ${label}: reply hierarchy, actions, posting, return navigation, empty and guest states`);
    } catch (error) { await page.screenshot({ path: join(output, `${label}-failure.png`) }).catch(() => {}); throw error; }
    finally { await context.close(); await browser.close(); await app.close(); }
}
await writeFile(join(output, 'results.json'), JSON.stringify(reports, null, 2));
