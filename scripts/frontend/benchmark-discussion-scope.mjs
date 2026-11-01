import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, webkit } from 'playwright';
import { startPreview } from './server.mjs';
import { normalizeDiscussionPost } from '../../discussion-service.js';

const output = process.env.DISCUSSION_SCOPE_OUTPUT ?? 'D:/Codex-artifacts/website1/benchmark-discussion-scope-20261013';
await mkdir(output, { recursive: true });
const results = [];
const dimensions = [
    { key: 'budget', name: 'Budget', options: [{ key: 'any', name: 'Any', isNeutral: true },
        { key: 'standard', name: 'Standard' }, { key: 'extended', name: 'Extended' }] },
    { key: 'length', name: 'Response length', options: [{ key: 'any', name: 'Any', isNeutral: true }, { key: 'long', name: 'Long' }] }
];
const makePost = (ID, categoryID, contextID, benchmarkID, conditionID, parentID = null) => ({
    ID, categoryID, categoryName: categoryID === 1 ? 'Language models' : 'Reasoning', contextID, parentID,
    contextValues: { budget: contextID === 10 ? 'standard' : 'extended', length: 'any' },
    text: `Synthetic discussion ${ID}`, authorName: 'Fixture contributor', createdAt: '2026-10-01T00:00:00Z',
    isOwn: false, isDeleted: false, upvotes: 8, downvotes: 1, myVote: 0, replyCount: ID === 801 ? 1 : 0,
    mentions: [{ benchmarkID, conditionID, label: benchmarkID === 101 ? 'General knowledge' : 'Advanced reasoning' }]
});
const posts = [makePost(801, 1, 10, 101, 1), makePost(802, 2, 10, 101, 1), makePost(803, 1, 10, 102, 2),
    makePost(804, 1, 10, 101, 901), makePost(805, 1, 10, 101, null), makePost(806, 1, 11, 101, 1),
    makePost(811, 1, 10, 101, 1, 801)];

const ready = page => page.waitForFunction(() => document.querySelector('#model-ranking-status')?.dataset.phase === 'ready');
const idle = page => page.waitForFunction(() => document.querySelector('#discussion-feed')?.getAttribute('aria-busy') === 'false');
const feedIDs = page => page.locator('#discussion-feed > .discussion-post').evaluateAll(nodes => nodes.map(node => Number(node.id.slice(5))));
async function loadAll(page) {
    for (let attempt = 0; attempt < 50; attempt++) {
        await idle(page);
        if (!await page.locator('#discussion-more').isVisible()) return;
        await page.locator('#discussion-more').evaluate(button => {
            if (!button.disabled && !button.hidden && button.getClientRects().length) button.click();
        });
        await page.waitForTimeout(30);
    }
    throw new Error('Discussion pagination did not settle');
}
async function geometry(page) {
    const result = await page.evaluate(() => {
        const panel = document.querySelector('.discussion-main'), scroll = document.querySelector('.discussion-scroll');
        const rect = panel.getBoundingClientRect();
        return { viewport: innerWidth, documentOverflow: document.documentElement.scrollWidth - innerWidth,
            panelOverflow: panel.scrollWidth - panel.clientWidth, scrollOverflow: scroll.scrollWidth - scroll.clientWidth,
            left: rect.left, right: rect.right,
            outside: [...panel.querySelectorAll('button, a, select, textarea, label, h2, h3')]
                .filter(node => node.getClientRects().length && getComputedStyle(node).visibility !== 'hidden')
                .map(node => ({ id: node.id, left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right }))
                .filter(node => node.left < rect.left - 1 || node.right > rect.right + 1) };
    });
    assert.ok(result.documentOverflow <= 1 && result.panelOverflow <= 1 && result.scrollOverflow <= 1, JSON.stringify(result));
    assert.deepEqual(result.outside, []);
    return result;
}

for (const [engine, launcher, width] of [['chromium', chromium, 1440], ['chromium', chromium, 1024],
    ['chromium', chromium, 390], ['chromium', chromium, 320], ['webkit', webkit, 390]]) {
    if (process.env.UI_TEST_ENGINE && process.env.UI_TEST_ENGINE !== engine) continue;
    if (process.env.UI_TEST_WIDTH && Number(process.env.UI_TEST_WIDTH) !== width) continue;
    const label = `${engine}-${width}`;
    const app = await startPreview({ secondaryBenchmark: true });
    const browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width, height: 900 }, isMobile: width < 761,
        hasTouch: width < 761, reducedMotion: 'reduce' });
    const page = await context.newPage(); page.setDefaultTimeout(15000);
    const errors = [], reads = [], writes = [];
    let template = true, failNext = false, holdAll = false, releaseAll, finishHeld;
    page.on('pageerror', error => errors.push(error.message));
    try {
        if (engine === 'webkit') await page.route(`${app.url}/**`, async route => {
            const response = await route.fetch(); await route.fulfill({ response, body: await response.body() });
        });
        await page.route(`${app.url}/api/get_discussion`, async route => {
            const body = route.request().postDataJSON(); reads.push(structuredClone(body));
            if (failNext) { failNext = false; await route.fulfill({ status: 502, json: { error: 'fixture_failed' } }); return; }
            const delayed = holdAll && body.allCategories;
            if (delayed) { holdAll = false; await new Promise(resolve => { releaseAll = resolve; }); }
            const root = body.threadID ? posts.find(post => post.ID === body.threadID) : null;
            const categoryID = root?.categoryID ?? body.categoryID;
            const values = root?.contextValues ?? { budget: 'standard', length: 'any', ...body.contextValues };
            let selected = posts.filter(post => body.threadID ? post.parentID === body.threadID : post.parentID === null);
            if (!body.threadID) {
                if (!body.allCategories || !body.benchmarkID) selected = selected.filter(post => post.categoryID === categoryID);
                if (body.contextID !== null) selected = selected.filter(post => post.contextID === body.contextID);
                if (body.benchmarkID) selected = selected.filter(post => post.mentions.some(mention => mention.benchmarkID === body.benchmarkID
                    && (body.conditionID === null || mention.conditionID === null || mention.conditionID === body.conditionID)));
                if (body.sort === 'new') selected = selected.toReversed();
            }
            const offset = body.offset ?? 0, pagePosts = selected.slice(offset, offset + 2);
            try {
                await route.fulfill({ json: { context: { categoryID, categoryPath: categoryID === 1 ? 'Language-models' : 'Language-models/Reasoning',
                    contextValues: values, dimensions: template ? dimensions.map(dimension => ({ ...dimension, selectedKey: values[dimension.key] })) : [] },
                    contexts: [{ ID: 10, values: { budget: 'standard', length: 'any' } }, { ID: 11, values: { budget: 'extended', length: 'any' } }],
                    authenticated: app.state.authenticated, userID: app.state.authenticated ? '1' : null, root,
                    posts: delayed ? pagePosts.map(post => ({ ...post, text: 'STALE RESPONSE' })) : pagePosts,
                    total: selected.length, hasMore: offset + pagePosts.length < selected.length } });
            } catch (error) { if (!delayed) throw error; }
            finally { if (delayed) finishHeld?.(); }
        });
        // Reject intercepted submissions: no post ever reaches the fixture server or a database.
        await page.route(`${app.url}/api/create_discussion_post`, async route => {
            const body = route.request().postDataJSON(); writes.push(body);
            const { expectedUserID, ...post } = body;
            assert.equal(expectedUserID, '1');
            try { normalizeDiscussionPost(post); }
            catch (error) { await route.fulfill({ status: error.status ?? 400, json: error.body }); return; }
            await route.fulfill({ status: 429, json: { error: 'discussion_post_cooldown' } });
        });
        await context.addInitScript(() => {
            localStorage.setItem('benchpoll-workspace-display-v1', 'standard');
            sessionStorage.setItem('benchpoll-workspace-preferences-v1', JSON.stringify({ mode: 'personal' }));
        });
        await page.goto(app.url); await ready(page); await page.evaluate(() => document.fonts.ready);
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        const benchmarkLink = page.locator('.bp-benchmark-row:not(.is-family)[data-condition-id="1"] .bp-benchmark-information-link').first();
        const openBenchmark = async () => {
            await benchmarkLink.click(); await idle(page);
            await page.waitForFunction(() => document.querySelector('#benchmark-information-name')?.textContent === 'General knowledge');
            assert.equal(await page.locator('#discussion-error').isVisible(), false);
        };
        await openBenchmark();
        const scope = page.locator('#discussion-scope-toggle'), entry = page.locator('#discussion-entry');
        const openCategory = async () => {
            if (width < 761 && await page.locator('#discussion-panel').getAttribute('aria-hidden') === 'false') {
                await page.locator('#discussion-close').click();
            }
            await entry.click();
        };
        assert.equal(await page.locator('#discussion-all-categories, #clear-benchmark, #scope-filter-label').count(), 0);
        assert.equal((await entry.textContent()).trim(), 'Category discussion');
        assert.equal(await entry.evaluate(node => node.closest('#discussion-panel') !== null), false);
        if (width < 761) {
            assert.equal(await page.locator('#discussion-panel').getAttribute('role'), 'dialog');
            assert.equal(await page.locator('#discussion-panel').getAttribute('aria-modal'), 'true');
            assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), true);
            await page.setViewportSize({ width: 1024, height: 900 });
            await page.waitForFunction(() => document.querySelector('#discussion-panel').getAttribute('role') === 'complementary');
            assert.equal(await entry.evaluate(node => node.closest('.bp-context-actions') !== null), true);
            await page.setViewportSize({ width, height: 900 });
            await page.waitForFunction(() => document.querySelector('#discussion-panel').getAttribute('role') === 'dialog');
            assert.equal(await entry.evaluate(node => node.closest('#discussion-panel') !== null), false);
        }
        await loadAll(page); assert.deepEqual(await feedIDs(page), [801, 805, 806]);
        await page.locator('#discussion-context').selectOption('10', { force: true }); await loadAll(page);
        assert.deepEqual(await feedIDs(page), [801, 805]);
        await scope.focus(); await page.keyboard.press('Space'); await loadAll(page);
        assert.equal(await scope.getAttribute('aria-pressed'), 'true');
        assert.equal(await page.locator('#discussion-scope-label').textContent(), 'All topics');
        assert.equal(await page.locator('#context-filter-label').isVisible(), false);
        assert.deepEqual(await feedIDs(page), [801, 802, 805, 806]);
        assert.match(await page.locator('#post-802 .discussion-context-badge').textContent(), /Reasoning/);
        assert.equal(reads.at(-1).benchmarkID, 101); assert.equal(reads.at(-1).conditionID, 1); assert.equal(reads.at(-1).contextID, null);
        const informationReads = app.state.requests.filter(request => request.path === '/api/get_benchmark_information').length;
        assert.equal(informationReads, 1);
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForResponse(response => response.url() === `${app.url}/api/get_discussion_summary`);
        assert.equal((await entry.textContent()).trim(), 'Category discussion');
        const allGeometry = await geometry(page);
        await page.locator('.discussion-scroll').evaluate(node => { node.scrollTop = 0; });
        await page.locator('#discussion-panel').screenshot({ path: join(output, `${label}-all-categories.png`) });

        await scope.hover();
        const style = await scope.evaluate(node => {
            const css = getComputedStyle(node), icon = getComputedStyle(node.querySelector('i'));
            return { background: css.backgroundColor, border: css.borderTopWidth, decoration: css.textDecorationLine,
                color: css.color, iconColor: icon.color, minHeight: css.minHeight, outline: css.outlineStyle };
        });
        assert.equal(style.background, 'rgba(0, 0, 0, 0)'); assert.equal(style.border, '0px'); assert.equal(style.decoration, 'none');
        assert.equal(style.color, style.iconColor); assert.ok(Number.parseFloat(style.minHeight) >= 32);
        await scope.focus(); await page.keyboard.press('Tab'); await page.keyboard.press('Shift+Tab');
        assert.notEqual(await scope.evaluate(node => getComputedStyle(node).outlineStyle), 'none');
        await scope.click(); await loadAll(page);
        assert.equal(await page.locator('#discussion-scope-label').textContent(), 'This topic');
        assert.equal(await page.locator('#context-filter-label').isVisible(), true);
        assert.deepEqual(await feedIDs(page), [801, 805, 806]);
        await page.locator('.discussion-scroll').evaluate(node => { node.scrollTop = 0; });
        await page.locator('#discussion-panel').screenshot({ path: join(output, `${label}-this-category.png`) });

        await scope.click(); await idle(page);
        if (width >= 761) {
            await page.locator('.bp-template-control[data-template-key="budget"]').click();
            await page.locator('.bp-template-choice').filter({ hasText: 'Extended' }).click();
            await ready(page); await page.waitForFunction(() => document.querySelector('#posting-context select')?.value === 'extended');
            assert.equal(await scope.getAttribute('aria-pressed'), 'true');
            assert.equal(await page.locator('#benchmark-information').isVisible(), true);
            assert.equal(reads.at(-1).benchmarkID, 101); assert.equal(reads.at(-1).conditionID, 1);
        }
        await page.locator('#discussion-compose-toggle').click();
        const selectors = page.locator('#posting-context select');
        await selectors.nth(0).selectOption('any', { force: true });
        assert.equal(await selectors.nth(1).isDisabled(), true);
        await selectors.nth(0).selectOption('extended', { force: true });
        assert.equal(await selectors.nth(1).isDisabled(), false);
        await selectors.nth(1).selectOption('long', { force: true });
        const text = page.locator('#discussion-text');
        await text.fill(''); await text.pressSequentially('x');
        const nativeValidation = await text.evaluate(node => ({ tooShort: node.validity.tooShort, valid: node.checkValidity() }));
        assert.equal(nativeValidation.tooShort, true);
        await page.locator('#post-discussion').click();
        if (engine === 'webkit' && nativeValidation.valid) {
            await page.locator('#discussion-error').waitFor();
            assert.match(await page.locator('#discussion-error').textContent(), /2 and 4,000/);
        } else { assert.equal(nativeValidation.valid, false); assert.equal(writes.length, 0); }
        const rejectedShortPosts = writes.length;
        await text.fill('Benchmark draft remains scoped to the selected task.');
        await page.locator('#post-discussion').click(); await page.locator('#discussion-error').waitFor();
        assert.equal(writes.length, rejectedShortPosts + 1); assert.equal(writes.at(-1).categoryID, 1);
        assert.deepEqual(writes.at(-1).contextValues, { budget: 'extended', length: 'long' });
        assert.deepEqual(writes.at(-1).mentions, [{ benchmarkID: 101, conditionID: 1 }]);
        await page.waitForFunction(() => document.querySelector('#discussion-error').textContent.includes('30 seconds'));
        assert.match(await page.locator('#discussion-error').textContent(), /30 seconds/);
        await scope.click(); await idle(page);
        assert.equal(await text.inputValue(), 'Benchmark draft remains scoped to the selected task.');
        assert.equal(await selectors.nth(1).inputValue(), 'long');
        const benchmarkDraftURL = new URL(await benchmarkLink.getAttribute('href'), app.url);
        benchmarkDraftURL.searchParams.set('context_budget', 'extended'); benchmarkDraftURL.searchParams.set('context_length', 'long');
        await geometry(page);
        await page.locator('#discussion-panel').screenshot({ path: join(output, `${label}-composer.png`) });
        const workspaceValues = new URL(await entry.getAttribute('href'), app.url).searchParams;
        await openCategory(); await loadAll(page);
        assert.equal(await page.locator('#benchmark-information').isVisible(), false);
        assert.equal(await scope.isVisible(), false);
        assert.equal(await page.locator('#discussion-title').textContent(), 'Discussion');
        assert.deepEqual(await feedIDs(page), [801, 803, 804, 805, 806]);
        assert.equal(reads.at(-1).benchmarkID, null); assert.equal(reads.at(-1).conditionID, null); assert.equal(reads.at(-1).allCategories, false);
        assert.equal(reads.at(-1).contextValues.budget, workspaceValues.get('context_budget'));
        assert.match(await entry.textContent(), /discussion/); assert.notEqual((await entry.textContent()).trim(), 'Category discussion');
        assert.equal(await entry.evaluate(node => node.closest('.bp-context-actions') !== null), true);
        await page.locator('#benchmark-discussion-view [data-sort="new"]').click(); await loadAll(page);
        assert.deepEqual(await feedIDs(page), [806, 805, 804, 803, 801]);
        await page.locator('#benchmark-discussion-view [data-sort="hot"]').click(); await loadAll(page);
        assert.deepEqual(await feedIDs(page), [801, 803, 804, 805, 806]);
        await page.locator('#discussion-compose-toggle').click(); await text.fill('Ordinary category draft');
        await page.locator('#discussion-close').click();
        assert.equal(await entry.evaluate(node => document.activeElement === node), true);
        await benchmarkLink.evaluate((node, url) => { node.href = url; }, benchmarkDraftURL.href);
        await openBenchmark();
        assert.equal(await text.inputValue(), 'Benchmark draft remains scoped to the selected task.');
        await openCategory(); await idle(page); assert.equal(await text.inputValue(), 'Ordinary category draft');
        await page.locator('#discussion-context').selectOption('11', { force: true }); await loadAll(page);
        assert.deepEqual(await feedIDs(page), [806]);
        await page.locator('#discussion-context').selectOption('', { force: true }); await loadAll(page);
        await page.locator('#post-801 .discussion-post-actions a').filter({ hasText: '1 replies' }).click(); await idle(page);
        assert.equal(await page.locator('#thread-root #post-801').count(), 1); assert.deepEqual(await feedIDs(page), [811]);
        assert.equal(await scope.isVisible(), false); assert.equal(await page.locator('#context-filter-label').isVisible(), false);
        await page.locator('#all-threads').click(); await loadAll(page);
        assert.equal(await page.locator('#thread-root .discussion-post').count(), 0);
        await page.locator('#discussion-close').click(); await openBenchmark();

        failNext = true; await scope.click(); await idle(page);
        assert.equal(await scope.getAttribute('aria-pressed'), 'true'); assert.equal(await page.locator('#benchmark-information').isVisible(), true);
        assert.equal(await page.locator('#discussion-error').isVisible(), true);
        await scope.click(); await idle(page); assert.equal(await page.locator('#discussion-error').isVisible(), false);
        const heldSettled = new Promise(resolve => { finishHeld = resolve; });
        holdAll = true; await scope.click();
        await page.waitForFunction(() => document.querySelector('#discussion-feed').getAttribute('aria-busy') === 'true');
        while (!releaseAll) await new Promise(resolve => setTimeout(resolve, 10));
        await scope.click(); await loadAll(page);
        releaseAll(); await heldSettled;
        assert.equal(await page.locator('#discussion-scope-label').textContent(), 'This topic');
        assert.equal(await page.locator('#discussion-feed').textContent().then(text => text.includes('STALE RESPONSE')), false);
        assert.equal(reads.at(-1).conditionID, 1);
        await geometry(page);
        if (width < 761) {
            const first = page.locator('#discussion-brand-slot .bp-brand'); await first.focus();
            await page.keyboard.press('Shift+Tab');
            assert.equal(await page.evaluate(() => document.querySelector('#discussion-panel').contains(document.activeElement)), true);
            await page.keyboard.press('Escape'); assert.equal(await page.locator('#discussion-panel').getAttribute('aria-hidden'), 'true');
            assert.equal(await page.locator('.bp-workspace').evaluate(node => node.inert), false);
        } else await page.locator('#discussion-close').click();
        template = false; await page.locator('#discussion-entry').click(); await idle(page);
        assert.equal(await page.locator('#context-filter-label').isVisible(), false);
        await page.locator('#discussion-close').click();
        app.state.authenticated = false; template = true;
        await page.goto(app.url); await ready(page);
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        await openBenchmark(); await scope.click(); await idle(page);
        await page.locator('#discussion-compose-toggle').click();
        assert.equal(await page.locator('#post-discussion').textContent(), 'Sign in to participate');
        await geometry(page);
        await page.locator('#discussion-close').click();
        app.state.authenticated = true; app.state.isPrivate = true;
        await page.goto(app.url); await ready(page);
        if (width < 761) await page.locator('button[data-mobile-panel="mix"]').click();
        assert.equal(await entry.isVisible(), false);
        const privateReads = reads.length;
        await benchmarkLink.click();
        await page.waitForFunction(() => document.querySelector('#benchmark-information-name')?.textContent === 'General knowledge');
        assert.equal(await page.locator('#benchmark-information').isVisible(), true);
        assert.equal(await page.locator('#benchmark-discussion-view').isVisible(), false);
        assert.equal(await page.locator('#discussion-composer').isVisible(), false);
        assert.equal(await scope.isVisible(), false); assert.equal(reads.length, privateReads);
        await geometry(page);
        assert.equal(app.state.requests.some(request => ['/api/create_discussion_post', '/api/vote_discussion', '/api/delete_discussion_post', '/api/submit_contribution'].includes(request.path)), false);
        assert.deepEqual(errors, []);
        results.push({ label, passed: true, allGeometry, style, nativeValidation, interceptedRejectedPosts: writes.length, realWrites: 0, pageErrors: errors });
        console.log(`PASS ${label}`);
    } catch (error) {
        await page.screenshot({ path: join(output, `${label}-failure.png`), fullPage: true }).catch(() => {});
        results.push({ label, passed: false, error: error.stack, pageErrors: errors, lastReads: reads.slice(-3) });
        console.error(`FAIL ${label}: ${error.stack}`);
    } finally {
        releaseAll?.(); await context.close(); await browser.close(); await app.close();
    }
}
await writeFile(join(output, 'verification.json'), JSON.stringify(results, null, 2));
if (results.some(result => !result.passed)) process.exitCode = 1;
